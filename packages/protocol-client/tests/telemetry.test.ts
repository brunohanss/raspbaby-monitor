import { describe, expect, test } from "vitest";
import { MAX_SAFE_COUNTER, MAX_TELEMETRY_BYTES, MAX_TELEMETRY_TIMESTAMP_MS, parseTelemetryMessage } from "../src";

const message = () => ({ protocol_version: 1, type: "monitor.telemetry", device_id: "pi-3", sequence: 12, timestamp_ms: 1800000000000, temperature_c: 52.5, audio_level: 0.02, motion_active: true, sound_active: false, dropped_events: 0, events: [{ id: "motion-1", kind: "motion", timestamp_ms: 1799999999800 }] });

describe("analysis telemetry", () => {
  test("parses bounded measurements and ignores optional extensions", () => {
    const value = message();
    expect(parseTelemetryMessage(JSON.stringify({ ...value, extension: true }))).toEqual(value);
    const { temperature_c, audio_level, dropped_events, sound_active, ...withoutOptional } = value;
    expect(parseTelemetryMessage(JSON.stringify(withoutOptional))).toMatchObject({ temperature_c: null, audio_level: null, dropped_events: 0, sound_active: false });
    expect([temperature_c, audio_level, dropped_events, sound_active]).toHaveLength(4);
  });

  test("rejects unsafe versions, identifiers, counters, measurements and event shapes", () => {
    const changes = [
      { protocol_version: 2 }, { type: "webrtc.offer" }, { device_id: "bad id" }, { device_id: "x".repeat(65) },
      { sequence: -1 }, { sequence: 0.5 }, { sequence: MAX_SAFE_COUNTER + 1 }, { timestamp_ms: MAX_TELEMETRY_TIMESTAMP_MS + 1 },
      { temperature_c: 126 }, { temperature_c: "52" }, { audio_level: -0.1 }, { audio_level: 1.1 }, { motion_active: 1 },
      { sound_active: null }, { sound_active: 1 },
      { dropped_events: null }, { dropped_events: -1 }, { events: null }, { events: [null] },
      { events: [{ id: "e", kind: "cry", timestamp_ms: 0 }] },
      { events: [{ id: "e", kind: "sound", timestamp_ms: 1800000000001 }] },
      { events: Array.from({ length: 33 }, (_, i) => ({ id: `e-${i}`, kind: "motion", timestamp_ms: 0 })) },
      { events: [{ id: "e", kind: "motion", timestamp_ms: 0 }, { id: "e", kind: "sound", timestamp_ms: 0 }] },
    ];
    for (const changed of changes) expect(() => parseTelemetryMessage(JSON.stringify({ ...message(), ...changed }))).toThrow();
    for (const raw of ["null", "[]", "{}", "{"]) expect(() => parseTelemetryMessage(raw)).toThrow();
    expect(() => parseTelemetryMessage(" ".repeat(MAX_TELEMETRY_BYTES + 1))).toThrow();
    expect(() => parseTelemetryMessage(`{"padding":"${"é".repeat(MAX_TELEMETRY_BYTES / 2)}"}`)).toThrow();
  });
});
