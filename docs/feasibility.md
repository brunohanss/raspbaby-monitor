# Media feasibility report

Status: In progress. The media gate is open.

## Evidence rules

Record the commit, host, OS, GStreamer version, plugin list, source, receiver,
and test duration for each run. Record failures as well as successful runs.
Keep media and private SDP out of the repository. Do not invent benchmark data.

## RB-001: Raspberry Pi capability check

Dependency: A Raspberry Pi 4, a USB camera, and a microphone.

Run this read-only probe on the Pi:

```sh
python3 scripts/probe_pi.py --output /tmp/raspbaby-capabilities.json
```

The probe lists V4L2 formats, stable device paths, ALSA inputs, plugin details,
memory, OS, and local network addresses. It does not capture media. Inspect the
report before sharing it. Test microphone sample formats separately. Plugin
presence does not prove that an encoder works or meets the resource target.

Acceptance: Record the tested ARM64 OS image and checksum, USB device models,
supported video modes, microphone formats, and local connectivity.

Result: The available device is a Pi 3B+, not a Pi 4. Its camera, microphone,
ARM64 OS, and real capture path were tested. The cached OS image checksum is
pinned in `config/tested-os-image.json`. See `real-camera-validation.md`.
The original Pi 4 acceptance check remains pending.

## RB-002: Media spike

Dependency: RB-001 for real-camera tests. Synthetic tests can start earlier.

Use the development instructions to run the synthetic source and receiver.
Run the same test in Windows WebView2 and Android WebView. Browser preview alone
does not satisfy either platform check.

| Check | Result |
| --- | --- |
| Windows WebView2 video and inbound audio | Clear real 640×480 picture verified from a RAM canvas frame with experimental DWC2 PIO; audio sample counters advance; audible output pending |
| Android WebView video and inbound audio | Clear real VGA picture and Home/lock/Back/reopen/notification Stop passed in Android 15 emulator with experimental DWC2 PIO; physical device pending |
| Raspberry Pi V4L2 and ALSA capture | Stock USB path remains corrupt; experimental exact-kernel DWC2 host PIO with stock UVC produces clear VGA; USB microphone produces samples |
| H.264 and Opus negotiation | Confirmed from active receiver codec statistics on both platforms |
| Restart after disconnect | New operator-driven sessions pass; automatic reconnect is not implemented |
| Two simultaneous receivers | Deferred until single receiver passes |
| No media files written | Pipelines and runner have no media storage; tests save counters only |
| CPU and RAM stability | Short samples recorded; long-running stability remains pending |
| Video latency P50/P95 | Not measured |
| Audio/video synchronization | Not measured |

### Native VGA follow-up: 2026-11-04

The native Windows **Connect camera** action established the real camera
session through existing trusted SSH key access. A frame read directly from
the application's video canvas in RAM showed a clear, natural-color,
full-frame person at 640×480. No footage was stored.

During 35 seconds hidden in the tray, video advanced from 2 to 538 frames and
decoded audio advanced from 25,440 to 1,711,680 samples. Launching the executable
again restored the same peer, which reached 584 video frames and 1,857,120
audio samples. **Stop** released the native session: `connected` became false
and `sessionId` became null.

At a 29-second process snapshot, the Pi daemon used 46,964 KiB RSS and 73.9%
CPU with one core equal to 100%. This is one sample, not an average or a
long-running resource bound. The Pi reported `throttled=0x0`.

The Android 15 emulator also passed clear real VGA playback through Home for
35 seconds, screen lock for 45 seconds, Back for 10 seconds, reopening, and
notification Stop. See the [camera report](real-camera-validation.md) and
[background report](background-validation.md) for the platform evidence.

These initial results used a bounded runtime DWC2 PIO experiment. An approved
experimental boot service is now installed for this exact Pi 3B+ kernel with
stock UVC. See [the persistent setup](persistent-pio-proposal.md) for its scope,
backup, removal, and physical recovery procedures.

### Persistent startup validation: 2026-11-04

An earlier service version bound PIO after reboot but returned only tiny invalid
video buffers and no FFmpeg frames. A guarded full host rebind recovered capture;
concurrent audio/video then produced 20 clear frames out of 20 sampled frames.
Driver binding alone is therefore not accepted as capture health.

The current service decodes three MJPEG VGA frames before committing startup.
Only a decode-health failure permits one controlled stock restore and PIO rebind;
at most two health attempts are allowed. Startup has a 90-second systemd limit
and a 75-second independent recovery timer. Failed startup restores stock.

At 11:23:11 CET, an ordinary boot passed the first health attempt. The first
native Windows **Connect camera** session then produced 48 video frames and
146,880 decoded audio samples. A 640×480 canvas frame inspected in RAM was clear.
**Stop** released the session. A second ordinary boot passed its first health
attempt at 11:26:00 CET. Its first Windows connection produced 50 video frames
and 146,400 decoded audio samples with a clear RAM-only frame. Stop released
the sender. Both consecutive boots passed without manual driver activation.

A separate post-rebind Windows check advanced to 530 video frames and 1,685,760
audio samples while hidden for 35 seconds, then 575 frames and 1,832,160 samples
after reopening. Stop released the session cleanly.

The original boot backup was exported to the computer and verified. An actual
uninstall restored the exact original config, bound stock USB, removed the unit
and include, and unloaded the test module. The setup was reinstalled with the
removal records retained in an archive. These checks do not establish general
Pi 4 compatibility or long-running reliability. The broader gate remains open,
including physical Android, audible output, latency, and synchronization.

Use a visible clock and an audible/visible pulse to measure latency and sync.
Use at least 20 samples for an initial latency distribution. Record the method
and sample count. Use `pidstat` or an equivalent OS tool for CPU and RSS. Check
memory across a sustained run. Do not infer latency from receiver RTT alone.

Stop the sender and disconnect the network. Confirm that the receiver clears
the video and shows a failure. Start a fresh session and confirm recovery.

Acceptance: Both Tauri platforms play video and audio, session restart works,
resource usage remains bounded, and measured results are recorded here.

## RB-003: Decisions

The first ADRs define the media gate, security boundary, and pending OS pin.
Production authentication and provisioning decisions still need evidence and
review. These ADRs do not claim that those features are implemented.
