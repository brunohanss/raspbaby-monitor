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

Result: Pending. No connected Raspberry Pi was available for the initial work.

## RB-002: Media spike

Dependency: RB-001 for real-camera tests. Synthetic tests can start earlier.

Use the development instructions to run the synthetic source and receiver.
Run the same test in Windows WebView2 and Android WebView. Browser preview alone
does not satisfy either platform check.

| Check | Result |
| --- | --- |
| Windows WebView2 video and inbound audio | Passed short native smoke test; audible output pending |
| Android WebView video and audible audio | Pending |
| Raspberry Pi V4L2 and ALSA capture | Pending |
| H.264 and Opus negotiation | Passed Windows and Chromium synthetic smoke tests |
| Restart after disconnect | Pending runtime evidence |
| Two simultaneous receivers | Deferred until single receiver passes |
| No media files written | Requires runtime inspection |
| CPU and RAM stability | Not measured |
| Video latency P50/P95 | Not measured |
| Audio/video synchronization | Not measured |

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
