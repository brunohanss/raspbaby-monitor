# Raspbaby Monitor — Implementation Plan

Version: 1.0
Status: Approved implementation specification
License: MIT
Primary language: Rust
Client language: TypeScript
Architecture: Local-first, edge processing, peer-to-peer media

## 1. Product Definition

Raspbaby Monitor is an open-source baby monitoring system.

It uses a Raspberry Pi with a USB webcam and microphone to
transmit live video and audio to Windows and Android devices
over a local Wi-Fi network.

The Raspberry Pi detects movement and audio activity.
Connected applications receive real-time events and play
configurable notifications.

The system does not require:
- An internet connection during normal operation.
- A cloud service.
- A user account.
- A database server.
- A subscription.
- A dedicated display on the Raspberry Pi.

The project must demonstrate production-quality Rust and
TypeScript engineering while remaining small and maintainable.

### 1.1 Primary objectives

P0 — Required:
- Live video from a USB webcam.
- Live microphone audio.
- Windows application.
- Android application.
- Automatic Raspberry Pi discovery.
- Secure device pairing.
- Basic motion detection.
- Motion-triggered notifications and sounds.
- Audio activity and crying-candidate alerts.
- Connection health monitoring.
- Automatic reconnection.
- Automatic startup after boot.
- Headless installation.
- Simulated camera for development.

P1 — Product improvements:
- Ready-to-flash Raspberry Pi image.
- Wi-Fi provisioning before first boot.
- Custom alert sound packs.
- Motion sensitivity adjustment.
- Detection-region configuration.
- Background operation on Windows.
- Performance and diagnostics dashboard.
- Automatic software update mechanism.

P2 — Optional extensions:
- Multiple camera support.
- Linux and macOS clients.
- Remote access through a VPN.
- Android background notifications.
- Advanced crying classification.
- Additional Raspberry Pi models.

### 1.2 Explicit exclusions

Do not implement:
- Cloud hosting.
- Remote internet streaming.
- Video recording.
- Video snapshots.
- Continuous audio recording.
- AI image recognition.
- Face recognition.
- Breathing or vital-sign monitoring.
- User registration.
- Subscription infrastructure.
- A persistent event history database.
- Docker as the primary installation method.

Detection events may be kept in a bounded in-memory buffer.
Do not persist images, audio, or raw media to storage.

### 1.3 Safety requirements

This product is a convenience monitor, not a medical device.

Never present motion or crying detection as guaranteed.

A missing alert does not prove that a baby is safe.

Connection loss must be visible and clearly distinguished
from normal inactivity.

The client must show the time of the last received heartbeat
and must never display an old video frame as live video.

Do not play alert sounds from the Raspberry Pi itself.
Play notification sounds only on client devices.

Do not expose the service to the public internet.

Do not assume that a trusted Wi-Fi network eliminates
the need for authentication.

---

## 2. Target Hardware

### 2.1 Raspberry Pi

Initial target:
- Raspberry Pi 4 Model B.
- 1 GB RAM.
- ARM64 processor.
- Built-in Wi-Fi.
- USB webcam.
- USB or integrated webcam microphone.
- MicroSD card, minimum 16 GB.
- Raspberry Pi OS Lite 64-bit.

Use Debian 13 / Raspberry Pi OS Trixie as the initial
tested operating-system baseline.

Pin a specific tested OS image release and checksum
in the build configuration.

Do not silently switch OS major versions.

### 2.2 Camera compatibility

The webcam model is not known.

Use Linux Video4Linux2 (V4L2) for USB camera discovery
and video capture.

Use ALSA for microphone discovery and audio capture.

Camera discovery must report:
- Device name.
- Stable device identifier, when available.
- Supported video formats.
- Supported resolutions.
- Supported frame rates.
- Microphone availability.
- Supported audio formats.

Prefer stable /dev/v4l/by-id paths when available.

Do not rely on /dev/video0 remaining constant.

### 2.3 Video format selection

Prefer, in order:
1. Native H.264 capture when supported.
2. Native MJPEG capture with efficient H.264 conversion.
3. Raw YUYV capture with H.264 encoding.

For the WebRTC implementation, use H.264 as the preferred
video codec.

Audio should use Opus.

Start with:
- Resolution: 1280 × 720.
- Frame rate: 15 FPS.
- Target bitrate: 1.5 Mbps.
- Audio: 48 kHz, mono, Opus.
- Audio bitrate: approximately 32 kbps.

These are initial configuration values, not guaranteed
hardware capabilities.

If the webcam or Raspberry Pi cannot sustain these
settings, select 640 × 480 at 15 FPS.

Do not assume Raspberry Pi hardware encoding is available
through the selected GStreamer pipeline.

Detect and benchmark actual encoder availability.

### 2.4 Performance targets

Target:
- Video latency: less than 500 ms on stable local Wi-Fi.
- Motion notification latency: less than 1 second.
- Audio/video synchronization error: less than 150 ms.
- Idle Pi CPU usage: less than 10%, excluding capture.
- Streaming CPU usage: preferably less than 40%.
- Total application memory: preferably less than 250 MB.
- No unbounded buffers or memory growth.

These are validation targets, not hard assumptions.

Measure P50 and P95 latency under realistic conditions.

Test with one and two concurrent clients.

Do not sacrifice stability merely to reach a benchmark.

---

## 3. Architecture

### 3.1 System components

Raspberry Pi:
- raspbaby-daemon
- raspbaby-media
- raspbaby-detection
- raspbaby-protocol
- raspbaby-install

Windows/Android:
- Raspbaby Tauri application
- React frontend
- Shared TypeScript API client
- WebRTC receiver
- Notification engine

Development:
- Simulated video/audio source
- Simulated motion events
- Network failure simulator
- Automated tests

### 3.2 Logical architecture

Raspberry Pi
  |
  +-- Camera / V4L2
  |     |
  |     +-- Capture pipeline
  |           |
  |           +-- WebRTC video
  |           |
  |           +-- Low-resolution motion analysis
  |
  +-- Microphone / ALSA
  |     |
  |     +-- WebRTC audio
  |     |
  |     +-- Audio activity detection
  |
  +-- Rust daemon
        |
        +-- Device discovery
        +-- Pairing and authentication
        +-- WebSocket control channel
        +-- WebRTC signaling
        +-- Event broadcasting
        +-- Health monitoring
        +-- Configuration management

Local Wi-Fi
  |
  +-- Windows Tauri client
  |
  +-- Android Tauri client

