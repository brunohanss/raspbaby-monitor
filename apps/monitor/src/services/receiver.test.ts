import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryMessage } from "@raspbaby/protocol-client";
import {
  MediaReceiver,
  type MediaStats,
  type ReceiverUpdate,
} from "./receiver";

class FakeVisibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  set(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakePeer extends EventTarget {
  channel = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    onclose: null as (() => void) | null,
    close: vi.fn(),
  };
  createDataChannel = vi.fn(() => this.channel);
  iceGatheringState = "complete";
  connectionState = "new";
  localDescription: { sdp: string } | null = null;
  ontrack: ((event: { track: MediaStreamTrack }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  addTransceiver = vi.fn(() => ({ setCodecPreferences: vi.fn() }));
  createOffer = vi.fn(async () => ({
    type: "offer",
    sdp: "v=0\r\nm=video\r\nm=audio\r\n",
  }));
  setLocalDescription = vi.fn(async (description: { sdp: string }) => {
    this.localDescription = description;
  });
  setRemoteDescription = vi.fn(async () => undefined);
  close = vi.fn();
  decoded = 0;
  videoBytes = 100;
  audioBytes = 0;
  audioLevel: number | undefined;
  width: number | undefined;
  height: number | undefined;
  getStats = vi.fn(
    async () =>
      new Map<string, Record<string, unknown>>([
        [
          "video",
          {
            type: "inbound-rtp",
            kind: "video",
            framesDecoded: this.decoded,
            bytesReceived: this.videoBytes,
            packetsLost: 0,
            frameWidth: this.width,
            frameHeight: this.height,
            codecId: "videoCodec",
          },
        ],
        [
          "audio",
          {
            type: "inbound-rtp",
            kind: "audio",
            bytesReceived: this.audioBytes,
            audioLevel: this.audioLevel,
          },
        ],
        ["videoCodec", { type: "codec", mimeType: "video/H264" }],
      ]),
  );
}

describe("manual media receiver", () => {
  let peer: FakePeer;
  let receiver: MediaReceiver;
  let updates: ReceiverUpdate[];
  let measured: MediaStats[];
  let visibility: FakeVisibility;
  let onTelemetry: ReturnType<
    typeof vi.fn<(message: TelemetryMessage | null) => void>
  >;
  let onStream: ReturnType<typeof vi.fn<(stream: MediaStream | null) => void>>;
  let stop: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }),
    });
    peer = new FakePeer();
    updates = [];
    measured = [];
    visibility = new FakeVisibility();
    onStream = vi.fn<(stream: MediaStream | null) => void>();
    onTelemetry = vi.fn<(message: TelemetryMessage | null) => void>();
    stop = vi.fn<() => void>();
    receiver = new MediaReceiver({
      peerFactory: () => peer as unknown as RTCPeerConnection,
      streamFactory: () =>
        ({
          addTrack: vi.fn(),
          getTracks: () => [{ stop, onended: null }],
        }) as unknown as MediaStream,
      onUpdate: (update) => updates.push(update),
      onStream,
      onStats: (stats) => measured.push(stats),
      onTelemetry,
      iceTimeoutMs: 100,
      visibilitySource: visibility,
    });
  });
  afterEach(() => {
    receiver.close();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("creates a receive-only video-first offer with a session identifier", async () => {
    const offer = JSON.parse(await receiver.start());
    expect(offer).toMatchObject({ protocol_version: 1, type: "webrtc.offer" });
    expect(offer.session_id).toBeTruthy();
    expect(peer.addTransceiver.mock.calls).toEqual([
      ["video", { direction: "recvonly" }],
      ["audio", { direction: "recvonly" }],
    ]);
    expect(updates.at(-1)?.state).toBe("awaiting-answer");
    expect(peer.createDataChannel).toHaveBeenCalledWith("raspbaby-monitor", {
      ordered: true,
    });
  });

  it("accepts ordered Pi telemetry, ignores invalid and replayed messages, and clears stale readings", async () => {
    const offer = JSON.parse(await receiver.start());
    await receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" }));
    const message = {
      protocol_version: 1,
      type: "monitor.telemetry",
      device_id: "pi-test",
      sequence: 1,
      timestamp_ms: Date.now(),
      temperature_c: 51.3,
      audio_level: 0.6,
      motion_active: true,
      sound_active: false,
      dropped_events: 0,
      events: [{ id: "motion-1", kind: "motion", timestamp_ms: Date.now() }],
    };
    peer.channel.onmessage?.({ data: JSON.stringify(message) });
    expect(onTelemetry).toHaveBeenLastCalledWith(message);
    const accepted = onTelemetry.mock.calls.length;
    peer.channel.onmessage?.({ data: JSON.stringify(message) });
    peer.channel.onmessage?.({ data: "invalid" });
    peer.channel.onmessage?.({
      data: JSON.stringify({
        ...message,
        sequence: 2,
        device_id: "another-pi",
      }),
    });
    expect(onTelemetry).toHaveBeenCalledTimes(accepted);
    for (let second = 0; second < 11; second++) {
      peer.decoded++;
      peer.videoBytes += 100;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(onTelemetry).toHaveBeenLastCalledWith(null);
    expect(peer.close).not.toHaveBeenCalled();
    peer.channel.onmessage?.({
      data: JSON.stringify({ ...message, sequence: 2 }),
    });
    expect(onTelemetry).toHaveBeenLastCalledWith({ ...message, sequence: 2 });
    receiver.close();
    expect(peer.channel.close).toHaveBeenCalled();
    expect(onTelemetry).toHaveBeenLastCalledWith(null);
  });

  it("rejects wrong sessions and message kinds before setting remote SDP", async () => {
    const offer = JSON.parse(await receiver.start());
    await expect(
      receiver.accept(
        JSON.stringify({
          ...offer,
          type: "webrtc.answer",
          session_id: "other",
        }),
      ),
    ).rejects.toThrow("another session");
    await expect(receiver.accept(JSON.stringify(offer))).rejects.toThrow(
      "webrtc.answer",
    );
    expect(peer.setRemoteDescription).not.toHaveBeenCalled();
  });

  it("waits for complete ICE and fails closed on timeout", async () => {
    peer.iceGatheringState = "gathering";
    const pending = expect(receiver.start()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(101);
    await pending;
    expect(peer.close).toHaveBeenCalled();
    expect(onStream).toHaveBeenLastCalledWith(null);
    expect(updates.at(-1)?.state).toBe("failed");
  });

  it("does not claim media is receiving until decoded frames advance; clears a stale stream", async () => {
    const offer = JSON.parse(await receiver.start());
    await receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" }));
    expect(updates.at(-1)?.state).toBe("connecting");
    peer.decoded = 1;
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)?.state).toBe("receiving");
    await vi.advanceTimersByTimeAsync(6000);
    expect(updates.at(-1)?.state).toBe("failed");
    expect(onStream).toHaveBeenLastCalledWith(null);
    expect(stop).toHaveBeenCalled();
  });

  it("clears the stream immediately when the connection disconnects", async () => {
    await receiver.start();
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    expect(updates.at(-1)?.state).toBe("disconnected");
    expect(peer.close).toHaveBeenCalled();
    expect(onStream).toHaveBeenLastCalledWith(null);
  });

  it("retains a hidden connection with progressing video bytes even when decoding pauses", async () => {
    const offer = JSON.parse(await receiver.start());
    await receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" }));
    peer.decoded = 1;
    await vi.advanceTimersByTimeAsync(1000);
    visibility.set("hidden");
    for (let second = 0; second < 8; second++) {
      peer.videoBytes += 100;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(updates.at(-1)?.state).toBe("receiving");
    expect(peer.close).not.toHaveBeenCalled();

    visibility.set("visible");
    expect(updates.at(-1)?.state).toBe("connecting");
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)?.state).toBe("connecting");
    peer.decoded = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(updates.at(-1)?.state).toBe("receiving");
  });

  it("clears stalled hidden video even if audio bytes keep arriving", async () => {
    const offer = JSON.parse(await receiver.start());
    await receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" }));
    peer.decoded = 1;
    await vi.advanceTimersByTimeAsync(1000);
    visibility.set("hidden");
    for (let second = 0; second < 6; second++) {
      peer.audioBytes += 100;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(updates.at(-1)?.state).toBe("failed");
    expect(peer.close).toHaveBeenCalled();
    expect(onStream).toHaveBeenLastCalledWith(null);
  });

  it("clears the old visible frame after resume when bytes arrive but decoding does not resume", async () => {
    const offer = JSON.parse(await receiver.start());
    await receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" }));
    peer.decoded = 1;
    await vi.advanceTimersByTimeAsync(1000);
    visibility.set("hidden");
    peer.videoBytes += 100;
    await vi.advanceTimersByTimeAsync(1000);
    visibility.set("visible");
    expect(updates.at(-1)?.state).toBe("connecting");
    for (let second = 0; second < 6; second++) {
      peer.videoBytes += 100;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(updates.at(-1)?.state).toBe("failed");
    expect(onStream).toHaveBeenLastCalledWith(null);
  });

  it("publishes only observed dimensions, codec, and audio levels; missing levels remain unknown", async () => {
    const offer = JSON.parse(await receiver.start());
    await receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" }));
    peer.decoded = 1;
    peer.audioBytes = 100;
    peer.width = 1280;
    peer.height = 720;
    await vi.advanceTimersByTimeAsync(1000);
    expect(measured.at(-1)).toMatchObject({
      width: 1280,
      height: 720,
      videoCodec: "video/H264",
      audioAvailable: true,
      audioLevel: null,
    });
    peer.audioLevel = 0.42;
    peer.decoded++;
    await vi.advanceTimersByTimeAsync(1000);
    expect(measured.at(-1)?.audioLevel).toBe(0.42);
    peer.audioLevel = 0;
    peer.decoded++;
    await vi.advanceTimersByTimeAsync(1000);
    expect(measured.at(-1)?.audioLevel).toBe(0);
    peer.audioLevel = 2;
    peer.decoded++;
    await vi.advanceTimersByTimeAsync(1000);
    expect(measured.at(-1)?.audioLevel).toBeNull();
    receiver.close();
    expect(measured.at(-1)).toMatchObject({
      audioLevel: null,
      audioAvailable: false,
    });
  });

  it("closes the peer when its answer SDP is rejected", async () => {
    const offer = JSON.parse(await receiver.start());
    peer.setRemoteDescription.mockRejectedValueOnce(new Error("invalid SDP"));
    await expect(
      receiver.accept(JSON.stringify({ ...offer, type: "webrtc.answer" })),
    ).rejects.toThrow("invalid SDP");
    expect(peer.close).toHaveBeenCalled();
    expect(updates.at(-1)?.state).toBe("failed");
    expect(onStream).toHaveBeenLastCalledWith(null);
  });
});
