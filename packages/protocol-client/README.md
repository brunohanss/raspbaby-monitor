# Local feasibility signaling

This package validates JSON for the Phase 0 media test. Copy each complete offer or answer through local standard input and output. Wait for ICE gathering to finish before you copy a message. Do not use trickle ICE in this test.

The browser creates `webrtc.offer`. The media process returns `webrtc.answer` with the same session ID. Use `parseSignalingMessage` before you accept a message. Check its type and session ID against the active peer connection.

The supported major version is 1. Reject all other versions. Ignore unknown optional fields. Limit each JSON message to 98,304 UTF-8 bytes, each SDP to 65,536 bytes, and each session ID to 64 ASCII letters, digits, dots, underscores, or hyphens. Empty SDP and empty session IDs are invalid. The WebRTC engine checks SDP syntax.

These messages do not authenticate a peer. Do not expose a signaling HTTP or WebSocket endpoint. Production signaling needs authenticated TLS and pairing after the media gate passes.

Rust types and limits are the source of the generated TypeScript contract. To update it in PowerShell, run:

```powershell
$env:UPDATE_PROTOCOL_TYPES = '1'
cargo test -p raspbaby-protocol generated_contract_is_current
Remove-Item Env:UPDATE_PROTOCOL_TYPES
```

Run `cargo test -p raspbaby-protocol` to check that the committed contract matches the Rust types. Run `pnpm --filter @raspbaby/protocol-client test` to check the client validator.

## Analysis telemetry

`parseTelemetryMessage(raw)` validates the separate `monitor.telemetry` contract.
It accepts at most 8,192 UTF-8 bytes and 32 events per message. The generated
`TelemetryMessage` and `TelemetryEvent` types come from the Rust protocol crate.
The existing offer/answer contract is unchanged.

Telemetry contains `device_id`, `sequence`, `timestamp_ms`, `temperature_c`,
`audio_level`, `motion_active`, `sound_active`, `dropped_events`, and `events`. Each event has
`id`, `kind` (`motion` or `sound`), and `timestamp_ms`. Timestamps are nonnegative
Unix milliseconds, supported through 2100-01-01. Events cannot be later than
their containing message. Sequence and drop counters are JavaScript-safe
nonnegative integers. A batch cannot contain duplicate event IDs.

IDs contain 1 to 64 ASCII letters, digits, dots, underscores, or hyphens. Use a
timestamp and counter in event IDs to avoid collisions after a daemon restart.
Temperature must be finite and within -40 to 125 °C, or null. When sourced from
the Pi thermal interface, it is CPU temperature; label it clearly. It does not
measure room or body temperature. Audio level is finite linear RMS from 0 to 1,
or null when unavailable. Missing nullable measurements default to null; a
missing drop counter defaults to zero. A null drop counter is invalid.
An absent `sound_active` defaults to false for older messages. A present sound
state must be boolean. Motion and sound are separate states: either can drive
a client alert. Event onsets count new activity episodes; client repeat-alert
intervals must not suppress history entries or create extra detector events.

Telemetry never includes raw frames, PCM, or credentials. A motion or sound
event does not prove reliable baby or crying recognition. Local history and
nightly graphs are client responsibilities; this package does not persist data.