### 3.3 Primary technology choices

Server:
- Rust stable.
- Tokio.
- Axum.
- Serde.
- Tracing.
- GStreamer.
- GStreamer WebRTC components.
- Rustls where practical.
- SQLite: not required.

Client:
- Tauri 2.
- React.
- TypeScript strict mode.
- Vite.
- Tailwind CSS.
- Zustand for limited UI state.
- Native WebRTC APIs.
- Tauri secure storage integration.

Testing:
- Rust unit tests.
- Cargo Clippy.
- Cargo Fmt.
- Vitest.
- React Testing Library.
- Playwright for Windows-facing UI tests.
- Android emulator tests.
- GitHub Actions.

### 3.4 Media transport

Use WebRTC for live video and audio.

Reason:
- Low latency.
- Browser/WebView compatibility.
- Built-in media encryption.
- Audio/video synchronization.
- Native jitter management.
- Support for multiple receiving clients.

Use GStreamer webrtcbin as the initial integration target.

Use GStreamer Rust bindings to manage the pipeline.

Do not implement:
- Custom RTP.
- Custom video encoding.
- Custom congestion control.
- Custom WebRTC encryption.

GStreamer must handle media operations.

Rust must handle the application and control logic.

### 3.5 Mandatory media feasibility spike

Before implementing the full application:

1. Inspect the installed GStreamer plugins on the Pi.
2. Confirm that V4L2 can capture video.
3. Confirm that ALSA can capture microphone audio.
4. Validate H.264 encoding or camera-native H.264.
5. Validate Opus encoding.
6. Create a minimal WebRTC stream.
7. Receive it in Windows WebView2.
8. Receive it in Android WebView.
9. Test audio/video synchronization.
10. Measure CPU and RAM usage.

The spike must produce a working prototype and benchmarks.

The agent must not build the rest of the system before
the media pipeline is validated.

If the selected GStreamer pipeline fails, investigate
its actual failure before changing architecture.

If compatibility is not achievable, create an architecture
decision record comparing alternative media engines.

Do not silently replace WebRTC with an insecure HTTP stream.

### 3.6 Streaming sessions

Each authorized client creates its own WebRTC peer connection.

Share a camera capture source between clients when possible.

Do not open the USB camera independently for each client.

Limit the initial implementation to two concurrent clients.

On client disconnect:
- Close the peer connection.
- Release session resources.
- Keep the camera service running.
- Notify the application of the disconnection.

Support reconnection without restarting the daemon.

### 3.7 Media encryption and authentication

WebRTC media must use DTLS-SRTP.

The signaling and control channel must also be authenticated
and protected against interception on the local network.

Use TLS for the control channel.

Generate a unique device identity on first boot.

Store the device private key with restrictive permissions.

During pairing, establish a trusted client identity.

Store trusted client credentials in OS secure storage.

Do not expose an unauthenticated WebRTC signaling endpoint.

Do not allow unauthenticated clients to start a media session.

Implement certificate or public-key pinning for device identity.

Document certificate renewal and key rotation behavior.

---

## 4. Device Discovery and Pairing

### 4.1 Discovery

Use mDNS/DNS-SD.

Default hostname:
raspbaby.local

Default service:
_raspbaby._tcp.local

The service advertisement should include:
- Protocol version.
- Device ID.
- Friendly device name.
- Control port.
- Pairing state.

Do not include:
- Pairing secrets.
- Wi-Fi credentials.
- Authentication tokens.
- Camera access credentials.

The client must support manual IP address entry as a fallback.

Device discovery must work without internet access.

### 4.2 Pairing flow

Initial state:
UNPAIRED

The Raspberry Pi must generate:
- Unique device identity.
- Cryptographic key pair.
- Random one-time pairing secret.

Preferred provisioning path:
The flash utility creates a unique pairing secret before
writing the image.

The secret is injected into a protected provisioning
configuration and displayed to the user.

The application may scan a QR code containing:
- Device ID.
- Pairing secret.
- Optional connection metadata.

The QR code must not contain Wi-Fi credentials.

A generic downloadable image must not contain a shared,
hardcoded pairing secret.

### 4.3 Pairing protocol

The pairing protocol must prove possession of the pairing
secret without transmitting the secret as a reusable password.

Use a reviewed PAKE protocol such as SPAKE2 where feasible.

The server must bind the pairing result to its device
identity and the client public key.

Do not invent a custom cryptographic handshake.

Pairing sequence:

1. Client discovers the Raspberry Pi.
2. Client connects to the pairing endpoint.
3. Client verifies the device identity using provisioning
   information where available.
4. Client proves possession of the pairing secret.
5. Server verifies the pairing request.
6. Client generates or registers its trusted identity.
7. Server stores the authorized client public key.
8. Client stores its trusted credentials.
9. Server invalidates the one-time pairing secret.
10. Client establishes an authenticated control session.

Support multiple trusted clients.

### 4.4 Pairing recovery

Provide a local administrative command:

raspbabyctl pairing reset

This command must:
- Require local root or authorized administrator access.
- Generate a new pairing secret.
- Invalidate pending pairing requests.
- Keep existing trusted clients unless explicit revocation
  is requested.
- Display the new pairing secret locally.

Also provide:

raspbabyctl clients list
raspbabyctl clients revoke <client-id>
raspbabyctl clients revoke-all

Do not implement a remote unauthenticated pairing reset.

### 4.5 Pairing security tests

Test:
- Valid pairing secret.
- Invalid pairing secret.
- Expired pairing secret.
- Reused pairing secret.
- Concurrent pairing attempts.
- Unauthorized media request.
- Revoked client credentials.
- Device identity mismatch.
- Reconnection after pairing.
- Certificate rotation and recovery.

---

## 5. Control Protocol

### 5.1 Transport

Use:
- HTTPS for basic configuration and health endpoints.
- Authenticated WebSocket for real-time events.
- WebRTC signaling messages through the authenticated
  control connection.

Use a single application control port where practical.

Default TCP control port:
8765

The exact ICE media ports must be documented and restricted
to the local network.

Do not make media ports accessible from the WAN.

### 5.2 HTTP endpoints

GET /api/v1/health

Return:
- Service status.
- Protocol version.
- Uptime.
- Camera availability.
- Microphone availability.
- Streaming subsystem status.

GET /api/v1/device

Return:
- Device ID.
- Device name.
- Device model.
- Software version.
- Supported capabilities.

