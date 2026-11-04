# Android background playback validation

Updated: 2026-11-04.

Status: Synthetic media passed the short Android emulator lifecycle checks.
Real VGA camera media also passed these checks with a temporary experimental
Pi USB host driver. A real receiver frame was visually inspected in memory.
The media gate remains open. Physical-device audio output and long-running
reliability are not established.

## Synthetic test scope, 2026-11-03

| Item | Test configuration |
| --- | --- |
| Build | Current working-tree UI and native plugin; no commit identifier was recorded for this run |
| Build host | Windows development host, PowerShell |
| Receiver | Packaged Tauri debug APK, Android 15 API 35 emulator, x86_64 |
| Emulator | `Medium_Phone_API_35`, cold boot, no visible window, no host audio, no saved snapshot |
| Sender | Available Raspberry Pi 3B+, daemon synthetic source |
| Source selection | `raspbaby-daemon --stdio-spike`, with no camera or microphone device arguments |
| Signaling | Authenticated SSH standard input/output; SDP remained in memory |
| Observation | WebView CDP, WebRTC statistics, native plugin status, Android service and power metadata |
| Notification permission | Granted only to the test application |

The synthetic source used the daemon's default 640 × 480 mode. No real camera
capture was started for these checks. The sender GStreamer version and plugin
inventory were not probed again for this run. This report is lifecycle evidence,
not a complete new media benchmark.

