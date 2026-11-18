/** Typed details from a protocol's app (`context.app`): what the member
 * was doing, on which page and product, what the app showed and any error.
 * Pure functions with no I/O. The network rules come in as an argument, so a
 * widget chunk checks typed details with the rules it already loaded;
 * `support-context.ts` passes its own. Nothing here signs, reads a chain or
 * decides access. */
import type { SupportNetwork } from "./support";

/** What the member was doing in the protocol's app. */
export const SUPPORT_APP_ACTIONS = [
  "deposit",
  "withdraw",
  "claim",
  "migrate",
  "swap",
  "stake",
  "unstake",
  "approve",
  "bridge",
  "other",
] as const;
export type SupportAppAction = (typeof SUPPORT_APP_ACTIONS)[number];
export const SUPPORT_WIDGET_API_VERSION = "1";
export const SUPPORT_FAILURE_KINDS = [
  "rejected",
  "simulation",
  "submission",
  "broadcast",
  "other",
] as const;
export type SupportFailureKind = (typeof SUPPORT_FAILURE_KINDS)[number];
export type SupportFailureInput = {
  kind: SupportFailureKind;
  at?: string;
  asset?: { symbol?: string; address?: string; network?: string | number };
  amount?: string;
};
export type SupportFailure = Omit<SupportFailureInput, "asset"> & {
  asset?: { symbol?: string; address?: string; network?: SupportNetwork };
};
export type SupportSdk = { widget: string; api: string };
/** Optional troubleshooting facts, independently selected before sending. */
export const SUPPORT_DIAGNOSTIC_FIELDS = [
  "browser",
  "operatingSystem",
  "viewport",
  "screen",
  "language",
  "timeZone",
  "connection",
] as const;
export type SupportDiagnosticField = (typeof SUPPORT_DIAGNOSTIC_FIELDS)[number];
export type SupportDiagnostics = {
  browser?: string;
  operatingSystem?: string;
  viewport?: { width: number; height: number };
  screen?: { width: number; height: number };
  language?: string;
  timeZone?: string;
  connection?: {
    online: boolean;
    effectiveType?: "slow-2g" | "2g" | "3g" | "4g";
    saveData?: boolean;
  };
};
/** Each typed field is one row the member ticks on its own. */
export const SUPPORT_APP_FIELDS = [
  "page",
  "action",
  "product",
  "shown",
  "error",
  "connector",
  "appVersion",
  "device",
  "browser",
  "operatingSystem",
  "viewport",
  "screen",
  "language",
  "timeZone",
  "connection",
  "failure",
  "sdk",
] as const;
export type SupportAppField = (typeof SUPPORT_APP_FIELDS)[number];
export const SUPPORT_APP_LIMITS = {
  pageChars: 200,
  labelBytes: 80,
  shownChars: 40,
  periodChars: 40,
  timeChars: 40,
  codeChars: 64,
  messageBytes: 300,
  shortBytes: 60,
  amountChars: 40,
} as const;
/** What a host, the widget or the SDK may send as `context.app`. */
export type SupportAppContextInput = SupportDiagnostics & {
  /** "/" and a path: no query or fragment, at most 200 characters. */
  page?: string;
  action?: SupportAppAction;
  /** A vault, pool or market: a label, or an address with its network. */
  product?: {
    label?: string;
    address?: string;
    network?: string | number;
    key?: string;
  };
  /** The value the app showed, such as "4.2%", with what it measures. */
  shown?: {
    value: string;
    metric?: { key?: string; label?: string };
    /** The time the value covers, such as "7 days". */
    period?: string;
    /** When the app showed it, ISO 8601. */
    asOf?: string;
  };
  error?: { code?: string; message?: string };
  /** The wallet app, such as "MetaMask". */
  connector?: string;
  appVersion?: string;
  /** Such as "Chrome 129 on macOS". */
  device?: string;
  failure?: SupportFailureInput;
};
/** The checked form the thread stores and the member and team read. */
export type SupportAppContext = SupportDiagnostics & {
  page?: string;
  action?: SupportAppAction;
  product?: {
    /** `<network>/<address>` (EVM lowercased) or the label's key. */
    key: string;
    label?: string;
    address?: string;
    network?: SupportNetwork;
  };
  shown?: {
    value: string;
    metric?: { key: string; label?: string };
    /** The time the value covers, such as "7 days". */
    period?: string;
    asOf?: string;
  };
  error?: { code?: string; message?: string };
  connector?: string;
  appVersion?: string;
  device?: string;
  failure?: SupportFailure;
  sdk?: SupportSdk;
};
/** One message per field, so the host knows what to fix. */
const APP_MESSAGES: Readonly<Record<SupportAppField, string>> = {
  page: "Share a page path that starts with / and has no ? or #.",
  action:
    "Choose deposit, withdraw, claim, migrate, swap, stake, unstake, approve, bridge or other.",
  product:
    "Share a product with a label of up to 80 bytes, or an address and its network.",
  shown:
    "Share the value shown in 40 characters or fewer, with an optional metric, period and time.",
  error:
    "Share an error code of up to 64 characters and a message of up to 300 bytes.",
  connector: "Keep wallet app, app version and device to 60 bytes each.",
  appVersion: "Keep wallet app, app version and device to 60 bytes each.",
  device: "Keep wallet app, app version and device to 60 bytes each.",
  browser: "Keep the browser and version to 60 bytes.",
  operatingSystem: "Keep the operating system and version to 60 bytes.",
  viewport: "Share a viewport width and height between 1 and 32,768 pixels.",
  screen: "Share a screen width and height between 1 and 32,768 pixels.",
  language: "Share a language tag such as en-US.",
  timeZone: "Share an IANA time zone such as Asia/Kolkata or UTC.",
  connection:
    "Share online status and optional connection type and data-saving preference.",
  failure:
    "Share the failure kind, time and the amount shown as a decimal string.",
  sdk: "Share the widget build and API version.",
};
/** A refused typed detail, with the message for the failing field. */
export class AppContextError extends Error {
  constructor(readonly field: SupportAppField | null) {
    super(
      field
        ? APP_MESSAGES[field]
        : "Share details from the app in the documented shape.",
    );
  }
}
const appError = (field: SupportAppField) => new AppContextError(field);
/** The network rules typed details use: "eip155:<n>", "solana" or a known
 * name, and a Solana account address. */