GET /api/v1/config

Return non-secret configuration.

PATCH /api/v1/config

Modify supported settings.

POST /api/v1/pairing/start

Begin a secure pairing exchange.

POST /api/v1/pairing/complete

Complete the pairing exchange.

GET /api/v1/diagnostics

Return operational diagnostics.

All endpoints except the minimum pairing bootstrap
and limited health discovery must require authentication.

Do not expose confidential diagnostics to unauthenticated
clients.

### 5.3 WebSocket events

Use versioned, typed JSON messages.

Event envelope fields:
- protocol_version
- type
- event_id
- timestamp
- payload

Define the following events:

device.status
camera.status
audio.status
motion.detected
motion.ended
audio.activity
audio.cry_candidate
stream.started
stream.stopped
stream.error
system.warning
system.heartbeat
webrtc.offer
webrtc.answer
webrtc.ice_candidate

Include WebRTC session IDs in signaling messages.

Use UTC timestamps in ISO 8601 format.

### 5.4 Event delivery

Use Tokio broadcast channels for the event bus.

Use bounded channel capacity.

Do not retain an unbounded event queue.

If the client misses events:
- Report the number of dropped events.
- Send the current device state.
- Continue from the latest state.

Motion events are best-effort.

Health monitoring must not depend on successful motion
event delivery.

### 5.5 Protocol compatibility

Use an explicit protocol version.

The client must reject unsupported major protocol versions.

The server must ignore unknown optional fields where safe.

Generate or validate TypeScript protocol types against
the Rust schema.

Avoid maintaining unrelated manually duplicated contracts.

---

## 6. Motion Detection

### 6.1 Processing strategy

Use a separate low-resolution analysis stream.

Do not process the full-resolution video stream for motion
detection.

Initial analysis settings:
- Width: 320 pixels.
- Height: 180 pixels.
- Analysis frame rate: 5 FPS.
- Grayscale image.
- Configurable detection region.

Use frame differencing.

Do not use machine learning for the initial version.

### 6.2 Algorithm

For each analysis frame:

1. Convert the frame to grayscale.
2. Apply a small Gaussian blur.
3. Compare the frame with the previous reference frame.
4. Calculate absolute pixel differences.
5. Apply a configurable difference threshold.
6. Exclude pixels outside the detection region.
7. Calculate the percentage of changed pixels.
8. Update the motion confidence using temporal smoothing.
9. Evaluate the motion state.
10. Emit a state transition when required.

Use an exponential moving average to reduce noise.

Detect sudden full-frame brightness changes.

Suppress probable camera exposure changes rather than
treating them automatically as baby movement.

The initial implementation does not need OpenCV.

Prefer a small, testable Rust implementation using
image buffers and standard numerical operations.

### 6.3 Motion states

States:
- IDLE
- MOTION_CANDIDATE
- MOTION_ACTIVE
- COOLDOWN

IDLE:
No meaningful movement detected.

MOTION_CANDIDATE:
Movement is detected but not yet confirmed.

MOTION_ACTIVE:
Sustained movement exceeds the confirmation threshold.

COOLDOWN:
Motion has ended and duplicate notifications are suppressed.

### 6.4 Initial motion defaults

Analysis rate: 5 FPS.
Changed-pixel threshold: configurable.
Motion confirmation: 600 ms.
Motion end delay: 2 seconds.
Alert cooldown: 30 seconds.

Initial sensitivity:
Medium.

Store sensitivity as a user-friendly value from 0 to 100.

Internally map sensitivity to detection thresholds.

Document the mapping.

All values must be configurable and validated.

### 6.5 Detection region

Support one rectangular region of interest.

Default:
Entire frame.

Allow the user to draw and resize the region on the
video preview.

Represent coordinates as normalized values from 0 to 1.

Persist the region on the Raspberry Pi.

This feature prevents movement outside the crib from
triggering unnecessary alerts.

### 6.6 Testing

Use deterministic synthetic sequences:
- No movement.
- Small object movement.
- Large movement.
- Sudden brightness change.
- Gradual brightness change.
- Camera noise.
- Motion near frame edges.
- Motion outside the configured region.
- Camera disconnect during movement.

Assert expected state transitions.

Measure false-positive behavior.

Do not claim reliable baby-specific detection.

---

## 7. Audio Monitoring

### 7.1 Live audio

Capture audio from ALSA.

Encode using Opus.

Transmit audio through WebRTC.

Play audio through the client's selected output device.

Support:
- Mute/unmute.
- Output volume.
- Audio connection status.

Do not add audio talkback.

### 7.2 Audio activity detection

Calculate audio RMS over short windows.

Initial window:
100 ms.

Maintain an adaptive noise floor.

Detect sustained audio above the noise floor.

Provide:
- Audio level indicator.
- Noise activity indicator.
- Configurable sensitivity.

Perform analysis on the Pi.

Do not transmit raw audio samples through WebSocket.

### 7.3 Crying-candidate detection

The initial implementation must not promise reliable
cry recognition.

Use sustained audio activity and a configurable
duration threshold as a simple crying-candidate heuristic.

Default:
- Sustained elevated audio: 3 seconds.
- Alert cooldown: 60 seconds.

Label the event:
"Possible crying / sustained sound"

Do not label it as confirmed crying.

Allow users to disable this feature.

Separate future sound classification work from the MVP.

### 7.4 Audio tests

Test:
- Silence.
- Constant background noise.
- Short isolated sound.
- Sustained loud sound.
- Changing noise floor.
- Missing microphone.
- Microphone reconnection.
- Audio channel errors.

The system must continue video monitoring if the
microphone becomes unavailable.

---

## 8. Alert Engine

### 8.1 Alert architecture

Detect events on the Raspberry Pi.

Decide which sound to play on the receiving client.

Separate:
- Detection.
- Event transmission.
- Notification policy.
- Sound playback.

This separation must allow the alert engine to work
with simulated events.

### 8.2 Alert levels

INFO:
Low-priority activity.

MOTION:
Confirmed movement.

AUDIO:
Sustained audio activity.

WARNING:
Camera or microphone failure.

CRITICAL:
Monitor connection lost.

Connection-failure alerts must not share the same cooldown
as motion alerts.

### 8.3 Sound profiles

Provide three initial profiles.

Gentle:
- Quiet original chime.
- Minimal interruption.

Classic:
- Short original alert.
- Medium volume.

