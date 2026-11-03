# Feasibility signaling protocol

This contract applies only to manual local signaling. It does not authenticate
the peer. Production control and event envelopes remain deferred.

Each message is one UTF-8 JSON line. The line has these fields:

| Field | Rule |
| --- | --- |
| `protocol_version` | Integer `1`; reject other major versions |
| `type` | `webrtc.offer` or `webrtc.answer` |
| `session_id` | 1 to 64 ASCII letters, digits, `_`, `-`, or `.` |
| `sdp` | Non-empty SDP, at most 65,536 UTF-8 bytes |

The JSON object is at most 98,304 UTF-8 bytes. Unknown optional fields are
ignored. An answer must match the current offer session. Rust generates the
TypeScript contract through ts-rs; a test checks for generation drift.

The browser creates receive-only video, then audio, and gathers all local ICE
candidates before exporting the offer. The daemon selects compatible offered
H.264 and Opus payload types and returns a complete answer. No trickle ICE,
remote configuration, event stream, or pairing route exists in this spike.

The initial spike requires constrained-baseline H.264, packetization mode 1,
and 48 kHz Opus. Unsupported offers fail with an error. No public ICE server is
configured. Exchange messages only with the intended peer through a trusted
local channel. Keep SDP out of issues and commits.
