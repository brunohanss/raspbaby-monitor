import { loadAlertSoundSettings, type AlertSoundSettings } from "./alertSound";
import type { ActivityEvent } from "./activity";

const ENABLED_KEY = "raspbaby:activity-alerts-enabled";
const REPEAT_KEY = "raspbaby:activity-alert-repeat-seconds";
export function activityAlertRepeatSeconds(): number {
  try {
    const value = Number(localStorage.getItem(REPEAT_KEY));
    return Number.isInteger(value) && value >= 5 && value <= 60 ? value : 5;
  } catch {
    return 5;
  }
}
export function saveActivityAlertRepeatSeconds(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60)
    throw new Error("Choose a repeat interval from 5 to 60 seconds.");
  localStorage.setItem(REPEAT_KEY, String(seconds));
}
export interface ActiveAlertState {
  motion: boolean;
  sound: boolean;
  timestamp_ms: number;
}
export function activityAlertsEnabled(): boolean {
  try {
    const value = localStorage.getItem(ENABLED_KEY);
    return value === null
      ? Boolean(loadAlertSoundSettings().clip)
      : value === "true";
  } catch {
    return false;
  }
}
export function saveActivityAlertsEnabled(enabled: boolean) {
  localStorage.setItem(ENABLED_KEY, String(enabled));
}

type AlertContext = Pick<
  AudioContext,
  | "state"
  | "resume"
  | "close"
  | "decodeAudioData"
  | "createBufferSource"
  | "createGain"
  | "destination"
>;
interface AlertOptions {
  onError: (message: string) => void;
  contextFactory?: () => AlertContext;
  settings?: () => AlertSoundSettings;
  enabled?: () => boolean;
  now?: () => number;
  repeatSeconds?: () => number;
}
/** Separate output from camera playback. Camera mute never reaches this service. */
export class ActivityAlertPlayer {
  private context: AlertContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private loading = false;
  private lastStarted = -Infinity;
  private disposed = false;
  private revision = 0;
  private buffer: AudioBuffer | null = null;
  private dataUrl = "";
  constructor(private readonly options: AlertOptions) {}
  unlock() {
    if (this.disposed) return;
    try {
      this.context ??= this.options.contextFactory?.() ?? new AudioContext();
      void this.context
        .resume()
        .then(() => this.options.onError(""))
        .catch(() =>
          this.options.onError(
            "Tap Allow alert sounds to enable audio playback.",
          ),
        );
    } catch {
      this.options.onError("Alert audio is unavailable on this device.");
    }
  }
  async notify(event: ActivityEvent): Promise<boolean> {
    return this.play(event.timestamp_ms);
  }
  async notifyActive(activity: ActiveAlertState | null): Promise<boolean> {
    if (!activity) {
      this.stop();
      return false;
    }
    const now = this.options.now?.() ?? Date.now();
    if (
      now - activity.timestamp_ms > 15000 ||
      activity.timestamp_ms > now + 5000
    ) {
      this.stop();
      return false;
    }
    if (!activity.motion && !activity.sound) {
      // A playing clip may finish, but quiet state cancels a pending decode and
      // never schedules another notification. History counts stay separate.
      this.revision++;
      return false;
    }
    return this.play(activity.timestamp_ms);
  }
  private async play(timestamp: number): Promise<boolean> {
    if (this.disposed || !(this.options.enabled?.() ?? activityAlertsEnabled()))
      return false;
    const now = this.options.now?.() ?? Date.now();
    // Reconnect history belongs in counts, but must not replay old alert sounds.
    if (
      now - timestamp > 15000 ||
      timestamp > now + 5000 ||
      this.loading ||
      this.source ||
      now - this.lastStarted <
        (this.options.repeatSeconds?.() ?? activityAlertRepeatSeconds()) * 1000
    )
      return false;
    try {
      const settings = this.options.settings?.() ?? loadAlertSoundSettings();
      if (!settings.clip) return false;
      const context = this.context;
      if (!context || context.state !== "running") {
        this.options.onError(
          "Tap Allow alert sounds to enable audio playback.",
        );
        return false;
      }
      this.loading = true;
      const revision = this.revision;
      if (!this.buffer || this.dataUrl !== settings.clip.dataUrl) {
        const binary = atob(settings.clip.dataUrl.split(",")[1]!);
        const bytes = Uint8Array.from(binary, (character) =>
          character.charCodeAt(0),
        );
        this.buffer = await context.decodeAudioData(bytes.buffer);
        this.dataUrl = settings.clip.dataUrl;
      }
      const currentSettings =
        this.options.settings?.() ?? loadAlertSoundSettings();
      if (
        this.disposed ||
        revision !== this.revision ||
        !(this.options.enabled?.() ?? activityAlertsEnabled()) ||
        currentSettings.clip?.dataUrl !== settings.clip.dataUrl
      )
        return false;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = this.buffer;
      gain.gain.value = currentSettings.volume;
      source.connect(gain);
      gain.connect(context.destination);
      this.source = source;
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        if (this.source === source) this.source = null;
      };
      source.start();
      this.lastStarted = this.options.now?.() ?? Date.now();
      return true;
    } catch {
      this.options.onError(
        "The alert sound could not play. Check the imported clip and allow audio.",
      );
      return false;
    } finally {
      this.loading = false;
    }
  }
  stop() {
    this.revision++;
    this.source?.stop();
    this.source = null;
  }
  dispose() {
    this.disposed = true;
    this.stop();
    void this.context?.close();
  }
}
