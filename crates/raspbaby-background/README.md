# Android background playback support

This Tauri 2 plugin gives an explicit live receiver session an Android
`mediaPlayback` foreground service. The Android library is part of the crate.
Tauri discovers the library through `build.rs`. Do not copy code into the
ignored `gen/android` project.

Register `tauri_plugin_background_monitor::init()` in the application. Give
the Android main window the `background-monitor:default` permission.

## Receiver contract

Use the following Android commands with no arguments:

| Invoke command | Required behavior |
| --- | --- |
| `plugin:background-monitor\|start` | Call after explicit user selection and confirmed live playback. The app must be visible. |
| `plugin:background-monitor\|heartbeat` | Call each 5 seconds, only if inbound media counters continue to increase. |
| `plugin:background-monitor\|stop` | Disable background support. The foreground WebRTC receiver can continue. Also call during session teardown. |
| `plugin:background-monitor\|status` | Read the actual service state. |

Each successful call returns `supported: true`, `active: boolean`, and an
optional `reason` string. These mobile commands are Android only. The plugin
does not provide desktop command implementations.

Listen for the window event `raspbaby-background-stop`. Close the WebRTC
receiver and clear the displayed media when this event occurs. The event can
come from the notification Stop action, the native watchdog, or service loss.
The normal `stop` command does not send this event. It removes the service and
wake lock while the foreground receiver can continue. The event handler must
be safe to call more than once.

On Android 13 and later, start requests notification permission. If the user
denies it, start fails. The plugin also rejects start when app notifications
are disabled. It does not claim that Android requires notification permission
to run a foreground service. This application requires a visible notification
to give the user a way to open or stop monitoring.

The service has an ongoing notification. Tap the notification to open the
existing app task. Select **Stop monitoring** to stop playback. During an
active session, Back moves the app task to the background. The plugin resumes
the existing WebView after Wry pauses it. It does this only while the service
is active. The screen can turn off. No screen wake lock is used.

A partial wake lock expires after 35 seconds unless valid receiver progress
renews it. A native watchdog stops the service if it receives no heartbeat for
30 seconds. The lock and notification are released on stop. The service uses
`START_NOT_STICKY`; it does not restart a playback claim after process death.

## Limits and validation

The service does not own the media pipeline. A foreground service alone does
not prove background audio or WebRTC continuity. Test Home, Back, screen lock,
notification reopen, notification Stop, and sender failure in the packaged
Tauri application. Check inbound media counters during each test. Check audible
output on a physical device separately.

Removing the app task from Recents, destroying its Activity, force stopping the
app, or an OS process kill ends this WebView receiver session. Start a new
session after the app opens again. Do not claim that playback survives these
actions. There is no local camera capture, microphone capture, recording,
automatic restart, or boot receiver.

Run `cargo fmt -p tauri-plugin-background-monitor -- --check`. Run the generated
Android plugin Gradle project task `testDebugUnitTest` to check lease expiry,
renewal, stop, and clock regression. The app build must also compile the Kotlin
plugin and merge its manifest. These checks do not replace device tests.

Validation on 2026-11-03, Windows development host:

- Rust format check passed.
- Tauri Android debug build for `x86_64` passed. Kotlin compiled and the
  generated project included the plugin library without manual edits.
- The merged app manifest includes the four declared permissions and the
  private `mediaPlayback` service. No camera or microphone permission was added.
- `:tauri-plugin-background-monitor:testDebugUnitTest` passed: 2 tests,
  0 failures, 0 skipped tests.
- The final UI debug APK launched in the Android 15 API 35 emulator. Calling
  `plugin:background-monitor|status` through its native WebView returned
  `supported: true` and `active: false`. This confirms native command routing
  and the capability permission. No session was started for this check.
- Background media continuity, notification actions, and physical-device
  audible playback still require runtime evidence.

References:

- [Tauri mobile plugins](https://v2.tauri.app/develop/plugins/develop-mobile/)
- [Android foreground service types](https://developer.android.com/develop/background-work/services/fgs/service-types)
- [Android notification permission](https://developer.android.com/develop/ui/views/notifications/notification-permission)
- [Android WebView lifecycle](https://developer.android.com/reference/android/webkit/WebView)
