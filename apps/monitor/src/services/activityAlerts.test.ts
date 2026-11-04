import { describe, expect, it, vi } from "vitest";
import {
  ActivityAlertPlayer,
  activityAlertRepeatSeconds,
  saveActivityAlertRepeatSeconds,
} from "./activityAlerts";
import type { ActivityEvent } from "./activity";

function setup() {
  let now = 100000;
  let enabled = true;
  const sources: {
    buffer: AudioBuffer | null;
    onended: (() => void) | null;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }[] = [];
  const gain = { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  const context = {
    state: "running" as AudioContextState,
    destination: {} as AudioDestinationNode,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    decodeAudioData: vi.fn(async () => ({}) as AudioBuffer),
    createGain: vi.fn(() => gain as unknown as GainNode),
    createBufferSource: vi.fn(() => {
      const source = {
        buffer: null,
        onended: null,
        start: vi.fn(),
        stop: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      sources.push(source);
      return source as unknown as AudioBufferSourceNode;
    }),
  };
  const onError = vi.fn();
  const player = new ActivityAlertPlayer({
    contextFactory: () => context,
    onError,
    settings: () => ({
      version: 1,
      volume: 0.65,
      clip: { name: "murloc.wav", dataUrl: "data:audio/wav;base64,AA==" },
    }),
    enabled: () => enabled,
    now: () => now,
  });
  const event = (kind: "motion" | "sound"): ActivityEvent => ({
    device_id: "pi",
    id: `${kind}-${now}`,
    kind,
    timestamp_ms: now,
  });
  return {
    player,
    context,
    sources,
    gain,
    onError,
    event,
    advance: (ms: number) => {
      now += ms;
    },
    disable: () => {
      enabled = false;
    },
  };
}

describe("independent activity alert audio", () => {
  it("uses one separate audio context for either motion or sound, with overlap and cooldown suppression", async () => {
    const test = setup();
    test.player.unlock();
    expect(await test.player.notify(test.event("motion"))).toBe(true);
    expect(test.gain.gain.value).toBe(0.65);
    expect(test.sources[0]?.start).toHaveBeenCalledOnce();
    test.advance(4000);
    expect(await test.player.notify(test.event("sound"))).toBe(false);
    test.sources[0]!.onended!();
    test.advance(1000);
    expect(await test.player.notify(test.event("sound"))).toBe(true);
    test.sources[1]!.onended!();
    test.advance(4000);
    expect(await test.player.notify(test.event("motion"))).toBe(false);
    test.advance(1000);
    expect(await test.player.notify(test.event("motion"))).toBe(true);
    // Camera mute is deliberately absent from the alert interface and audio graph.
    expect(test.context.createBufferSource).toHaveBeenCalledTimes(3);
    test.player.dispose();
  });

  it.each([
    [true, false],
    [false, true],
  ] as const)(
    "repeats for motion=%s / sound=%s without requiring the other detector",
    async (motion, sound) => {
      const test = setup();
      test.player.unlock();
      const active = () => ({
        motion,
        sound,
        timestamp_ms: test.event("motion").timestamp_ms,
      });
      expect(await test.player.notifyActive(active())).toBe(true);
      test.sources[0]!.onended!();
      test.advance(4999);
      expect(await test.player.notifyActive(active())).toBe(false);
      test.advance(1);
      expect(await test.player.notifyActive(active())).toBe(true);
      expect(test.sources).toHaveLength(2);
      test.player.dispose();
    },
  );

  it("does not repeat during quiet or stale state, and null stops a playing notification", async () => {
    const test = setup();
    test.player.unlock();
    expect(
      await test.player.notifyActive({
        motion: true,
        sound: false,
        timestamp_ms: 100000,
      }),
    ).toBe(true);
    test.sources[0]!.onended!();
    test.advance(10000);
    expect(
      await test.player.notifyActive({
        motion: false,
        sound: false,
        timestamp_ms: 110000,
      }),
    ).toBe(false);
    expect(
      await test.player.notifyActive({
        motion: false,
        sound: true,
        timestamp_ms: 1,
      }),
    ).toBe(false);
    expect(test.sources).toHaveLength(1);
    expect(
      await test.player.notifyActive({
        motion: false,
        sound: true,
        timestamp_ms: 110000,
      }),
    ).toBe(true);
    expect(await test.player.notifyActive(null)).toBe(false);
    expect(test.sources[1]?.stop).toHaveBeenCalledOnce();
    test.player.dispose();
  });

  it("suppresses overlapping starts while decoding and cancels that start when activity becomes quiet", async () => {
    const test = setup();
    test.player.unlock();
    let finishDecode!: (buffer: AudioBuffer) => void;
    test.context.decodeAudioData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDecode = resolve;
        }),
    );
    const pending = test.player.notifyActive({
      motion: true,
      sound: false,
      timestamp_ms: 100000,
    });
    expect(
      await test.player.notifyActive({
        motion: false,
        sound: true,
        timestamp_ms: 100000,
      }),
    ).toBe(false);
    expect(
      await test.player.notifyActive({
        motion: false,
        sound: false,
        timestamp_ms: 100000,
      }),
    ).toBe(false);
    finishDecode({} as AudioBuffer);
    expect(await pending).toBe(false);
    expect(test.sources).toHaveLength(0);
    expect(
      await test.player.notifyActive({
        motion: false,
        sound: true,
        timestamp_ms: 100000,
      }),
    ).toBe(true);
    test.player.dispose();
  });

  it("stores an adjustable 5–60 second repeat interval and rejects invalid settings", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    try {
      expect(activityAlertRepeatSeconds()).toBe(5);
      for (const invalid of [4, 61, 5.5, Number.NaN])
        expect(() => saveActivityAlertRepeatSeconds(invalid)).toThrow();
      saveActivityAlertRepeatSeconds(60);
      expect(activityAlertRepeatSeconds()).toBe(60);
      saveActivityAlertRepeatSeconds(5);
      expect(activityAlertRepeatSeconds()).toBe(5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports blocked audio without pretending to play and respects the independent alert disable setting", async () => {
    const test = setup();
    expect(await test.player.notify(test.event("sound"))).toBe(false);
    expect(test.onError).toHaveBeenCalledWith(
      expect.stringContaining("Allow alert sounds"),
    );
    test.player.unlock();
    test.disable();
    expect(await test.player.notify(test.event("motion"))).toBe(false);
    expect(test.sources).toHaveLength(0);
    test.player.dispose();
  });

  it("does not replay old reconnect history or start decoded audio after monitoring stops", async () => {
    const test = setup();
    test.player.unlock();
    expect(
      await test.player.notify({ ...test.event("sound"), timestamp_ms: 1 }),
    ).toBe(false);
    let finishDecode!: (buffer: AudioBuffer) => void;
    test.context.decodeAudioData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDecode = resolve;
        }),
    );
    const pending = test.player.notify(test.event("motion"));
    test.player.stop();
    finishDecode({} as AudioBuffer);
    expect(await pending).toBe(false);
    expect(test.sources).toHaveLength(0);
    test.player.dispose();
  });
});
