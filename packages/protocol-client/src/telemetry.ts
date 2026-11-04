import {
  MAX_SAFE_COUNTER,
  MAX_TELEMETRY_BYTES,
  MAX_TELEMETRY_EVENTS,
  MAX_TELEMETRY_ID_BYTES,
  MAX_TELEMETRY_TIMESTAMP_MS,
  PROTOCOL_VERSION,
  type TelemetryEvent,
  type TelemetryMessage,
} from "./generated";

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a telemetry object");
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_TELEMETRY_ID_BYTES || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("Invalid telemetry ID");
  }
  return value;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("Invalid telemetry integer");
  return value;
}

function nullableRange(value: unknown, minimum: number, maximum: number): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error("Invalid telemetry measurement");
  return value;
}

/** Parse analysis results only. No raw media belongs in this bounded contract. */
export function parseTelemetryMessage(raw: string): TelemetryMessage {
  if (raw.length > MAX_TELEMETRY_BYTES || new TextEncoder().encode(raw).length > MAX_TELEMETRY_BYTES) throw new Error("Telemetry exceeds 8192 bytes");
  const value = object(JSON.parse(raw));
  if (value.protocol_version !== PROTOCOL_VERSION) throw new Error("Unsupported telemetry major version");
  if (value.type !== "monitor.telemetry") throw new Error("Unsupported telemetry type");
  if (typeof value.motion_active !== "boolean") throw new Error("Invalid motion state");
  if (value.sound_active !== undefined && typeof value.sound_active !== "boolean") throw new Error("Invalid sound state");
  const timestamp = integer(value.timestamp_ms, MAX_TELEMETRY_TIMESTAMP_MS);
  if (!Array.isArray(value.events) || value.events.length > MAX_TELEMETRY_EVENTS) throw new Error("Invalid telemetry events");
  const ids = new Set<string>();
  const events: TelemetryEvent[] = value.events.map((entry: unknown) => {
    const event = object(entry);
    const id = identifier(event.id);
    if (ids.has(id)) throw new Error("Duplicate event ID");
    ids.add(id);
    if (event.kind !== "motion" && event.kind !== "sound") throw new Error("Unsupported activity event");
    return { id, kind: event.kind, timestamp_ms: integer(event.timestamp_ms, timestamp) };
  });
  return {
    protocol_version: PROTOCOL_VERSION,
    type: "monitor.telemetry",
    device_id: identifier(value.device_id),
    sequence: integer(value.sequence, MAX_SAFE_COUNTER),
    timestamp_ms: timestamp,
    temperature_c: nullableRange(value.temperature_c, -40, 125),
    audio_level: nullableRange(value.audio_level, 0, 1),
    motion_active: value.motion_active,
    sound_active: value.sound_active === undefined ? false : value.sound_active,
    dropped_events: integer(value.dropped_events === undefined ? 0 : value.dropped_events, MAX_SAFE_COUNTER),
    events,
  };
}
