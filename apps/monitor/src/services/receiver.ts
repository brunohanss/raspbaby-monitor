import { createOffer, parseSignalingMessage } from "@raspbaby/protocol-client";

export type ReceiverState =
  | "idle"
  | "gathering"
  | "awaiting-answer"
  | "connecting"
  | "receiving"
  | "disconnected"
  | "failed";
export interface ReceiverUpdate {
  state: ReceiverState;
  detail: string;
  lastMediaAt: number | null;
}
export interface MediaStats {
  frames: number;
  bytes: number;
  packetsLost: number;
}
interface ReceiverOptions {
  onUpdate: (update: ReceiverUpdate) => void;
  onStream: (stream: MediaStream | null) => void;
  onStats: (stats: MediaStats) => void;
  peerFactory?: () => RTCPeerConnection;
  streamFactory?: () => MediaStream;
  iceTimeoutMs?: number;
}

/** A single manual, local-only experiment. No device permission or capture is requested. */
export class MediaReceiver {
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private sessionId = "";
  private poll: ReturnType<typeof setInterval> | undefined;
  private cancelGather: (() => void) | undefined;
  private frames = 0;
  private lastMediaAt: number | null = null;
  private connectedAt = 0;
  private awaitingAnswer = false;

  constructor(private readonly options: ReceiverOptions) {}

  private update(state: ReceiverState, detail: string) {
    this.options.onUpdate({ state, detail, lastMediaAt: this.lastMediaAt });
  }

  async start(): Promise<string> {
    this.close();
    this.frames = 0;
    this.lastMediaAt = null;
    this.options.onStats({ frames: 0, bytes: 0, packetsLost: 0 });
    this.sessionId = crypto.randomUUID();
    const peer =
      this.options.peerFactory?.() ??
      new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.peer = peer;
    this.stream = this.options.streamFactory?.() ?? new MediaStream();
    this.update("gathering", "Collecting local network candidates…");
    peer.ontrack = ({ track }) => {
      if (this.peer !== peer) return;
      this.stream?.addTrack(track);
      track.onended = () =>
        this.fail("A media track ended. Create a new offer.");
      this.options.onStream(this.stream);
    };
    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return;
      if (["disconnected", "failed", "closed"].includes(peer.connectionState)) {
        const state =
          peer.connectionState === "failed" ? "failed" : "disconnected";
        this.release();
        this.update(
          state,
          "Media connection lost. Create a new offer to retry.",
        );
      } else if (peer.connectionState === "connected") {
        this.connectedAt = Date.now();
        this.update("connecting", "Peer connected. Waiting for decoded video.");
        this.poll ??= setInterval(() => {
          void this.sample(peer);
        }, 1000);
      }
    };
    try {
      for (const kind of ["video", "audio"] as const) {
        const transceiver = peer.addTransceiver(kind, {
          direction: "recvonly",
        });
        const capabilities = RTCRtpReceiver.getCapabilities(kind);
        const preferred = capabilities?.codecs.filter(
          (codec) =>
            codec.mimeType.toLowerCase() ===
            (kind === "video" ? "video/h264" : "audio/opus"),
        );
        if (preferred?.length) transceiver.setCodecPreferences(preferred);
      }
      await peer.setLocalDescription(await peer.createOffer());
      await this.gather(peer);
      if (this.peer !== peer) throw new Error("Session stopped.");
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("The WebView did not create an SDP offer.");
      this.awaitingAnswer = true;
      this.update(
        "awaiting-answer",
        "Offer ready. Transfer it through a trusted terminal.",
      );
      return JSON.stringify(createOffer(this.sessionId, sdp));
    } catch (error) {
      if (this.peer === peer)
        this.fail(
          error instanceof Error ? error.message : "Offer creation failed.",
        );
      throw error;
    }
  }

  async accept(raw: string): Promise<void> {
    const answer = parseSignalingMessage(raw);
    if (answer.type !== "webrtc.answer")
      throw new Error("Paste a webrtc.answer message.");
    if (answer.session_id !== this.sessionId)
      throw new Error(
        "Answer belongs to another session. Create a fresh offer.",
      );
    const peer = this.peer;
    if (!peer || !this.awaitingAnswer)
      throw new Error("Create an offer before applying an answer.");
    try {
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    } catch (error) {
      if (this.peer === peer)
        this.fail("The WebView rejected the answer SDP. Create a new offer.");
      throw error;
    }
    if (this.peer !== peer) return;
    this.awaitingAnswer = false;
    this.connectedAt = Date.now();
    this.update("connecting", "Answer accepted. Waiting for media.");
    // Also bound negotiation: some runtimes never report a failed ICE state.
    this.poll ??= setInterval(() => {
      void this.sample(peer);
    }, 1000);
  }

  private gather(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        peer.removeEventListener("icegatheringstatechange", changed);
        this.cancelGather = undefined;
        if (error) reject(error);
        else resolve();
      };
      const changed = () => {
        if (peer.iceGatheringState === "complete") done();
      };
      const timer = setTimeout(
        () =>
          done(
            new Error(
              "ICE gathering timed out. Check local network access and retry.",
            ),
          ),
        this.options.iceTimeoutMs ?? 15000,
      );
      this.cancelGather = () => done(new Error("Session stopped."));
      peer.addEventListener("icegatheringstatechange", changed);
      changed();
    });
  }

  private async sample(peer: RTCPeerConnection) {
    try {
      const reports = await peer.getStats();
      if (peer !== this.peer) return;
      let frames = 0;
      let bytes = 0;
      let packetsLost = 0;
      reports.forEach((report) => {
        if (report.type === "inbound-rtp") {
          bytes += Number(report.bytesReceived ?? 0);
          packetsLost += Number(report.packetsLost ?? 0);
          if (report.kind === "video" || report.mediaType === "video")
            frames += Number(report.framesDecoded ?? 0);
        }
      });
      this.options.onStats({ frames, bytes, packetsLost });
      if (frames > this.frames) {
        this.frames = frames;
        this.lastMediaAt = Date.now();
        this.update(
          "receiving",
          "Decoded video is arriving. Check audio and sync manually.",
        );
      } else if (Date.now() - (this.lastMediaAt ?? this.connectedAt) > 5000) {
        this.fail(
          "No new decoded video for 5 seconds. The previous frame was cleared.",
        );
      }
    } catch {
      if (peer === this.peer)
        this.fail("Could not read media health. Create a new offer.");
    }
  }

  private fail(detail: string) {
    this.release();
    this.update("failed", detail);
  }
  private release() {
    this.cancelGather?.();
    clearInterval(this.poll);
    this.poll = undefined;
    const peer = this.peer;
    this.peer = null;
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    for (const track of this.stream?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.stream = null;
    this.awaitingAnswer = false;
    this.options.onStream(null);
  }
  close() {
    this.release();
    this.update("idle", "No media session.");
  }
}
