//! Phase 0 media spike. Synthetic media or explicit Linux V4L2/ALSA capture.
//! No network signaling service or media recording.

use std::fmt;

#[cfg(feature = "gstreamer-runtime")]
mod runtime;
#[cfg(feature = "gstreamer-runtime")]
pub use runtime::MediaSession;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaError(pub String);

impl fmt::Display for MediaError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MediaError {}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SourceConfig {
    #[default]
    Synthetic,
    LinuxCapture(LinuxCapture),
}

/// Device strings are validated once and are set through GStreamer properties.
/// They must never be interpolated into a pipeline launch string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxCapture {
    video_device: String,
    audio_device: String,
}

impl LinuxCapture {
    pub fn new(video_device: &str, audio_device: &str) -> Result<Self, MediaError> {
        let valid_video = if let Some(name) = video_device.strip_prefix("/dev/v4l/by-id/") {
            !name.is_empty()
                && name.len() <= 255
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b':'))
                && name != "."
                && name != ".."
        } else if let Some(index) = video_device.strip_prefix("/dev/video") {
            !index.is_empty() && index.len() <= 3 && index.bytes().all(|b| b.is_ascii_digit())
        } else {
            false
        };
        if !valid_video {
            return Err(MediaError("video device must be /dev/v4l/by-id/<device> or /dev/video<index>; use the stable by-id path when available".into()));
        }
        let valid_audio = audio_device
            .strip_prefix("plughw:CARD=")
            .and_then(|value| value.split_once(",DEV="))
            .is_some_and(|(card, device)| {
                !card.is_empty()
                    && card.len() <= 32
                    && card
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
                    && !device.is_empty()
                    && device.len() <= 2
                    && device.bytes().all(|b| b.is_ascii_digit())
                    && device.parse::<u8>().is_ok_and(|index| index <= 31)
            });
        if !valid_audio {
            return Err(MediaError("audio device must be plughw:CARD=<card-name>,DEV=<0..31>; use arecord -l to find the capture card".into()));
        }
        Ok(Self {
            video_device: video_device.into(),
            audio_device: audio_device.into(),
        })
    }

    pub fn video_device(&self) -> &str {
        &self.video_device
    }
    pub fn audio_device(&self) -> &str {
        &self.audio_device
    }
}

/// Fixed presets keep pipeline inputs bounded and prohibit launch-string injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum VideoPreset {
    #[default]
    Vga,
    Hd,
}

impl VideoPreset {
    pub fn dimensions(self) -> (u16, u16) {
        match self {
            Self::Vga => (640, 480),
            Self::Hd => (1280, 720),
        }
    }
}

/// RTP payload IDs must follow the receiver's offer, rather than fixed browser defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PayloadTypes {
    pub h264: u8,
    pub opus: u8,
}

impl PayloadTypes {
    pub fn from_offer(sdp: &str) -> Result<Self, MediaError> {
        if sdp.len() > raspbaby_protocol::MAX_SDP_BYTES {
            return Err(MediaError("SDP exceeds the size limit".into()));
        }
        let mut video = None;
        let mut audio = None;
        let mut section = "";
        let mut media_order = Vec::new();
        let mut allowed_payloads = Vec::new();
        for line in sdp.lines() {
            if line.starts_with("m=") {
                let fields: Vec<_> = line.split_whitespace().collect();
                section = fields.first().copied().unwrap_or("");
                if fields.get(1) == Some(&"0") {
                    return Err(MediaError("offer rejects a required media section".into()));
                }
                allowed_payloads = fields
                    .iter()
                    .skip(3)
                    .filter_map(|s| s.parse::<u8>().ok())
                    .collect();
                media_order.push(section);
            }
            let Some(mapping) = line.strip_prefix("a=rtpmap:") else {
                continue;
            };
            let Some((pt, codec)) = mapping.split_once(' ') else {
                continue;
            };
            let pt = pt
                .parse::<u8>()
                .ok()
                .filter(|pt| (96..=127).contains(pt) && allowed_payloads.contains(pt));
            if section == "m=video" && codec.eq_ignore_ascii_case("H264/90000") {
                // This spike encodes constrained baseline with packetization mode 1.
                // Require a compatible advertised format instead of answering with an arbitrary H.264 profile.
                if let Some(pt) = pt {
                    let prefix = format!("a=fmtp:{pt} ");
                    let compatible = sdp
                        .lines()
                        .filter_map(|line| line.strip_prefix(&prefix))
                        .any(|params| {
                            let params: Vec<_> = params.split(';').map(str::trim).collect();
                            params.contains(&"packetization-mode=1")
                                && params.iter().any(|param| {
                                    param
                                        .strip_prefix("profile-level-id=")
                                        .is_some_and(|profile| {
                                            profile.len() == 6
                                                && profile.bytes().all(|b| b.is_ascii_hexdigit())
                                                && profile[..4].eq_ignore_ascii_case("42e0")
                                        })
                                })
                        });
                    if compatible {
                        video = video.or(Some(pt));
                    }
                }
            } else if section == "m=audio" && codec.eq_ignore_ascii_case("opus/48000/2") {
                audio = audio.or(pt);
            }
        }
        if media_order != ["m=video", "m=audio"] {
            return Err(MediaError(
                "spike requires exactly one video section followed by one audio section".into(),
            ));
        }
        match (video, audio) {
            (Some(h264), Some(opus)) => Ok(Self { h264, opus }),
            _ => Err(MediaError(
                "offer must include constrained-baseline H.264 packetization-mode=1 and 48 kHz Opus audio with dynamic RTP payload IDs"
                    .into(),
            )),
        }
    }
}

