//! Operator-driven SSH signaling for the Windows development application.
//! Existing SSH keys and known_hosts establish trust. This is not device pairing.

use std::{
    io::{self, BufRead, BufReader, Write},
    net::Ipv4Addr,
    os::windows::process::CommandExt,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

use raspbaby_protocol::{parse_message, SignalKind, MAX_MESSAGE_BYTES};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
const EOF_TIMEOUT: Duration = Duration::from_secs(3);
const CAMERA_PATH: &str = "/dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0";

#[derive(Clone, Default)]
pub struct CameraConnector {
    state: Arc<Mutex<ConnectorState>>,
    quitting: Arc<AtomicBool>,
}

#[derive(Default)]
struct ConnectorState {
    generation: u64,
    requested: Option<SessionKey>,
    owned: Option<OwnedSession>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionKey {
    generation: u64,
    session_id: String,
}

struct OwnedSession {
    child: Child,
    stdin: Option<ChildStdin>,
    // Keep the pipe open after the single answer, without retaining media or SDP.
    _stdout: Option<BufReader<ChildStdout>>,
}

impl Drop for OwnedSession {
    fn drop(&mut self) {
        self.stdin.take();
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct Negotiated {
    answer: String,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSessionStatus {
    session_id: Option<String>,
    /// The owned SSH process is alive and has completed SDP exchange.
    /// The frontend must separately check its WebRTC media health.
    connected: bool,
}

impl ConnectorState {
    fn begin(&mut self, session_id: String) -> (SessionKey, Option<OwnedSession>) {
        self.generation = self.generation.wrapping_add(1);
        let key = SessionKey {
            generation: self.generation,
            session_id,
        };
        self.requested = Some(key.clone());
        (key, self.owned.take())
    }

    fn take_matching(&mut self, key: &SessionKey) -> Option<OwnedSession> {
        if self.requested.as_ref() != Some(key) {
            return None;
        }
        self.requested = None;
        self.owned.take()
    }

    fn cancel_session(&mut self, session_id: &str) -> Option<OwnedSession> {
        let key = self
            .requested
            .as_ref()
            .filter(|key| key.session_id == session_id)?
            .clone();
        self.take_matching(&key)
    }
}

fn validate_destination(host: &str, user: &str) -> Result<(), String> {
    let valid_user = !user.is_empty()
        && user.len() <= 32
        && user
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'));
    if !valid_user {
        return Err("SSH user must be 1–32 ASCII letters, digits, underscores, or hyphens, and start with a letter or underscore.".into());
    }
    let valid_host = if let Ok(address) = host.parse::<Ipv4Addr>() {
        address.is_private()
    } else {
        !host.is_empty()
            && host.len() <= 253
            && !host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
    };
    if !valid_host {
        return Err("SSH host must be an ASCII DNS hostname or a private IPv4 address, without a port or shell arguments.".into());
    }
    Ok(())
}

fn ssh_arguments(host: &str, user: &str, hd: bool) -> Result<Vec<String>, String> {
    validate_destination(host, user)?;
    let remote = format!(
        "/home/{user}/raspbaby-feasibility/target/debug/raspbaby-daemon --stdio-spike{} --video-device {CAMERA_PATH} --audio-device plughw:CARD=Device,DEV=0",
        if hd { " --hd" } else { "" }
    );
    Ok([
        "-T",
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=yes",
        "-oConnectTimeout=10",
        "-oServerAliveInterval=10",
        "-oServerAliveCountMax=2",
        "-oPreferredAuthentications=publickey",
        "-oPasswordAuthentication=no",
        "-oKbdInteractiveAuthentication=no",
        "-oClearAllForwardings=yes",
        "-oPermitLocalCommand=no",
        "-oControlMaster=no",
        "-oControlPath=none",
        "--",
    ]
    .into_iter()
    .map(str::to_owned)
    .chain([format!("{user}@{host}"), remote])
    .collect())
}

fn read_signaling_line(reader: &mut impl BufRead) -> io::Result<String> {
    let mut bytes = Vec::new();
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "SSH closed before an answer. Check the SSH key and known_hosts, the Pi daemon path, and capture devices."));
        }
        let take = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map_or(chunk.len(), |n| n + 1);
        if bytes.len() + take > MAX_MESSAGE_BYTES + 2 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "The Pi signaling answer exceeds the size limit.",
            ));
        }
        let complete = chunk[take - 1] == b'\n';
        bytes.extend_from_slice(&chunk[..take]);
        reader.consume(take);
        if complete {
            bytes.pop();
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            if bytes.len() > MAX_MESSAGE_BYTES {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "The Pi signaling answer exceeds the size limit.",
                ));
            }
            return String::from_utf8(bytes).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "The Pi signaling answer is not UTF-8.",
                )
            });
        }
    }
}

