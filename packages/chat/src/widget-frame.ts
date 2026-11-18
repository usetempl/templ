/** Frame mode: the names the frame host on a
 * protocol's page, the frame adapter on Templ's frame origin and the worker
 * share, and the one check the frame host runs before it lets the page's
 * wallet sign anything the frame asks for. Browser-safe: no wallet library,
 * no network, no storage. */
import { createSolanaSignInMessage, parseSolanaSignInMessage } from "./solana";
import {
  WIDGET_REMEMBER_STATEMENT,
  WIDGET_SIGN_IN_STATEMENT,
} from "./widget-wallet";

/** The header a frame request names its host page's origin in. The worker
 * accepts it only from the configured frame origin. */
export const WIDGET_HOST_ORIGIN_HEADER = "X-Templ-Host-Origin";
/** The frame document's path on the frame origin, before the workspace id. */
export const WIDGET_FRAME_PATH = "/support-frame/v1/";
/** The one window message of a mount: it carries the port. */
export const WIDGET_FRAME_HELLO = "templ.frame.hello";
export const WIDGET_FRAME_VERSION = 1;
/** Port messages larger than this, as JSON text, are dropped unread. */
export const WIDGET_FRAME_MESSAGE_LIMIT = 16_384;
/** The longest sign-in text the frame host lets a wallet sign, in bytes. */
export const WIDGET_FRAME_SIGN_IN_BYTES = 4096;
/** Sign-ins the frame host relays per rolling minute. */
export const WIDGET_FRAME_SIGNS_PER_MINUTE = 3;

/** Each port message kind with its exact keys: required first, then
 * optional. Anything else is dropped without a reply. One table per
 * direction, so each side carries only what it reads. */
type FrameKinds = Record<
  string,
  readonly [readonly string[], readonly string[]]
>;
/** Page to frame. */
export const WIDGET_FRAME_TO_FRAME: FrameKinds = {
  init: [["options", "wallet"], ["adopt"]],
  open: [[], []],
  close: [[], []],
  context: [["context"], []],
  failure: [["id", "context"], ["capture"]],
  wallet: [["wallet"], []],
  appearance: [["theme", "font"], []],
  result: [
    ["id", "ok"],
    ["value", "error"],
  ],
  destroy: [[], []],
};
/** Frame to page. */
export const WIDGET_FRAME_TO_HOST: FrameKinds = {
  "guest-restored": [["fragment"], []],
  ready: [[], []],
  captured: [["id"], []],
  panel: [["open"], []],
  unread: [["n"], []],
  "appearance-config": [["value"], []],
  call: [["id", "m", "p"], []],
  adopted: [["ok"], []],
};
export type WidgetFrameMessage = { k: string } & Record<string, unknown>;

/** The size a port message counts for: its JSON text, with byte arrays
 * counted by their length. Unserializable data counts as too large. */
export function frameMessageSize(data: unknown): number {
  try {
    return JSON.stringify(data, (_key, value) =>
      value instanceof Uint8Array ? value.length : value,
    ).length;
  } catch {
    return Infinity;
  }
}

/** A port message as its receiver may handle it: a plain object with a
 * known `k` and exactly that kind's keys, within the size cap. `kinds` is
 * the receiving side's table. */
export function checkedFrameMessage(
  data: unknown,
  kinds: FrameKinds,
): WidgetFrameMessage | null {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.getPrototypeOf(data) !== Object.prototype
  )
    return null;
  const message = data as Record<string, unknown>;
  if (
    typeof message.k !== "string" ||
    !Object.prototype.hasOwnProperty.call(kinds, message.k)
  )
    return null;
  const [required, optional] = kinds[message.k];
  const keys = Object.keys(message).filter((key) => key !== "k");
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    frameMessageSize(message) > WIDGET_FRAME_MESSAGE_LIMIT
  )
    return null;
  return message as WidgetFrameMessage;
}

/** An `https:` origin a frame may serve: no path, credentials, query or
 * fragment, and not a development origin on this computer. */
export function isFrameHostOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 200) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/** What the page's wallet reports right now, and the one workspace resource
 * a Templ sign-in for this page names. `now` is Unix ms. */
