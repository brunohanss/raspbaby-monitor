# Real camera validation

Updated: 2026-11-04. Scope: Phase 0 feasibility and RB-001/RB-002.

Current application result: Windows and Android VGA receivers now have clear
visual evidence with the temporary DWC2 PIO host path. These new checks
supersede the earlier transport-only acceptance for this tested runtime path.
The earlier corruption on the stock USB host path remains a separate failure.
No permanent camera fix is installed, and the broad media gate remains open.

## Current direct-capture result

A temporary DWC2 host driver with DMA disabled (PIO), built from the exact
matching kernel source, produced a clear, natural-color, full-frame person
image with the stock UVC driver. The independent test decoded MJPEG 640×480
directly to RGB in RAM. It bypassed the application, WebRTC, and H.264. No
footage was stored.

| Measurement | Direct-capture result |
| --- | --- |
| Duration | 120.96 seconds |
| RGB output sampling | 5 FPS; 597 sampled frames, all 597 distinct |
| Decoded input | 3,175 frames; 26.564 FPS |
| Flagged V4L2 buffers dropped | 376 |
| JPEG errors | 0 reported |
| Mean total CPU use | 18.57% of four-core capacity |
| FFmpeg diagnostic maximum RSS | 183,532 KiB |

The CPU and RSS figures describe this direct diagnostic, not the Rust daemon.
They do not establish application performance or sustained 30 FPS capture.
Windows and Android VGA application playback with this capture path now have
evidence in the follow-ups below. The media feasibility gate remains open.

This result used a separate experimental runtime host module on kernel
`6.18.50+rpt-rpi-v8`. The stock host driver was restored after the trials.
Normal boot remains configured for the original `dwc_otg` path; no permanent
camera fix is installed. See the opt-in
[Pi 3B+ USB compatibility experiment](pi3-usb-compatibility.md) for scope,
USB impact, build requirements, and restoration steps.

## Windows VGA application follow-up, 2026-11-04

A fresh native Windows Tauri build connected through the **Connect camera**
button. The application started one authenticated SSH standard-input/output
sender session with the real Pi camera and microphone. This one-click operator
connection is not production pairing or automatic device discovery.

A receiver frame was inspected through an in-memory canvas. It showed a clear
full-frame 640 × 480 image. The earlier green lower image and scrambled rows
were absent. The frame was not stored. The sender used the temporary DWC2 PIO
host path and the rebuilt daemon, not a synthetic source.

The receiver continued while the Windows window was hidden for at least 35
seconds. Starting a second application executable reopened the existing window
and retained the same peer. The normal Live **Stop** action then released the
native session and the Pi camera.

| Windows real-camera sample | Decoded video frames | Audio sample counter |
| --- | --- | --- |
| Before the hidden-window check | 2 | 25,440 |
| After 35 seconds hidden | 538 | 1,711,680 |
| After reopening through a second executable | 584 | 1,857,120 |

After normal Stop, native status returned `sessionId: null` and
`connected: false`. The Pi camera was released before the Android test began.

A daemon resource snapshot at approximately 29 seconds reported RSS of
46,964 KiB and process CPU of 73.9% on a one-core scale. The CPU value is one
snapshot, not an average or a four-core-capacity percentage. The Pi reported
`throttled=0x0`. These short observations do not establish sustained resource
use, physical latency, audio/video sync, or audible client output. No media or
SDP files were saved.

## Android VGA application follow-up, 2026-11-04

The packaged Tauri debug APK received the real Pi camera and microphone in the
Android 15 API 35 x86_64 emulator. The sender used the rebuilt daemon, explicit
V4L2 and ALSA devices, stock UVC, and the temporary DWC2 PIO host driver under an
active restoration lease. The test started after the Windows receiver released
the camera. Signaling used authenticated SSH standard input/output. SDP stayed
in memory.

A 640 × 480 Android receiver frame was inspected through an in-memory canvas.
It showed a clear full-frame person and room with natural colors. The earlier
green lower image and scrambled rows were absent in this frame. The frame was
displayed directly for inspection and was not stored. This is visual evidence
for the experimental runtime path, not a permanent stock-driver repair.

