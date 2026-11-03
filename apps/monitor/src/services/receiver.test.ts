import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaReceiver, type ReceiverUpdate } from "./receiver";

class FakePeer extends EventTarget {
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
  getStats = vi.fn(
    async () =>
      new Map([
        [
          "video",
          {
            type: "inbound-rtp",
            kind: "video",
            framesDecoded: this.decoded,
            bytesReceived: 100,
            packetsLost: 0,
          },
        ],
      ]),
  );
}

describe("manual media receiver", () => {
  let peer: FakePeer;
  let receiver: MediaReceiver;
  let updates: ReceiverUpdate[];
  let onStream: ReturnType<typeof vi.fn<(stream: MediaStream | null) => void>>;
  let stop: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: () => ({ codecs: [{ mimeType: "video/H264" }] }),
    });
    peer = new FakePeer();
    updates = [];
    onStream = vi.fn<(stream: MediaStream | null) => void>();
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
      onStats: vi.fn(),
      iceTimeoutMs: 100,
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
