use raspbaby_media::{LinuxCapture, MediaError, SourceConfig, VideoPreset};
use std::error::Error;
#[cfg(any(test, feature = "gstreamer-runtime"))]
use std::io::{self, BufRead};

#[cfg(any(test, feature = "gstreamer-runtime"))]
use raspbaby_protocol::MAX_MESSAGE_BYTES;

fn main() {
    if let Err(error) = run() {
        eprintln!("raspbaby-daemon: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        println!(
            "Raspbaby Phase 0 media spike\nUsage: raspbaby-daemon --stdio-spike [--hd] [--video-device <V4L2-path> --audio-device <ALSA-device>]\n\nThe default source is synthetic. Linux capture requires both device options.\nVideo: /dev/v4l/by-id/<device> (preferred) or /dev/video<index>.\nAudio: plughw:CARD=<card-name>,DEV=<0..31>.\nCapture uses MJPEG at 30 FPS, decoded and reduced to 15 FPS; --hd selects 1280x720 instead of 640x480.\nRead one browser offer JSON line from stdin. Write one answer JSON line to stdout.\nKeep stdin open; close it or press Ctrl+C to stop. No network signaling service or recording.\nRequires the gstreamer-runtime Cargo feature and GStreamer 1.22+ plugins."
        );
        return Ok(());
    }
    let options = parse_options(&args)?;
    #[cfg(not(feature = "gstreamer-runtime"))]
    return Err(format!(
        "media runtime is disabled for {:?} at {:?}; build with --features gstreamer-runtime",
        options.source, options.preset
    )
    .into());

    #[cfg(feature = "gstreamer-runtime")]
    {
        use raspbaby_media::MediaSession;
        use std::io::Write;
        use std::time::{Duration, Instant};
        eprintln!(
            "Operator-driven media spike. Paste one browser offer JSON line. Keep stdin open to stream."
        );
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let line = read_bounded_line(&mut input)?;
        let offer = raspbaby_protocol::parse_message(&line)?;
        let (session, answer) = MediaSession::answer(&offer, options.preset, &options.source)?;
        println!("{}", serde_json::to_string(&answer)?);
        io::stdout().flush()?;
        eprintln!("Answer ready. Apply it in the receiver. Close stdin to stop.");
        // A bounded reader thread allows bus failures to end the session even while stdin is idle.
        drop(input);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let mut input = io::stdin().lock();
            let result = read_bounded_line(&mut input);
            let _ = sender.send(result.is_ok());
        });
        let start = Instant::now();
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => (),
            }
            session.check_bus()?;
            if matches!(options.source, SourceConfig::Synthetic)
                && start.elapsed() >= Duration::from_secs(30 * 60)
            {
                eprintln!("Spike session time limit reached.");
                break;
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
struct SpikeOptions {
    preset: VideoPreset,
    source: SourceConfig,
}

fn parse_options(args: &[String]) -> Result<SpikeOptions, MediaError> {
    if args.first().map(String::as_str) != Some("--stdio-spike") {
        return Err(MediaError("expected --stdio-spike; use --help".into()));
    }
    let mut preset = VideoPreset::Vga;
    let mut hd = false;
    let mut video = None;
    let mut audio = None;
    let mut args = args.iter().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--hd" if !hd => {
                preset = VideoPreset::Hd;
                hd = true;
            }
            "--video-device" if video.is_none() => {
                video = Some(args.next().ok_or_else(|| {
                    MediaError("--video-device requires a V4L2 device path".into())
                })?);
            }
            "--audio-device" if audio.is_none() => {
                audio = Some(args.next().ok_or_else(|| {
                    MediaError("--audio-device requires an ALSA device name".into())
                })?);
            }
            _ => {
                return Err(MediaError(
                    "unknown or duplicate argument; use --help".into(),
                ));
            }
        }
    }
    let source = match (video, audio) {
        (None, None) => SourceConfig::Synthetic,
        (Some(video), Some(audio)) => SourceConfig::LinuxCapture(LinuxCapture::new(video, audio)?),
        _ => return Err(MediaError("real capture requires both --video-device and --audio-device; no synthetic fallback is applied".into())),
    };
    Ok(SpikeOptions { preset, source })
}

/// Read at most one bounded JSON line. Never allocate for the rest of an oversized input.
#[cfg(any(test, feature = "gstreamer-runtime"))]
fn read_bounded_line(reader: &mut impl BufRead) -> io::Result<String> {
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            if bytes.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "stdin closed before a message",
                ));
            }
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "JSON message must end with a newline",
            ));
        }
        let take = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |n| n + 1);
        if bytes.len() + take > MAX_MESSAGE_BYTES + 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "signaling line too large",
            ));
        }
        let complete = chunk[take - 1] == b'\n';
        bytes.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if complete {
            return String::from_utf8(bytes).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "signaling must be UTF-8")
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(args: &[&str]) -> Result<SpikeOptions, MediaError> {
        parse_options(
            &args
                .iter()
                .map(|arg| (*arg).to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn synthetic_is_default_and_real_capture_is_explicit() {
        assert_eq!(
            options(&["--stdio-spike"]).unwrap(),
            SpikeOptions {
                preset: VideoPreset::Vga,
                source: SourceConfig::Synthetic
            }
        );
        let real = options(&[
            "--stdio-spike",
            "--audio-device",
            "plughw:CARD=Device,DEV=0",
            "--hd",
            "--video-device",
            "/dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0",
        ])
        .unwrap();
        assert_eq!(real.preset, VideoPreset::Hd);
        assert!(matches!(real.source, SourceConfig::LinuxCapture(_)));
    }

    #[test]
    fn rejects_partial_duplicate_and_unknown_source_options() {
        for args in [
            vec!["--stdio-spike", "--video-device", "/dev/video0"],
            vec![
                "--stdio-spike",
                "--audio-device",
                "plughw:CARD=Device,DEV=0",
            ],
            vec!["--stdio-spike", "--video-device"],
            vec!["--stdio-spike", "--hd", "--hd"],
            vec!["--stdio-spike", "--listen", "8765"],
            vec![
                "--stdio-spike",
                "--audio-device",
                "plughw:CARD=Device,DEV=0",
                "--audio-device",
                "plughw:CARD=Other,DEV=0",
            ],
        ] {
            assert!(options(&args).is_err());
        }
    }

    #[test]
    fn reads_exactly_one_message() {
        let mut input = io::Cursor::new(b"first\nsecond\n");
        assert_eq!(read_bounded_line(&mut input).unwrap(), "first\n");
        assert_eq!(read_bounded_line(&mut input).unwrap(), "second\n");
    }

    #[test]
    fn rejects_large_or_incomplete_or_invalid_utf8_messages() {
        let large = vec![b'x'; MAX_MESSAGE_BYTES + 2];
        for bytes in [large, b"unterminated".to_vec(), vec![255, b'\n'], vec![]] {
            assert!(read_bounded_line(&mut io::Cursor::new(bytes)).is_err());
        }
    }
}
