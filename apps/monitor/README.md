# Media receiver development

This Tauri 2 shell uses the same React receiver on Windows and Android. It is a Phase 0 experiment. It does not implement product pairing or network signaling. Use a trusted local terminal for the manual SDP exchange. The receiver does not capture local media or save received media.

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

`pnpm dev` starts the browser UI at `http://127.0.0.1:1420`. `pnpm tauri dev` starts the Windows WebView2 shell. Install the Rust MSVC toolchain, Visual Studio C++ build tools, and WebView2 before you start the shell. `cargo check -p raspbaby-monitor-app` checks the Windows shell without opening a window. The bundle configuration is disabled until platform validation is complete.

## Manual media test

1. Build the native daemon with the `gstreamer-runtime` feature. See the root media instructions for required plugins.
2. Start `raspbaby-daemon --stdio-spike` in a trusted terminal. Keep standard input open.
3. Select **Create offer** in the UI. Wait for local ICE gathering to finish.
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
```

The generated `src-tauri/gen` tree contains machine-specific build state and is ignored. `android init` was run successfully during scaffold validation. An APK build and launch are separate checks. Do not mark Android media compatibility as verified until the stream works in Android WebView.

For a physical Android device, pass the LAN host explicitly when you start the Vite server, and configure the Tauri development URL for that host. The default development server binds only to loopback. Do not expose the development server outside the test network. Android screen lock and background monitoring are not supported.
