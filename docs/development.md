# Development

## Prerequisites

Use Rust stable, Node.js 24, and the pnpm version in `package.json`.
Use one frontend package manager: pnpm. Commit both lockfiles after dependency
changes. `Cargo.lock` pins `kstring` to 2.0.2 because 2.0.5 requires Rust 1.96;
the initial host uses Rust 1.93.1. Do not update this pin without checking MSRV.

For Windows, install the Visual Studio C++ build tools and WebView2 runtime.
For Android, install Android Studio, SDK, NDK, JDK, and the Rust Android targets.
Set `ANDROID_HOME` and `JAVA_HOME` to the installed SDK and JDK directories.

## Frontend and Tauri

From the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:1420`. Browser preview is for development. To start the
Windows application or compile it without an installer:

```powershell
pnpm tauri dev
pnpm tauri build --no-bundle
```

Generate the Android project from the checked-in Tauri configuration:

```powershell
pnpm tauri android init
pnpm tauri android dev
pnpm tauri android build --debug
```

Generated Android files are ignored. Run `android init` on a fresh clone.
The Android 15 emulator APK was built, launched, and tested with synthetic
media and the real Pi VGA camera. Android development may require an explicit Vite host override and an
address reachable from the emulator. Bind development servers only to the
interfaces needed for that test.

Android background playback uses the local `raspbaby-background` Tauri plugin.
The plugin library and manifest are included in the generated Android build.
Do not copy plugin code into `gen/android`. An explicit connected monitoring
session starts a foreground service with an ongoing notification. Home, Back,
screen lock, notification reopen, notification Stop, and disabling background
support were tested with synthetic and real VGA media in the Android 15 emulator. Physical
devices, audible output, and long-running operation still need validation.
See [background validation](background-validation.md) for the results, limits,
and the unresolved mobile answer-form interaction issue. These results do not
close the media gate. Clear real VGA image evidence is recorded separately in
[real camera validation](real-camera-validation.md).

After the Android project includes the plugin, run its local unit tests:

```powershell
Push-Location apps/monitor/src-tauri/gen/android
.\gradlew.bat :tauri-plugin-background-monitor:testDebugUnitTest --console=plain
Pop-Location
```

The service stops if the playback Activity is destroyed or the app task is
removed. It does not restart after process death. Back moves an active monitor
task to the background. Do not treat an Android force stop as a background
playback operation.

## Native media spike

Install the MSVC x86-64 GStreamer runtime and development files on Windows.
Use a full plugin installation. This spike needs `webrtcbin`, libnice, DTLS,
SRTP, `videotestsrc`, `audiotestsrc`, `x264enc`, `h264parse`, `rtph264pay`,
`opusenc`, and `rtpopuspay`. Real monitoring also uses `appsink`, `videoscale`,
`videoconvert`, and `videorate`. See the official
[Windows installation guide](https://gstreamer.freedesktop.org/documentation/installing/on-windows.html).
Check the actual install directory; do not assume that all hosts use this path.

```powershell
$gstRoot = 'C:\Users\hanss\AppData\Local\Programs\gstreamer\1.0\msvc_x86_64'
$env:PATH = "$gstRoot\bin;$env:PATH"
$env:GSTREAMER_1_0_ROOT_MSVC_X86_64 = $gstRoot
$env:PKG_CONFIG_PATH = "$gstRoot\lib\pkgconfig"
$env:GST_REGISTRY = "$PWD\target\gst-registry.bin"
cargo run --locked -p raspbaby-daemon --features gstreamer-runtime -- --stdio-spike
```

For Debian or Ubuntu development, install `pkg-config`, the GStreamer core,
base, and bad development libraries, and the base, good, bad, ugly, ALSA, and libnice
runtime plugin packages. Debian packages `alsasrc` separately as `gstreamer1.0-alsa`.
The native CI job lists the exact package names for
its Ubuntu runner. Those packages are not a tested Raspberry Pi OS image pin.

Open **Settings > Advanced connection** and select **Create offer**. Copy the complete JSON line.
Paste it into the sender terminal. Copy the answer JSON line from stdout and
paste it into the receiver. Select **Apply answer**. Unmute audio to check the
test tone. Keep the sender terminal open. A second input line, EOF, Ctrl+C, or
the synthetic test's 30-minute session limit stops the sender. Real device
monitoring has no 30-minute limit. Pass `--hd` after `--stdio-spike`
to test 1280×720. The default is 640×480 at 15 FPS.

Do not pipe an offer file into the sender: EOF stops the session. Do not save
SDP or media. Transfer SDP only through a trusted local channel. The spike has
no product pairing or network control listener.

## Real Linux webcam source

The real source requires both device options. It never substitutes synthetic
media when a device is absent. Use a V4L2 device with MJPEG at 30 FPS and one
of the two supported sizes: 640×480 or 1280×720. The pipeline decodes MJPEG,
reduces video to 15 FPS, and encodes H.264. Audio uses ALSA and 48 kHz mono Opus.

On the Pi, from the project directory:

```sh
CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 \
  "$HOME/.cargo/bin/cargo" build --locked -p raspbaby-daemon --features gstreamer-runtime
./target/debug/raspbaby-daemon --stdio-spike \
  --video-device /dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0 \
  --audio-device plughw:CARD=Device,DEV=0
