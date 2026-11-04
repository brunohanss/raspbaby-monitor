import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  CameraOff,
  ChartNoAxesColumn,
  ChevronDown,
  CircleAlert,
  House,
  Link2,
  List,
  Maximize,
  Minus,
  Play,
  PlugZap,
  Power,
  Settings,
  Square,
  SquareStop,
  Thermometer,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { RaspberryMark } from "./components/RaspberryMark";
import { AlertSoundSettings } from "./components/AlertSoundSettings";
import { ActivityStatistics } from "./components/ActivityStatistics";
import {
  parseSignalingMessage,
  type TelemetryMessage,
} from "@raspbaby/protocol-client";
import {
  addActivity,
  emptyActivity,
  loadActivity,
  saveActivity,
} from "./services/activity";
import {
  ActivityAlertPlayer,
  activityAlertsEnabled,
  activityAlertRepeatSeconds,
  saveActivityAlertRepeatSeconds,
  saveActivityAlertsEnabled,
} from "./services/activityAlerts";
import {
  connectCamera,
  disconnectCamera,
  loadCameraConnection,
  saveCameraConnection,
} from "./services/camera";
import { useBackgroundMonitor } from "./hooks/useBackgroundMonitor";
import {
  MediaReceiver,
  type MediaStats,
  type ReceiverUpdate,
} from "./services/receiver";
import {
  isAndroid,
  isWindowsApp,
  supportsAndroidBackground,
  windowCommand,
} from "./services/background";

type Screen = "live" | "events" | "statistics" | "settings";
const initialStatus: ReceiverUpdate = {
  state: "idle",
  detail: "Connect your camera to start monitoring.",
  lastMediaAt: null,
};
const emptyStats: MediaStats = { frames: 0, bytes: 0, packetsLost: 0 };
const navigation = [
  { id: "live", label: "Live", icon: House },
  { id: "events", label: "Events", icon: List },
  { id: "statistics", label: "Statistics", icon: ChartNoAxesColumn },
  { id: "settings", label: "Settings", icon: Settings },
] as const;

