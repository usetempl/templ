import { HttpError } from "./common";

/** RFC 9562 UUIDv7: 48-bit millisecond timestamp, a 12-bit counter in
 * rand_a, then random bits. Minted inside a storage transaction, the id orders
 * records created in that transaction; the counter keeps ids minted in the
 * same millisecond in mint order (method 1), so a burst still ranks FIFO. */
let lastMintedMs = -1;
let mintedSequence = 0;
/** Callers pass the current time; anything else is a server fault. */
const unminted = () =>
  new HttpError(503, "This could not be saved. Try again.");
export function uuidv7(
  nowMs: number,
  random: (bytes: Uint8Array) => Uint8Array = (bytes) =>
    crypto.getRandomValues(bytes),
): string {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs >= 2 ** 48)
    throw unminted();
  let ms = nowMs;
  const bytes = random(new Uint8Array(16));
  if (bytes.length !== 16) throw unminted();
  if (ms === lastMintedMs && mintedSequence < 0xfff) mintedSequence++;
  else if (ms === lastMintedMs) {
    // Counter exhausted inside one millisecond: borrow the next one.
    ms++;
    mintedSequence = 0;
  } else mintedSequence = 0;
  lastMintedMs = ms;
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = (ms >>> 24) & 0xff;
  bytes[3] = (ms >>> 16) & 0xff;
  bytes[4] = (ms >>> 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = 0x70 | ((mintedSequence >>> 8) & 0x0f);
  bytes[7] = mintedSequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