export type FrameSignInExpectation = {
  /** `location.host` and `location.origin` of the protocol's page. */
  host: string;
  origin: string;
  /** Only Templ’s own help page may use its workspace help URI. */
  hosted?: boolean;
  /** The page's current account: an EVM address or a Solana base58 key. */
  address: string;
  /** The EVM chain the page's wallet reports now; unused for Solana. */
  chainId?: number;
  /** `widgetSignInResource(<Templ app origin>, <workspace>)`. */
  resource: string;
  now: number;
};

const STATEMENTS: readonly string[] = [
  WIDGET_SIGN_IN_STATEMENT,
  WIDGET_REMEMBER_STATEMENT,
];
const NONCE = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
/** Issued no more than a minute ahead, not expired, and valid for at most
 * ten minutes. */
function timesHold(issued: string, expires: string, now: number) {
  if (!ISO.test(issued) || !ISO.test(expires)) return false;
  const issuedAt = Date.parse(issued);
  const expiresAt = Date.parse(expires);
  return (
    Number.isFinite(issuedAt) &&
    Number.isFinite(expiresAt) &&
    issuedAt <= now + 60_000 &&
    now < expiresAt &&
    expiresAt <= issuedAt + 600_000
  );
}

/** Whether `text` is exactly a Templ widget sign-in (SIWE for "evm", Sign In
 * With Solana for "solana") for this page's domain and origin, the page
 * wallet's current account (and EVM chain), one of the two widget
 * statements, a single-use nonce, a short validity and this workspace as
 * the only resource. Nothing else may be in it. */
export function checkFrameSignIn(
  family: "evm" | "solana",
  text: string,
  expected: FrameSignInExpectation,
): boolean {
  if (
    typeof text !== "string" ||
    new TextEncoder().encode(text).length > WIDGET_FRAME_SIGN_IN_BYTES
  )
    return false;
  const uri = expected.hosted
    ? expected.resource.replace(
        `${expected.origin}/rooms/`,
        `${expected.origin}/help/`,
      )
    : expected.origin;
  if (
    expected.hosted &&
    (!expected.resource.startsWith(`${expected.origin}/rooms/`) ||
      uri === expected.resource)
  )
    return false;
  if (family === "solana") {
    const parsed = parseSolanaSignInMessage(text);
    if (
      !parsed ||
      parsed.domain !== expected.host ||
      parsed.address !== expected.address ||
      parsed.uri !== uri ||
      !STATEMENTS.includes(parsed.statement) ||
      !NONCE.test(parsed.nonce) ||
      parsed.resources.length !== 1 ||
      parsed.resources[0] !== expected.resource ||
      !timesHold(parsed.issuedAt, parsed.expirationTime, expected.now)
    )
      return false;
    // Rebuilt field by field, it must give back the same text: no repeated
    // key, no extra line.
    return (
      createSolanaSignInMessage({
        ...parsed,
        issuedAt: new Date(parsed.issuedAt),
        expirationTime: new Date(parsed.expirationTime),
      }) === text
    );
  }
  const lines = text.split("\n");
  const value = (index: number, key: string) =>
    lines[index]?.startsWith(`${key}: `)
      ? lines[index].slice(key.length + 2)
      : null;
  const issued = value(9, "Issued At");
  const expires = value(10, "Expiration Time");
  return (
    lines.length === 13 &&
    lines[0] ===
      `https://${expected.host} wants you to sign in with your Ethereum account:` &&
    /^0x[0-9a-fA-F]{40}$/.test(lines[1]) &&
    lines[1].toLowerCase() === expected.address.toLowerCase() &&
    lines[2] === "" &&
    STATEMENTS.includes(lines[3]) &&
    lines[4] === "" &&
    lines[5] === `URI: ${uri}` &&
    lines[6] === "Version: 1" &&
    Number.isSafeInteger(expected.chainId) &&
    lines[7] === `Chain ID: ${expected.chainId}` &&
    NONCE.test(value(8, "Nonce") ?? "") &&
    issued !== null &&
    expires !== null &&
    timesHold(issued, expires, expected.now) &&
    lines[11] === "Resources:" &&
    lines[12] === `- ${expected.resource}`
  );
}