fn negotiate(
    mut stdin: ChildStdin,
    mut stdout: BufReader<ChildStdout>,
    offer: String,
    session_id: &str,
) -> Result<Negotiated, String> {
    stdin
        .write_all(offer.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|_| {
            "Could not send the offer through SSH. Check the SSH key and known_hosts.".to_string()
        })?;
    let line = read_signaling_line(&mut stdout).map_err(|error| error.to_string())?;
    let answer = parse_message(&line)
        .map_err(|_| "The Pi returned an invalid signaling answer.".to_string())?;
    if answer.kind != SignalKind::Answer || answer.session_id != session_id {
        return Err("The Pi answer does not match the current offer session.".into());
    }
    let answer = serde_json::to_string(&answer)
        .map_err(|_| "Could not encode the Pi answer.".to_string())?;
    Ok(Negotiated {
        answer,
        stdin,
        stdout,
    })
}

fn stop_owned(mut session: OwnedSession) -> Result<(), String> {
    // EOF makes the remote daemon release V4L2/ALSA before SSH exits.
    session.stdin.take();
    let deadline = Instant::now() + EOF_TIMEOUT;
    loop {
        match session.child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => break,
        }
    }
    // Terminate only this connector's child. Never search for or kill other SSH processes.
    session
        .child
        .kill()
        .map_err(|_| "The owned SSH process could not be stopped.".to_string())?;
    session
        .child
        .wait()
        .map_err(|_| "The owned SSH process could not be reaped.".to_string())?;
    Ok(())
}

impl CameraConnector {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, ConnectorState>, String> {
        self.state
            .lock()
            .map_err(|_| "Camera connection state is unavailable. Quit and reopen the app.".into())
    }

    fn clear_request(&self, key: &SessionKey) {
        let owned = self
            .lock()
            .ok()
            .and_then(|mut state| state.take_matching(key));
        if let Some(owned) = owned {
            let _ = stop_owned(owned);
        }
    }

