# Initial delivery status

The full approved backlog is in [the implementation plan](implementation-plan.md).
This file tracks the first work package and the monitoring work explicitly
requested by the user while RB-002 remains open.

| ID | Scope | Dependencies | Acceptance | Status |
| --- | --- | --- | --- | --- |
| RB-001 | Read-only Pi capability probe | Pi 4 and USB devices | Record capabilities and exact tested OS image | Available Pi 3B+ tested; image download pinned; Pi 4 pending |
| RB-002 | Synthetic and real H.264/Opus WebRTC spike | GStreamer; target WebViews | Both Tauri targets play media; record resource and recovery evidence | Real VGA stream passes both targets; full gate remains open |
| RB-003 | Initial architecture decisions | Plan review | Record evidence, boundaries, and unresolved risks | Initial ADRs added; final media decision pending |
| RB-010 | Rust workspace and crate boundaries | None | Build, unit tests, format, and Clippy pass | Foundation added; see validation report |
| RB-011 | Shared Tauri skeleton | Frontend toolchain; mobile SDK | Start Windows and Android apps | Windows and Android emulator built, launched, and tested |
| RB-012 | Initial CI | RB-010; RB-011 | Run quality checks on pull requests | Initial hosted run passes all five jobs; branch protection pending |
| User-approved monitoring | Real Pi analysis, metadata, history, and local activity sounds | Real capture; existing trusted SSH session | Record real inputs and separate event counts from repeat playback | Implemented; initial live evidence recorded; final repeat-policy runtime checks pending |

Automated tests cover protocol input limits, media configuration, receiver
failure handling, capability probe errors, motion/sound analysis, and client
activity policy. Real motion/sound detection, Pi CPU temperature, bounded local
history, and activity sounds are implemented. Pairing, discovery, automatic
reconnect, and production provisioning remain pending. See
[validation](validation.md) for executed checks.

Next action: Complete sync, latency, two-client resource, and long-running
checks. Test the planned Pi 4 and a physical Android device. Review the real
camera evidence before expanding the product scope. Close the media gate only
after its remaining acceptance checks pass.

## Selected activity alert sound

Use the same Murloc sound for each motion alert and each sound-activity alert.
Use the exact clip selected by the user:
[Sound of a Murloc](https://www.youtube.com/watch?v=qMPpnCvCZvw).
Keep imported audio local to each client, as specified in section 8.3 of the
implementation plan. Do not replace it with a generated imitation. The local
sound setting, preview, and real activity triggers are implemented at the user's
request. Play while motion **or** sound is active, repeat every five seconds by
default (configurable 5–60 seconds), and prevent overlapping playback. Repeats
must not add history events. Camera mute does not disable analysis or meters.

Real analysis uses 320×180 GRAY8 at 5 FPS and 100 ms microphone RMS windows.
Detector cooldown defaults are zero so new confirmed episodes are counted.
Ordered, reliable WebRTC metadata replaces no part of SSH signaling. Each
client retains at most 500 event rows and 90 nightly summaries; graphs show
18:00–08:00 local time and seven nights. Synthetic tests do not emit detections.
Cry recognition is not implemented. Physical audio/sync, multiple clients,
latency, and long-running monitoring remain acceptance work.
