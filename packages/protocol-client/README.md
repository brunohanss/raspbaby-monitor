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