The same receiver peer stayed connected during at least 35 seconds after Home,
45 seconds with the Android display asleep, and 10 seconds after Back. Video
bytes, decoded frames, and audio sample counters continued to increase. Reopen
retained the peer and displayed fresh 640 × 480 video. During screen lock,
Android power metadata confirmed `mWakefulness=Asleep`.

| Android real-camera samples | Video bytes | Decoded video frames | Audio sample counter |
| --- | --- | --- | --- |
| Home, at 5 seconds | 6,478,702 | 503 | 1,582,560 |
| Home, at 35 seconds | 12,247,339 | 920 | 3,060,960 |
| Before screen lock | 13,029,571 | 979 | 3,256,800 |
| Screen lock, at 45 seconds | 21,497,362 | 1,653 | 5,428,320 |
| Reopened after screen lock | 22,315,506 | 1,718 | 5,637,600 |

The visible notification Stop action closed the peer and cleared the video.
The foreground service and its partial wake lock were released. The owned SSH
sender exited with code 0, and no process held the Pi camera afterward.

The answer was applied with a normal Playwright click after blur and a 700 ms
settling delay. No DOM click dispatch was needed in this run. A normal manual
mobile touch flow still needs validation. See
[background validation](background-validation.md) for the interaction issue,
native resource checks, and complete lifecycle results.

CDP was attached and emulator host audio was disabled. Received audio samples
do not prove audible speaker output or audio/video sync. This run did not
measure latency, CPU, memory, HD playback, or long-running stability. No media
or SDP files were saved.

## Visual-quality correction

The transport checks below do not prove a usable camera picture. Subsequent
visual inspection found scrambled upper rows and a green lower image in an
independent viewer that bypasses the application, WebRTC, and H.264. Direct
FFmpeg capture reports missing JPEG end markers, overreads, and entropy errors.
Raw capture also reports corrupted V4L2 buffers. The stock camera input remains
unsuitable. The experimental direct-capture result above is separate evidence.
Do not treat earlier frame-count passes as visual acceptance.

A physical USB disconnect for approximately ten seconds and reconnect to a
different Pi port did not remove the decode errors. The kernel registered the
camera again on the new port. The device is bound to `uvcvideo` on kernel
`6.18.50+rpt-rpi-v8`; it is not missing a video driver. Independent FFmpeg probes
also report damaged MJPEG at the advertised 480×320, 720×480, 1280×720, and
1920×1080 sizes. The power status remains `throttled=0x0`. These observations do
not establish whether the cause is the camera, its cable, USB compatibility,
or the kernel driver. A later Windows test produced a clear picture, as
described below.

The USB descriptors list two formats: MJPEG and uncompressed YUYV. They do not
list H.264, although the supplied marketing description claims H.264 support.
Do not select a native H.264 source without device evidence.

Both V4L2 memory mapping and user-pointer capture produce incomplete JPEG
frames. A ten-frame VGA sample contained ten JPEG start markers but only six
or seven end markers. The sample remained in memory. A short USB metadata
probe reported successful isochronous completion during capture; it did not
report packet errors before shutdown. This does not prove that every payload
byte is correct. No USB payload or camera sample was saved.

An approved comparison used the installed `dwc2` host driver for one boot.
VGA and 1080p MJPEG remained corrupt; 320×240 YUYV at 25 FPS produced no valid
frames. The alternate driver also emitted a kernel warning in
`dwc2_assign_and_init_hc`. The original boot file was restored automatically
and its SHA-256 matched the backup. The temporary recovery service was removed.
A second boot confirmed that the original `dwc_otg` driver was active again.
The comparison did not establish a fix. Do not recommend this driver switch
as a solution for this camera.

An approved temporary UVC module experiment aligned this camera's isochronous
buffer offsets from 3069 to 3072 bytes. Packet lengths remained 3069 bytes.
The module was built from the exact matching Raspberry Pi kernel source
package (`1:6.18.50-1+rpt1`) and reviewed before loading. A 45-second direct
preview still showed horizontal colored corruption. FFmpeg exited with code
zero but reported 1,053 diagnostic lines, including entropy errors and
overreads. This is a visual failure. Aligned offsets also permit a different
`dwc_otg` scheduling path, so the changed appearance does not isolate a cause.
The script unloaded the experiment and restored the stock module. No installed
module or boot file was replaced. Do not ship this experimental patch.