Dramatic:
- Funny, exaggerated cinematic-style alert.
- Adjustable volume.
- Optional stronger sound for repeated activity.

Use original or appropriately licensed audio assets.

Do not bundle copyrighted film sound effects.

Allow users to import their own audio files.

Imported audio remains local to the client.

Supported formats:
- WAV.
- MP3.
- OGG, if supported consistently by target runtimes.

### 8.4 Alert behavior

Support:
- Enable/disable motion alerts.
- Enable/disable audio alerts.
- Sound profile selection.
- Individual event sound selection.
- Notification volume.
- Alert cooldown.
- Temporary mute.
- Test sound.
- Notification history for the current session.

Do not require notification permission for in-app sound.

Use native OS notifications where supported.

### 8.5 Windows behavior

When the application window is open:
- Show toast or in-app notification.
- Play configured sound.

When minimized to tray:
- Keep the monitoring service active.
- Receive events.
- Display native notification.
- Play configured sound.

On application exit:
- Stop monitoring.
- Do not claim that alerts remain active.

### 8.6 Android behavior

Initial version:
- Monitor while the application remains active.
- Play sounds while the application is active.
- Show in-app notifications.

Android screen-lock and background monitoring are
not guaranteed or supported in the MVP.

Display this limitation clearly.

Do not implement Firebase Cloud Messaging.

Do not promise alerts when the Android process is stopped.

### 8.7 Notification deduplication

Prevent duplicate alerts from repeated WebSocket messages.

Use event_id for deduplication.

Keep a bounded set of recent event identifiers.

Apply cooldown per alert category.

Reset transient notification state on a fresh session
while preserving user settings.

---

## 9. Tauri Application

### 9.1 Shared application

Use one Tauri 2 project for:
- Windows.
- Android.

Reuse React UI components and TypeScript logic.

Implement platform-specific behavior only when necessary.

Keep platform-specific code behind explicit interfaces.

### 9.2 Application screens

Screen 1: Device discovery

Show:
- Discovered Raspberry Pi devices.
- Friendly device names.
- Connection availability.
- Add device by IP.
- Pairing action.

Screen 2: Pairing

Show:
- QR code scanning option on Android.
- Manual pairing secret entry.
- Connection progress.
- Security errors.
- Pairing success state.

Screen 3: Live monitor

Main screen.

Show:
- Large live video view.
- Current connection state.
- Audio mute control.
- Audio level indicator.
- Motion indicator.
- Camera name.
- Monitoring duration.
- Alert controls.
- Settings access.

Keep the interface minimal.

Screen 4: Settings

Sections:
- Device.
- Camera.
- Motion.
- Audio.
- Alerts.
- Security.
- Diagnostics.

Screen 5: Diagnostics

Show:
- Device uptime.
- Video FPS.
- Video bitrate.
- WebRTC connection state.
- Network round-trip time.
- Packet loss, when available.
- Raspberry Pi CPU.
- Raspberry Pi RAM.
- Raspberry Pi temperature.
- Camera health.
- Microphone health.

### 9.3 UI design

Design direction:
- Clean.
- Warm.
- Modern.
- Minimal.
- Slightly playful.

Default theme:
Dark mode.

Suggested palette:
- Background: #10141B.
- Surface: #1A202A.
- Primary: #8DB7FF.
- Accent: #B9A7FF.
- Success: #68D6B0.
- Warning: #F2C078.
- Error: #EF7777.
- Text: #F5F7FA.
- Secondary text: #A5B0BF.

Do not use a complicated component framework.

Use Tailwind CSS and a small design token system.

Prioritize the video area over decorative UI.

### 9.4 Client state management

Use Zustand for:
- Selected device.
- Device connection state.
- Monitoring status.
- Notification preferences.
- UI settings.

Do not put WebRTC frame data in React state.

Keep the WebRTC session in a dedicated service.

Use typed interfaces.

### 9.5 Reconnection strategy

On connection loss:
1. Mark stream unavailable immediately.
2. Stop displaying the previous frame as live.
3. Show a visible disconnection warning.
4. Attempt reconnection with exponential backoff.
5. Reauthenticate using stored client credentials.
6. Restart signaling and WebRTC negotiation.
7. Resume the stream.
8. Clear the disconnected state only after actual recovery.

Initial retry delays:
1, 2, 4, 8, 15 seconds.

Maximum delay:
15 seconds.

Add bounded jitter.

Do not loop continuously without delays.

Show the elapsed time since the last heartbeat.

---

## 10. Raspberry Pi Installation

### 10.1 Installation goals

The final user experience must be:

1. Download Raspbaby.
2. Insert microSD card into a computer.
3. Enter Wi-Fi name and password.
4. Flash microSD card.
5. Insert the card into the Raspberry Pi.
6. Connect the webcam.
7. Power on the Raspberry Pi.
8. Open Raspbaby on Windows or Android.
9. Discover and pair the device.
10. Start monitoring.

No keyboard or display is required on the Raspberry Pi.

No SSH interaction is required in the final installation flow.

### 10.2 Installation approach

Implement two installation methods.

Method A:
Official Raspberry Pi OS + one-command installer.

Method B:
Ready-to-flash Raspbaby OS image.

Method A is developed first.

Method B is the final product experience.

Both methods must install the same service binaries,
configuration format and systemd units.

### 10.3 Method A — Standard Raspberry Pi OS

Use Raspberry Pi Imager.

Select:
Raspberry Pi OS Lite 64-bit.

Configure:
- Hostname: raspbaby
- Username: operator-defined
- Password: operator-defined
- Wi-Fi SSID
- Wi-Fi password
- Wi-Fi regulatory country
- Time zone
- SSH enabled for initial administration

After boot, execute the documented installation command
over SSH.

The installation script must:
1. Detect the operating system.
2. Detect ARM64 architecture.
3. Verify required disk space.
4. Install pinned runtime dependencies.
5. Download verified Raspbaby binaries.
6. Create the service user.
7. Create configuration directories.
8. Install systemd service files.
9. Configure device permissions.
10. Generate device identity if missing.
11. Initialize pairing.
12. Enable and start services.
13. Run health checks.
14. Display pairing instructions.

Do not use an unverified remote shell script.

Use versioned release assets and checksum verification.

### 10.4 Method B — Ready-to-flash image

Use Raspberry Pi rpi-image-gen as the preferred image
generation system.

Generate a customized Raspberry Pi OS Lite image.