export type AppContextRules = {
  parseSupportNetwork(value: unknown): SupportNetwork | null;
  isSolanaAddress(value: unknown): boolean;
};
const SOLANA: SupportNetwork = "solana";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
/** Empty strings and null are "not provided". */
const provided = (value: unknown) =>
  value !== undefined && value !== null && value !== "";
// eslint-disable-next-line no-control-regex
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The case frame's tag rule, so a product or metric key matches it. */
const APP_TAG = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;
const ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const utf8 = (value: string) => new TextEncoder().encode(value).length;
/** One line of plain text within `max` UTF-8 bytes (or characters with
 * `chars`), trimmed; null when invalid or blank. */
function line(value: unknown, max: number, chars = false): string | null {
  if (typeof value !== "string" || LINE_CONTROL.test(value)) return null;
  const text = value.trim();
  if (!text || (chars ? text.length : utf8(text)) > max) return null;
  return text;
}
/** A tag key from a label, the rule the case frame uses: lowercase, spaces
 * to dashes, other characters dropped. */
function appTag(label: string): string | null {
  const key = label
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._:/-]/g, "")
    .replace(/^[._:/-]+/, "")
    .slice(0, 80);
  return APP_TAG.test(key) ? key : null;
}
function appRecord(value: unknown, field: SupportAppField) {
  if (!isRecord(value)) throw appError(field);
  return value;
}
function appKey(
  input: Record<string, unknown>,
  label: string | undefined,
  field: SupportAppField,
): string {
  if (provided(input.key)) {
    if (typeof input.key !== "string" || !APP_TAG.test(input.key))
      throw appError(field);
    return input.key;
  }
  const key = label ? appTag(label) : null;
  if (!key) throw appError(field);
  return key;
}
function appProduct(
  value: unknown,
  { parseSupportNetwork, isSolanaAddress }: AppContextRules,
): SupportAppContext["product"] {
  const input = appRecord(value, "product");
  let label: string | undefined;
  if (provided(input.label)) {
    label = line(input.label, SUPPORT_APP_LIMITS.labelBytes) ?? undefined;
    if (!label) throw appError("product");
  }
  let network: SupportNetwork | undefined;
  if (provided(input.network)) {
    // A chain id reads as "eip155:<id>", so the same rule checks it.
    network =
      parseSupportNetwork(
        typeof input.network === "number"
          ? `eip155:${input.network}`
          : input.network,
      ) ?? undefined;
    if (!network) throw appError("product");
  }
  let address: string | undefined;
  if (provided(input.address)) {
    if (typeof input.address !== "string" || !network)
      throw appError("product");
    address = input.address.trim();
    if (
      network === SOLANA
        ? !isSolanaAddress(address)
        : !EVM_ADDRESS.test(address)
    )
      throw appError("product");
  }
  // The key rule of the case frame's `productKey`: an address and its
  // network name the contract, EVM lowercased and Solana as sent.
  const key =
    address && network
      ? `${network}/${network === SOLANA ? address : address.toLowerCase()}`
      : appKey(input, label, "product");
  return {
    key,
    ...(label ? { label } : {}),
    ...(address ? { address } : {}),
    ...(network ? { network } : {}),
  };
}
function appShown(value: unknown): SupportAppContext["shown"] {
  const input = appRecord(value, "shown");
  const shown = line(input.value, SUPPORT_APP_LIMITS.shownChars, true);
  if (!shown) throw appError("shown");
  const out: NonNullable<SupportAppContext["shown"]> = { value: shown };
  if (provided(input.metric)) {
    const metric = appRecord(input.metric, "shown");
    let label: string | undefined;
    if (provided(metric.label)) {
      label = line(metric.label, SUPPORT_APP_LIMITS.labelBytes) ?? undefined;
      if (!label) throw appError("shown");
    }
    out.metric = {
      key: appKey(metric, label, "shown"),
      ...(label ? { label } : {}),
    };
  }
  if (provided(input.period)) {
    const period = line(input.period, SUPPORT_APP_LIMITS.periodChars, true);
    if (!period) throw appError("shown");
    out.period = period;
  }
  if (provided(input.asOf)) {
    const time = line(input.asOf, SUPPORT_APP_LIMITS.timeChars, true);
    const at =
      time && /^\d{4}-\d{2}-\d{2}T/.test(time) ? Date.parse(time) : NaN;
    if (!Number.isFinite(at)) throw appError("shown");
    out.asOf = new Date(at).toISOString();
  }
  return out;
}
function appErrorField(value: unknown): SupportAppContext["error"] {
  const input = appRecord(value, "error");
  const out: NonNullable<SupportAppContext["error"]> = {};
  if (provided(input.code)) {
    if (typeof input.code !== "string" || !ERROR_CODE.test(input.code))
      throw appError("error");
    out.code = input.code;
  }
  if (provided(input.message)) {
    // A message may span lines; other control characters are refused.
    const message =
      typeof input.message === "string" && !CONTROL.test(input.message)
        ? input.message.trim()
        : "";
    if (!message || utf8(message) > SUPPORT_APP_LIMITS.messageBytes)
      throw appError("error");
    out.message = message;
  }
  if (!out.code && !out.message) throw appError("error");
  return out;
}