### Follow-up: 2026-11-04

The temporary alignment module was also tested with uncompressed YUYV.
At 320×240 and 25 FPS, a 45-second direct RGB preview completed without FFmpeg
capture errors. Visual inspection still failed: part of the room was visible,
but the right side was magenta and damaged. At 640×480 and 22 FPS, no preview
frames arrived before the 55-second timeout. Both tests restored stock UVC.
Do not interpret the error-free QVGA run as visual acceptance.

A separate stock Raspberry Pi kernel, `6.12.62+rpt-rpi-v8`, was staged with its
matching modules, device tree, overlays, and initramfs. The APT package SHA-256
was `057e6ec6f467a93206097110e4ffd2398f30c473539259f343625a945a23f6d6`.
The test used firmware `tryboot`; normal boot files were not replaced. The
running kernel version was verified before capture. MJPEG VGA still reported
missing end markers, overreads, and entropy errors. This comparison did not
establish a usable capture path or a regression limited to kernel 6.18.
Raw QVGA did not produce output frames and required stopping the bounded
diagnostic process after its termination signal failed to end capture.
A normal reboot restored kernel `6.18.50+rpt-rpi-v8` and the stock UVC module.
The test boot files and parallel old-kernel modules were then removed after
the cleanup script verified the original boot-file hashes.

A one-time stock-kernel `dwc_otg` USB PIO test disabled DMA and both FIQ options.
The effective settings were verified as `0`, `N`, and `N`. Direct MJPEG capture
still reported missing end markers and overreads. A normal reboot restored
the default settings. The temporary tryboot and command-line files were removed.

A USB control-metadata probe found a frame-interval inconsistency: descriptors
advertise 30 FPS, while GET_MIN(PROBE) returned 400000 (25 FPS) and GET_MAX
returned 800000 (12.5 FPS). These responses concern different frame indices;
they do not by themselves establish a supported VGA frame rate. A separate
temporary driver test changed only this camera's VGA MJPEG interval to 400000.
The original buffer code was restored before building that test. USB COMMIT
was verified as 400000, but a 45-second direct preview still showed corrupted
bands and a green lower region. FFmpeg reported 175 diagnostic lines, including
missing end markers, overreads, and entropy errors. The stock UVC module was
restored and its source-version identifier matched the installed module.
Neither experiment established a usable capture path. Do not ship the test
module or treat decoder exit code zero as visual acceptance.

### Device identification and external reports

On 2026-11-04, the same external DV20 camera was connected to the Windows host.
Windows PnP confirmed USB ID `4c4a:4a55`. An independent GStreamer Media
Foundation preview selected `DV20 USB CAMERA` explicitly, with MJPEG 640×480
at 30 FPS, `jpegdec`, and a Direct3D sink. Visual inspection showed a clear
full-frame picture with natural colours and no green region or scrambled
bands. The user also confirmed the picture worked. This is evidence that
the camera can produce a usable picture on this Windows USB host. It narrows
the Pi failure toward the USB/Linux capture path; it does not establish a Pi
fix. No media was recorded.

The working Windows connection used an Intel USB 3.20 xHCI host controller.
Ten MJPEG frames were inspected in RAM: ten JPEG start markers and ten end
markers were present. No frame bytes were saved.

After reconnection, stock Pi capture was still corrupt. A bounded camera-only
test requested one 1023-byte USB transaction with a 1024-byte buffer stride.
USBmon verified those lengths and offsets, and UVC COMMIT remained at 30 FPS.
The 45-second direct preview still failed, with scrambled bands and a green
lower region. FFmpeg emitted 1,958 diagnostic lines. The stock module was
restored. Do not ship this experiment.