The image must contain:
- Raspberry Pi OS Lite.
- Raspbaby daemon.
- Media runtime dependencies.
- Systemd service.
- Device configuration.
- First-boot provisioning service.
- Network provisioning integration.
- Recovery utilities.

The image must not contain:
- User Wi-Fi credentials.
- Shared private device keys.
- Default reusable pairing credentials.
- Developer SSH keys.
- Build-time secrets.
- Personal test data.

The image must be generated reproducibly.

Record:
- Base image version.
- Dependency versions.
- Binary checksums.
- Build commit.
- Build date.

### 10.5 Wi-Fi provisioning

Preferred solution:
Pre-flash provisioning on the user's computer.

The provisioning workflow collects:
- Wi-Fi SSID.
- Wi-Fi password.
- Country.
- Optional device name.

The application must not transmit these values to an
external server.

The provisioning utility must write the values directly
to the selected removable microSD card or its image.

Use NetworkManager-compatible Wi-Fi configuration on
the target Raspberry Pi OS release.

Do not depend on legacy wpa_supplicant.conf behavior.

Use the supported Raspberry Pi OS provisioning mechanism
when available.

If a custom first-boot configuration format is needed:
- Define a versioned provisioning schema.
- Store it only in a controlled first-boot location.
- Restrict access to configuration secrets.
- Apply it exactly once.
- Remove temporary plaintext provisioning files.
- Preserve the operational NetworkManager connection.
- Never log the Wi-Fi password.

Do not claim that deleting a temporary file securely erases
it from flash storage.

Do not store the Wi-Fi password in the Git repository.

### 10.6 Provisioning utility

Build a lightweight desktop provisioning utility.

It may initially be a command-line utility.

The final Windows UI should provide:
- Image selection or download.
- Removable device selection.
- Wi-Fi configuration.
- Device name.
- Image verification.
- Flash confirmation.
- Progress.
- Pairing QR code.
- Completion instructions.

Strongly prefer reusing Raspberry Pi Imager capabilities
instead of implementing disk flashing from scratch.

If integration with the Imager is insufficient, keep the
flashing utility separate from the monitoring application.

Never erase a drive without explicit confirmation.

Show:
- Device model.
- Capacity.
- Drive identifier.
- Destructive operation warning.

Exclude system drives by default.

Only allow deliberate removable-device selection.

### 10.7 Pairing secret provisioning

The provisioning utility generates a cryptographically
random one-time pairing secret.

It writes the required secret material into the image
using the defined secure provisioning format.

It displays a QR code that can be scanned by the mobile app.

It also provides a manual recovery code.

Do not store the Wi-Fi password in the QR code.

For a generic image without a provisioning utility,
pairing must remain disabled until a unique secret is
generated and obtained through a local administrative
recovery path.

Never use a published default pairing code.

### 10.8 First boot

On first boot:

1. Expand the root filesystem if required.
2. Apply the supplied network configuration.
3. Generate device cryptographic identity.
4. Initialize protected configuration storage.
5. Import the one-time pairing secret.
6. Delete the temporary provisioning file.
7. Start the Raspbaby daemon.
8. Discover the webcam and microphone.
9. Advertise the device over mDNS.
10. Enter the UNPAIRED state.
11. Wait for authorized pairing.

The service must not fail permanently when the camera
is absent during startup.

Continue to advertise the device.

Show camera unavailability in the client.

### 10.9 Failed Wi-Fi configuration

Do not implement a hotspot in the first release.

Provide a documented recovery process:

Option 1:
Reflash the card with corrected credentials.

Option 2:
Attach Ethernet and use the local administration tools.

Option 3:
Edit the Wi-Fi configuration through a supported
provisioning process.

The project should be structured to support an optional
temporary setup hotspot later.

### 10.10 systemd

Create a systemd service:

raspbaby.service

Requirements:
- Start after relevant local system services.
- Do not require external internet connectivity.
- Restart on unexpected failure.
- Apply restart rate limits.
- Run under a dedicated non-root account.
- Restrict filesystem access.
- Restrict device permissions.
- Use systemd hardening directives where compatible.
- Support graceful shutdown.
- Write structured logs to journald.

The service should start when the camera is absent
and retry camera discovery.

Avoid restart storms.

### 10.11 Updates

Initial update method:
Manual installation of a verified new release.

The update process must:
- Verify the artifact checksum.
- Stop the service safely.
- Preserve configuration and trusted clients.
- Install the new binary.
- Restart the service.
- Check health.
- Roll back the binary on failed startup when practical.

Do not enable automatic unattended feature updates
in the MVP.

Security maintenance procedures must be documented.

---

## 11. Configuration Management

### 11.1 Configuration files

System configuration:
 /etc/raspbaby/config.toml

Protected credentials:
 /var/lib/raspbaby/identity/

Application data:
 /var/lib/raspbaby/

Logs:
 systemd journal

### 11.2 Configuration fields

[device]
name
device_id

[video]
device
resolution
fps
bitrate
preferred_codec

[audio]
device
enabled
activity_enabled
cry_candidate_enabled
activity_sensitivity

[motion]
enabled
sensitivity
analysis_fps
confirmation_ms
cooldown_ms
region

[network]
control_port
discovery_enabled
max_clients

[security]
pairing_enabled
trusted_clients_limit

### 11.3 Configuration validation

Reject:
- Invalid port numbers.
- Negative frame rates.
- Unsupported resolutions.
- Motion regions outside valid coordinates.
- Out-of-range sensitivity.
- Invalid timeouts.
- Unknown required schema versions.

Use typed Rust configuration structures.

Return actionable error messages.

Prefer safe defaults over implicit silent behavior.

---

## 12. Repository Structure