```

Replace these device values with the capability report values for your hardware.
Add `--hd` for 1280×720. Other formats, arbitrary sizes, automatic selection,
and camera-native H.264 are not implemented in this spike. Verify capabilities
with `v4l2-ctl --list-formats-ext` and `arecord -l` before starting capture.

The single build job and disabled development debug information limit build
memory on the available Pi 3B+. The workspace development profile compiles
`raspbaby-detection` at optimization level 3 to reduce analysis cost on the Pi.
These settings do not change the media codec. New resource measurements are
pending for the optimized detection build. Do not
interpret a development-build measurement as a production release benchmark.

## Real monitoring metadata and alerts

The native Windows **Connect camera** action uses existing trusted OpenSSH
keys and `known_hosts`. Set the hostname/private IPv4 address and SSH username
in Settings. The Pi daemon must already exist at
`/home/<username>/raspbaby-feasibility/target/debug/raspbaby-daemon` with the
tested camera and ALSA devices. The app does not install the daemon or manage
the USB host driver. See [persistent Pi compatibility](persistent-pio-proposal.md).

Before creating its offer, the receiver creates an ordered, reliable data
channel named `raspbaby-monitor`. Real capture tees decoded video to a bounded
320×180 GRAY8, 5 FPS analysis branch and 48 kHz mono audio to 100 ms RMS windows.
The sender publishes current levels/activity and event metadata about every
200 ms; it reads Pi CPU temperature once per second. It does not send raw
analysis frames or PCM through the channel. SSH still carries only the bounded
offer/answer signaling exchange. There is no new control listener.

Motion uses smoothing and confirmation. Sound uses a 300 ms confirmation,
minimum RMS 0.025, and a learned-noise threshold of twice the floor plus 0.005.
Both default detector cooldowns are zero: each new confirmed episode can add
an event. This does not make each active sample an event. Sound activity is
not cry recognition. Synthetic sources have no detection branches.

The client stores at most 500 local event rows and 90 nightly summaries.
Graphs use 18:00–08:00 in the client's local time and a seven-night view.
Storage contains event metadata, not recordings. Closing all receiver sessions
ends this session-based analysis; no unattended Pi event archive is provided.

Camera **Mute** changes microphone playback only. The meter and Pi analysis
continue. The separately imported Murloc clip plays while motion **or** sound
is active, repeats at the configured 5–60 second interval (default 5), and
never overlaps itself. Repeat playback does not increment history counts.
Import the user's exact clip locally; do not add it to the repository.

For an automated remote test, first establish SSH trust and key authentication.
Do not put a password in the command or an environment file. In PowerShell:

```powershell
$env:RASPBABY_SSH_TARGET = 'raspbaby@raspbaby.local'
$env:RASPBABY_REMOTE_COMMAND = '/home/raspbaby/raspbaby-feasibility/target/debug/raspbaby-daemon --stdio-spike --video-device /dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0 --audio-device plughw:CARD=Device,DEV=0'
$env:RASPBABY_DURATION_SECONDS = '60'
pnpm --filter @raspbaby/monitor test:media
```

Unset `RASPBABY_SPIKE_BIN` when selecting SSH mode. SSH carries signaling through
authenticated standard input/output. The media uses WebRTC directly. This is
an operator-driven test, not production pairing. Only use an explicit command
that you trust. Do not insert user input into the remote shell command.

## Checks

```powershell
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked -p raspbaby-daemon -p raspbaby-media --features gstreamer-runtime
cargo clippy --locked -p raspbaby-daemon -p raspbaby-media --features gstreamer-runtime --all-targets -- -D warnings
python -m unittest discover -s tests -v
python -m unittest discover -s tools/pi3-dwc2-pio -p test_tools.py -v
python -m unittest discover -s tools/pi3-dwc2-pio/persistent -p test_persistent.py -v
pnpm check
pnpm test
pnpm build
pnpm --filter @raspbaby/monitor format:check
pnpm audit --audit-level high
cargo audit
```

Install `cargo-audit` first if it is absent. The default workspace excludes
Tauri from default members so core tests do not need platform WebView libraries.
Use `cargo check --locked -p raspbaby-monitor-app` for the native shell.

To regenerate protocol types after a contract change, set
`UPDATE_PROTOCOL_TYPES=1` for `cargo test -p raspbaby-protocol`. Remove the
variable and rerun the test to check for drift. Review generated changes.

## Automated native browser smoke test

Build the media-feature daemon. Install the Playwright Chromium runtime:

```powershell
cargo build --locked -p raspbaby-daemon --features gstreamer-runtime
pnpm --filter @raspbaby/monitor exec playwright install chromium
pnpm dev
```

In a second terminal, set the GStreamer environment as above, then run:

```powershell
$env:RASPBABY_SPIKE_BIN = "$PWD\target\debug\raspbaby-daemon.exe"
pnpm --filter @raspbaby/monitor test:media
```

The runner exchanges SDP in memory, verifies negotiated H.264/Opus, checks
continued media progress for 60 seconds by default, then stops the sender and
checks that the old video is cleared. `RASPBABY_DURATION_SECONDS` accepts 1 to
600 seconds. `RASPBABY_TEST_URL` can
select a built preview server. Prefer a built preview during concurrent work
to prevent source hot reload from interrupting the test.

Set `RASPBABY_CDP_URL` to a temporary loopback debugging endpoint to test an
already running native WebView. Use `RASPBABY_RUNTIME_LABEL` to identify the
platform in the output. The Windows and Android smoke checks used this mode.
Close debugging endpoints after each test. A Chromium-only result does not
establish native WebView compatibility. Inbound audio bytes do not prove
audible output or audio/video synchronization.

## Deferred build commands

Automated ARM64 release artifacts, installation packages, and Pi image builds
are not configured yet. The ARM64 development daemon has been built on the Pi.
Do not publish placeholder artifacts. Validate RB-001 and RB-002, select and pin
the tested OS image, then implement the packaging backlog in dependency order.
