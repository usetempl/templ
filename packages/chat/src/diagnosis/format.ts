import { shortSolanaAddress } from "../solana";

/** "2026-10-02T14:05:00.123Z" -> "2026-10-02 14:05 UTC". The input is already
 * validated; the engine never reads a clock. */
export function formatIsoTime(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** Digits with thousands separators: "12345678" -> "12,345,678". */
export function formatInteger(value: string | bigint | number): string {
  const text = typeof value === "string" ? value : value.toString();
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  let out = "";
  for (let index = 0; index < digits.length; index++) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ",";
    out += digits[index];
  }
  return negative ? `-${out}` : out;
}

/** A token amount with at most 6 decimals, truncated toward zero and never
 * rounded up. A non-zero amount below 0.000001 reads "<0.000001". */
export function formatAmount(raw: bigint, decimals: number): string {
  const value = raw < 0n ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  let fraction = "";
  if (decimals > 0) {
    const rest = (value % scale).toString().padStart(decimals, "0");
    fraction = rest.slice(0, 6).replace(/0+$/, "");
  }
  if (whole === 0n && fraction === "" && value > 0n) return "<0.000001";
  return fraction
    ? `${formatInteger(whole)}.${fraction}`
    : formatInteger(whole);
}

/** 0x71c7656ec7ab88b098defb751b7401b5f6d8976f -> 0x71c7…976f */
export function shortHex(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Short form of an EVM address or hash, or of a Solana address or signature. */
export function shortRef(value: string): string {
  return value.startsWith("0x") ? shortHex(value) : shortSolanaAddress(value);
}

/** ["Ethereum", "Base", "BNB Chain"] -> "Ethereum, Base or BNB Chain". */
export function formatList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** Removes control and format characters (including bidi overrides), turns
 * double quotes into single quotes so staff quoting stays unambiguous, and
 * keeps at most `max` characters. Contract- and program-supplied text only
 * ever reaches staff text through this function. */
export function sanitizeText(value: string, max = 200): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/"/g, "'");
  const chars = Array.from(clean);
  return chars.length > max ? chars.slice(0, max).join("") : clean;
}

/** Cuts text to at most `max` characters at a word boundary. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  return `${space > max / 2 ? head.slice(0, space) : head}…`;
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}
