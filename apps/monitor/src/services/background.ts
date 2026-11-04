import { invoke, isTauri } from "@tauri-apps/api/core";

export const isAndroid = /Android/i.test(navigator.userAgent);
export const isWindowsApp = isTauri() && /Windows/i.test(navigator.userAgent);
export const supportsAndroidBackground = isTauri() && isAndroid;

export interface BackgroundStatus {
  supported: boolean;
  active: boolean;
  reason: string | null;
}

export function backgroundCommand(
  command: "start" | "stop" | "status" | "heartbeat",
) {
  return invoke<BackgroundStatus>(`plugin:background-monitor|${command}`);
}

export function windowCommand(
  command:
    | "minimize_window"
    | "toggle_maximize_window"
    | "hide_to_tray"
    | "start_window_drag"
    | "quit_app",
) {
  return invoke<void>(command);
}
