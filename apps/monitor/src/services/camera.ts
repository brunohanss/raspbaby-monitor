import { invoke } from "@tauri-apps/api/core";

export interface CameraConnection {
  host: string;
  user: string;
}
const defaults: CameraConnection = { host: "raspbaby.local", user: "raspbaby" };

export function loadCameraConnection(): CameraConnection {
  try {
    const saved = JSON.parse(
      localStorage.getItem("raspbaby:camera-connection") ?? "null",
    ) as Partial<CameraConnection> | null;
    return {
      host: typeof saved?.host === "string" ? saved.host : defaults.host,
      user: typeof saved?.user === "string" ? saved.user : defaults.user,
    };
  } catch {
    return defaults;
  }
}

export function saveCameraConnection(connection: CameraConnection) {
  try {
    localStorage.setItem(
      "raspbaby:camera-connection",
      JSON.stringify(connection),
    );
  } catch {
    /* Storage can be unavailable in a restricted WebView. */
  }
}

export function connectCamera(offer: string, connection: CameraConnection) {
  return invoke<string>("connect_camera", {
    offer,
    host: connection.host.trim(),
    user: connection.user.trim(),
    hd: false,
  });
}

export function disconnectCamera(sessionId: string) {
  return invoke<void>("disconnect_camera", { sessionId });
}
