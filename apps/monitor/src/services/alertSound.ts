export const MAX_ALERT_SOUND_BYTES = 1024 * 1024;
export const ALERT_SOUND_STORAGE_KEY = "raspbaby:alert-sound";

export interface AlertSoundSettings {
  version: 1;
  volume: number;
  clip: { name: string; dataUrl: string } | null;
}
type SoundStorage = Pick<Storage, "getItem" | "setItem">;
const maximumDataUrlLength = Math.ceil(MAX_ALERT_SOUND_BYTES / 3) * 4 + 64;

export function defaultAlertSoundSettings(): AlertSoundSettings {
  return { version: 1, volume: 0.65, clip: null };
}

function validateSettings(value: unknown): AlertSoundSettings {
  if (!value || typeof value !== "object")
    throw new Error("Invalid sound settings.");
  const settings = value as Partial<AlertSoundSettings>;
  if (
    settings.version !== 1 ||
    typeof settings.volume !== "number" ||
    !Number.isFinite(settings.volume) ||
    settings.volume < 0 ||
    settings.volume > 1
  )
    throw new Error("Invalid sound volume.");
  if (settings.clip !== null) {
    const clip = settings.clip;
    if (
      !clip ||
      typeof clip.name !== "string" ||
      !clip.name ||
      clip.name.length > 200 ||
      typeof clip.dataUrl !== "string" ||
      clip.dataUrl.length > maximumDataUrlLength ||
      !/^data:audio\/(?:wav|mpeg|ogg);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        clip.dataUrl,
      )
    )
      throw new Error("Invalid local sound file.");
    const decodedLength = atob(
      clip.dataUrl.slice(clip.dataUrl.indexOf(",") + 1),
    ).length;
    if (decodedLength === 0 || decodedLength > MAX_ALERT_SOUND_BYTES)
      throw new Error("Invalid local sound size.");
  }
  return settings as AlertSoundSettings;
}

export function loadAlertSoundSettings(
  storage?: SoundStorage,
): AlertSoundSettings {
  try {
    const raw = (storage ?? localStorage).getItem(ALERT_SOUND_STORAGE_KEY);
    if (raw === null) return defaultAlertSoundSettings();
    if (raw.length > maximumDataUrlLength + 1024)
      throw new Error("Saved sound is too large.");
    return validateSettings(JSON.parse(raw));
  } catch {
    throw new Error(
      "Could not read the saved alert sound. Import the file again.",
    );
  }
}

export function saveAlertSoundSettings(
  settings: AlertSoundSettings,
  storage?: SoundStorage,
) {
  validateSettings(settings);
  try {
    (storage ?? localStorage).setItem(
      ALERT_SOUND_STORAGE_KEY,
      JSON.stringify(settings),
    );
  } catch {
    throw new Error(
      "Could not save the sound on this device. Free local storage or choose a smaller file.",
    );
  }
}

export async function importAlertSound(
  file: File,
): Promise<NonNullable<AlertSoundSettings["clip"]>> {
  if (file.size === 0 || file.size > MAX_ALERT_SOUND_BYTES)
    throw new Error("Choose a sound file between 1 byte and 1 MiB.");
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const mime =
    extension === "wav"
      ? "audio/wav"
      : extension === "mp3"
        ? "audio/mpeg"
        : extension === "ogg"
          ? "audio/ogg"
          : null;
  if (!mime) throw new Error("Choose a WAV, MP3, or OGG sound file.");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new Error("Could not read this sound file. Select it again.");
  }
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ALERT_SOUND_BYTES)
    throw new Error("Choose a sound file between 1 byte and 1 MiB.");
  // Encode bounded bytes directly. No remote URL or network request is involved.
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return {
    name: file.name.slice(0, 200),
    dataUrl: `data:${mime};base64,${btoa(binary)}`,
  };
}
