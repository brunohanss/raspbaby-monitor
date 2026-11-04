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
  width?: number | null;
  height?: number | null;
  videoCodec?: string | null;
  audioLevel?: number | null;
  audioAvailable?: boolean;
}
interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}
interface ReceiverOptions {
  onUpdate: (update: ReceiverUpdate) => void;
  onStream: (stream: MediaStream | null) => void;
  onStats: (stats: MediaStats) => void;
  peerFactory?: () => RTCPeerConnection;
  streamFactory?: () => MediaStream;
  iceTimeoutMs?: number;
  visibilitySource?: VisibilitySource;
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
  private videoBytes = 0;
  private lastVideoProgressAt = 0;
  private lastDecodedProgressAt = 0;
  private resumeBaselinePending = false;
  private hidden = false;
  private visibilityRevision = 0;
  private visibility: VisibilitySource | undefined;
  private stats: MediaStats = { frames: 0, bytes: 0, packetsLost: 0 };

  constructor(private readonly options: ReceiverOptions) {
    this.visibility =
      options.visibilitySource ??
      (typeof document === "undefined" ? undefined : document);
  }

  private onVisibilityChange = () => {
    const hidden = this.visibility?.visibilityState === "hidden";
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    this.visibilityRevision++;
    if (!this.peer || !this.poll) return;
    if (hidden) {
      this.lastVideoProgressAt = Date.now();
    } else {
      // Hide the last frame immediately on return. The first stats read establishes
      // a baseline; only a later decoded frame can make the visible view live.
      this.resumeBaselinePending = true;
      this.lastDecodedProgressAt = Date.now();
      this.update(
        "connecting",
        "Waiting for a fresh decoded video frame after resuming.",
      );
      void this.sample(this.peer);
    }
  };

  private publishStats(stats: MediaStats) {
    this.stats = stats;
    this.options.onStats(stats);
  }

  private update(state: ReceiverState, detail: string) {
    this.options.onUpdate({ state, detail, lastMediaAt: this.lastMediaAt });
  }

  async start(): Promise<string> {
    this.close();
    this.frames = 0;
    this.videoBytes = 0;
    this.lastVideoProgressAt = 0;
    this.lastDecodedProgressAt = 0;
    this.resumeBaselinePending = false;
    this.hidden = this.visibility?.visibilityState === "hidden";
    this.lastMediaAt = null;
    this.publishStats({
      frames: 0,
      bytes: 0,
      packetsLost: 0,
      width: null,
      height: null,
      videoCodec: null,
      audioLevel: null,
      audioAvailable: false,
    });
    this.sessionId = crypto.randomUUID();
    const peer =
      this.options.peerFactory?.() ??
      new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.peer = peer;
    this.visibility?.addEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
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
        this.lastVideoProgressAt = this.connectedAt;
        this.lastDecodedProgressAt = this.connectedAt;
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
    this.lastVideoProgressAt = this.connectedAt;
    this.lastDecodedProgressAt = this.connectedAt;
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
      const visibilityRevision = this.visibilityRevision;
      const reports = await peer.getStats();
      if (peer !== this.peer || visibilityRevision !== this.visibilityRevision)
        return;
      let frames = 0;
      let bytes = 0;
      let packetsLost = 0;
      let videoBytes = 0;
      let width: number | null = null;
      let height: number | null = null;
      let videoCodec: string | null = null;
      let audioLevel: number | null = null;
      let audioAvailable = false;
      reports.forEach((report) => {
        if (report.type === "inbound-rtp") {
          bytes += Number(report.bytesReceived ?? 0);
          packetsLost += Number(report.packetsLost ?? 0);
          if (report.kind === "video" || report.mediaType === "video") {
            frames += Number(report.framesDecoded ?? 0);
            videoBytes += Number(report.bytesReceived ?? 0);
            if (typeof report.frameWidth === "number" && report.frameWidth > 0)
              width = report.frameWidth;
            if (
              typeof report.frameHeight === "number" &&
              report.frameHeight > 0
            )
              height = report.frameHeight;
            const codec = reports.get(report.codecId);
            if (typeof codec?.mimeType === "string")
              videoCodec = codec.mimeType;
          } else if (report.kind === "audio" || report.mediaType === "audio") {
            if (Number(report.bytesReceived ?? 0) > 0) audioAvailable = true;
            if (
              typeof report.audioLevel === "number" &&
              Number.isFinite(report.audioLevel) &&
              report.audioLevel >= 0 &&
              report.audioLevel <= 1
            )
              audioLevel = Math.max(audioLevel ?? 0, report.audioLevel);
          }
        }
      });
      const audioTracks =
        this.stream?.getTracks().filter((track) => track.kind === "audio") ??
        [];
      if (
        audioTracks.length &&
        !audioTracks.some(
          (track) => track.readyState === "live" && !track.muted,
        )
      )
        audioAvailable = false;
      if (!audioAvailable) audioLevel = null;
      this.publishStats({
        frames,
        bytes,
        packetsLost,
        width,
        height,
        videoCodec,
        audioLevel,
        audioAvailable,
      });
      const now = Date.now();
      if (videoBytes > this.videoBytes) this.lastVideoProgressAt = now;
      this.videoBytes = videoBytes;
      if (this.hidden) {
        if (frames > this.frames) this.lastMediaAt = now;
        this.frames = frames;
        if (now - this.lastVideoProgressAt > 5000) {
          this.fail(
            "No incoming video for 5 seconds while the app was hidden. The stream was cleared.",
          );
        } else if (videoBytes > 0) {
          this.update(
            this.lastMediaAt === null ? "connecting" : "receiving",
            "Video transport is active in the background. Visible playback is not being checked.",
          );
        }
        return;
      }
      if (this.resumeBaselinePending) {
        this.frames = frames;
        this.resumeBaselinePending = false;
      } else if (frames > this.frames) {
        this.frames = frames;
        this.lastMediaAt = now;
        this.lastDecodedProgressAt = now;
        this.update(
          "receiving",
          "Decoded video is arriving. Check audio and sync manually.",
        );
      } else if (now - this.lastDecodedProgressAt > 5000) {
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
    this.visibility?.removeEventListener(
      "visibilitychange",
      this.onVisibilityChange,
    );
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
    this.publishStats({
      ...this.stats,
      audioLevel: null,
      audioAvailable: false,
    });
    this.options.onStream(null);
  }
  close() {
    this.release();
    this.update("idle", "No media session.");
  }
}
