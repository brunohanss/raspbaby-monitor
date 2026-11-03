# Native media test notes

Test date: 2026-11-03. Host: Windows. Native runtime: GStreamer 1.28.8 MSVC x86-64. Rust bindings: 0.24.5.

The synthetic source uses H.264 video and mono Opus audio. The receiver creates a video-first, audio-second offer. A local operator transfers the bounded JSON messages through standard input and output. The spike does not open a network signaling service or write media files.

## H.264 negotiation

An initial test rejected the video media section or marked it inactive. The encoder produced constrained-baseline `profile-level-id=42c016` at VGA. The browser offered constrained-baseline `42e01f`. These values describe different H.264 level and constraint limits.

GStreamer 1.28 `webrtcbin` intersects the offer caps with the current source caps. Its answer path uses a normal caps intersection. The literal values can therefore prevent selection of a compatible constrained-baseline stream. See the [`_create_answer_task` implementation](https://github.com/GStreamer/gstreamer/blob/1.28/subprojects/gst-plugins-bad/ext/webrtc/gstwebrtcbin.c).

The prototype now sets the pipeline to `Ready`, exchanges SDP from the upstream codec capabilities, and then sets the pipeline to `Playing`. The encoder starts after local SDP is set. This order lets GStreamer negotiate the receiver's codec limits before the encoder supplies its actual lower-level stream caps. No SPS bytes or SDP profile fields are rewritten. Explicit `peer.sink_0` and `peer.sink_1` links keep video and audio associated with the required offer order.

## RTP packet loss

An initial pipeline put a three-buffer leaky queue after each RTP payloader. One H.264 frame can contain many RTP packets. The queue discarded packets from the same frame. Receivers reported incoming bytes but decoded no video.

The pipeline now discards old raw buffers before each encoder. The RTP queues use bounded buffers with backpressure. They do not discard RTP packets. See the [GStreamer queue behavior](https://gstreamer.freedesktop.org/documentation/coreelements/queue.html). A regression test checks both presets and both media branches.

## Observed result

After these changes, the local integration test received H.264 video and Opus audio in both Playwright Chromium and the actual Windows Tauri WebView2 application. The test also confirmed that sender exit removes the old video frame. The first successful samples contained 11 decoded video frames in Chromium and 13 in WebView2, with zero reported lost packets.

These are functional smoke tests. They do not establish latency, CPU, memory, audio/video synchronization, long-run stability, Android playback, or Raspberry Pi capture performance. Those checks remain required before the media feasibility gate can pass.
