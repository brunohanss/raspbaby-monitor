import { useEffect, useRef, useState } from "react";
import { Music2, Play, Square, Upload, X } from "lucide-react";
import {
  defaultAlertSoundSettings,
  importAlertSound,
  loadAlertSoundSettings,
  saveAlertSoundSettings,
  type AlertSoundSettings as SoundSettings,
} from "../services/alertSound";

export function AlertSoundSettings() {
  const [initial] = useState(() => {
    try {
      return { settings: loadAlertSoundSettings(), error: "" };
    } catch (cause) {
      return {
        settings: defaultAlertSoundSettings(),
        error:
          cause instanceof Error
            ? cause.message
            : "Could not read the saved sound.",
      };
    }
  });
  const [settings, setSettings] = useState(initial.settings);
  const [error, setError] = useState(initial.error);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const player = audio.current;
    return () => player?.pause();
  }, []);
  useEffect(() => {
    if (audio.current) audio.current.volume = settings.volume;
  }, [settings.volume]);

  function stopPreview() {
    audio.current?.pause();
    if (audio.current) audio.current.currentTime = 0;
    setPlaying(false);
  }
  function save(next: SoundSettings) {
    saveAlertSoundSettings(next);
    setSettings(next);
    setError("");
  }
  async function select(file: File) {
    setBusy(true);
    stopPreview();
    try {
      save({ ...settings, clip: await importAlertSound(file) });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not import this sound.",
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }
  async function preview() {
    const player = audio.current;
    if (!player || !settings.clip) return;
    stopPreview();
    setError("");
    try {
      player.volume = settings.volume;
      await player.play();
      setPlaying(true);
    } catch {
      setError(
        "This sound could not play. Choose a supported WAV, MP3, or OGG file.",
      );
    }
  }

  return (
    <section
      className="settings-panel"
      aria-labelledby="alert-sound-title"
      style={{ marginTop: 24 }}
    >
      <div className="setting-row">
        <div className="setting-label">
          <Music2 />
          <div>
            <h3 id="alert-sound-title">Murloc alert sound</h3>
            <p>One local clip for movement and sound alerts.</p>
          </div>
        </div>
      </div>
      <div className="connection-body">
        <p className="connection-help">
          Import your Murloc clip as WAV, MP3, or OGG (up to 1 MiB). It stays on
          this device. Automatic alerts will be available when detection is
          implemented.
        </p>
        <p
          className="setting-value"
          style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}
        >
          {settings.clip
            ? `Selected: ${settings.clip.name}`
            : "No sound selected"}
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg"
          aria-label="Import alert sound"
          disabled={busy}
          className="sr-only"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void select(file);
          }}
        />
        <div className="form-actions">
          <button
            type="button"
            className="subtle-button"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={15} />
            {busy ? "Importing…" : "Choose sound"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy || !settings.clip}
            onClick={() => {
              if (playing) stopPreview();
              else void preview();
            }}
          >
            {playing ? <Square size={15} /> : <Play size={15} />}
            {playing ? "Stop preview" : "Preview sound"}
          </button>
          <button
            type="button"
            className="subtle-button"
            disabled={busy || !settings.clip}
            onClick={() => {
              stopPreview();
              try {
                save({ ...settings, clip: null });
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not clear the sound.",
                );
              }
            }}
          >
            <X size={15} />
            Clear sound
          </button>
        </div>
        <label
          htmlFor="alert-sound-volume"
          className="setting-value"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 12,
            marginTop: 22,
          }}
        >
          Preview volume · {Math.round(settings.volume * 100)}%
          <input
            id="alert-sound-volume"
            type="range"
            min="0"
            max="100"
            step="1"
            value={Math.round(settings.volume * 100)}
            disabled={busy}
            onChange={(event) => {
              try {
                save({ ...settings, volume: Number(event.target.value) / 100 });
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not save volume.",
                );
              }
            }}
            style={{ width: 180, maxWidth: "100%", accentColor: "#a276ff" }}
          />
        </label>
        {error && (
          <p
            className="setting-message"
            role="alert"
            style={{ padding: "14px 0 0", margin: 0 }}
          >
            {error}
          </p>
        )}
        <audio
          ref={audio}
          src={settings.clip?.dataUrl}
          preload="none"
          onEnded={() => setPlaying(false)}
          onError={() => {
            setPlaying(false);
            if (settings.clip)
              setError(
                "This sound could not play. Choose a supported WAV, MP3, or OGG file.",
              );
          }}
        />
      </div>
    </section>
  );
}
