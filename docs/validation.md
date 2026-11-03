# Initial validation

Date: 2026-11-03. Host: Windows x86-64. Rust: 1.93.1.
Node: 24.21.0. pnpm: 12.8.2. GStreamer MSVC: 1.28.8.

## Executed checks

| Task | Check | Result |
| --- | --- | --- |
| RB-001 | Python capability probe error tests | 3 passed |
| RB-010 | Default Rust unit tests | 10 passed |
| RB-010 | Cargo Fmt and Clippy with warnings denied | Passed |
| RB-010 | Generated TypeScript contract drift check | Passed |
| RB-002 | Native GStreamer build, unit tests, and Clippy | Passed |
| RB-002 | Required synthetic media plugins | Present |
| RB-002 | Native sender to Playwright Chromium | Decoded video and inbound audio; sender-exit cleanup passed |
| RB-002 | Native sender to Windows Tauri WebView2 | Decoded video and inbound audio; sender-exit cleanup passed |
| RB-011 | Shared frontend type check and lint | Passed |
| RB-011 | Frontend unit tests | 9 passed |
| RB-011 | Production frontend build and source format | Passed |
| RB-011 | Windows Tauri debug build without bundle | Passed |
| RB-011 | Android project generation | Passed |
| RB-012 | Frontend dependency audit | No known vulnerabilities found |
| RB-012 | Rust dependency audit | No blocking vulnerability; 2 advisory warnings |

The Rust audit reports `proc-macro-error` 1.0.4 as unmaintained
(RUSTSEC-2024-0370) and `glib` 0.18.5 iterator unsoundness
(RUSTSEC-2024-0429). These are transitive Linux GUI dependencies in Tauri's
dependency tree. No local advisory suppression was added. Review upstream
updates before a production release. An audit pass does not establish security.

## Open checks

Initial native tests exposed literal H.264 caps matching during SDP negotiation
and packet loss from a leaky queue after the RTP payloader. The sender now
negotiates in Ready state and drops raw buffers before encoding. RTP queues
apply bounded backpressure. Both Chromium and Windows WebView2 smoke tests
passed after these fixes. Short counter samples showed 11 and 13 decoded frames,
respectively, with received audio bytes. These are functional checks, not
latency, sync, resource, or sustained packet-loss benchmarks.

Audible output, Android APK build and playback, real Raspberry Pi capture,
latency, sync, two-client resource use, and soak tests remain pending.
The media feasibility gate remains open. No performance numbers are published.

GitHub Actions defines Rust, native media, frontend, Windows shell, and
dependency audit jobs. Its remote result is separate from local validation.
Branch protection is not configured by this change.

## Files and behavior by task

- RB-001: `scripts/probe_pi.py` and `tests/test_probe_pi.py` collect read-only
  capabilities and test missing tools, timeouts, and failed commands.
- RB-002: `crates/raspbaby-media`, `crates/raspbaby-daemon`, and
  `apps/monitor/scripts/media-integration.mjs` implement and exercise the spike.
- RB-003: `docs/decisions` records the media, security, and OS boundaries.
- RB-010: `Cargo.toml`, the lockfile, and `crates` define the Rust workspace.
- RB-011: `apps/monitor` and `packages/protocol-client` provide the receiver
  shell, shared types, runtime validation, and receiver failure tests.
- RB-012: `.github/workflows/ci.yml` defines repeatable quality checks.

The approved plan is preserved in `docs/implementation-plan.md`. README,
development, protocol, security, backlog, and feasibility documents describe
the implemented scope and limits. Optional product features remain deferred.
