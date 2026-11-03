use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

use gstreamer::{self as gst, prelude::*};
use gstreamer_webrtc as webrtc;
use raspbaby_protocol::{SignalKind, SignalingMessage};

use crate::{MediaError, PayloadTypes, VideoPreset, synthetic_pipeline};

const NEGOTIATION_TIMEOUT: Duration = Duration::from_secs(20);

/// Owns one synthetic peer. Dropping it stops capture and releases media resources.
pub struct SyntheticSession {
    pipeline: gst::Pipeline,
    peer: gst::Element,
}

impl Drop for SyntheticSession {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
    }
}

impl SyntheticSession {
    pub fn answer(
        offer: &SignalingMessage,
        preset: VideoPreset,
    ) -> Result<(Self, SignalingMessage), MediaError> {
        offer.validate().map_err(error)?;
        if offer.kind != SignalKind::Offer {
            return Err(MediaError("expected a webrtc.offer message".into()));
        }
        let payloads = PayloadTypes::from_offer(&offer.sdp)?;
        gst::init().map_err(error)?;
        let pipeline = gst::parse::launch(&synthetic_pipeline(preset, payloads))
            .map_err(error)?
            .downcast::<gst::Pipeline>()
            .map_err(|_| MediaError("GStreamer did not create a pipeline".into()))?;
        let peer = pipeline
            .by_name("peer")
            .ok_or_else(|| MediaError("webrtcbin missing".into()))?;
        let session = Self { pipeline, peer };
        let sdp = gstreamer_sdp::SDPMessage::parse_buffer(offer.sdp.as_bytes()).map_err(error)?;
        let description = webrtc::WebRTCSessionDescription::new(webrtc::WebRTCSDPType::Offer, sdp);
        session
            .pipeline
            .set_state(gst::State::Ready)
            .map_err(error)?;
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
        session
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(error)?;

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

    /// Return pipeline failures without logging SDP or media data.
    pub fn check_bus(&self) -> Result<(), MediaError> {
        let bus = self
            .pipeline
            .bus()
            .ok_or_else(|| MediaError("pipeline bus missing".into()))?;
        while let Some(message) = bus.pop() {
            match message.view() {
                gst::MessageView::Error(e) => {
                    return Err(MediaError(format!(
                        "GStreamer pipeline error: {}",
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