    fn connect(
        &self,
        offer: String,
        host: String,
        user: String,
        hd: bool,
    ) -> Result<String, String> {
        if self.quitting.load(Ordering::SeqCst) {
            return Err("The app is quitting.".into());
        }
        let offer = parse_message(&offer).map_err(|error| error.to_string())?;
        if offer.kind != SignalKind::Offer {
            return Err("Expected a WebRTC offer.".into());
        }
        let args = ssh_arguments(&host, &user, hd)?;
        let offer_json =
            serde_json::to_string(&offer).map_err(|_| "Could not encode the offer.".to_string())?;
        let (key, previous) = self.lock()?.begin(offer.session_id);
        if let Some(previous) = previous {
            if let Err(error) = stop_owned(previous) {
                self.clear_request(&key);
                return Err(error);
            }
        }
        if self.lock()?.requested.as_ref() != Some(&key) {
            return Err("Camera connection was cancelled.".into());
        }
        let ssh = std::path::PathBuf::from(
            std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into()),
        )
        .join("System32/OpenSSH/ssh.exe");
        let child = Command::new(ssh)
            .args(args)
            .creation_flags(0x08000000)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn();
        let child = match child {
            Ok(child) => child,
            Err(_) => {
                self.clear_request(&key);
                return Err("Windows OpenSSH could not start. Install the Windows OpenSSH client and check the SSH key and known_hosts.".into());
            }
        };
        let mut owned = OwnedSession {
            child,
            stdin: None,
            _stdout: None,
        };
        let Some(stdin) = owned.child.stdin.take() else {
            let _ = stop_owned(owned);
            self.clear_request(&key);
            return Err("SSH input pipe is unavailable.".into());
        };
        let Some(stdout) = owned.child.stdout.take() else {
            drop(stdin);
            let _ = stop_owned(owned);
            self.clear_request(&key);
            return Err("SSH output pipe is unavailable.".into());
        };
        {
            let mut state = self.lock()?;
            if state.requested.as_ref() != Some(&key) || self.quitting.load(Ordering::SeqCst) {
                drop(state);
                drop(stdin);
                drop(stdout);
                let _ = stop_owned(owned);
                return Err("Camera connection was cancelled.".into());
            }
            state.owned = Some(owned);
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let session_id = key.session_id.clone();
        std::thread::spawn(move || {
            let result = negotiate(stdin, BufReader::new(stdout), offer_json, &session_id);
            let _ = sender.send(result);
        });
        let result = receiver.recv_timeout(ANSWER_TIMEOUT).map_err(|_| "The Pi did not answer within 60 seconds. Check its SSH access, daemon, camera, and microphone.".to_string()).and_then(|result| result);
        let negotiated = match result {
            Ok(negotiated) => negotiated,
            Err(error) => {
                self.clear_request(&key);
                return Err(error);
            }
        };
        let mut state = self.lock()?;
        if state.requested.as_ref() != Some(&key) {
            return Err("Camera connection was cancelled.".into());
        }
        let owned = state
            .owned
            .as_mut()
            .ok_or("Camera connection was cancelled.")?;
        if owned
            .child
            .try_wait()
            .map_err(|_| "Could not read SSH process status.")?
            .is_some()
        {
            drop(state);
            self.clear_request(&key);
            return Err("The Pi sender exited before the answer could be used.".into());
        }
        owned.stdin = Some(negotiated.stdin);
        owned._stdout = Some(negotiated.stdout);
        Ok(negotiated.answer)
    }

    fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let owned = self.lock()?.cancel_session(session_id);
        if let Some(owned) = owned {
            stop_owned(owned)?;
        }
        Ok(())
    }

    fn status(&self) -> Result<CameraSessionStatus, String> {
        let mut state = self.lock()?;
        let exited = if let Some(owned) = state.owned.as_mut() {
            owned
                .child
                .try_wait()
                .map_err(|_| "Could not read SSH process status.")?
                .is_some()
        } else {
            false
        };
        if exited {
            state.owned.take();
            state.requested = None;
        }
        Ok(CameraSessionStatus {
            session_id: state.requested.as_ref().map(|key| key.session_id.clone()),
            connected: state
                .owned
                .as_ref()
                .is_some_and(|owned| owned.stdin.is_some()),
        })
    }

    pub fn shutdown(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        let owned = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.requested = None;
            state.owned.take()
        };
        if let Some(owned) = owned {
            let _ = stop_owned(owned);
        }
    }
}

#[tauri::command]
pub async fn connect_camera(
    connector: State<'_, CameraConnector>,
    offer: String,
    host: String,
    user: String,
    hd: Option<bool>,
) -> Result<String, String> {
    let connector = connector.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connector.connect(offer, host, user, hd.unwrap_or(false))
    })
    .await
    .map_err(|_| "Camera connection task failed.".to_string())?
}

#[tauri::command]
pub async fn disconnect_camera(
    connector: State<'_, CameraConnector>,
    session_id: String,
) -> Result<(), String> {
    let connector = connector.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connector.disconnect(&session_id))
        .await
        .map_err(|_| "Camera disconnect task failed.".to_string())?
}

#[tauri::command]
pub fn camera_session_status(
    connector: State<'_, CameraConnector>,
) -> Result<CameraSessionStatus, String> {
    connector.status()
}

