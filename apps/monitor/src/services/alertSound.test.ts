import { describe, expect, it } from "vitest";
import {
  ALERT_SOUND_STORAGE_KEY,
  MAX_ALERT_SOUND_BYTES,
  defaultAlertSoundSettings,
  importAlertSound,
  loadAlertSoundSettings,
  saveAlertSoundSettings,
} from "./alertSound";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("local alert sound", () => {
  it("imports supported files as bounded local audio data and restores one shared selection", async () => {
    const storage = memoryStorage();
    for (const [extension, mime] of [
      ["wav", "audio/wav"],
      ["mp3", "audio/mpeg"],
      ["ogg", "audio/ogg"],
    ]) {
      const file = new File(
        [new Uint8Array([0, 1, 254, 255])],
        `murloc.${extension}`,
      );
      const clip = await importAlertSound(file);
      expect(clip.dataUrl).toBe(`data:${mime};base64,AAH+/w==`);
      const settings = { ...defaultAlertSoundSettings(), clip, volume: 0.4 };
      saveAlertSoundSettings(settings, storage);
      expect(loadAlertSoundSettings(storage)).toEqual(settings);
      expect(storage.values.size).toBe(1);
    }
  });

  it("rejects empty, unsupported, and oversized imports before saving", async () => {
    await expect(importAlertSound(new File([], "empty.wav"))).rejects.toThrow(
      "1 MiB",
    );
    await expect(
      importAlertSound(new File(["audio"], "remote.html")),
    ).rejects.toThrow("WAV, MP3, or OGG");
    await expect(
      importAlertSound(
        new File([new Uint8Array(MAX_ALERT_SOUND_BYTES + 1)], "large.mp3"),
      ),
    ).rejects.toThrow("1 MiB");
  });

  it("retains the previous selection on storage failure and can clear the clip while preserving volume", async () => {
    const storage = memoryStorage();
    const clip = await importAlertSound(new File(["audio"], "murloc.mp3"));
    const settings = { ...defaultAlertSoundSettings(), clip, volume: 0.3 };
    saveAlertSoundSettings(settings, storage);
    const fullStorage = {
      getItem: storage.getItem,
      setItem: () => {
        throw new Error("Quota exceeded");
      },
    };
    expect(() =>
      saveAlertSoundSettings({ ...settings, clip: null }, fullStorage),
    ).toThrow("Free local storage");
    expect(loadAlertSoundSettings(storage)).toEqual(settings);
    saveAlertSoundSettings({ ...settings, clip: null }, storage);
    expect(loadAlertSoundSettings(storage)).toEqual({
      version: 1,
      volume: 0.3,
      clip: null,
    });
    expect(storage.getItem(ALERT_SOUND_STORAGE_KEY)).not.toContain(
      clip.dataUrl,
    );
  });

  it("rejects remote URLs, damaged saved data, and invalid volume instead of playing arbitrary sources", () => {
    const storage = memoryStorage();
    expect(loadAlertSoundSettings(storage)).toEqual(
      defaultAlertSoundSettings(),
    );
    for (const value of [
      "invalid JSON",
      JSON.stringify({ version: 1, volume: 2, clip: null }),
      JSON.stringify({
        version: 1,
        volume: 0.5,
        clip: { name: "remote", dataUrl: "https://example.com/audio.mp3" },
      }),
    ]) {
      storage.values.set(ALERT_SOUND_STORAGE_KEY, value);
      expect(() => loadAlertSoundSettings(storage)).toThrow(
        "Import the file again",
      );
    }
    expect(() =>
      saveAlertSoundSettings(
        { version: 1, volume: Number.NaN, clip: null },
        storage,
      ),
    ).toThrow("volume");
  });
});