raspbaby-monitor/
|
+-- Cargo.toml
+-- Cargo.lock
+-- package.json
+-- pnpm-lock.yaml
+-- README.md
+-- LICENSE
+-- CONTRIBUTING.md
+-- SECURITY.md
+-- CHANGELOG.md
+-- .editorconfig
+-- .gitignore
|
+-- crates/
|   |
|   +-- raspbaby-daemon/
|   |   +-- src/
|   |   +-- tests/
|   |
|   +-- raspbaby-media/
|   |   +-- src/
|   |   +-- tests/
|   |
|   +-- raspbaby-detection/
|   |   +-- src/
|   |   +-- tests/
|   |
|   +-- raspbaby-protocol/
|   |   +-- src/
|   |   +-- tests/
|   |
|   +-- raspbaby-cli/
|       +-- src/
|
+-- apps/
|   |
|   +-- monitor/
|   |   +-- src/
|   |   |   +-- components/
|   |   |   +-- screens/
|   |   |   +-- hooks/
|   |   |   +-- services/
|   |   |   +-- stores/
|   |   |   +-- styles/
|   |   |   +-- types/
|   |   |
|   |   +-- src-tauri/
|   |   +-- package.json
|   |
|   +-- provisioner/
|       +-- src/
|       +-- src-tauri/
|
+-- packages/
|   +-- protocol-client/
|   +-- ui/
|
+-- assets/
|   +-- sounds/
|   +-- icons/
|
+-- packaging/
|   +-- systemd/
|   +-- installer/
|   +-- image/
|   +-- provisioning/
|
+-- simulator/
|   +-- fixtures/
|   +-- scenarios/
|
+-- tests/
|   +-- integration/
|   +-- network/
|   +-- performance/
|
+-- docs/
|   +-- architecture.md
|   +-- installation.md
|   +-- pairing.md
|   +-- security.md
|   +-- troubleshooting.md
|   +-- protocol.md
|   +-- performance.md
|   +-- development.md
|   +-- decisions/
|
+-- .github/
    +-- workflows/
    +-- ISSUE_TEMPLATE/

Do not create empty directories without an immediate use.

Prefer clear module boundaries over unnecessary abstractions.

---

## 13. Development Workflow

### 13.1 Local development

Develop the Rust daemon on Windows or Linux when possible.

Hardware-dependent camera capture must be behind
an interface.

Create a simulated media source.

The simulator must support:
- Synthetic video.
- Synthetic audio.
- Deterministic motion.
- Noise.
- Camera disconnect.
- Microphone disconnect.
- Reconnection.
- Network delay.
- Packet loss scenarios.

The Tauri application must be usable without a real Pi
during development.

### 13.2 Minimum development commands

Provide documented commands for:
- Starting the simulator.
- Running the Rust daemon.
- Starting the Tauri development application.
- Running Rust tests.
- Running frontend tests.
- Running integration tests.
- Building Windows.
- Building Android.
- Building ARM64 daemon.
- Building the Raspberry Pi image.

Use one package manager for the frontend.

Preferred:
pnpm.

Keep the root commands consistent across platforms.

### 13.3 Code quality

Rust:
- cargo fmt.
- cargo clippy.
- cargo test.
- cargo deny or equivalent dependency auditing.

TypeScript:
- strict mode.
- ESLint.
- Prettier.
- Vitest.
- Type checking.

Do not suppress compiler warnings without justification.

Avoid unnecessary unsafe Rust.

Any unsafe code must include a documented safety rationale.

---

## 14. Implementation Backlog

All tasks must have:
- A unique identifier.
- A clear implementation scope.
- Dependencies.
- Acceptance criteria.
- Automated tests where practical.

### Phase 0 — Research and Feasibility

RB-001 — Validate Raspberry Pi environment

Tasks:
- Confirm ARM64 operating system.
- Check available memory.
- Check USB camera capabilities.
- Check microphone capabilities.
- Verify network connectivity.
- Record tested operating-system release.

Acceptance criteria:
- Hardware capability report generated.
- Device paths documented.
- Unsupported formats identified.

RB-002 — Validate media pipeline

Tasks:
- Build minimal GStreamer video capture.
- Build minimal microphone capture.
- Encode H.264 and Opus.
- Send media through WebRTC.
- Receive media on Windows.
- Receive media on Android.
- Measure basic CPU and memory usage.

Acceptance criteria:
- Video and audio play on both platforms.
- No uncontrolled memory growth.
- Media startup and reconnection tested.
- Feasibility report added to docs.

RB-003 — Record architecture decisions

Tasks:
- Document media implementation.
- Document authentication approach.
- Document provisioning approach.
- Document known performance limitations.

Acceptance criteria:
- ADR documents exist.
- Major engineering decisions have evidence.

### Phase 1 — Repository Foundation

RB-010 — Create Rust workspace

Tasks:
- Initialize workspace.
- Create protocol crate.
- Create daemon crate.
- Create media crate.
- Create detection crate.

Acceptance criteria:
- Workspace builds.
- Unit tests execute.
- Clippy succeeds.

RB-011 — Create Tauri application

Tasks:
- Initialize Tauri 2.
- Add React and TypeScript.
- Configure Tailwind.
- Configure Windows target.
- Configure Android target.
- Create base navigation.

Acceptance criteria:
- Windows app starts.
- Android app starts.
- Shared React UI renders on both.

RB-012 — Configure CI

Tasks:
- Rust quality checks.
- Frontend quality checks.
- Unit tests.
- Build smoke tests.
- Dependency auditing.

Acceptance criteria:
- Pull requests execute CI.
- Failed checks block merging.

### Phase 2 — Streaming

RB-020 — Implement camera discovery

Tasks:
- Enumerate V4L2 devices.
- Read supported capture formats.
- Select capture configuration.
- Handle absent devices.

Acceptance criteria:
- USB camera is discovered.
- Supported formats are displayed.
- Camera removal does not crash the daemon.

RB-021 — Implement microphone discovery

Tasks:
- Enumerate ALSA inputs.
- Select input device.
- Detect microphone availability.

Acceptance criteria:
- Microphone is detected.
- Invalid audio device is reported safely.

RB-022 — Implement WebRTC signaling

Tasks:
- Define typed signaling protocol.
- Implement offer/answer exchange.
- Implement ICE candidate exchange.
- Manage peer connection lifecycle.
- Require authorization before session creation.

Acceptance criteria:
- Authorized client can establish a stream.
- Unauthorized client cannot establish a stream.
- Disconnect releases peer resources.

RB-023 — Implement live monitoring

Tasks:
- Build video pipeline.
- Build audio pipeline.
- Display video in Tauri.
- Play microphone audio.
- Support mute.

Acceptance criteria:
- Video and audio operate concurrently.
- No persistent media files are created.
- Two-client test passes within hardware limits.

### Phase 3 — Detection

RB-030 — Implement motion analysis

Tasks:
- Downsample camera frames.
- Convert to grayscale.
- Compute frame differences.
- Calculate motion score.
- Apply temporal smoothing.

Acceptance criteria:
- Synthetic motion is detected.
- Static frames do not generate repeated alerts.
- Motion analysis operates independently from streaming.

RB-031 — Implement motion state machine

