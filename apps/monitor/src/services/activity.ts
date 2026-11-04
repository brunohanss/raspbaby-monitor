import type { TelemetryEvent } from "@raspbaby/protocol-client";

export interface ActivityEvent extends TelemetryEvent {
  device_id: string;
}
export interface ActivityCount {
  motion: number;
  sound: number;
}
export interface NightActivity extends ActivityCount {
  hours: ActivityCount[];
}
export interface ActivityState {
  version: 1;
  events: ActivityEvent[];
  seen: { key: string; time: number }[];
  dedupFloor: number;
  nights: Record<string, NightActivity>;
}
export const ACTIVITY_STORAGE_KEY = "raspbaby:activity:v1";
export const MAX_RECENT_EVENTS = 500;
export const MAX_SEEN_EVENTS = 10000;
export const NIGHT_HOURS = [18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4, 5, 6, 7];
type ActivityStorage = Pick<Storage, "getItem" | "setItem">;

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function latestNightKey(time = Date.now()): string {
  const date = new Date(time);
  if (date.getHours() < 18) date.setDate(date.getDate() - 1);
  return dateKey(date);
}
export function nightKey(time: number): string | null {
  const date = new Date(time);
  const hour = date.getHours();
  if (hour >= 8 && hour < 18) return null;
  if (hour < 8) date.setDate(date.getDate() - 1);
  return dateKey(date);
}
export function previousNights(key: string, count = 7): string[] {
  const date = new Date(`${key}T18:00:00`);
  if (!Number.isFinite(date.getTime()) || dateKey(date) !== key) return [];
  return Array.from({ length: count }, () => {
    const result = dateKey(date);
    date.setDate(date.getDate() - 1);
    return result;
  });
}
export function emptyNight(): NightActivity {
  return {
    motion: 0,
    sound: 0,
    hours: NIGHT_HOURS.map(() => ({ motion: 0, sound: 0 })),
  };
}
export function emptyActivity(): ActivityState {
  return { version: 1, events: [], seen: [], dedupFloor: 0, nights: {} };
}
function validEvent(event: ActivityEvent): boolean {
  return (
    /^[A-Za-z0-9_.-]{1,64}$/.test(event.device_id) &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(event.id) &&
    (event.kind === "motion" || event.kind === "sound") &&
    Number.isSafeInteger(event.timestamp_ms) &&
    event.timestamp_ms > 0
  );
}
export function addActivity(
  state: ActivityState,
  deviceId: string,
  incoming: TelemetryEvent[],
  now = Date.now(),
): { state: ActivityState; fresh: ActivityEvent[] } {
  const next: ActivityState = {
    ...state,
    events: [...state.events],
    seen: [...state.seen],
    nights: { ...state.nights },
  };
  const known = new Set(next.seen.map((entry) => entry.key));
  const fresh: ActivityEvent[] = [];
  const oldestDay = previousNights(latestNightKey(now), 90).at(-1)!;
  for (const event of incoming) {
    const item = { ...event, device_id: deviceId };
    if (
      !validEvent(item) ||
      item.timestamp_ms <= next.dedupFloor ||
      item.timestamp_ms > now + 5000 ||
      item.timestamp_ms < now - 91 * 86400000
    )
      continue;
    const key = `${deviceId}/${event.id}`;
    if (known.has(key)) continue;
    known.add(key);
    next.seen.push({ key, time: item.timestamp_ms });
    next.events.push(item);
    fresh.push(item);
    const night = nightKey(item.timestamp_ms);
    if (night && night >= oldestDay) {
      const old = next.nights[night] ?? emptyNight();
      const hours = old.hours.map((hour) => ({ ...hour }));
      const bin =
        hours[NIGHT_HOURS.indexOf(new Date(item.timestamp_ms).getHours())]!;
      bin[item.kind]++;
      next.nights[night] = { ...old, [item.kind]: old[item.kind] + 1, hours };
    }
  }
  next.events.sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  next.events = next.events.slice(-MAX_RECENT_EVENTS);
  next.seen.sort((a, b) => a.time - b.time);
  if (next.seen.length > MAX_SEEN_EVENTS) {
    next.dedupFloor = Math.max(
      next.dedupFloor,
      next.seen[next.seen.length - MAX_SEEN_EVENTS - 1]!.time,
    );
    next.seen = next.seen.slice(-MAX_SEEN_EVENTS);
  }
  next.nights = Object.fromEntries(
    Object.entries(next.nights)
      .filter(([key]) => key >= oldestDay)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 90),
  );
  return { state: next, fresh };
}
export function loadActivity(storage?: ActivityStorage): ActivityState {
  const raw = (storage ?? localStorage).getItem(ACTIVITY_STORAGE_KEY);
  if (!raw) return emptyActivity();
  if (raw.length > 2 * 1024 * 1024)
    throw new Error("Saved activity is too large.");
  const state = JSON.parse(raw) as ActivityState;
  const validCount = (count: ActivityCount) =>
    count &&
    Number.isSafeInteger(count.motion) &&
    count.motion >= 0 &&
    Number.isSafeInteger(count.sound) &&
    count.sound >= 0;
  if (
    state.version !== 1 ||
    !Array.isArray(state.events) ||
    state.events.length > MAX_RECENT_EVENTS ||
    !state.events.every(validEvent) ||
    !Array.isArray(state.seen) ||
    state.seen.length > MAX_SEEN_EVENTS ||
    !state.seen.every(
      (item) =>
        typeof item.key === "string" &&
        item.key.length <= 129 &&
        Number.isSafeInteger(item.time) &&
        item.time > 0,
    ) ||
    !Number.isSafeInteger(state.dedupFloor) ||
    state.dedupFloor < 0 ||
    !state.nights ||
    typeof state.nights !== "object" ||
    Object.keys(state.nights).length > 90 ||
    !Object.entries(state.nights).every(
      ([key, night]) =>
        /^\d{4}-\d{2}-\d{2}$/.test(key) &&
        validCount(night) &&
        Array.isArray(night.hours) &&
        night.hours.length === 14 &&
        night.hours.every(validCount),
    )
  )
    throw new Error("Saved activity is invalid.");
  return state;
}
export function saveActivity(state: ActivityState, storage?: ActivityStorage) {
  (storage ?? localStorage).setItem(
    ACTIVITY_STORAGE_KEY,
    JSON.stringify(state),
  );
}
