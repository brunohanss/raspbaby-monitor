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
The initial work checks project generation; device launch and playback still
need validation. Android development may require an explicit Vite host override
and an address reachable from the emulator. Bind development servers only to
interfaces needed for that test. Android background monitoring is not supported.

## Native media spike

Install the MSVC x86-64 GStreamer runtime and development files on Windows.
Use a full plugin installation. This spike needs `webrtcbin`, libnice, DTLS,
SRTP, `videotestsrc`, `audiotestsrc`, `x264enc`, `h264parse`, `rtph264pay`,
`opusenc`, and `rtpopuspay`. See the official
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
base, and bad development libraries, and the base, good, bad, ugly, and libnice
runtime plugin packages. The native CI job lists the exact package names for
its Ubuntu runner. Those packages are not a tested Raspberry Pi OS image pin.

Start the receiver and select **Create offer**. Copy the complete JSON line.
Paste it into the sender terminal. Copy the answer JSON line from stdout and
paste it into the receiver. Select **Apply answer**. Unmute audio to check the
test tone. Keep the sender terminal open. A second input line, EOF, Ctrl+C, or
the 30-minute session limit stops the sender. Pass `--hd` after `--stdio-spike`
to test 1280×720. The default is 640×480 at 15 FPS.

Do not pipe an offer file into the sender: EOF stops the session. Do not save
SDP or media. Transfer SDP only through a trusted local channel. The spike has
no pairing or authenticated network control. It does not capture a USB camera.

## Checks

```powershell
cargo fmt --all -- --check
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked -p raspbaby-daemon -p raspbaby-media --features gstreamer-runtime
cargo clippy --locked -p raspbaby-daemon -p raspbaby-media --features gstreamer-runtime --all-targets -- -D warnings
python -m unittest discover -s tests -v
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

The runner exchanges SDP in memory, checks inbound video and audio, then stops
the sender and checks that the old video is cleared. `RASPBABY_TEST_URL` can
select a built preview server. Prefer a built preview during concurrent work
to prevent source hot reload from interrupting the test. This test does not
prove audible output, sync, Windows WebView2, or Android WebView compatibility.

## Deferred build commands

ARM64 daemon, installation package, and Pi image builds are not configured yet.
Do not publish placeholder artifacts. Validate RB-001 and RB-002, select and pin
the tested OS image, then implement the packaging backlog in dependency order.
