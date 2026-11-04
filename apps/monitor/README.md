# Media receiver development

This Tauri 2 shell uses the same React receiver on Windows and Android. It is a Phase 0 experiment, without product pairing. The Windows app can exchange signaling through existing trusted SSH key access; other development clients can use manual SDP exchange. The receiver does not capture local media or save received media.

Use Node 24 and pnpm 12.8.2. From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm --filter @raspbaby/monitor format:check
pnpm tauri dev
pnpm tauri build --debug --no-bundle
```

`pnpm dev` starts the browser UI at `http://127.0.0.1:1420`. `pnpm tauri dev` starts the Windows WebView2 shell. Install the Rust MSVC toolchain, Visual Studio C++ build tools, and WebView2 before you start the shell. `cargo check -p raspbaby-monitor-app` checks the Windows shell without opening a window.

Build the tested development installer with `pnpm tauri build --debug --bundles nsis`.
The Windows installer runs for the current user and adds Start menu and desktop
shortcuts. It also registers a Windows uninstall entry. The GUI executable does
not open a console. This installer does not imply production readiness.

## Windows camera connection

Build and run the current native Windows app. In **Settings**, enter the Pi
hostname or private IPv4 address and SSH username, then select **Connect camera**.
The connector uses Windows OpenSSH with existing keys and a trusted host entry
in `known_hosts`. It starts the fixed development daemon at
`/home/<username>/raspbaby-feasibility/target/debug/raspbaby-daemon` on the Pi;
that daemon and the capture devices must already be ready. It does not install
software or activate the experimental USB driver. See the
[root setup instructions](../../README.md) and
[Pi USB compatibility scope](../../docs/pi3-usb-compatibility.md).

## Monitoring and alerts

Real monitoring receives Pi CPU temperature, microphone RMS, motion/sound
activity, and events over the ordered, reliable `raspbaby-monitor` WebRTC data
channel. Signaling still uses SSH or the manual exchange below. Synthetic
sources emit no detections. Real sessions have no 30-minute limit; synthetic
tests retain that limit.

History is local to the client: at most 500 event rows and 90 nightly summaries,
with 18:00–08:00 local-time graphs and a seven-night view. It records confirmed
episodes, not each repeated alert. It does not backfill periods with no session.

Camera **Mute** changes microphone playback only; analysis and meters continue.
Import the selected Murloc clip in Settings. It plays while motion **or** sound
is active, repeats every five seconds by default (configurable 5–60 seconds),
and never overlaps itself. Repeats do not add history events. This is sound
activity detection, not cry recognition. See the
[monitoring development guide](../../docs/development.md#real-monitoring-metadata-and-alerts).

## Manual media test

1. Build the native daemon with the `gstreamer-runtime` feature. See the root media instructions for required plugins.
2. Start `raspbaby-daemon --stdio-spike` in a trusted terminal. Keep standard input open.
3. Open **Settings > Advanced connection** and select **Create offer**. Wait for local ICE gathering to finish.
4. Copy the full offer JSON line to daemon standard input.
5. Copy the answer JSON line from daemon standard output. Paste it in **Apply the sender answer**.
6. Select **Apply answer**. Confirm that decoded frames increase. Enable audio and check the sound.
7. Stop the sender. Confirm that the video clears and the failure state appears.

The receiver uses no STUN or TURN servers. It waits up to 15 seconds for complete local ICE gathering. It rejects answers for another session. It clears the stream on connection loss, track end, explicit stop, or five seconds without new decoded video. A new session requires a new offer. There is no automatic retry in this experiment.

The UI reports the last observed video progress. It does not report a device heartbeat. Audio bytes and decoded video do not establish audio/video synchronization or physical latency. Measure those separately.

## Native sender integration test

This test uses Playwright Chromium. It does not validate Windows WebView2 or Android WebView.

Start `pnpm dev` in one terminal. In a second PowerShell terminal:

```powershell
pnpm --filter @raspbaby/monitor exec playwright install chromium
$env:RASPBABY_SPIKE_BIN = 'D:\Dev\Raspbaby-monitor\target\debug\raspbaby-daemon.exe'
# Add the installed GStreamer bin directory to PATH if required.
pnpm --filter @raspbaby/monitor test:media
```

The test starts the native sender, exchanges SDP through standard input/output, checks received audio bytes and decoded video frames, and checks that sender termination clears the video. It exits with an error when the sender is unavailable. It does not substitute a mock stream.

## Android shell

Install Android Studio, an Android SDK, an NDK, a compatible JDK, and the Rust Android targets. Set `ANDROID_HOME`, `NDK_HOME`, and `JAVA_HOME` for your installation. Generate the platform project locally:

```powershell
pnpm tauri android init
pnpm tauri android dev
# Build a debug APK for an x86_64 emulator:
pnpm tauri android build --debug --target x86_64 --apk --ci
```

The generated `src-tauri/gen` tree contains machine-specific build state and is ignored. A debug x86_64 APK in the `Medium_Phone_API_35` emulator (Android 15, WebView 124.0.6367.219) played clear real VGA video with advancing audio counters. Home, screen lock, Back, reopening, and notification Stop passed with the experimental Pi DWC2 PIO capture path. Physical-device testing, audible output, and synchronization remain pending. See the [camera report](../../docs/real-camera-validation.md) and [background validation](../../docs/background-validation.md).

On Windows, Kotlin incremental compilation can fail when the Cargo registry and project are on different drives. The tested build recovered through the Gradle fallback compiler. If a build stops on this error, set `kotlin.incremental=false` in the generated Android `gradle.properties` and build again. This setting changes compiler caching only.

For a physical Android device, pass the LAN host explicitly when you start the Vite server, and configure the Tauri development URL for that host. The default development server binds only to loopback. Do not expose the development server outside the test network. Emulator background results do not establish physical-device behavior.
