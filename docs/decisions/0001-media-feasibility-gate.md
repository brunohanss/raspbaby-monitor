# ADR 0001: Validate GStreamer before product features

Status: Accepted for the feasibility spike. Real Pi 3B+ transport is tested;
full feasibility acceptance remains open.

## Context

The approved plan requires GStreamer `webrtcbin`, H.264 video, and Opus audio.
The first target is a Raspberry Pi 4 with 1 GB RAM. The camera model is unknown.
The initial development machine has Rust, Node.js, and Android SDK tools.
GStreamer and a connected Raspberry Pi were not found during the initial check.

## Decision

Build a small Rust media spike with synthetic video and audio. Put native
GStreamer code behind an explicit Cargo feature. Use the same receiver in the
Windows and Android Tauri application. Keep the source choice explicit.

Use local manual SDP exchange or authenticated SSH stdio for this spike.
Do not start an HTTP or WebSocket
signaling server. Do not configure public STUN or TURN servers. This workflow
requires an operator at each end. It is not the production pairing protocol.
Exchange SDP only through a trusted local channel. SDP can contain local network
addresses and fingerprints. Do not commit SDP or include it in public reports.

WebRTC handles encrypted media. The prototype must not record media.
Do not add discovery, detection, alerts, or installation services until media
plays in both target WebViews and the feasibility evidence is recorded.

## Consequences

Default Rust tests can run without native GStreamer libraries. A separate native
build must check the actual media feature. Neither a successful build nor a
synthetic browser test proves Raspberry Pi camera compatibility.

Keep the gate open until the checks in `docs/feasibility.md` pass. Do not change
the media engine merely because a plugin is missing on the development host.