/// No files, remote URLs, STUN servers, or TURN servers are used.
/// Drop only raw buffers under load. RTP queues apply backpressure because
/// dropping individual H.264 packets can destroy an entire encoded frame.
pub fn synthetic_pipeline(preset: VideoPreset, payloads: PayloadTypes) -> String {
    media_pipeline(preset, payloads, &SourceConfig::Synthetic)
}

pub fn media_pipeline(
    preset: VideoPreset,
    payloads: PayloadTypes,
    source: &SourceConfig,
) -> String {
    let (width, height) = preset.dimensions();
    let (video, audio) = match source {
        SourceConfig::Synthetic => (
            format!(
                "videotestsrc is-live=true pattern=ball ! video/x-raw,width={width},height={height},framerate=15/1"
            ),
            "audiotestsrc is-live=true wave=sine volume=0.1",
        ),
        SourceConfig::LinuxCapture(_) => (
            format!(
                "v4l2src name=camera do-timestamp=true ! image/jpeg,width={width},height={height},framerate=30/1 ! identity drop-buffer-flags=corrupted ! jpegdec ! videorate drop-only=true ! video/x-raw,width={width},height={height},framerate=15/1"
            ),
            "alsasrc name=microphone do-timestamp=true",
        ),
    };
    format!(
        "webrtcbin name=peer bundle-policy=max-bundle \
         {video} ! \
         queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! \
         videoconvert ! x264enc tune=zerolatency speed-preset=ultrafast bitrate=1500 key-int-max=30 bframes=0 ! \
         video/x-h264,profile=constrained-baseline ! h264parse ! rtph264pay pt={} config-interval=-1 ! \
         application/x-rtp,media=video,encoding-name=H264,payload={} ! queue max-size-buffers=128 max-size-bytes=0 max-size-time=200000000 ! peer.sink_0 \
         {audio} ! audioconvert ! audioresample ! \
         audio/x-raw,rate=48000,channels=1 ! queue max-size-buffers=3 max-size-bytes=0 max-size-time=0 leaky=downstream ! opusenc bitrate=32000 ! rtpopuspay pt={} ! \
         application/x-rtp,media=audio,encoding-name=OPUS,payload={} ! queue max-size-buffers=128 max-size-bytes=0 max-size-time=200000000 ! peer.sink_1",
        payloads.h264, payloads.h264, payloads.opus, payloads.opus
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_capture_devices_without_launch_string_interpolation() {
        let path = "/dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0";
        let capture = LinuxCapture::new(path, "plughw:CARD=Device,DEV=0").unwrap();
        assert_eq!(capture.video_device(), path);
        assert_eq!(capture.audio_device(), "plughw:CARD=Device,DEV=0");
        for preset in [VideoPreset::Vga, VideoPreset::Hd] {
            let pipeline = media_pipeline(
                preset,
                PayloadTypes {
                    h264: 108,
                    opus: 111,
                },
                &SourceConfig::LinuxCapture(capture.clone()),
            );
            let (width, height) = preset.dimensions();
            assert!(pipeline.contains(&format!(
                "image/jpeg,width={width},height={height},framerate=30/1"
            )));
            // Require actual decoded dimensions. No videoscale element can
            // turn a lower-resolution camera frame into an apparent preset pass.
            assert!(pipeline.contains(&format!("jpegdec ! videorate drop-only=true ! video/x-raw,width={width},height={height},framerate=15/1")));
            assert!(!pipeline.contains("videoscale"));
            assert!(pipeline.contains("alsasrc name=microphone"));
            assert!(!pipeline.contains(path));
            assert!(!pipeline.contains("plughw:"));
            assert!(!pipeline.contains("testsrc"));
        }
    }

    #[test]
    fn rejects_unsafe_or_unsupported_capture_device_names() {
        for path in [
            "",
            "/tmp/camera",
            "/dev/video",
            "/dev/video1000",
            "/dev/v4l/by-id/..",
            "/dev/v4l/by-id/../../etc/passwd",
            "/dev/video0 ! filesink location=leak",
            "/dev/video0\n",
            "/dev/v4l/by-id/\"camera\"",
        ] {
            assert!(LinuxCapture::new(path, "plughw:CARD=Device,DEV=0").is_err());
        }
        for device in [
            "",
            "default",
            "plughw:CARD=,DEV=0",
            "plughw:CARD=Device,DEV=32",
            "plughw:CARD=Device,DEV=-1",
            "plughw:CARD=Device,DEV=0 ! fakesink",
            "plughw:CARD=Device,DEV=0\n",
            "plughw:CARD=Device,DEV=é",
        ] {
            assert!(LinuxCapture::new("/dev/video0", device).is_err());
        }
        assert!(LinuxCapture::new("/dev/video999", "plughw:CARD=USB_Audio-1,DEV=31").is_ok());
    }

    #[test]
    fn discards_flagged_capture_frames_before_jpeg_decoding() {
        let source = SourceConfig::LinuxCapture(
            LinuxCapture::new("/dev/video0", "plughw:CARD=Device,DEV=0").unwrap(),
        );
        let payloads = PayloadTypes {
            h264: 108,
            opus: 111,
        };
        for preset in [VideoPreset::Vga, VideoPreset::Hd] {
            let pipeline = media_pipeline(preset, payloads, &source);
            let (width, height) = preset.dimensions();
            // V4L2 error buffers must be discarded while still compressed.
            // Filtering after jpegdec would let damaged JPEG data reach it.
            assert!(pipeline.contains(&format!(
                "image/jpeg,width={width},height={height},framerate=30/1 ! identity drop-buffer-flags=corrupted ! jpegdec"
            )));
            assert_eq!(pipeline.matches("drop-buffer-flags=").count(), 1);
            assert!(!synthetic_pipeline(preset, payloads).contains("drop-buffer-flags="));
        }
    }

    #[test]
    fn uses_offered_payloads_and_correct_media_sections() {
        let offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 107\r\na=rtpmap:107 H264/90000\r\na=fmtp:107 packetization-mode=1;profile-level-id=42e01f\r\nm=audio 9 UDP/TLS/RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\n";
        let pts = PayloadTypes::from_offer(offer).unwrap();
        assert_eq!(
            pts,
            PayloadTypes {
                h264: 107,
                opus: 109
            }
        );
        let pipeline = synthetic_pipeline(VideoPreset::Hd, pts);
        assert!(pipeline.contains("width=1280,height=720,framerate=15/1"));
        assert!(pipeline.contains("rtph264pay pt=107"));
        assert!(pipeline.contains("rtpopuspay pt=109"));
    }

    #[test]
    fn rejects_missing_codecs_and_invalid_payloads() {
        for offer in [
            "",
            "m=video 9 RTP/AVP 100\na=rtpmap:100 VP8/90000",
            "m=video 9 RTP/AVP 95\na=rtpmap:95 H264/90000\nm=audio 9 RTP/AVP 111\na=rtpmap:111 opus/48000/2",
        ] {
            assert!(PayloadTypes::from_offer(offer).is_err());
        }
    }

    #[test]
    fn default_is_lower_cost_vga() {
        assert_eq!(VideoPreset::default().dimensions(), (640, 480));
    }

    #[test]
    fn drops_only_raw_buffers_and_preserves_encoded_rtp_packets() {
        for preset in [VideoPreset::Vga, VideoPreset::Hd] {
            let pipeline = synthetic_pipeline(
                preset,
                PayloadTypes {
                    h264: 108,
                    opus: 111,
                },
            );
            let (video, audio) = pipeline.split_once("audiotestsrc").unwrap();
            for (branch, encoder, payloader, sink) in [
                (video, "x264enc", "rtph264pay", "peer.sink_0"),
                (audio, "opusenc", "rtpopuspay", "peer.sink_1"),
            ] {
                let (raw, encoded) = branch.split_once(encoder).unwrap();
                assert!(raw.contains("max-size-buffers=3"));
                assert!(raw.contains("leaky=downstream"));
                // A keyframe spans many RTP packets. A leaky queue here made
                // actual Chromium and WebView2 receivers decode zero frames.
                assert!(!encoded.contains("leaky="));
                let rtp = encoded.split_once(payloader).unwrap().1;
                assert!(rtp.contains("queue max-size-buffers=128"));
                assert!(rtp.contains("max-size-time=200000000"));
                assert!(rtp.contains(sink));
            }
        }
    }

    #[test]
    fn rejects_unsupported_profiles_and_malformed_media_without_panicking() {
        let valid = "m=video 9 UDP/TLS/RTP/SAVPF 107\na=rtpmap:107 H264/90000\na=fmtp:107 packetization-mode=1;profile-level-id=42e01f\nm=audio 9 UDP/TLS/RTP/SAVPF 109\na=rtpmap:109 opus/48000/2\n";
        for profile in ["42e0zz", "ééé", "ab€x", "64001f", "42001f"] {
            assert!(PayloadTypes::from_offer(&valid.replace("42e01f", profile)).is_err());
        }
        for invalid in [
            valid.replace("m=video 9", "m=video 0"),
            valid.replace("SAVPF 107", "SAVPF 108"),
            valid.replace("packetization-mode=1", "packetization-mode=0"),
            format!("{valid}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\n"),
        ] {
            assert!(PayloadTypes::from_offer(&invalid).is_err());
        }
    }
}
