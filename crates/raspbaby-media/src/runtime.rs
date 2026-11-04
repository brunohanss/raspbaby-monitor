use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, mpsc},
    thread::JoinHandle,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use gstreamer::{self as gst, prelude::*};
use gstreamer_webrtc as webrtc;
use raspbaby_detection::{AudioConfig, AudioDetector, MotionConfig, MotionDetector};
use raspbaby_protocol::{SignalKind, SignalingMessage};
use raspbaby_protocol::{TelemetryEvent, TelemetryEventKind, TelemetryKind, TelemetryMessage};

use crate::{MediaError, PayloadTypes, SourceConfig, VideoPreset, media_pipeline};

const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(20);

/// Owns one peer. Dropping it stops sources and releases media resources.
pub struct MediaSession {
    pipeline: gst::Pipeline,
    peer: gst::Element,
    telemetry: Option<TelemetrySession>,
}

impl Drop for MediaSession {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
        self.telemetry.take();
    }
}

impl MediaSession {
    pub fn answer(
        offer: &SignalingMessage,
        preset: VideoPreset,
        source: &SourceConfig,
    ) -> Result<(Self, SignalingMessage), MediaError> {
        offer.validate().map_err(error)?;
        if offer.kind != SignalKind::Offer {
            return Err(MediaError("expected a webrtc.offer message".into()));
        }
        let payloads = PayloadTypes::from_offer(&offer.sdp)?;
        validate_source(source)?;
        gst::init().map_err(error)?;
        let pipeline = gst::parse::launch(&media_pipeline(preset, payloads, source))
            .map_err(error)?
            .downcast::<gst::Pipeline>()
            .map_err(|_| MediaError("GStreamer did not create a pipeline".into()))?;
        if let SourceConfig::LinuxCapture(capture) = source {
            pipeline
                .by_name("camera")
                .ok_or_else(|| {
                    MediaError("V4L2 source missing; install the GStreamer good plugins".into())
                })?
                .set_property("device", capture.video_device());
            pipeline
                .by_name("microphone")
                .ok_or_else(|| {
                    MediaError("ALSA source missing; install the GStreamer ALSA plugin".into())
                })?
                .set_property("device", capture.audio_device());
        }
        let peer = pipeline
            .by_name("peer")
            .ok_or_else(|| MediaError("webrtcbin missing".into()))?;
        let telemetry = if matches!(source, SourceConfig::LinuxCapture(_)) {
            Some(TelemetrySession::new(&pipeline, &peer)?)
        } else {
            None
        };
        let session = Self {
            pipeline,
            peer,
            telemetry,
        };
        let sdp = gstreamer_sdp::SDPMessage::parse_buffer(offer.sdp.as_bytes()).map_err(error)?;
        let description = webrtc::WebRTCSessionDescription::new(webrtc::WebRTCSDPType::Offer, sdp);
        session.set_state(gst::State::Ready)?;
        // Negotiate from upstream capabilities before starting the encoder.
        // webrtcbin intersects SDP caps literally; an already-running encoder's
        // lower H.264 level would otherwise reject a compatible receiver offer.

        let (promise, result) = promise_channel();
        session
            .peer
            .emit_by_name::<()>("set-remote-description", &[&description, &promise]);
        wait_promise(result)?;

        let (promise, result) = promise_channel();
        session
            .peer
            .emit_by_name::<()>("create-answer", &[&None::<gst::Structure>, &promise]);
        let response = wait_promise(result)?
            .ok_or_else(|| MediaError("GStreamer returned no SDP answer".into()))?;
        let answer = response
            .get::<webrtc::WebRTCSessionDescription>("answer")
            .map_err(error)?;
        let (promise, result) = promise_channel();
        session
            .peer
            .emit_by_name::<()>("set-local-description", &[&answer, &promise]);
        wait_promise(result)?;
        session.set_state(gst::State::Playing)?;

        let start = Instant::now();
        while session
            .peer
            .property::<webrtc::WebRTCICEGatheringState>("ice-gathering-state")
            != webrtc::WebRTCICEGatheringState::Complete
        {
            session.check_bus()?;
            if start.elapsed() >= NEGOTIATION_TIMEOUT {
                return Err(MediaError(
                    "ICE gathering exceeded 20 seconds; no partial answer was emitted".into(),
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let local = session
            .peer
            .property::<Option<webrtc::WebRTCSessionDescription>>("local-description")
            .ok_or_else(|| MediaError("local SDP description missing".into()))?;
        let message = SignalingMessage {
            protocol_version: offer.protocol_version,
            kind: SignalKind::Answer,
            session_id: offer.session_id.clone(),
            sdp: local.sdp().as_text().map_err(error)?.to_string(),
        };
        message.validate().map_err(error)?;
        Ok((session, message))
    }

    fn set_state(&self, state: gst::State) -> Result<(), MediaError> {
        if self.pipeline.set_state(state).is_err() {
            self.check_bus()?;
            return Err(MediaError("cannot start media sources; check device availability, capture mode, ALSA card, and video/audio group permissions".into()));
        }
        Ok(())
    }

    /// Return pipeline failures without logging SDP or media data.
    pub fn check_bus(&self) -> Result<(), MediaError> {
        let bus = self
            .pipeline
            .bus()
            .ok_or_else(|| MediaError("pipeline bus missing".into()))?;
        while let Some(message) = bus.pop() {
            match message.view() {
                gst::MessageView::Error(e) => {
                    let source = e
                        .src()
                        .map(|source| source.name().to_string())
                        .unwrap_or_else(|| "pipeline".into());
                    return Err(MediaError(format!(
                        "GStreamer {source} error: {}. Check device connection, permissions, MJPEG capture mode, and ALSA input.",
                        e.error()
                    )));
                }
                gst::MessageView::Eos(_) => {
                    return Err(MediaError("media pipeline stopped".into()));
                }
                _ => (),
            }
        }
        let state = self
            .peer
            .property::<webrtc::WebRTCPeerConnectionState>("connection-state");
        if matches!(
            state,
            webrtc::WebRTCPeerConnectionState::Failed | webrtc::WebRTCPeerConnectionState::Closed
        ) {
            return Err(MediaError(format!("WebRTC connection {state:?}")));
        }
        Ok(())
    }
}

const MAX_PENDING_EVENTS: usize = 128;
const MAX_CHANNEL_BUFFER: u64 = 65_536;

struct Analysis {
    motion: MotionDetector,
    audio: AudioDetector,
    audio_samples: Vec<f32>,
    motion_active: bool,
    motion_at: Option<Instant>,
    audio_level: Option<f32>,
    audio_active: bool,
    audio_at: Option<Instant>,
    pending: VecDeque<TelemetryEvent>,
    dropped_events: u64,
    next_event: u64,
}

impl Analysis {
    fn new() -> Result<Self, MediaError> {
        Ok(Self {
            motion: MotionDetector::new(MotionConfig::default()).map_err(error)?,
            audio: AudioDetector::new(AudioConfig::default()).map_err(error)?,
            audio_samples: Vec::with_capacity(4800),
            motion_active: false,
            motion_at: None,
            audio_level: None,
            audio_active: false,
            audio_at: None,
            pending: VecDeque::with_capacity(MAX_PENDING_EVENTS),
            dropped_events: 0,
            next_event: 0,
        })
    }

    fn event(&mut self, kind: TelemetryEventKind, timestamp_ms: u64) {
        self.next_event = self.next_event.saturating_add(1);
        if self.pending.len() == MAX_PENDING_EVENTS {
            // Keep earlier unreported events. Report every overflow explicitly.
            self.dropped_events = self.dropped_events.saturating_add(1);
            return;
        }
        self.pending.push_back(TelemetryEvent {
            id: format!("{timestamp_ms}-{}", self.next_event),
            kind,
            timestamp_ms,
        });
    }
}

/// All callbacks and the worker belong to one media session. Only event metadata
/// and the latest levels cross the lock; no frame or PCM queue is retained.
struct TelemetrySession {
    handlers: Vec<(gst::Element, gst::glib::SignalHandlerId)>,
    channel: Arc<Mutex<Option<webrtc::WebRTCDataChannel>>>,
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl TelemetrySession {
    fn new(pipeline: &gst::Pipeline, peer: &gst::Element) -> Result<Self, MediaError> {
        let analysis = Arc::new(Mutex::new(Analysis::new()?));
        let sinks = [("analysis_video", true), ("analysis_audio", false)]
            .into_iter()
            .map(|(name, video)| {
                pipeline
                    .by_name(name)
                    .map(|sink| (sink, video))
                    .ok_or_else(|| MediaError(format!("{name} missing")))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let channel: Arc<Mutex<Option<webrtc::WebRTCDataChannel>>> = Arc::new(Mutex::new(None));
        let mut handlers = Vec::new();
        let started = Instant::now();
        let channels = channel.clone();
        let handler = peer.connect("on-data-channel", false, move |values| {
            if let Ok(incoming) = values[1].get::<webrtc::WebRTCDataChannel>() {
                if incoming.label().as_deref() != Some("raspbaby-monitor")
                    || !incoming.is_ordered()
                    || incoming.max_retransmits() != -1
                    || incoming.max_packet_lifetime() != -1
                {
                    incoming.close();
                } else if let Ok(mut selected) = channels.lock() {
                    if selected.is_none() {
                        *selected = Some(incoming);
                    } else {
                        incoming.close();
                    }
                }
            }
            None
        });
        handlers.push((peer.clone(), handler));
        for (sink, video) in sinks {
            let shared = analysis.clone();
            let handler = sink.connect("new-sample", false, move |values| {
                let Ok(sink) = values[0].get::<gst::Element>() else {
                    return Some(gst::FlowReturn::Ok.to_value());
                };
                let sample = sink.emit_by_name::<Option<gst::Sample>>("pull-sample", &[]);
                if let Some(sample) = sample
                    && let Some(buffer) = sample.buffer()
                    && let Ok(mapped) = buffer.map_readable()
                    && let Ok(mut state) = shared.lock()
                {
                    let now = unix_ms();
                    let elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
                    if video {
                        // GRAY8 width 320 has no default row padding. Reject any
                        // unexpected allocation rather than interpreting it.
                        if mapped.len() == 320 * 180
                            && let Ok(reading) = state.motion.update(mapped.as_slice(), elapsed_ms)
                        {
                            state.motion_active = reading.active;
                            state.motion_at = Some(Instant::now());
                            if reading.event {
                                state.event(TelemetryEventKind::Motion, now);
                            }
                        }
                    } else {
                        for bytes in mapped.as_slice().chunks_exact(2) {
                            state.audio_samples.push(
                                f32::from(i16::from_le_bytes([bytes[0], bytes[1]])) / 32768.0,
                            );
                            if state.audio_samples.len() == 4800 {
                                let samples = std::mem::take(&mut state.audio_samples);
                                if let Ok(reading) = state.audio.update(&samples, elapsed_ms) {
                                    state.audio_level = Some(reading.level);
                                    state.audio_active = reading.active;
                                    state.audio_at = Some(Instant::now());
                                    if reading.event {
                                        state.event(TelemetryEventKind::Sound, now);
                                    }
                                }
                                state.audio_samples = samples;
                                state.audio_samples.clear();
                            }
                        }
                    }
                }
                Some(gst::FlowReturn::Ok.to_value())
            });
            handlers.push((sink, handler));
        }
        let (stop, stopped) = mpsc::channel();
        let channels = channel.clone();
        let worker = std::thread::Builder::new()
            .name("raspbaby-telemetry".into())
            .spawn(move || {
                let device_id = device_id();
                let mut sequence = 0_u64;
                let mut temperature_c = None;
                let mut temperature_at = Instant::now() - Duration::from_secs(1);
                loop {
                    if stopped.recv_timeout(Duration::from_millis(200))
                        != Err(mpsc::RecvTimeoutError::Timeout)
                    {
                        break;
                    }
                    if temperature_at.elapsed() >= Duration::from_secs(1) {
                        temperature_c = temperature();
                        temperature_at = Instant::now();
                    }
                    let selected = channels.lock().ok().and_then(|channel| channel.clone());
                    let Some(selected) = selected else { continue };
                    if selected.ready_state() != webrtc::WebRTCDataChannelState::Open
                        || selected.buffered_amount() > MAX_CHANNEL_BUFFER - 8192
                    {
                        continue;
                    }
                    if let Ok(mut state) = analysis.lock() {
                        // A wall-clock adjustment must not make already queued
                        // events invalid or block every later telemetry update.
                        let timestamp_ms = unix_ms()
                            .max(state.pending.back().map_or(0, |event| event.timestamp_ms));
                        let message = TelemetryMessage {
                            protocol_version: raspbaby_protocol::PROTOCOL_VERSION,
                            kind: TelemetryKind::MonitorTelemetry,
                            device_id: device_id.clone(),
                            sequence,
                            timestamp_ms,
                            temperature_c,
                            audio_level: state
                                .audio_at
                                .filter(|at| at.elapsed() < Duration::from_secs(2))
                                .and(state.audio_level),
                            motion_active: state
                                .motion_at
                                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
                                && state.motion_active,
                            sound_active: state
                                .audio_at
                                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
                                && state.audio_active,
                            events: state.pending.iter().take(32).cloned().collect(),
                            dropped_events: state.dropped_events,
                        };
                        if message.validate().is_ok()
                            && let Ok(encoded) = serde_json::to_string(&message)
                            && encoded.len() <= 8192
                            && selected.send_string_full(Some(&encoded)).is_ok()
                        {
                            state.pending.drain(..message.events.len());
                            sequence = sequence.saturating_add(1);
                        }
                    }
                }
            })
            .map_err(|failure| {
                for (element, handler) in handlers.drain(..) {
                    element.disconnect(handler);
                }
                error(failure)
            })?;
        Ok(Self {
            handlers,
            channel,
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for TelemetrySession {
    fn drop(&mut self) {
        for (element, handler) in self.handlers.drain(..) {
            element.disconnect(handler);
        }
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Ok(mut channel) = self.channel.lock()
            && let Some(channel) = channel.take()
        {
            channel.close();
        }
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn device_id() -> String {
    // A deterministic non-secret identifier; never transmit the machine-id itself.
    let identity = std::fs::read_to_string("/etc/machine-id").unwrap_or_default();
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in identity.trim().bytes().take(128) {
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    format!("raspbaby-{hash:016x}")
}

fn temperature() -> Option<f32> {
    let value = std::fs::read_to_string("/sys/class/thermal/thermal_zone0/temp")
        .ok()?
        .trim()
        .parse::<f32>()
        .ok()?
        / 1000.0;
    (value.is_finite() && (-40.0..=125.0).contains(&value)).then_some(value)
}

type PromiseResult = Result<Option<gst::Structure>, String>;

fn promise_channel() -> (gst::Promise, mpsc::Receiver<PromiseResult>) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let promise = gst::Promise::with_change_func(move |result| {
        let result = result
            .map(|reply| reply.map(ToOwned::to_owned))
            .map_err(|e| format!("{e:?}"));
        let _ = sender.send(result);
    });
    (promise, receiver)
}

fn wait_promise(
    receiver: mpsc::Receiver<PromiseResult>,
) -> Result<Option<gst::Structure>, MediaError> {
    let response = receiver
        .recv_timeout(NEGOTIATION_TIMEOUT)
        .map_err(error)?
        .map_err(MediaError)?;
    if let Some(ref reply) = response
        && reply.has_field("error")
    {
        return Err(MediaError(
            "GStreamer rejected the session description".into(),
        ));
    }
    Ok(response)
}

fn error(e: impl std::fmt::Display) -> MediaError {
    MediaError(e.to_string())
}

fn validate_source(source: &SourceConfig) -> Result<(), MediaError> {
    #[cfg(not(target_os = "linux"))]
    if matches!(source, SourceConfig::LinuxCapture(_)) {
        return Err(MediaError(
            "V4L2/ALSA capture requires Linux; use the default synthetic source on this host"
                .into(),
        ));
    }
    #[cfg(target_os = "linux")]
    if let SourceConfig::LinuxCapture(capture) = source {
        use std::os::unix::fs::FileTypeExt;
        let metadata = std::fs::metadata(capture.video_device()).map_err(|_| MediaError("camera is absent or inaccessible; check the /dev/v4l/by-id path, USB connection, and video group permissions".into()))?;
        if !metadata.file_type().is_char_device() {
            return Err(MediaError(
                "selected camera path is not a V4L2 character device".into(),
            ));
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod linux_tests {
    use super::*;
    use crate::LinuxCapture;

    #[test]
    fn capture_pipeline_links_with_native_plugins_without_opening_devices() {
        gst::init().unwrap();
        let source = SourceConfig::LinuxCapture(
            LinuxCapture::new("/dev/video999", "plughw:CARD=Missing,DEV=0").unwrap(),
        );
        for preset in [VideoPreset::Vga, VideoPreset::Hd] {
            // Parsing constructs elements in Null. It validates factory names,
            // property types, caps, and pad links without starting capture.
            let pipeline = gst::parse::launch(&media_pipeline(
                preset,
                PayloadTypes {
                    h264: 108,
                    opus: 111,
                },
                &source,
            ))
            .unwrap()
            .downcast::<gst::Pipeline>()
            .unwrap();
            assert_eq!(pipeline.current_state(), gst::State::Null);
            assert_eq!(
                pipeline
                    .by_name("camera")
                    .unwrap()
                    .factory()
                    .unwrap()
                    .name(),
                "v4l2src"
            );
            assert_eq!(
                pipeline
                    .by_name("microphone")
                    .unwrap()
                    .factory()
                    .unwrap()
                    .name(),
                "alsasrc"
            );
            assert_eq!(pipeline.by_name("peer").unwrap().sink_pads().len(), 2);
        }
    }

    #[test]
    fn missing_camera_fails_closed_instead_of_selecting_synthetic_media() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = format!(
            "/dev/v4l/by-id/raspbaby-test-missing-{}-{unique}",
            std::process::id()
        );
        assert!(!std::path::Path::new(&path).exists());
        let source = SourceConfig::LinuxCapture(
            LinuxCapture::new(&path, "plughw:CARD=Missing,DEV=0").unwrap(),
        );
        let failure = validate_source(&source).unwrap_err();
        assert!(
            failure
                .to_string()
                .contains("camera is absent or inaccessible")
        );
        assert!(matches!(source, SourceConfig::LinuxCapture(_)));
        assert!(validate_source(&SourceConfig::Synthetic).is_ok());
    }
}

#[cfg(test)]
mod telemetry_tests {
    use super::*;

    #[test]
    fn backpressure_keeps_earliest_unreported_events_and_counts_overflow() {
        let mut analysis = Analysis::new().unwrap();
        for index in 0..MAX_PENDING_EVENTS + 7 {
            analysis.event(TelemetryEventKind::Motion, 1000 + index as u64);
        }
        assert_eq!(analysis.pending.len(), MAX_PENDING_EVENTS);
        assert_eq!(analysis.dropped_events, 7);
        assert_eq!(analysis.pending.front().unwrap().timestamp_ms, 1000);
        assert_eq!(analysis.pending.back().unwrap().timestamp_ms, 1127);
        analysis.pending.drain(..32);
        analysis.event(TelemetryEventKind::Sound, 2000);
        assert_eq!(analysis.pending.len(), 97);
        assert_eq!(
            analysis.pending.back().unwrap().kind,
            TelemetryEventKind::Sound
        );
        assert_eq!(analysis.dropped_events, 7);
    }
}
