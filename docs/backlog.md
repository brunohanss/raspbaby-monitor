# Initial delivery status

The full approved backlog is in [the implementation plan](implementation-plan.md).
This file tracks the first work package. Later phases remain gated by RB-002.

| ID | Scope | Dependencies | Acceptance | Status |
| --- | --- | --- | --- | --- |
| RB-001 | Read-only Pi capability probe | Pi 4 and USB devices | Record capabilities and exact tested OS image | Available Pi 3B+ tested; image download pinned; Pi 4 pending |
| RB-002 | Synthetic and real H.264/Opus WebRTC spike | GStreamer; target WebViews | Both Tauri targets play media; record resource and recovery evidence | Real VGA stream passes both targets; full gate remains open |
| RB-003 | Initial architecture decisions | Plan review | Record evidence, boundaries, and unresolved risks | Initial ADRs added; final media decision pending |
| RB-010 | Rust workspace and crate boundaries | None | Build, unit tests, format, and Clippy pass | Foundation added; see validation report |
| RB-011 | Shared Tauri skeleton | Frontend toolchain; mobile SDK | Start Windows and Android apps | Windows and Android emulator built, launched, and tested |
| RB-012 | Initial CI | RB-010; RB-011 | Run quality checks on pull requests | Initial hosted run passes all five jobs; branch protection pending |

Automated tests cover protocol input limits, media configuration, receiver
failure handling, and capability probe errors. Detection algorithms and product
features remain deferred. See [validation](validation.md) for executed checks.

Next action: Complete sync, latency, two-client resource, and long-running
checks. Test the planned Pi 4 and a physical Android device. Review the real
camera evidence before starting product features. Close the media gate only
after its remaining acceptance checks pass.

## Selected activity alert sound

Use the same Murloc sound for each motion alert and each sound-activity alert.
Use the exact clip selected by the user:
[Sound of a Murloc](https://www.youtube.com/watch?v=qMPpnCvCZvw).
Keep imported audio local to each client, as specified in section 8.3 of the
implementation plan. Do not replace it with a generated imitation. The local
sound setting and preview can be prepared now at the user's request. Automatic
motion and sound triggers remain dependent on the detection and alert phases.