Tasks:
- Add candidate state.
- Add active state.
- Add cooldown.
- Emit start/end events.

Acceptance criteria:
- State transitions are deterministic.
- Duplicate events are controlled.
- Unit tests cover every transition.

RB-032 — Implement audio activity analysis

Tasks:
- Calculate RMS.
- Track noise floor.
- Detect sustained activity.
- Emit audio activity events.

Acceptance criteria:
- Sustained sound produces an event.
- Short noise is filtered as configured.
- Audio detection can be disabled.

RB-033 — Implement detection configuration

Tasks:
- Configure sensitivity.
- Configure region of interest.
- Configure cooldowns.
- Persist settings on Pi.

Acceptance criteria:
- Settings survive reboot.
- Invalid settings are rejected.
- Changes affect subsequent detection events.

### Phase 4 — Control and Security

RB-040 — Implement device discovery

Tasks:
- Advertise DNS-SD service.
- Discover devices from Windows.
- Discover devices from Android.
- Add manual address fallback.

Acceptance criteria:
- Device appears without manual IP entry.
- Manual IP entry works when mDNS fails.

RB-041 — Implement secure pairing

Tasks:
- Generate unique device identity.
- Implement PAKE pairing.
- Register client public key.
- Persist trusted clients.
- Protect stored secrets.

Acceptance criteria:
- Correct secret enables pairing.
- Incorrect secret is rejected.
- Reused secret is rejected.
- No hardcoded pairing secrets exist.

RB-042 — Implement authorization

Tasks:
- Authenticate client sessions.
- Authorize configuration access.
- Authorize WebRTC signaling.
- Authorize event subscriptions.
- Support client revocation.

Acceptance criteria:
- Unpaired clients cannot access media.
- Revoked clients lose access.
- Security integration tests pass.

RB-043 — Implement health monitoring

Tasks:
- Add heartbeat.
- Detect camera failures.
- Detect microphone failures.
- Detect media pipeline failure.
- Add recovery state.

Acceptance criteria:
- Camera disconnection is reported.
- Network failure is reported.
- Monitoring recovers when possible.

### Phase 5 — Tauri Product UI

RB-050 — Implement discovery screen

Acceptance criteria:
- Device list displays discovered Pi devices.
- Manual connection works.
- Unavailable devices are clearly identified.

RB-051 — Implement pairing screen

Acceptance criteria:
- User can pair with secret.
- Pairing failures show actionable messages.
- Trusted device is remembered.

RB-052 — Implement monitor screen

Acceptance criteria:
- Video is primary UI element.
- Audio can be muted.
- Motion indicator works.
- Connection state is visible.
- Windows and Android layouts are usable.

RB-053 — Implement settings

Acceptance criteria:
- Motion settings can be changed.
- Audio settings can be changed.
- Alert settings can be changed.
- Changes are validated and persisted.

RB-054 — Implement diagnostics

Acceptance criteria:
- Device health is displayed.
- Connection statistics are displayed.
- Failure messages identify likely causes.

### Phase 6 — Alerts

RB-060 — Implement notification engine

Tasks:
- Consume typed events.
- Apply notification policies.
- Deduplicate events.
- Apply cooldowns.
- Trigger sounds.

Acceptance criteria:
- Motion event plays selected alert.
- Cooldown prevents alert spam.
- Notification state is predictable.

RB-061 — Implement sound profiles

Tasks:
- Bundle original sounds.
- Add gentle/classic/dramatic profiles.
- Support sound previews.
- Support imported sound files.

Acceptance criteria:
- Profiles work on Windows and Android.
- User sound files remain local.
- Sounds can be disabled.

RB-062 — Implement Windows tray monitoring

Tasks:
- Add tray icon.
- Add minimize behavior.
- Preserve active connections while minimized.
- Show native notifications.

Acceptance criteria:
- Monitoring continues when minimized.
- Alert sound plays while minimized.
- Explicit exit stops monitoring.

### Phase 7 — Installation

RB-070 — Implement one-command installer

Tasks:
- Detect Raspberry Pi model.
- Verify operating system.
- Install dependencies.
- Install service binary.
- Create service user.
- Set permissions.
- Start systemd service.
- Validate health.

Acceptance criteria:
- Fresh Raspberry Pi OS installation succeeds.
- Re-running installer is safe.
- Installation errors are actionable.

RB-071 — Implement first-boot provisioning

Tasks:
- Define provisioning schema.
- Apply Wi-Fi credentials.
- Generate device identity.
- Import pairing secret.
- Configure mDNS.
- Start daemon.

Acceptance criteria:
- Pi joins configured Wi-Fi.
- Service starts automatically.
- Temporary provisioning files are removed.
- No shared pairing credentials exist.

RB-072 — Implement customized image

Tasks:
- Configure rpi-image-gen.
- Include Raspbaby binaries.
- Include runtime dependencies.
- Include first-boot provisioning.
- Produce compressed image.

Acceptance criteria:
- Fresh image boots on Pi 4.
- Image contains no personal secrets.
- Build is reproducible.
- Artifact checksum is published.

RB-073 — Implement provisioning utility

Tasks:
- Accept Wi-Fi credentials.
- Select microSD card.
- Verify image.
- Apply provisioning configuration.
- Generate pairing secret.
- Display pairing QR.
- Flash card through a verified mechanism.

Acceptance criteria:
- Windows installation workflow completes.
- System drives are protected from accidental selection.
- Provisioned Pi starts without SSH intervention.
- User can pair with the generated QR or secret.

### Phase 8 — Stability and Security

RB-080 — Long-running test

Tasks:
- Run Pi continuously for 24 hours.
- Monitor memory.
- Monitor CPU.
- Record disconnects.
- Check stream recovery.

Acceptance criteria:
- No unbounded memory growth.
- No daemon crash during normal operation.
- Recovery works after network interruption.

RB-081 — Network failure testing

Test:
- Wi-Fi disconnection.
- Router restart.
- Client sleep.
- Pi reboot.
- Packet loss.
- High latency.
- Multiple simultaneous connections.

Acceptance criteria:
- Failure state is visible.
- Stale video is not shown as live.
- Reconnection works without manual restart.

RB-082 — Security validation

Tasks:
- Check unauthorized endpoints.
- Check media authorization.
- Check pairing replay resistance.
- Check certificate validation.
- Check secret storage.
- Check logging for leaked credentials.
- Run dependency audit.

