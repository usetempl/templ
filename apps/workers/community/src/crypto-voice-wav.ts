import { HttpError } from "./common";

const HEADER_BYTES = 44;
const BYTES_PER_SECOND = 32_000;
export const CRYPTO_VOICE_WAV = {
  minDataBytes: 12_800,
  maxDataBytes: 120 * BYTES_PER_SECOND,
  maxBytes: HEADER_BYTES + 120 * BYTES_PER_SECOND,
} as const;
/** A 20 ms frame counts as sound above about -50 dBFS; ten of them pass. */
const FRAME_SAMPLES = 320;
const QUIET = 100;
const SOUND_FRAMES = 10;
const BASE64_STEP = 24_576;
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type CryptoVoiceNote = {
  bytes: Uint8Array;
  clientId: string;
  /** Whole seconds, rounded up, for the cost hold. */
  seconds: number;
};

const unreadable = () =>
  new HttpError(
    400,
    "This voice note could not be read. Record it again.",
    undefined,
    "voice-note-invalid",
  );
const tooLarge = () =>
  new HttpError(
    413,
    "This voice note is too long. Keep it under 2 minutes.",
    undefined,
    "voice-note-too-large",
  );
const tooShort = () =>
  new HttpError(
    400,
    "This voice note is too short. Record it again.",
    undefined,
    "voice-note-too-short",
  );

export function cryptoVoiceDataBytes(header: Uint8Array): number {
  if (header.byteLength < HEADER_BYTES) throw unreadable();
  const view = new DataView(header.buffer, header.byteOffset, HEADER_BYTES);
  const tag = (at: number) =>
    String.fromCharCode(header[at], header[at + 1], header[at + 2], header[at + 3]);
  const data = view.getUint32(40, true);
  if (
    tag(0) !== "RIFF" ||
    tag(8) !== "WAVE" ||
    tag(12) !== "fmt " ||
    tag(36) !== "data" ||
    view.getUint32(16, true) !== 16 ||
    view.getUint16(20, true) !== 1 ||
    view.getUint16(22, true) !== 1 ||
    view.getUint32(24, true) !== 16_000 ||
    view.getUint32(28, true) !== BYTES_PER_SECOND ||
    view.getUint16(32, true) !== 2 ||
    view.getUint16(34, true) !== 16 ||
    view.getUint32(4, true) !== data + 36 ||
    data % 2 !== 0
  )
    throw unreadable();
  if (data > CRYPTO_VOICE_WAV.maxDataBytes) throw tooLarge();
  if (data < CRYPTO_VOICE_WAV.minDataBytes) throw tooShort();
  return data;
}

export function cryptoVoiceHasSound(bytes: Uint8Array): boolean {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset + HEADER_BYTES,
    bytes.byteLength - HEADER_BYTES,
  );
  const frame = FRAME_SAMPLES * 2;
  let loud = 0;
  for (let start = 0; start + frame <= view.byteLength; start += frame) {
    let energy = 0;
    for (let at = start; at < start + frame; at += 2) {
      const sample = view.getInt16(at, true);
      energy += sample * sample;
    }
    if (energy >= FRAME_SAMPLES * QUIET * QUIET && ++loud >= SOUND_FRAMES)
      return true;
  }
  return false;
}

export function checkedCryptoVoiceWav(bytes: Uint8Array): { seconds: number } {
  const data = cryptoVoiceDataBytes(bytes);
  if (bytes.byteLength !== HEADER_BYTES + data) throw unreadable();
  if (!cryptoVoiceHasSound(bytes))
    throw new HttpError(
      422,
      "Templ could not hear any words. Record it again or type your question.",
      undefined,
      "voice-note-silent",
    );
  return { seconds: Math.ceil(data / BYTES_PER_SECOND) };
}

export async function readCryptoVoiceNote(
  request: Request,
  url: URL,
): Promise<CryptoVoiceNote> {
  if (
    request.headers.get("Content-Type") !== "audio/wav" ||
    request.headers.has("Content-Encoding")
  )
    throw new HttpError(
      415,
      "This voice note could not be read. Record it again.",
      undefined,
      "voice-note-invalid",
    );
  const clientId = url.searchParams.get("clientId") ?? "";
  if (!CLIENT_ID.test(clientId) || [...url.searchParams.keys()].length !== 1)
    throw new HttpError(
      400,
      "Send a valid voice note request id.",
      undefined,
      "voice-note-invalid",
    );
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^[0-9]{1,10}$/.test(declared)) throw unreadable();
    if (Number(declared) > CRYPTO_VOICE_WAV.maxBytes) throw tooLarge();
    if (Number(declared) < HEADER_BYTES + CRYPTO_VOICE_WAV.minDataBytes)
      throw tooShort();
  }
  const reader = request.body?.getReader();
  if (!reader) throw unreadable();
  const header = new Uint8Array(HEADER_BYTES);
  let size = 0;
  let bytes: Uint8Array | undefined;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > CRYPTO_VOICE_WAV.maxBytes) throw tooLarge();
      let offset = 0;
      if (!bytes) {
        offset = Math.min(HEADER_BYTES - size, value.byteLength);
        header.set(value.subarray(0, offset), size);
        size += offset;
        if (size < HEADER_BYTES) continue;
        const total = HEADER_BYTES + cryptoVoiceDataBytes(header);
        if (declared !== null && Number(declared) !== total) throw unreadable();
        bytes = new Uint8Array(total);
        bytes.set(header);
      }
      const remaining = value.subarray(offset);
      if (size + remaining.byteLength > bytes.length) throw unreadable();
      bytes.set(remaining, size);
      size += remaining.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error instanceof HttpError ? error : unreadable();
  } finally {
    reader.releaseLock();
  }
  if (!bytes || size !== bytes.length) throw unreadable();
  return { bytes, clientId, ...checkedCryptoVoiceWav(bytes) };
}

/** Base64 for the model's `audio` field, built in steps of whole triplets. */
export function cryptoVoiceBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.byteLength; at += BASE64_STEP)
    text += btoa(String.fromCharCode(...bytes.subarray(at, at + BASE64_STEP)));
  return text;
}
