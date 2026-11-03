import { useEffect, useRef, useState } from "react";
import {
  MediaReceiver,
  type MediaStats,
  type ReceiverUpdate,
} from "./services/receiver";

const initial: ReceiverUpdate = {
  state: "idle",
  detail: "Create an offer to start a local media test.",
  lastMediaAt: null,
};
export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const receiver = useRef<MediaReceiver | null>(null);
  const [status, setStatus] = useState(initial);
  const [stats, setStats] = useState<MediaStats>({
    frames: 0,
    bytes: 0,
    packetsLost: 0,
  });
  const [offer, setOffer] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const service = new MediaReceiver({
      onUpdate: setStatus,
      onStats: setStats,
      onStream: (stream) => {
        const element = video.current;
        if (!element) return;
        if (element.srcObject !== stream) element.srcObject = stream;
        if (!stream) {
          element.pause();
          element.load();
        } else if (element.paused)
          void element
            .play()
            .then(() => {
              if (element.srcObject === stream) setError("");
            })
            .catch((cause: unknown) => {
              if (cause instanceof DOMException && cause.name === "AbortError")
                return;
              if (element.srcObject === stream)
                setError("Playback needs a tap. Use Play media below.");
            });
      },
    });
    receiver.current = service;
    return () => service.close();
  }, []);

  async function generate() {
    setBusy(true);
    setError("");
    setOffer("");
    setAnswer("");
    try {
      setOffer(await receiver.current!.start());
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start WebRTC.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    setBusy(true);
    setError("");
    try {
      await receiver.current!.accept(answer);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not apply answer.",
      );
    } finally {
      setBusy(false);
    }
  }
  const receiving = status.state === "receiving";
  return (
    <main className="mx-auto max-w-6xl px-5 py-7 sm:px-9 sm:py-10">
      <header className="mb-9 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="brand" aria-hidden="true">
            ◔
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              raspbaby<span className="text-accent">.</span>
            </h1>
            <p className="text-xs text-secondary">
              A little closer, even from here.
            </p>
          </div>
        </div>
        <span className="badge">MEDIA LAB · PHASE 0</span>
      </header>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">LOCAL WEBRTC EXPERIMENT</p>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight">
            Room to test.
          </h2>
          <p className="mt-2 text-sm text-secondary">
            Validate video and audio before the monitor takes shape.
          </p>
        </div>
        <span className={`status ${receiving ? "active" : ""}`}>
          <span aria-hidden="true">●</span> {status.state.replaceAll("-", " ")}
        </span>
      </div>
      <section
        className="overflow-hidden rounded-3xl border border-line bg-surface"
        aria-label="Media receiver"
      >
        <div className="viewport">
          <video
            ref={video}
            autoPlay
            playsInline
            muted={muted}
            className="h-full w-full object-contain"
            aria-label="Received camera video"
          />
          {!receiving && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
              <span className="text-5xl text-accent" aria-hidden="true">
                ◌
              </span>
              <h3 className="text-xl font-medium">
                {status.state === "failed" || status.state === "disconnected"
                  ? "Stream unavailable"
                  : "Waiting for a real stream"}
              </h3>
              <p className="max-w-md text-sm text-secondary">{status.detail}</p>
            </div>
          )}
          {receiving && (
            <span className="absolute left-5 top-5 rounded-full bg-background/85 px-3 py-1 text-xs text-success">
              ● Receiving decoded video
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
          <p className="text-xs text-secondary">
            H.264 + Opus · local candidates only
          </p>
          <div className="flex gap-2">
            <button
              className="secondary"
              onClick={() => {
                setMuted(!muted);
              }}
            >
              Audio {muted ? "off" : "on"}
            </button>
            <button
              className="secondary"
              onClick={() => {
                void video.current
                  ?.play()
                  .then(() => setError(""))
                  .catch((cause: unknown) => {
                    if (
                      cause instanceof DOMException &&
                      cause.name === "AbortError"
                    )
                      return;
                    setError("Playback failed. Check WebView codec support.");
                  });
              }}
            >
              Play media
            </button>
            <button
              className="secondary"
              onClick={() => {
                receiver.current?.close();
                setOffer("");
                setAnswer("");
              }}
            >
              Stop
            </button>
          </div>
        </div>
      </section>
      <div
        className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4"
        aria-label="Measured diagnostics"
      >
        {[
          ["Decoded frames", String(stats.frames)],
          ["Received media", `${(stats.bytes / 1024).toFixed(1)} KiB`],
          ["Packets lost", String(stats.packetsLost)],
          [
            "Last video progress",
            status.lastMediaAt
              ? new Date(status.lastMediaAt).toLocaleTimeString()
              : "Not received",
          ],
        ].map(([label, value]) => (
          <div
            className="rounded-2xl border border-line bg-surface p-4"
            key={label}
          >
            <p className="text-xs text-secondary">{label}</p>
            <p className="mt-2 text-lg font-medium">{value}</p>
          </div>
        ))}
      </div>
      <section className="mt-8" aria-labelledby="exchange">
        <div className="mb-5">
          <p className="eyebrow">MANUAL SIGNALING</p>
          <h2 id="exchange" className="mt-2 text-xl font-medium">
            Two messages. One local stream.
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-secondary">
            Use a trusted terminal to run the GStreamer spike. Paste the offer
            into its standard input. Paste the answer from its standard output
            here. Keep the terminal open. SDP contains local network details;
            share it only with the intended peer.
          </p>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="panel">
            <label htmlFor="offer" className="text-sm font-medium">
              01 · Create the receiver offer
            </label>
            <p className="mt-2 mb-4 text-xs text-secondary">
              No camera or microphone access is requested on this device.
            </p>
            <textarea
              id="offer"
              value={offer}
              readOnly
              placeholder="Your offer will appear here after ICE gathering."
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="primary"
                disabled={busy}
                onClick={() => {
                  void generate();
                }}
              >
                {busy ? "Please wait…" : "Create offer"}
              </button>
              <button
                className="secondary"
                disabled={!offer}
                onClick={() => {
                  void navigator.clipboard
                    .writeText(offer)
                    .catch(() =>
                      setError("Select and copy the offer manually."),
                    );
                }}
              >
                Copy offer
              </button>
            </div>
          </div>
          <div className="panel">
            <label htmlFor="answer" className="text-sm font-medium">
              02 · Apply the sender answer
            </label>
            <p className="mt-2 mb-4 text-xs text-secondary">
              Paste the complete JSON line from the spike process.
            </p>
            <textarea
              id="answer"
              value={answer}
              onChange={(event) => setAnswer(event.target.value)}
              placeholder='{"protocol_version":1,"type":"webrtc.answer",…}'
              spellCheck={false}
              maxLength={98304}
            />
            <button
              className="primary mt-3"
              disabled={busy || !answer || status.state !== "awaiting-answer"}
              onClick={() => {
                void apply();
              }}
            >
              Apply answer
            </button>
          </div>
        </div>
        {error && (
          <p
            className="mt-4 rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
        <p className="mt-4 text-xs text-secondary" role="status">
          {status.detail}
        </p>
      </section>
      <footer className="mt-9 border-t border-line pt-5 text-xs leading-6 text-secondary">
        Feasibility prototype. Pairing, discovery, alerts, heartbeat, and
        automatic reconnection are not implemented. Android monitoring requires
        the app to stay active. This is a convenience monitor, not a medical
        device. A missing alert does not prove safety.
      </footer>
    </main>
  );
}
