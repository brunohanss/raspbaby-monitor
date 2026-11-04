import { useEffect, useRef, useState, type RefObject } from "react";
import type { MediaStats, ReceiverUpdate } from "../services/receiver";
import {
  backgroundCommand,
  supportsAndroidBackground,
} from "../services/background";

export function useBackgroundMonitor(
  enabled: boolean,
  hasSession: boolean,
  status: RefObject<ReceiverUpdate>,
  stats: RefObject<MediaStats>,
) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState("");
  const nativeActive = useRef(false);
  useEffect(() => {
    if (!supportsAndroidBackground) return;
    let disposed = false;
    let attempted = false;
    let lastBytes = stats.current.bytes;
    let lastHeartbeat = 0;
    if (!enabled || !hasSession) {
      void backgroundCommand("stop")
        .then(() => {
          nativeActive.current = false;
          if (!disposed) setActive(false);
        })
        .catch(() => {});
      return () => {
        disposed = true;
      };
    }
    const tick = async () => {
      if (disposed) return;
      const bytes = stats.current.bytes;
      if (!attempted && status.current.state === "receiving") {
        attempted = true;
        try {
          const result = await backgroundCommand("start");
          if (disposed) return;
          nativeActive.current = result.active;
          setActive(result.active);
          setError(result.reason ?? "");
          lastHeartbeat = Date.now();
        } catch (cause) {
          if (!disposed) setError(String(cause));
        }
      } else if (
        nativeActive.current &&
        bytes > lastBytes &&
        Date.now() - lastHeartbeat >= 5000
      ) {
        lastHeartbeat = Date.now();
        try {
          const result = await backgroundCommand("heartbeat");
          if (!disposed) {
            nativeActive.current = result.active;
            setActive(result.active);
          }
        } catch {
          if (!disposed) {
            nativeActive.current = false;
            setActive(false);
            setError(
              "Background monitoring stopped. Open the app and reconnect.",
            );
          }
        }
      }
      lastBytes = bytes;
    };
    void tick();
    const timer = setInterval(() => {
      void tick();
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [enabled, hasSession, status, stats]);
  return { active, error };
}
