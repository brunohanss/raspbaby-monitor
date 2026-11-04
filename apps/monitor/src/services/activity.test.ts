import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTIVITY_STORAGE_KEY,
  MAX_RECENT_EVENTS,
  MAX_SEEN_EVENTS,
  addActivity,
  emptyActivity,
  latestNightKey,
  loadActivity,
  nightKey,
  previousNights,
  saveActivity,
} from "./activity";

const originalTimezone = process.env.TZ;
beforeEach(() => {
  process.env.TZ = "Europe/Paris";
});
afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimezone;
});
const time = (value: string) => new Date(value).getTime();

describe("received activity metadata", () => {
  it("uses local evening dates and excludes daytime from night totals at exact boundaries", () => {
    expect(nightKey(time("2026-11-04T18:00:00+01:00"))).toBe("2026-11-04");
    expect(nightKey(time("2026-11-05T07:59:59+01:00"))).toBe("2026-11-04");
    expect(nightKey(time("2026-11-05T08:00:00+01:00"))).toBeNull();
    expect(nightKey(time("2026-11-04T17:59:59+01:00"))).toBeNull();
    expect(latestNightKey(time("2026-11-05T13:00:00+01:00"))).toBe(
      "2026-11-04",
    );
  });

  it("counts both repeated DST hours in one wall-clock bin and walks calendar dates across DST", () => {
    const first = time("2026-10-25T00:30:00Z");
    const second = time("2026-10-25T01:30:00Z");
    const result = addActivity(
      emptyActivity(),
      "pi",
      [
        { id: "one", kind: "motion", timestamp_ms: first },
        { id: "two", kind: "motion", timestamp_ms: second },
      ],
      second + 1000,
    );
    expect(result.state.nights["2026-10-24"]?.motion).toBe(2);
    expect(result.state.nights["2026-10-24"]?.hours[8]?.motion).toBe(2);
    expect(previousNights("2026-10-26", 3)).toEqual([
      "2026-10-26",
      "2026-10-25",
      "2026-10-24",
    ]);
    expect(nightKey(time("2026-03-29T01:30:00Z"))).toBe("2026-03-28");
    expect(previousNights("2026-03-30", 3)).toEqual([
      "2026-03-30",
      "2026-03-29",
      "2026-03-28",
    ]);
  });

  it("deduplicates device plus event IDs across persisted reconnects while retaining totals after row trimming", () => {
    const start = time("2026-11-04T20:00:00+01:00");
    const events = Array.from(
      { length: MAX_RECENT_EVENTS + 20 },
      (_, index) => ({
        id: `event-${index}`,
        kind: "sound" as const,
        timestamp_ms: start + index * 1000,
      }),
    );
    const result = addActivity(emptyActivity(), "pi", events, start + 600000);
    expect(result.state.events).toHaveLength(MAX_RECENT_EVENTS);
    expect(result.state.nights["2026-11-04"]?.sound).toBe(520);
    let saved = "";
    const storage = {
      getItem: (key: string) => (key === ACTIVITY_STORAGE_KEY ? saved : null),
      setItem: (_key: string, value: string) => {
        saved = value;
      },
    };
    saveActivity(result.state, storage);
    const repeated = addActivity(
      loadActivity(storage),
      "pi",
      events,
      start + 600000,
    );
    expect(repeated.fresh).toHaveLength(0);
    expect(repeated.state.nights["2026-11-04"]?.sound).toBe(520);
    const otherDevice = addActivity(
      repeated.state,
      "other-pi",
      [events[0]!],
      start + 600000,
    );
    expect(otherDevice.fresh).toHaveLength(1);
    expect(otherDevice.state.nights["2026-11-04"]?.sound).toBe(521);
  });

  it("bounds dedup metadata and refuses replay older than its retention floor without shrinking rollups", () => {
    const start = time("2026-11-04T20:00:00+01:00");
    const events = Array.from({ length: MAX_SEEN_EVENTS + 1 }, (_, index) => ({
      id: `e-${index}`,
      kind: "motion" as const,
      timestamp_ms: start + index,
    }));
    const result = addActivity(emptyActivity(), "pi", events, start + 20000);
    expect(result.state.seen).toHaveLength(MAX_SEEN_EVENTS);
    expect(result.state.nights["2026-11-04"]?.motion).toBe(10001);
    const repeated = addActivity(
      result.state,
      "pi",
      [events[0]!],
      start + 21000,
    );
    expect(repeated.fresh).toHaveLength(0);
    expect(repeated.state.nights["2026-11-04"]?.motion).toBe(10001);
  });

  it("keeps daytime events in history and rejects fabricated future timestamps and malformed storage", () => {
    const now = time("2026-11-04T12:00:00+01:00");
    const result = addActivity(
      emptyActivity(),
      "pi",
      [
        { id: "day", kind: "motion", timestamp_ms: now },
        { id: "future", kind: "sound", timestamp_ms: now + 60000 },
      ],
      now,
    );
    expect(result.state.events).toHaveLength(1);
    expect(result.state.nights).toEqual({});
    expect(() =>
      loadActivity({ getItem: () => '{"version":1}', setItem: () => {} }),
    ).toThrow();
  });
});