Acceptance criteria:
- No unauthorized media access.
- No default credentials.
- No exposed provisioning secrets.
- Security findings are documented and resolved.

RB-083 — Resource benchmarking

Tasks:
- Measure 480p and 720p.
- Test 1 and 2 clients.
- Measure CPU.
- Measure RAM.
- Measure video latency.
- Measure notification latency.
- Measure audio/video sync.

Acceptance criteria:
- Publish benchmark results.
- Identify tested camera models.
- Document unsupported hardware combinations.

### Phase 9 — Public Repository

RB-090 — Create README

Include:
- Project description.
- Screenshots.
- Architecture overview.
- Feature list.
- Supported hardware.
- Quick installation.
- Security model.
- Development instructions.
- Project limitations.
- License.

RB-091 — Create documentation

Required documents:
- Architecture.
- Installation.
- Provisioning.
- Pairing.
- Security.
- Development.
- Troubleshooting.
- Performance benchmarks.
- Protocol specification.

RB-092 — Configure GitHub Releases

Produce:
- Windows installer.
- Android APK.
- ARM64 Raspberry Pi daemon.
- Raspberry Pi installation package.
- Compressed Raspberry Pi image.
- SHA-256 checksums.

Use release artifact signing where practical.

RB-093 — Create demo

Record a demonstration using simulated media.

Demonstrate:
- Device discovery.
- Pairing.
- Live video.
- Motion detection.
- Funny alert.
- Connection loss.
- Automatic recovery.

Do not publish identifiable child footage.

---

## 15. Testing Strategy

### 15.1 Unit tests

Cover:
- Motion algorithms.
- Motion state transitions.
- Configuration validation.
- Event serialization.
- Alert cooldowns.
- Authentication policy.
- Protocol compatibility.

### 15.2 Integration tests

Cover:
- Daemon and client communication.
- Pairing.
- WebRTC signaling.
- Event broadcasting.
- Device configuration updates.
- Client revocation.
- Simulated camera failure.

### 15.3 Hardware tests

Run on the real Raspberry Pi 4.

Cover:
- USB camera detection.
- Microphone detection.
- Video playback.
- Audio playback.
- Wi-Fi recovery.
- Reboot recovery.
- Long-running operation.
- CPU throttling.
- Power interruption recovery.

### 15.4 Performance tests

Record:
- Idle memory usage.
- Active memory usage.
- CPU utilization.
- Stream initialization time.
- Video latency P50/P95.
- Alert latency P50/P95.
- Packet loss.
- Connection recovery time.
- Device temperature.

Publish measured results.

Do not use fabricated benchmark data.

### 15.5 Security tests

Cover:
- Unauthorized camera access.
- Unauthorized microphone access.
- Unauthorized WebRTC signaling.
- Incorrect pairing secret.
- Replayed pairing requests.
- Invalid device identity.
- Revoked clients.
- Corrupted configuration.
- Unauthorized configuration changes.

---

## 16. Definition of Done

The MVP is complete only when:

1. A Raspberry Pi 4 can start the daemon automatically.
2. A USB webcam can transmit live video.
3. A microphone can transmit live audio.
4. Windows and Android clients can display the stream.
5. Device discovery works on the local network.
6. Secure pairing is implemented and tested.
7. Unauthorized clients cannot access the stream.
8. Motion detection operates on the Pi.
9. Motion events trigger client notifications.
10. Audio activity detection operates on the Pi.
11. Alerts have configurable sounds and cooldowns.
12. The Windows application operates while minimized.
13. Connection failures are clearly reported.
14. Disconnected clients reconnect automatically.
15. The simulator works without Raspberry Pi hardware.
16. Automated CI tests pass.
17. No media is recorded persistently.
18. Security and operational limits are documented.
19. The repository includes installation instructions.
20. All critical features have been tested on real hardware.

The flashable image is a separate release milestone.

The final installation milestone is complete only when:

1. A clean image can be flashed to a microSD card.
2. Wi-Fi can be configured before first boot.
3. Unique pairing credentials are provisioned securely.
4. The Pi starts without keyboard or monitor.
5. The client discovers the Pi.
6. The user pairs and starts monitoring.
7. No SSH commands are required during normal setup.

---

## 17. Agent Execution Instructions

Implement the project incrementally.

Mandatory rules:

1. Read this specification before modifying the repository.
2. Inspect the repository before creating new files.
3. Keep implementations small and testable.
4. Do not introduce cloud services.
5. Do not introduce databases without a demonstrated need.
6. Do not introduce machine learning into the MVP.
7. Do not write custom media codecs.
8. Do not invent custom cryptographic protocols.
9. Do not bypass pairing or media authentication.
10. Do not store video or audio.
11. Do not build complex abstractions without immediate use.
12. Prefer existing stable libraries.
13. Keep configuration explicit.
14. Validate external inputs.
15. Implement bounded queues and resource limits.
16. Include tests with each implementation task.
17. Update documentation when behavior changes.
18. Keep Windows and Android behavior consistent.
19. Treat hardware capabilities as facts to verify.
20. Never report an untested feature as complete.

Before implementing a phase:
- Check its dependencies.
- Review the relevant architecture decisions.
- Identify any unresolved technical risks.

After implementing a phase:
- Run the required tests.
- Run static analysis.
- Verify acceptance criteria.
- Update documentation.
- Record any deviations from the specification.

For each task, report:
- Task ID.
- Implemented behavior.
- Files changed.
- Tests executed.
- Test results.
- Remaining limitations.

Do not implement optional features before the MVP works.

Do not replace a failed implementation with an unrelated
technology without documenting the reason.

Priority order:
1. Security and correctness.
2. Reliable streaming.
3. Hardware efficiency.
4. Recovery behavior.
5. User experience.
6. Installation convenience.
7. Optional features.

## 18. First Implementation Assignment

Start with Phase 0 and Phase 1.

First deliverables:

1. Rust workspace.
2. Tauri Windows and Android application skeleton.
3. Shared protocol crate.
4. Simulated camera and microphone interface.
5. Working local media feasibility prototype.
6. Initial CI pipeline.
7. First architecture decision records.
8. README with development instructions.

Do not begin advanced motion detection or custom image
generation before the video/audio feasibility prototype
has been validated.

The first milestone is successful when a simulated or
real camera produces live video and audio in the Windows
and Android Tauri applications through WebRTC.

The second milestone is successful when an authenticated
real Raspberry Pi can provide the same stream.

After these milestones, continue with the backlog in
dependency order.