The final UI APK and Kotlin plugin compiled successfully. The generated Android
project included the plugin library without manual changes to its settings or
Activity. The merged manifest included `FOREGROUND_SERVICE`,
`FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `POST_NOTIFICATIONS`, and `WAKE_LOCK`.
The private service declared the `mediaPlayback` type. No local camera or
microphone capture permission was added.

The plugin unit test task passed: 2 tests, 0 failures, 0 skipped tests. The tests
check playback lease expiry, renewal, clearing, and clock regression. They do
not test Android media playback.

## Synthetic runtime results

The test selected background monitoring and connected the synthetic source.
The application started the service after media arrived. It sent heartbeats
while receiver media counters advanced. Native status returned `active: true`.
Android reported `isForeground=true`, service type `0x2` (`mediaPlayback`),
notification ID 4201 with an ongoing flag and one action, and a partial wake
lock named `Raspbaby:LivePlayback`.

| Check | Observation | Result |
| --- | --- | --- |
| Home | Media counters continued for at least 35 seconds; the same peer remained connected | Passed |
| Reopen after Home | The existing task reopened and displayed fresh decoded video | Passed |
| Screen lock | Media counters continued for at least 45 seconds; Android power metadata reported `mWakefulness=Asleep` | Passed |
| Reopen after screen lock | The same peer remained connected and displayed fresh decoded video | Passed |
| Back | The Android launcher became the resumed Activity; the monitor service and media session continued | Passed |
| Notification reopen | Tapping the ongoing notification reopened the existing connected receiver | Passed |
| Disable background monitoring | The service became inactive while foreground video and audio counters continued | Passed |
| Enable background monitoring again | The connected foreground receiver started a new active service | Passed |
| Notification Stop | Tapping the visible Stop action closed the peer and cleared the video element | Passed |
| Resource release after Stop | No active monitor foreground service or monitor partial wake lock remained | Passed |

The following counters show actual media progress. They are cumulative values
within each session, not throughput or latency measurements.

| Interval | Video bytes, start → end | Decoded video frames, start → end | Audio sample counter, start → end |
| --- | --- | --- | --- |
| Home, 35-second check | 99,893 → 477,491 | 125 → 662 | 423,360 → 2,136,960 |
| Screen lock, 45-second check | 520,541 → 1,001,119 | 704 → 1,384 | 2,324,160 → 4,500,000 |
| Notification reopen, focused session | 92,578 → 189,661 | 127 → 266 | 401,760 → 841,920 |

The audio counter came from WebRTC statistics (`totalSamplesReceived`, with
`jitterBufferEmittedCount` as a fallback). Received audio bytes also increased.
These counters do not establish audible speaker output or audio/video sync.

After notification Stop, native status reported `active: false` and the reason
`Stopped from notification`. The peer state was `closed`. The video element had
`readyState: 0`, `videoWidth: 0`, and `paused: true`. The test also checked native
service and wake-lock release. This check did not infer success from the
notification disappearing alone.

All owned synthetic SSH sender processes exited with code 0 after their input
closed. The tests did not save SDP, screenshots, video, or audio.

## Real VGA camera follow-up, 2026-11-04

The same installed Android 15 API 35 x86_64 emulator APK received the Pi's real
USB camera and microphone. The Windows receiver released capture before this
test. Signaling used authenticated SSH standard input/output. The sender used
the rebuilt daemon with explicit V4L2 and ALSA device arguments; it did not use
the synthetic source.

The Pi used the temporary DWC2 PIO host module and stock UVC driver. This was an
active runtime experiment with a restoration lease. It does not establish a
permanent fix for the normal stock USB host path. See
[real camera validation](real-camera-validation.md) for the capture context.

A 640 × 480 frame was read from the Android video element through an in-memory
canvas and displayed for inspection. It showed a clear full-frame person and
room with natural colors. The earlier green lower image and scrambled rows
were absent in this inspected frame. No frame or SDP file was saved. No claim
is made about frames that were not visually inspected.

The real sender answer was applied with a normal Playwright button click after
the answer field lost focus and a 700 ms settling delay. The click passed. This
run did not use forced clicks or DOM event dispatch for **Apply answer**. It
does not establish an unaided manual mobile touch flow; the earlier interaction
issue still needs a direct user-input regression test.

| Real camera check | Result |
| --- | --- |
| Home for at least 35 seconds | Same peer remained connected; media counters and native service stayed active |
| Screen lock for at least 45 seconds | Media counters continued; Android reported `mWakefulness=Asleep` |
| Reopen after Home and screen lock | Same peer remained connected, with fresh decoded 640 × 480 video |
| Back for at least 10 seconds and reopen | Media counters continued and the existing task reopened |
| Disable background support | Service stopped while foreground media continued |
| Enable background support again | Service restarted for the connected session |
| Visible notification Stop action | Peer closed, video cleared, and service became inactive |
| Cleanup | Sender exited with code 0; no camera owner, active monitor service, or monitor partial wake lock remained |

| Real camera samples | Video bytes, start → end | Decoded video frames, start → end | Audio sample counter, start → end |
| --- | --- | --- | --- |
| Home samples at 5 s → 35 s | 6,478,702 → 12,247,339 | 503 → 920 | 1,582,560 → 3,060,960 |
| Before screen lock → 45 s locked | 13,029,571 → 21,497,362 | 979 → 1,653 | 3,256,800 → 5,428,320 |
| Reopened after screen lock | 22,315,506 | 1,718 | 5,637,600 |
| Foreground sample after background support was disabled | 25,873,829 | 2,003 | 6,548,640 |

Native metadata confirmed foreground service type `0x2`, ongoing notification
ID 4201, and a partial wake lock during playback. After notification Stop,
native status reported `active: false` and `Stopped from notification`. The peer
state was `closed`; video width and height were zero, `readyState` was zero,
and playback was paused. The Pi camera had no owner after sender exit.

CDP remained attached and emulator host audio remained disabled. This run does
not establish audible output, audio/video sync, latency, long-term stability,
HD playback, or a permanent camera-driver fix. No CPU or memory benchmark was
collected for this application run.

## Test issues and limitations

The mobile answer form has an unresolved interaction issue. After the test
filled the sender answer, a normal Playwright click on **Apply answer** was
intercepted by the textarea, labels, or other connection-form elements during
scrolling. The lifecycle test dispatched the button click directly in the DOM
to isolate background behavior. This does not prove that the normal mobile
touch flow is usable. Fix the form interaction and repeat a normal user-input
test before claiming that flow works.

The initial notification automation also needed correction. Dumping the Android
UI hierarchy to `/dev/tty` did not return its XML through adb. A retry swipe
opened Quick Settings and hid the notification list. The successful check read
the hierarchy through `exec-out uiautomator dump /dev/stdout`, kept it in memory,
expanded the notification with its Android expand button, and tapped the visible
Stop action. It did not invoke the private service directly from the shell.

CDP remained attached during media observation. The tests used an emulator with
host audio disabled. Repeat the lifecycle checks on physical Android hardware,
including audible playback, without an attached debugger. Test longer sessions,
battery restrictions, network loss, permission denial, and notification-channel
blocking separately. Native lease expiry has unit coverage; this run did not
measure watchdog expiry on a device.

The WebView owns the receiver. The service alone cannot recover a destroyed
WebView. Removing the app task from Recents, destroying the playback Activity,
force stopping the application, or an OS process kill ends the session. The
service uses `START_NOT_STICKY`. Start a new session after reopening the app in
these cases. These actions were not continuity acceptance checks in this run.

The historical synthetic checks did not establish real camera image quality.
The later real VGA follow-up above adds clear-frame and background-playback
evidence for the temporary DWC2 PIO path. Corruption on the original stock USB
host path remains unresolved. The application results do not establish a
permanent driver fix or close the remaining media acceptance checks.