function MotionIcon() {
  return (
    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <circle cx="43" cy="10" r="7" fill="currentColor" />
      <path
        d="m28 20 11 4 8 10 10 1M37 25l-9 14 13 6-4 15M29 38l-9 10H8M28 19l-9-3-9 7"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function App() {
  const video = useRef<HTMLVideoElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const receiver = useRef<MediaReceiver | null>(null);
  const statusRef = useRef(initialStatus);
  const statsRef = useRef<MediaStats>(emptyStats);
  const alertPlayer = useRef<ActivityAlertPlayer | null>(null);
  const [initialActivity] = useState(() => {
    try {
      return { state: loadActivity(), error: "" };
    } catch {
      return {
        state: emptyActivity(),
        error: "Saved activity could not be read. New events will appear here.",
      };
    }
  });
  const activityRef = useRef(initialActivity.state);
  const nativeSession = useRef<string | null>(null);
  const connectionGeneration = useRef(0);
  const [screen, setScreen] = useState<Screen>("live");
  const [status, setStatus] = useState(initialStatus);
  const [stats, setStats] = useState<MediaStats>(emptyStats);
  const [activity, setActivity] = useState(initialActivity.state);
  const [activityIssue, setActivityIssue] = useState(initialActivity.error);
  const [telemetry, setTelemetry] = useState<TelemetryMessage | null>(null);
  const [alertsEnabled, setAlertsEnabled] = useState(activityAlertsEnabled);
  const [alertRepeatSeconds, setAlertRepeatSeconds] = useState(
    activityAlertRepeatSeconds,
  );
  const [alertIssue, setAlertIssue] = useState("");
  const [offer, setOffer] = useState("");
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [backgroundEnabled, setBackgroundEnabled] = useState(true);
  const [cameraConnection, setCameraConnection] =
    useState(loadCameraConnection);

  function releaseNativeCamera() {
    const sessionId = nativeSession.current;
    nativeSession.current = null;
    if (sessionId && isWindowsApp)
      void disconnectCamera(sessionId).catch(() => {});
  }

  useEffect(() => {
    const alerts = new ActivityAlertPlayer({ onError: setAlertIssue });
    alertPlayer.current = alerts;
    const service = new MediaReceiver({
      onUpdate: (update) => {
        if (["idle", "failed", "disconnected"].includes(update.state))
          releaseNativeCamera();
        if (["idle", "failed", "disconnected"].includes(update.state))
          alerts.stop();
        statusRef.current = update;
        setStatus(update);
      },
      onTelemetry: (message) => {
        setTelemetry(message);
        if (!message) {
          alerts.stop();
          return;
        }
        void alerts.notifyActive({
          motion: message.motion_active,
          sound: message.sound_active,
          timestamp_ms: message.timestamp_ms,
        });
        const result = addActivity(
          activityRef.current,
          message.device_id,
          message.events,
        );
        if (!result.fresh.length) return;
        activityRef.current = result.state;
        setActivity(result.state);
        try {
          saveActivity(result.state);
          setActivityIssue("");
        } catch {
          setActivityIssue(
            "Local storage is unavailable. New activity is kept in memory until the app closes.",
          );
        }
        for (const event of result.fresh) void alerts.notify(event);
      },
      onStats: (sample) => {
        statsRef.current = sample;
        setStats(sample);
      },
      onStream: (stream) => {
        const element = video.current;
        if (!element) return;
        if (element.srcObject !== stream) element.srcObject = stream;
        if (!stream) {
          element.pause();
          element.load();
        } else if (element.paused)
          void element.play().catch((cause: unknown) => {
            if (cause instanceof DOMException && cause.name === "AbortError")
              return;
            if (element.srcObject === stream)
              setError("Tap Play to start camera playback.");
          });
      },
    });
    receiver.current = service;
    const stopFromNotification = () => service.close();
    window.addEventListener("raspbaby-background-stop", stopFromNotification);
    return () => {
      window.removeEventListener(
        "raspbaby-background-stop",
        stopFromNotification,
      );
      service.close();
      alerts.dispose();
      releaseNativeCamera();
    };
  }, []);

  const receiving = status.state === "receiving";
  const hasSession = !["idle", "failed", "disconnected"].includes(status.state);
  const connecting = hasSession && !receiving;
  const failed = status.state === "failed" || status.state === "disconnected";
  const background = useBackgroundMonitor(
    backgroundEnabled,
    hasSession,
    statusRef,
    statsRef,
  );

  async function generate() {
    alertPlayer.current?.unlock();
    setBusy(true);
    setError("");
    setOffer("");
    setAnswer("");
    try {
      setOffer(await receiver.current!.start());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the camera.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    alertPlayer.current?.unlock();
    setBusy(true);
    setError("");
    try {
      await receiver.current!.accept(answer);
      setScreen("live");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the camera.",
      );
    } finally {
      setBusy(false);
    }
  }
  function stop() {
    connectionGeneration.current++;
    receiver.current?.close();
    setOffer("");
    setAnswer("");
    setError("");
    setBusy(false);
  }
  async function connectToCamera() {
    alertPlayer.current?.unlock();
    if (!isWindowsApp) {
      openConnection();
      return;
    }
    const generation = ++connectionGeneration.current;
    setBusy(true);
    setError("");
    setScreen("live");
    try {
      const localOffer = await receiver.current!.start();
      if (generation !== connectionGeneration.current) return;
      const sessionId = parseSignalingMessage(localOffer).session_id;
      nativeSession.current = sessionId;
      const remoteAnswer = await connectCamera(localOffer, cameraConnection);
      if (
        generation !== connectionGeneration.current ||
        nativeSession.current !== sessionId
      ) {
        await disconnectCamera(sessionId);
        return;
      }
      await receiver.current!.accept(remoteAnswer);
    } catch (cause) {
      if (generation === connectionGeneration.current) {
        receiver.current?.close();
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (generation === connectionGeneration.current) setBusy(false);
    }
  }
  function openConnection() {
    setAdvancedOpen(true);
    setScreen("settings");
  }
  async function play() {
    try {
      await video.current?.play();
      setError("");
    } catch {
      setError("Playback could not start. Check your camera connection.");
    }
  }
  async function fullScreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await player.current?.requestFullscreen();
    } catch {
      setError("Full screen is not available in this window.");
    }
  }
  function nativeAction(command: Parameters<typeof windowCommand>[0]) {
    if (isWindowsApp)
      void windowCommand(command).catch(() =>
        setError("The window action could not finish."),
      );
  }

  const audioLevel = telemetry?.audio_level ?? stats.audioLevel ?? null;
  const soundAvailable = Boolean(
    (telemetry || (receiving && stats.audioAvailable)) && audioLevel !== null,
  );
  const litBars =
    soundAvailable && audioLevel !== null
      ? Math.min(10, Math.ceil(Math.sqrt(audioLevel) * 10))
      : 0;
  const soundLabel =
    !soundAvailable || audioLevel === null
      ? "Unavailable"
      : audioLevel < 0.04
        ? "Low"
        : audioLevel < 0.3
          ? "Moderate"
          : "High";
  const resolution =
    receiving && stats.height
      ? stats.height >= 720
        ? `${stats.height}p`
        : `${stats.width} × ${stats.height}`
      : null;
  const statusLabel = receiving
    ? "Live"
    : connecting
      ? "Connecting"
      : "Offline";

  return (
    <div className={`monitor-app ${isAndroid ? "android-app" : ""}`}>
      <header className="app-header">
        <div
          className="brand-title"
          onPointerDown={(event) => {
            if (event.button === 0) nativeAction("start_window_drag");
          }}
          onDoubleClick={() => nativeAction("toggle_maximize_window")}
        >
          <RaspberryMark className="raspberry-logo" />
          <h1>
            Raspbaby <span>Monitor</span>
          </h1>
        </div>
        <div className="header-actions">
          <div
            className={`connection-pill ${receiving ? "is-live" : connecting ? "is-connecting" : failed ? "is-failed" : ""}`}
            role="status"
          >
            <span className="status-dot" />
            {statusLabel}
          </div>
          {receiving ? (
            <Wifi
              className="network-icon is-connected"
              aria-label="Camera connected"
            />
          ) : (
            <WifiOff className="network-icon" aria-label="Camera offline" />
          )}
          <button
            className={`audio-toggle ${!muted ? "is-on" : ""}`}
            role="switch"
            aria-checked={!muted}
            aria-label="Camera sound"
            onClick={() => setMuted((value) => !value)}
            title={muted ? "Turn camera sound on" : "Mute camera sound"}
          >
            {muted ? <VolumeX /> : <Volume2 />}
            <span className="toggle-track">
              <span />
            </span>
          </button>
          {!isAndroid && (
            <div className="window-controls">
              <button
                aria-label="Minimize window"
                disabled={!isWindowsApp}
                onClick={() => nativeAction("minimize_window")}
              >
                <Minus />
              </button>
              <button
                aria-label="Maximize window"
                disabled={!isWindowsApp}
                onClick={() => nativeAction("toggle_maximize_window")}
              >
                <Square />
              </button>
              <button
                className="close-window"
                aria-label="Close to tray"
                title="Close to tray · monitoring continues"
                disabled={!isWindowsApp}
                onClick={() => nativeAction("hide_to_tray")}
              >
                <X />
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="app-main">
        <section
          className={`monitor-layout ${screen !== "live" ? "monitor-offscreen" : ""}`}
          aria-label="Live monitor"
          aria-hidden={screen !== "live"}
        >
          <div
            ref={player}
            className={`camera-player ${receiving ? "is-receiving" : ""}`}
          >
            <video
              ref={video}
              autoPlay
              playsInline
              muted={muted}
              aria-label="Received camera video"
            />
            {!receiving && (
              <div className="camera-empty">
                <CameraOff />
                <h2>
                  {failed
                    ? "Connection lost"
                    : connecting
                      ? "Connecting to camera"
                      : "Your camera, a little closer."}
                </h2>
                <p>
                  {failed
                    ? "The live view has stopped. Reconnect to resume monitoring."
                    : connecting
                      ? "Waiting for a fresh camera frame…"
                      : "Connect your Raspberry Pi to start the live view."}
                </p>
                {!connecting && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() => {
                      void connectToCamera();
                    }}
                  >
                    <PlugZap size={19} />
                    {failed ? "Reconnect camera" : "Connect camera"}
                  </button>
                )}
              </div>
            )}
            <div className={`video-status ${receiving ? "is-live" : ""}`}>
              <span className="status-dot" />
              {statusLabel}
            </div>
            <button
              className="fullscreen-button"
              aria-label="Full screen"
              onClick={() => {
                void fullScreen();
              }}
            >
              <Maximize />
            </button>
            {resolution && (
              <span className="resolution-badge">{resolution}</span>
            )}
            <div className="player-actions">
              <button
                aria-label="Play media"
                title="Play media"
                onClick={() => {
                  void play();
                }}
              >
                <Play />
              </button>
              <button aria-label="Stop" title="Stop monitoring" onClick={stop}>
                <SquareStop />
              </button>
              <button
                aria-label="Camera connection"
                title="Camera connection"
                onClick={openConnection}
              >
                <Link2 />
              </button>
            </div>
            {receiving && (
              <span className="sr-only">Receiving decoded video</span>
            )}
          </div>
          <aside className="sensor-stack" aria-label="Monitor information">
            <section className="sensor-card temperature-card">
              <Thermometer className="sensor-icon temperature-icon" />
              <div>
                <h2>Raspberry Pi Temperature</h2>
                <p className="temperature-value">
                  {telemetry?.temperature_c == null
                    ? "—"
                    : telemetry.temperature_c.toFixed(1)}{" "}
                  <span>°C</span>
                </p>
                <span className="sensor-note">
                  {telemetry?.temperature_c == null
                    ? "Not reported"
                    : "Pi CPU temperature"}
                </span>
              </div>
            </section>
            <section className="sensor-card sound-card">
              <AudioLines className="sensor-icon sound-icon" />
              <div className="sound-content">
                <h2>Sound level</h2>
                <div
                  className="sound-meter"
                  role="meter"
                  aria-label="Sound level"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    soundAvailable && audioLevel !== null
                      ? Math.round(audioLevel * 100)
                      : undefined
                  }
                  aria-valuetext={soundLabel}
                >
                  {Array.from({ length: 10 }, (_, index) => (
                    <span
                      key={index}
                      className={index < litBars ? "lit" : ""}
                    />
                  ))}
                </div>
                <p className="sensor-state">{soundLabel}</p>
              </div>
            </section>
            <section className="sensor-card motion-card">
              <div className="sensor-icon motion-icon">
                <MotionIcon />
              </div>
              <div>
                <h2>Motion</h2>
                <p className="sensor-state">
                  {telemetry
                    ? telemetry.motion_active
                      ? "Movement detected"
                      : "No movement"
                    : "Unavailable"}
                </p>
                <span className="sensor-note">
                  {telemetry
                    ? "Camera motion detector"
                    : "Waiting for device telemetry"}
                </span>
              </div>
            </section>
          </aside>
        </section>
        {screen === "events" && (
          <section className="content-screen" aria-labelledby="events-title">
            <div className="screen-heading">
              <div>
                <p className="eyebrow">CAMERA ACTIVITY</p>
                <h2 id="events-title">Events</h2>
                <p>Movement and sustained sound reported by your camera.</p>
              </div>
              <span className="count-pill">
                {activity.events.length} recent events
              </span>
            </div>
            <div className="events-panel">
              {activity.events.length ? (
                [...activity.events].reverse().map((event) => (
                  <div
                    className="event-row"
                    key={`${event.device_id}/${event.id}`}
                  >
                    <span className="event-symbol">
                      {event.kind === "motion" ? <House /> : <AudioLines />}
                    </span>
                    <div>
                      <h3>
                        {event.kind === "motion"
                          ? "Movement detected"
                          : "Sustained sound detected"}
                      </h3>
                      <p>
                        {new Date(event.timestamp_ms).toLocaleDateString()} ·{" "}
                        {new Date(event.timestamp_ms).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-panel">
                  <List />
                  <h3>No events yet</h3>
                  <p>
                    Real movement and sound events will appear here when the
                    camera reports them.
                  </p>
                </div>
              )}
            </div>
            <p className="screen-footnote">
              {activityIssue ||
                "Event metadata stays on this device. The latest 500 events are kept; no camera images or audio are saved."}
              {telemetry?.dropped_events
                ? ` The device reports ${telemetry.dropped_events} dropped events; counts may be incomplete.`
                : ""}
            </p>
          </section>
        )}
        {screen === "statistics" && <ActivityStatistics activity={activity} />}
        {screen === "settings" && (
          <section
            className="content-screen settings-screen"
            aria-labelledby="settings-title"
          >
            <div className="screen-heading">
              <div>
                <p className="eyebrow">MAKE YOURSELF AT HOME</p>
                <h2 id="settings-title">Settings</h2>
                <p>Your camera, sound, and monitoring preferences.</p>
              </div>
            </div>
            {!isAndroid && (
              <form
                className="settings-panel camera-settings"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connectToCamera();
                }}
              >
                <div className="setting-label">
                  <Link2 />
                  <div>
                    <h3>Raspberry Pi connection</h3>
                    <p>Use your Pi's hostname and existing SSH key access.</p>
                  </div>
                </div>
                <div className="camera-fields">
                  <label>
                    Hostname or IP address
                    <input
                      value={cameraConnection.host}
                      onChange={(event) => {
                        const next = {
                          ...cameraConnection,
                          host: event.target.value,
                        };
                        setCameraConnection(next);
                        saveCameraConnection(next);
                      }}
                      placeholder="raspbaby.local"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label>
                    SSH username
                    <input
                      value={cameraConnection.user}
                      onChange={(event) => {
                        const next = {
                          ...cameraConnection,
                          user: event.target.value,
                        };
                        setCameraConnection(next);
                        saveCameraConnection(next);
                      }}
                      placeholder="raspbaby"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                </div>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy || !isWindowsApp}
                >
                  {busy ? "Connecting…" : "Connect camera"}
                </button>
                {!isWindowsApp && (
                  <p className="connection-help">
                    Open the Windows application to use the direct Pi
                    connection.
                  </p>
                )}
              </form>
            )}
            <div className="settings-panel">
              <div className="setting-row">
                <div className="setting-label">
                  <Volume2 />
                  <div>
                    <h3>Camera sound</h3>
                    <p>Hear the microphone from your Raspberry Pi.</p>
                  </div>
                </div>
                <button
                  className={`setting-switch ${!muted ? "is-on" : ""}`}
                  role="switch"
                  aria-checked={!muted}
                  aria-label="Enable camera sound"
                  onClick={() => setMuted((value) => !value)}
                >
                  <span />
                </button>
              </div>
              <div className="setting-row">
                <div className="setting-label">
                  <House />
                  <div>
                    <h3>Keep monitoring in the background</h3>
                    <p>
                      {isAndroid
                        ? "Android shows a notification while monitoring is active."
                        : "Closing the window keeps the monitor in the system tray."}
                    </p>
                  </div>
                </div>
                {supportsAndroidBackground ? (
                  <button
                    className={`setting-switch ${backgroundEnabled ? "is-on" : ""}`}
                    role="switch"
                    aria-checked={backgroundEnabled}
                    aria-label="Background monitoring"
                    onClick={() => setBackgroundEnabled((value) => !value)}
                  >
                    <span />
                  </button>
                ) : (
                  <span className="setting-value">
                    {isWindowsApp ? "Always on" : "In the installed app"}
                  </span>
                )}
              </div>
              {supportsAndroidBackground && (
                <p className="setting-message" role="status">
                  {background.error ||
                    (background.active
                      ? "Background monitoring is active."
                      : "Background monitoring starts after the camera connects.")}
                </p>
              )}
            </div>
            <section className="settings-panel" style={{ marginTop: 24 }}>
              <div className="setting-row">
                <div className="setting-label">
                  <AudioLines />
                  <div>
                    <h3>Activity alerts</h3>
                    <p>
                      Murloc plays for movement or sound, even when camera sound
                      is muted.
                    </p>
                  </div>
                </div>
                <button
                  className={`setting-switch ${alertsEnabled ? "is-on" : ""}`}
                  role="switch"
                  aria-checked={alertsEnabled}
                  aria-label="Enable activity alerts"
                  onClick={() => {
                    try {
                      const enabled = !alertsEnabled;
                      saveActivityAlertsEnabled(enabled);
                      setAlertsEnabled(enabled);
                      if (enabled) alertPlayer.current?.unlock();
                      else alertPlayer.current?.stop();
                    } catch {
                      setAlertIssue(
                        "Could not save the activity alert preference.",
                      );
                    }
                  }}
                >
                  <span />
                </button>
              </div>
              <div className="connection-body">
                <button
                  className="subtle-button"
                  onClick={() => alertPlayer.current?.unlock()}
                >
                  Allow alert sounds
                </button>
                <p
                  className="connection-help"
                  style={{ marginTop: 14, marginBottom: 0 }}
                >
                  Movement OR sound can trigger Murloc. It repeats while either
                  remains active, with no overlapping clips. Quiet or
                  unavailable telemetry stops repeats.
                </p>
                <label
                  className="setting-value"
                  htmlFor="activity-alert-repeat"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: 12,
                    marginTop: 18,
                  }}
                >
                  Repeat interval · {alertRepeatSeconds} seconds
                  <input
                    id="activity-alert-repeat"
                    aria-label="Activity alert repeat interval"
                    type="range"
                    min="5"
                    max="60"
                    step="1"
                    value={alertRepeatSeconds}
                    onChange={(event) => {
                      try {
                        const seconds = Number(event.target.value);
                        saveActivityAlertRepeatSeconds(seconds);
                        setAlertRepeatSeconds(seconds);
                        setAlertIssue("");
                      } catch {
                        setAlertIssue(
                          "Could not save the repeat interval. Choose 5–60 seconds.",
                        );
                      }
                    }}
                    style={{
                      width: 180,
                      maxWidth: "100%",
                      accentColor: "#a276ff",
                    }}
                  />
                </label>
                {alertIssue && (
                  <p className="setting-message" role="alert">
                    {alertIssue}
                  </p>
                )}
              </div>
            </section>
            <AlertSoundSettings
              onChange={() => setAlertsEnabled(activityAlertsEnabled())}
              onPreview={() => alertPlayer.current?.unlock()}
            />
            <details
              className="connection-settings"
              open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
            >
              <summary>
                <span>
                  <Link2 />
                  Advanced connection
                </span>
                <ChevronDown />
              </summary>
              <div className="connection-body">
                <p className="connection-help">
                  Local media setup is available here until device pairing is
                  ready. Transfer messages only through your trusted local
                  terminal or SSH connection.
                </p>
                <div className="exchange-grid">
                  <div>
                    <label htmlFor="offer">Receiver offer</label>
                    <textarea
                      id="offer"
                      value={offer}
                      readOnly
                      placeholder="Create an offer to connect this receiver."
                    />
                    <div className="form-actions">
                      <button
                        className="primary-button"
                        disabled={busy}
                        onClick={() => {
                          void generate();
                        }}
                      >
                        {busy ? "Please wait…" : "Create offer"}
                      </button>
                      <button
                        className="subtle-button"
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
                  <div>
                    <label htmlFor="answer">Sender answer</label>
                    <textarea
                      id="answer"
                      value={answer}
                      onChange={(event) => setAnswer(event.target.value)}
                      placeholder="Paste the complete answer JSON from your sender."
                      spellCheck={false}
                      maxLength={98304}
                    />
                    <div className="form-actions">
                      <button
                        className="primary-button"
                        disabled={
                          busy || !answer || status.state !== "awaiting-answer"
                        }
                        onClick={() => {
                          void apply();
                        }}
                      >
                        Apply answer
                      </button>
                    </div>
                  </div>
                </div>
                <div className="connection-footer">
                  <span>{receiving ? "Camera connected" : status.detail}</span>
                  <button className="subtle-button" onClick={stop}>
                    Stop monitoring
                  </button>
                </div>
              </div>
            </details>
            <div className="settings-bottom">
              <p>
                Raspbaby Monitor <span>0.1.0</span>
              </p>
              {isWindowsApp && (
                <button
                  className="quit-button"
                  onClick={() => nativeAction("quit_app")}
                >
                  <Power size={17} />
                  Quit Raspbaby Monitor
                </button>
              )}
            </div>
          </section>
        )}
        {error && (
          <div className="error-toast" role="alert">
            <CircleAlert size={19} />
            <span>{error}</span>
            <button aria-label="Dismiss message" onClick={() => setError("")}>
              <X size={17} />
            </button>
          </div>
        )}
        <p className="sr-only" data-testid="connection-detail">
          {status.detail}
        </p>
      </main>
      <nav className="bottom-navigation" aria-label="Main navigation">
        {navigation.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`navigation-item ${screen === id ? "active" : ""}`}
            aria-current={screen === id ? "page" : undefined}
            onClick={() => setScreen(id)}
          >
            <Icon
              className={id === "live" && screen === id ? "filled-home" : ""}
              strokeWidth={1.9}
            />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
