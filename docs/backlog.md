# Initial delivery status

The full approved backlog is in [the implementation plan](implementation-plan.md).
This file tracks the first work package. Later phases remain gated by RB-002.

| ID | Scope | Dependencies | Acceptance | Status |
| --- | --- | --- | --- | --- |
| RB-001 | Read-only Pi capability probe | Pi 4 and USB devices | Record capabilities and exact tested OS image | Probe added; hardware test pending |
| RB-002 | Synthetic H.264/Opus WebRTC spike | GStreamer; target WebViews | Both Tauri targets play media; record resource and recovery evidence | Prototype in progress; runtime gate open |
| RB-003 | Initial architecture decisions | Plan review | Record evidence, boundaries, and unresolved risks | Initial ADRs added; final media decision pending |
| RB-010 | Rust workspace and crate boundaries | None | Build, unit tests, format, and Clippy pass | Foundation added; see validation report |
| RB-011 | Shared Tauri skeleton | Frontend toolchain; mobile SDK | Start Windows and Android apps | Skeleton added; platform runtime checks pending |
| RB-012 | Initial CI | RB-010; RB-011 | Run quality checks on pull requests | Workflow added; remote run pending |

Automated tests cover protocol input limits, media configuration, receiver
failure handling, and capability probe errors. Detection algorithms and product
features remain deferred. See [validation](validation.md) for executed checks.

Next action: Install the native GStreamer development/runtime packages, run the
media spike, then run it on the Pi and both Tauri platforms. Close the media gate
only after all acceptance checks pass. Do not treat a pending check as complete.
