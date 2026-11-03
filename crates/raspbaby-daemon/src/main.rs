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
            "Raspbaby Phase 0 media spike\nUsage: raspbaby-daemon --stdio-spike [--hd]\n\nRead one browser offer JSON line from stdin. Write one answer JSON line to stdout.\nKeep stdin open; close it or press Ctrl+C to stop. No network signaling service.\nRequires the gstreamer-runtime Cargo feature and GStreamer 1.22+ plugins."
        );
        return Ok(());
    }
    if args != ["--stdio-spike"] && args != ["--stdio-spike", "--hd"] {
        return Err("unsupported arguments; use --help".into());
    }
    #[cfg(not(feature = "gstreamer-runtime"))]
    return Err("media runtime is disabled; build with --features gstreamer-runtime".into());

    #[cfg(feature = "gstreamer-runtime")]
    {
        use raspbaby_media::{SyntheticSession, VideoPreset};
        use std::io::Write;
        use std::time::{Duration, Instant};
        eprintln!(
            "Local synthetic spike only. Paste one browser offer JSON line. Keep stdin open to stream."
        );
        let stdin = io::stdin();
        let mut input = stdin.lock();
        let line = read_bounded_line(&mut input)?;
        let offer = raspbaby_protocol::parse_message(&line)?;
        let preset = if args.len() == 2 {
            VideoPreset::Hd
        } else {
            VideoPreset::Vga
        };
        let (session, answer) = SyntheticSession::answer(&offer, preset)?;
        println!("{}", serde_json::to_string(&answer)?);
        io::stdout().flush()?;
        eprintln!(
            "Answer ready. Apply it in the receiver. Close stdin to stop. Maximum session: 30 minutes."
        );
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
            if start.elapsed() >= Duration::from_secs(30 * 60) {
                eprintln!("Spike session time limit reached.");
                break;
            }
        }
        Ok(())
    }
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