pub async fn quit(app: AppHandle) {
    let connector = app.state::<CameraConnector>().inner().clone();
    if connector.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = tauri::async_runtime::spawn_blocking(move || connector.shutdown()).await;
    app.exit(0);
}

pub fn request_quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        quit(app).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_validation_rejects_option_shell_and_path_injection() {
        for host in [
            "",
            "-oProxyCommand=bad",
            "pi;whoami",
            "pi.local\n",
            "user@pi",
            "pi:22",
            "pi..local",
            "8.8.8.8",
            "192.168.1.999",
            "é.local",
        ] {
            assert!(validate_destination(host, "raspbaby").is_err());
        }
        for user in [
            "",
            "-root",
            "../root",
            "root;id",
            "root/name",
            "root\n",
            "root@other",
            "a name",
        ] {
            assert!(validate_destination("raspbaby.local", user).is_err());
        }
        for host in [
            "raspbaby.local",
            "pi",
            "PI-1.home.arpa",
            "192.168.1.5",
            "10.0.0.1",
            "172.31.255.254",
        ] {
            assert!(validate_destination(host, "raspbaby").is_ok());
        }
        assert!(validate_destination("172.32.0.1", "raspbaby").is_err());
        assert!(validate_destination(&format!("{}.local", "a".repeat(64)), "raspbaby").is_err());
        assert!(validate_destination("pi.local", &"a".repeat(33)).is_err());
    }

    #[test]
    fn ssh_command_is_key_only_fixed_capture_and_vga_by_default() {
        let args = ssh_arguments("pi.local", "raspbaby", false).unwrap();
        for required in [
            "-T",
            "-oBatchMode=yes",
            "-oStrictHostKeyChecking=yes",
            "-oPreferredAuthentications=publickey",
            "-oClearAllForwardings=yes",
            "-oPermitLocalCommand=no",
        ] {
            assert!(args.iter().any(|arg| arg == required));
        }
        assert_eq!(args[args.len() - 2], "raspbaby@pi.local");
        let remote = args.last().unwrap();
        assert!(remote.starts_with("/home/raspbaby/raspbaby-feasibility/target/debug/raspbaby-daemon --stdio-spike --video-device "));
        assert!(remote.contains(CAMERA_PATH));
        assert!(remote.ends_with("--audio-device plughw:CARD=Device,DEV=0"));
        assert!(!remote.contains("--hd"));
        assert!(ssh_arguments("pi.local", "raspbaby", true)
            .unwrap()
            .last()
            .unwrap()
            .contains("--stdio-spike --hd --video-device"));
    }

    #[test]
    fn stale_disconnect_and_completed_requests_cannot_replace_a_new_session() {
        let mut state = ConnectorState::default();
        let (old, _) = state.begin("old".into());
        let (new, _) = state.begin("new".into());
        state.cancel_session("old");
        state.take_matching(&old);
        assert_eq!(state.requested.as_ref(), Some(&new));
        state.cancel_session("new");
        assert!(state.requested.is_none());
        let (reused, _) = state.begin("new".into());
        state.take_matching(&new);
        assert_eq!(state.requested.as_ref(), Some(&reused));
    }

    #[test]
    fn answer_line_is_bounded_utf8_and_requires_newline() {
        assert_eq!(
            read_signaling_line(&mut io::Cursor::new(b"answer\r\nnext\n")).unwrap(),
            "answer"
        );
        for input in [
            vec![b'x'; MAX_MESSAGE_BYTES + 3],
            b"partial".to_vec(),
            vec![255, b'\n'],
            vec![],
        ] {
            assert!(read_signaling_line(&mut io::Cursor::new(input)).is_err());
        }
        let exact = format!("{}\n", "x".repeat(MAX_MESSAGE_BYTES));
        assert_eq!(
            read_signaling_line(&mut io::Cursor::new(exact))
                .unwrap()
                .len(),
            MAX_MESSAGE_BYTES
        );
    }
}