const exactKeys = (input: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(input).every((key) => keys.includes(key));
function dimensions(value: unknown, field: "viewport" | "screen") {
  const input = appRecord(value, field);
  if (
    !exactKeys(input, ["width", "height"]) ||
    ![input.width, input.height].every(
      (n) =>
        typeof n === "number" && Number.isInteger(n) && n > 0 && n <= 32768,
    )
  )
    throw appError(field);
  return { width: input.width as number, height: input.height as number };
}
function connection(
  value: unknown,
): NonNullable<SupportDiagnostics["connection"]> {
  const input = appRecord(value, "connection");
  if (
    !exactKeys(input, ["online", "effectiveType", "saveData"]) ||
    typeof input.online !== "boolean" ||
    (input.effectiveType !== undefined &&
      (typeof input.effectiveType !== "string" ||
        !["slow-2g", "2g", "3g", "4g"].includes(input.effectiveType))) ||
    (input.saveData !== undefined && typeof input.saveData !== "boolean")
  )
    throw appError("connection");
  return {
    online: input.online,
    ...(input.effectiveType !== undefined
      ? { effectiveType: input.effectiveType as "slow-2g" | "2g" | "3g" | "4g" }
      : {}),
    ...(input.saveData !== undefined
      ? { saveData: input.saveData as boolean }
      : {}),
  };
}
function appFailure(value: unknown, rules: AppContextRules): SupportFailure {
  const input = appRecord(value, "failure");
  if (
    !exactKeys(input, ["kind", "at", "asset", "amount"]) ||
    !SUPPORT_FAILURE_KINDS.includes(input.kind as SupportFailureKind)
  )
    throw appError("failure");
  const out: SupportFailure = { kind: input.kind as SupportFailureKind };
  if (input.at !== undefined) {
    const time = line(input.at, SUPPORT_APP_LIMITS.timeChars, true);
    if (
      !time ||
      !/^\d{4}-\d{2}-\d{2}T/.test(time) ||
      !Number.isFinite(Date.parse(time))
    )
      throw appError("failure");
    out.at = new Date(time).toISOString();
  }
  if (input.amount !== undefined) {
    if (
      typeof input.amount !== "string" ||
      input.amount.length > SUPPORT_APP_LIMITS.amountChars ||
      !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(input.amount)
    )
      throw appError("failure");
    out.amount = input.amount;
  }
  if (input.asset !== undefined) {
    const asset = appRecord(input.asset, "failure");
    if (!exactKeys(asset, ["symbol", "address", "network"]))
      throw appError("failure");
    const symbol =
      asset.symbol === undefined
        ? undefined
        : line(asset.symbol, SUPPORT_APP_LIMITS.shortBytes);
    if (asset.symbol !== undefined && !symbol) throw appError("failure");
    const product = appProduct(
      {
        label: symbol ?? "Asset",
        address: asset.address,
        network: asset.network,
      },
      rules,
    )!;
    if (!symbol && !product.address) throw appError("failure");
    out.asset = {
      ...(symbol ? { symbol } : {}),
      ...(product.address ? { address: product.address } : {}),
      ...(product.network ? { network: product.network } : {}),
    };
  }
  return out;
}
function appSdk(value: unknown): SupportSdk {
  const input = appRecord(value, "sdk");
  const widget = line(input.widget, SUPPORT_APP_LIMITS.shortBytes);
  const api = line(input.api, SUPPORT_APP_LIMITS.shortBytes);
  if (
    !exactKeys(input, ["widget", "api"]) ||
    !widget ||
    !api ||
    !/^[a-zA-Z0-9._-]+$/.test(widget) ||
    !/^[a-zA-Z0-9._-]+$/.test(api)
  )
    throw appError("sdk");
  return { widget, api };
}

/** Checks `context.app`: each field on its own rule, unknown fields
 * ignored. An empty result is undefined. Throws AppContextError with the
 * failing field's message. */
export function parseAppContext(
  value: unknown,
  rules: AppContextRules,
): SupportAppContext | undefined {
  if (!isRecord(value)) throw new AppContextError(null);
  const out: SupportAppContext = {};
  if (provided(value.page)) {
    const page = line(value.page, SUPPORT_APP_LIMITS.pageChars, true);
    if (!page || page[0] !== "/" || /[?#\s]/.test(page)) throw appError("page");
    out.page = page;
  }
  if (provided(value.action)) {
    if (!SUPPORT_APP_ACTIONS.includes(value.action as SupportAppAction))
      throw appError("action");
    out.action = value.action as SupportAppAction;
  }
  if (provided(value.product)) out.product = appProduct(value.product, rules);
  if (provided(value.shown)) out.shown = appShown(value.shown);
  if (provided(value.error)) out.error = appErrorField(value.error);
  for (const field of [
    "connector",
    "appVersion",
    "device",
    "browser",
    "operatingSystem",
  ] as const)
    if (provided(value[field])) {
      const text = line(value[field], SUPPORT_APP_LIMITS.shortBytes);
      if (!text) throw appError(field);
      out[field] = text;
    }
  for (const field of ["viewport", "screen"] as const)
    if (provided(value[field])) out[field] = dimensions(value[field], field);
  if (provided(value.language)) {
    if (
      typeof value.language !== "string" ||
      value.language.length > 60 ||
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value.language)
    )
      throw appError("language");
    out.language = value.language;
  }
  if (provided(value.timeZone)) {
    if (
      typeof value.timeZone !== "string" ||
      value.timeZone.length > 80 ||
      !/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(value.timeZone)
    )
      throw appError("timeZone");
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      throw appError("timeZone");
    }
    out.timeZone = value.timeZone;
  }
  if (provided(value.connection)) out.connection = connection(value.connection);
  if (provided(value.failure)) out.failure = appFailure(value.failure, rules);
  if (provided(value.sdk)) out.sdk = appSdk(value.sdk);
  return Object.keys(out).length ? out : undefined;
}
/** Every string a member shares in `app`, for the recovery-phrase screen. */
export function appContextTexts(app: SupportAppContext | undefined): string[] {
  if (!app) return [];
  return [
    app.page,
    app.product?.label,
    app.shown?.value,
    app.shown?.metric?.label,
    app.shown?.period,
    app.error?.message,
    app.connector,
    app.appVersion,
    app.device,
    app.browser,
    app.operatingSystem,
    app.language,
    app.timeZone,
    app.failure?.asset?.symbol,
    app.sdk?.widget,
    app.sdk?.api,
  ].filter((text): text is string => typeof text === "string");
}