A subsequent three-second binary USBmon check used stock UVC and printed
metadata only. All 1,049 captured nonempty payloads had valid 12-byte UVC
headers. There were no malformed nonempty headers or camera error flags.
Zero-length slots were counted separately. Reassembled frame metadata already
showed missing JPEG end markers before V4L2 decoding, and USBmon reported zero
dropped monitor events. Thus malformed-header rejection in UVC does not explain
this sample. USBmon observes host-controller output; it does not identify
whether missing bytes originate in the host controller, bus, power path, or
camera firmware interaction with that host.

Holding camera runtime power active and requesting a USB reset did not remove
the decode errors. The reset utility printed `failed [No such device]` despite
its zero exit code, so this is not proof of a successful hardware reset. The
original runtime-power policy was restored.

A stock-kernel video-only tryboot excluded `snd_usb_audio` before enumeration.
The absence of the module and unbound audio interfaces were verified. MJPEG
capture still reported entropy errors, overreads, and missing end markers.
The test files were removed and a normal reboot was requested to restore USB
audio. This experiment does not support ALSA initialization as the cause.

The device reports Jieli Technology, USB ID `4c4a:4a55`, product string
`USB Composite Device`, UVC name `DV20 USB`, revision `1.00`, and no serial.
These values do not identify a unique retail model or firmware build. The USB
descriptor requests up to 400 mA and negotiates high-speed USB 2.0.

