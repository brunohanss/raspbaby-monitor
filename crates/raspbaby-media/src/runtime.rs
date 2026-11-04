use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

use gstreamer::{self as gst, prelude::*};
use gstreamer_webrtc as webrtc;
use raspbaby_protocol::{SignalKind, SignalingMessage};

use crate::{MediaError, PayloadTypes, SourceConfig, VideoPreset, media_pipeline};

const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(20);

/// Owns one peer. Dropping it stops sources and releases media resources.
pub struct MediaSession {
    pipeline: gst::Pipeline,
    peer: gst::Element,
}

impl Drop for MediaSession {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
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
        let session = Self { pipeline, peer };
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