A first-hand report for the same USB ID describes a green picture through a
USB 2 hub and working capture after moving to a USB 3 port:
[LinuxQuestions report](https://www.linuxquestions.org/questions/slackware-14/webcams-working-in-slackware-4175754098/).
This is a compatibility lead, not proof of the cause on this Pi. The available
Pi 3B+ cannot reproduce a test with a USB 3 host controller. A USB 3 hub connected
to its USB 2 host would not reproduce that change of host controller.

The real USB webcam and microphone transport checks pass on Windows Tauri and
the Android 15 Tauri emulator at 640×480. Windows also passes transport checks at 1280×720.
Android 720p is not accepted: the emulator renders 640×480 when 720p is requested.
Do not report that case as a successful HD test.

## Hardware and software

| Item | Observed value |
| --- | --- |
| Pi | Raspberry Pi 3 Model B Plus Rev 1.4; nominal 1 GB RAM; 905 MiB available |
| Architecture | aarch64 |
| OS | Raspberry Pi OS Lite, image reference 2026-10-06; Debian 13.7 Trixie |
| Image provenance | Cached download matches the official checksum; flashed bytes were not independently verified |
| Webcam | Jieli Technology USB Composite Device, USB ID 4c4a:4a55 |
| Stable video path | `/dev/v4l/by-id/usb-Jieli_Technology_USB_Composite_Device-video-index0` |
| Input video | MJPEG, 640×480 or 1280×720, 30 FPS |
| Other advertised video | YUYV 640×480 at 22 FPS; 320×240 at 25/30 FPS; not used by this spike |
| Microphone | USB Audio, ALSA card name `Device`, device 0 |
| Native audio | S16_LE, mono; 48 kHz capture tested |
| GStreamer | 1.26.2 on Pi; Rust bindings 0.24.5 |
| Rust | 1.93.1 ARM64; one build job; development debug information disabled |
| Windows receiver | Native Tauri WebView2, Edge 156.0.4314.58 |
| Android receiver | Native Tauri app in Android 15/API 35 emulator; WebView 124.0.6367.219 |

The Pi 4 remains the planned product target. These tests use the available
Pi 3B+ and do not establish Pi 4 compatibility. The exact image URL and checksum
are in [the OS image pin](../config/tested-os-image.json).

## Capture and transport checks

V4L2 MJPEG capture, JPEG decode, and x264 encoding completed to `fakesink`.
ALSA microphone capture and Opus encoding also completed to `fakesink`.
A separate three-second in-memory microphone check read 144,000 samples;
143,925 were nonzero. No audio samples were saved.

The `v4l2h264enc` factory exists, but its actual probe failed with
`Failed to process frame` and a possible driver/memory error. The tests use
the working software `x264enc` path. Factory presence is not proof of working
hardware encoding. The hardware encoder failure remains unresolved.

The sender captures MJPEG at 30 FPS, reduces it to 15 FPS, and sends H.264 at
approximately 1.5 Mbps. Microphone audio is converted to 48 kHz mono and sent
as Opus. No synthetic source is present in the real capture pipeline.

Signaling runs through authenticated SSH standard input/output. Media uses
WebRTC. No HTTP/WebSocket signaling listener, STUN service, or TURN service
is used. This is an operator-driven experiment, not product pairing.

## Sustained receiver results

Only one receiver ran at a time. Duration starts after initial media arrives;
it is not a stream-startup or physical-latency measurement.

| Receiver and requested preset | Duration | New decoded frames | Mean decoded FPS | Final video/audio packets lost | Result |
| --- | --- | --- | --- | --- | --- |
| Windows, VGA | 60.648 s | 910 | 15.00 | 0 / 0 | Pass |
| Android emulator, VGA | 60.931 s | 903 | 14.82 | 17 / 4 | Pass; no five-second progress gap |
| Windows, HD | 30.332 s | 455 | 15.00 | 0 / 0 | Pass; receiver reports 1280×720 |
| Android emulator, HD request | 30.547 s | 459 | 15.03 | 0 / 0 | HD failure; actual output is 640×480 |

Each run confirmed active H.264 and Opus codec IDs, advancing video/audio
counters, and a playing video element. The HD checks also confirmed positive
decoded-audio sample counters. Closing SSH input stopped the remote sender
with exit code zero, and the receiver cleared its old video. New sessions
reopened the camera and microphone without restarting the Pi.

The resource table below was measured with development sender SHA-256
`97a796373d50b852f7fb5c378b17bcaf56378de17b6dd461e0ea9f6c2f1dfc11`.
A later explicit post-decode dimension constraint does not resize frames;
it rejects a source that cannot retain the selected size. Final strict
dimension checks use sender SHA-256
`afe2c293c829e6bbee5ac0211cedf944f66a18f89aa5b92093308e55a6a87d62`.

## Short resource samples

`pidstat -h -u -r -C raspbaby-daemon 1` sampled the process once per second.
CPU percentages can exceed 100% because the process has several threads.
The four-core-capacity column divides that process CPU percentage by four;
it is not a measurement of total system CPU use. Samples include startup.

| Run | Active samples | Mean process CPU, one core = 100% | Mean share of four-core capacity | Peak RSS |
| --- | --- | --- | --- | --- |
| Windows VGA | 63 | 66.01% | 16.50% | 49.27 MiB |
| Android VGA | 66 | 65.91% | 16.48% | 50.07 MiB |
| Windows HD | 32 | 115.43% | 28.86% | 57.36 MiB |
| Android HD request, rendered VGA | 33 | 117.51% | 29.38% | 57.18 MiB |

The Pi reported `get_throttled=0x0` after the runs. These short samples do not
establish a memory-leak limit, a 24-hour stability result, or production-build
performance. Raw local reports stay outside Git.

## Android HD investigation

A repeat run checked both inbound frame dimensions and `video.videoWidth` /
`video.videoHeight`; all showed 640×480. Restarting the Android app without
erasing data did not resolve the mismatch. A strict 1280×720 assertion failed.

An isolated Pi capture/decode/encode probe negotiated 1280×720 at every stage.
The Android process selected `c2.goldfish.h264.decoder`; its logs showed
640×480 configuration/output and configuration warnings. They did not show
an explicit HD rejection. The root cause is not established. Do not describe
this as a proven emulator resolution limit or silently relabel VGA as HD.

Use VGA on this emulator. Test a current physical Android device before
accepting Android HD. Do not change the media engine to hide this failure.

## Remaining acceptance checks

- Audible output on physical client hardware and measured audio/video sync.
- Physical latency P50/P95 and notification latency when alerts exist.
- Pi 4 and physical Android testing.
- Two clients sharing one capture source; the spike currently serves one peer.
- Wi-Fi interruption, automatic reconnect, and long-running stability.
- Production pairing, identity pinning, authorization, and service installation.

The broad media feasibility gate remains open. Earlier real VGA transport
checks and the later clear direct DWC2 PIO capture are separate results.
Windows VGA and Android VGA playback with the experimental capture path now
have short native-application and visual evidence above. Physical Android and
longer-running checks remain.
The unimplemented product features are not part of these results.
