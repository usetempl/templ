/** De-identified eval copies of answered requests (`templ-eval/1`): the
 * de-identification rules, the eval case and run shapes and their checks.
 *
 * Browser-safe: no SDK, storage, RPC or signing, and no word list (recovery
 * phrases are refused by the worker before this step). A copy is
 * de-identified, not anonymous: on-chain data can sometimes point back to a
 * wallet, so a person on the team checks every copy before it is saved, and
 * the server refuses a copy that still holds an identifier it can detect.
 *
 * What the rules replace, in order:
 * - explorer links become `<TX_n>`; other links lose their query and
 *   fragment, and become `<URL_n>` unless their host is on the keep list;
 * - emails `<EMAIL_n>`, ENS and SNS names `<ENS_n>`;
 * - 32-byte hex values (with or without 0x) and longer hex runs, and base58
 *   runs that decode to 64 bytes (Solana signatures), become `<TX_n>`;
 * - EVM addresses and base58 runs that decode to 32 bytes (Solana
 *   accounts) become `<ADDR_n>` unless kept (profile entries the reviewer
 *   keeps);
 * - handles, including "my discord is name", become `<HANDLE_n>`; phone
 *   numbers `<PHONE>`, IP addresses `<IP>`;
 * - dates become day offsets from the day the request opened (`D+n`),
 *   times of day `<TIME>`, block numbers `<BLOCK_n>`;
 * - display names of the member and the team become `<MEMBER>` and `<TEAM>`;
 * - amounts with a unit are rounded to two significant digits.
 * The same value maps to the same placeholder everywhere in one case. */
import { base58Decode } from "./solana";
import type { SupportHandoffReason, SupportNetwork } from "./support";
import type {
  SupportCaseFrame,
  SupportEvidence,
  SupportPoint,
} from "./support-evidence";
import {
  REPLY_LABELS,
  RUBRIC_ITEMS,
  RUBRIC_SCORES,
  RUBRIC_TEXT,
  checkedReplyLabels,
  type ReplyLabel,
  type RubricItem,
  type RubricScore,
} from "./support-quality";

export const EVAL_SCHEMA = "templ-eval/1";
export const EVAL_PLACEHOLDER = {
  address: "ADDR",
  transaction: "TX",
  email: "EMAIL",
  ens: "ENS",
  handle: "HANDLE",
  url: "URL",
  phone: "PHONE",
  ip: "IP",
  member: "MEMBER",
  team: "TEAM",
  time: "TIME",
  date: "DATE",
  block: "BLOCK",
} as const;
export type PlaceholderKind = keyof typeof EVAL_PLACEHOLDER;
/** Kinds numbered per value (`<ADDR_1>`); the others are one token. */
const NUMBERED: ReadonlySet<PlaceholderKind> = new Set([
  "address",
  "transaction",
  "email",
  "ens",
  "handle",
  "url",
  "block",
]);

export const EVAL_LIMITS = {
  casesFunded: 1_000,
  casesFree: 50,
  golden: 500,
  turns: 12,
  turnChars: 2_000,
  answerChars: 4_000,
  phrases: 8,
  phraseChars: 80,
  noteChars: 280,
  evidence: 16,
  profileRefs: 16,
  tags: 10,
  caseBytes: 32_768,
  importLines: 500,
  importBytes: 2_097_152,
  /** Lines per import call: an import body stays under the room's 24 KB
   * request cap, so the app sends a file in parts. */
  importLinesPerCall: 40,
  exportPage: 100,
  retentionDays: 730,
  runsKept: 100,
  runRetentionDays: 180,
  runResults: 1_000,
  runBytes: 1_048_576,
  /** Results per run call, for the same request cap. */
  runResultsPerCall: 40,
  outputChars: 4_000,
  runsPerHour: 10,
  perPersonPerHour: 30,
} as const;

export type DeidOptions = {
  /** Lowercase EVM addresses and exact Solana ids that stay. */
  keepAddresses: ReadonlySet<string>;
  /** Hosts whose links keep their path. Queries and fragments always go. */
  keepHosts: ReadonlySet<string>;
  /** Token symbols whose amounts are rounded (profile symbols plus
   * `EVAL_AMOUNT_UNITS`). */
  amountUnits: ReadonlySet<string>;
  /** Display names to remove; entries under 3 characters are ignored. */
  names: { member: string[]; team: string[] };
  /** The day the request opened (YYYY-MM-DD): dates become offsets from it.
   * Without it a date becomes `<DATE>`. */
  baseDate?: string | null;
};
export const EVAL_AMOUNT_UNITS = [
  "USDC",
  "USDT",
  "DAI",
  "ETH",
  "WETH",
  "WBTC",
  "BTC",
  "SOL",
  "USDS",
  "FRAX",
  "crvUSD",
  "GHO",
  "LUSD",
  "BOLD",
] as const;

export type PlaceholderMap = {
  readonly counts: Map<PlaceholderKind, number>;
  readonly values: Map<string, string>;
};
export function createPlaceholderMap(): PlaceholderMap {
  return { counts: new Map(), values: new Map() };
}
function placeholder(
  map: PlaceholderMap,
  kind: PlaceholderKind,
  key: string,
  replaced: Partial<Record<PlaceholderKind, number>>,
): string {
  replaced[kind] = (replaced[kind] ?? 0) + 1;
  if (!NUMBERED.has(kind)) return `<${EVAL_PLACEHOLDER[kind]}>`;
  const id = `${kind}:${key}`;
  const known = map.values.get(id);
  if (known) return known;
  const n = (map.counts.get(kind) ?? 0) + 1;
  map.counts.set(kind, n);
  const token = `<${EVAL_PLACEHOLDER[kind]}_${n}>`;
  map.values.set(id, token);
  return token;
}

export type DeidCheck = {
  kind: "number" | "block" | "date" | "url" | "base58";
  /** Already de-identified, at most 60 characters. */
  excerpt: string;
};
export type DeidResult = {
  text: string;
  replaced: Partial<Record<PlaceholderKind, number>>;
  checks: DeidCheck[];
};

const B58 = "1-9A-HJ-NP-Za-km-z";
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const EMAIL_RE = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[A-Za-z]{2,}/g;
const ENS_RE = /\b[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.(?:eth|sol)\b/gi;
const HEX_LONG_RE = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{64,}(?![0-9A-Za-z])/g;
const EVM_RE = /(?<![0-9A-Za-z])0x[0-9a-fA-F]{40}(?![0-9A-Za-z])/g;
const BASE58_RE = new RegExp(`(?<![${B58}])[${B58}]{32,88}(?![${B58}])`, "g");
const HANDLE_RE = /(?<![\w.@])@[A-Za-z0-9_][A-Za-z0-9_.]{1,31}/g;
const TAG_RE = /\b[A-Za-z0-9_.]{2,32}#\d{4}\b/g;
const NAMED_HANDLE_RE =
  /\b(discord|telegram|twitter|tg|x|github|reddit)((?:\s+(?:handle|username|user|name|id|account))?\s*(?:is|:|=|-)\s*)@?([A-Za-z0-9_][A-Za-z0-9_.]{1,31})\b/gi;
const PHONE_RE = /(?:\+\d[\d\s().-]{7,18}\d|\(\d{3}\)\s?\d{3}[-.\s]?\d{4})/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
const IPV6_RE = /\[[0-9a-fA-F:]{2,39}\]/g;
const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const ISO_DATE_RE =
  /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}|\s?UTC)?)?\b/g;
const MONTH_DAY_RE = new RegExp(
  `\\b(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "gi",
);
const DAY_MONTH_RE = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})(?:,?\\s+(\\d{4}))?\\b`,
  "gi",
);
const SLASH_DATE_RE = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g;
const TIME_RE = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?(?:UTC|am|pm))?\b/gi;
const BLOCK_RE =
  /\b(block|blk)((?:\s+(?:number|no\.?|height))?\s*#?\s*)(\d{3,})\b/gi;
const LONG_NUMBER_RE = /(?<![\w<_.,])\d{5,}(?![\w>])/g;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function decodes(value: string): number {
  try {
    return base58Decode(value).length;
  } catch {
    return 0;
  }
}
const DAY = 86_400_000;
function dayNumber(year: number, month: number, day: number): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const at = Date.UTC(year, month - 1, day);
  const check = new Date(at);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
    return null;
  return at / DAY;
}
function baseDay(options: DeidOptions): { day: number; year: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(options.baseDate ?? "");
  if (!match) return null;
  const day = dayNumber(Number(match[1]), Number(match[2]), Number(match[3]));
  return day === null ? null : { day, year: Number(match[1]) };
}
function offset(base: { day: number } | null, day: number | null): string {
  if (!base || day === null) return `<${EVAL_PLACEHOLDER.date}>`;
  const diff = day - base.day;
  return `D${diff < 0 ? "-" : "+"}${Math.abs(diff)}`;
}

/** Two significant digits with a `~` prefix: "1234.5678" → "~1,200",
 * "0.03791" → "~0.038", "12,345" → "~12,000". */
export function roundAmount(value: string): string {
  const number = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(number)) return value;
  if (number === 0) return "~0";
  const rounded = Number(number.toPrecision(2));
  if (Math.abs(rounded) >= 1)
    return `~${Math.round(rounded).toLocaleString("en-US")}`;
  return `~${String(rounded)}`;
}

const AMOUNT = "(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)";
function amountPatterns(units: ReadonlySet<string>): RegExp[] {
  const list = [...units]
    .filter((unit) => /^[A-Za-z0-9.+-]{1,12}$/.test(unit))
    .map(escapeRegex);
  const words = "shares|tokens|USD|dollars";
  return [
    new RegExp(`(?<![~\\w<.])\\$\\s?${AMOUNT}(?![\\w>])`, "g"),
    new RegExp(
      `(?<![~\\w<.,])${AMOUNT}(\\s?)(${[...list, words].join("|")})\\b`,
      "gi",
    ),
  ];
}

/** De-identifies one text with a case-wide placeholder map. Idempotent:
 * running it on its own output changes nothing. */
export function deidentifyText(
  input: string,
  map: PlaceholderMap,
  options: DeidOptions,
): DeidResult {
  const replaced: Partial<Record<PlaceholderKind, number>> = {};
  const checks: DeidCheck[] = [];
  const keepHosts = new Set([...options.keepHosts].map((h) => h.toLowerCase()));
  let text = input;
  // 1-2. Links.
  text = text.replace(URL_RE, (raw) => {
    const trimmed = raw.replace(/[.,;:!?]+$/, "");
    const tail = raw.slice(trimmed.length);
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return placeholder(map, "url", trimmed.toLowerCase(), replaced) + tail;
    }
    const path = url.pathname;
    const tx = /\/(?:tx|transaction|txs)\/([^/?#]+)/i.exec(path);
    if (tx)
      return (
        placeholder(map, "transaction", tx[1].toLowerCase(), replaced) + tail
      );
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (keepHosts.has(host) && url.protocol === "https:") {
      if (url.search || url.hash)
        checks.push({ kind: "url", excerpt: `https://${host}${path}`.slice(0, 60) });
      return `https://${host}${path === "/" ? "" : path}${tail}`;
    }
    return (
      placeholder(map, "url", `${host}${path}`.toLowerCase(), replaced) + tail
    );
  });
  // 3. Emails, 4. ENS and SNS names.
  text = text.replace(EMAIL_RE, (raw) =>
    placeholder(map, "email", raw.toLowerCase(), replaced),
  );
  text = text.replace(ENS_RE, (raw) =>
    placeholder(map, "ens", raw.toLowerCase(), replaced),
  );
  // 5-6. Hashes and signatures before addresses: a 32-byte hash is never
  // cut into an address.
  text = text.replace(HEX_LONG_RE, (raw) =>
    placeholder(
      map,
      "transaction",
      raw.toLowerCase().replace(/^0x/, ""),
      replaced,
    ),
  );
  text = text.replace(EVM_RE, (raw) =>
    options.keepAddresses.has(raw.toLowerCase())
      ? raw.toLowerCase()
      : placeholder(map, "address", raw.toLowerCase(), replaced),
  );
  // 7. Base58: Solana signatures and accounts.
  text = text.replace(BASE58_RE, (raw) => {
    const bytes = decodes(raw);
    if (bytes === 64) return placeholder(map, "transaction", raw, replaced);
    if (bytes === 32)
      return options.keepAddresses.has(raw)
        ? raw
        : placeholder(map, "address", raw, replaced);
    checks.push({ kind: "base58", excerpt: `${raw.slice(0, 8)}…` });
    return raw;
  });
  // 8. Handles.
  text = text.replace(
    NAMED_HANDLE_RE,
    (_raw, service: string, joint: string, name: string) =>
      /^<[A-Z]+(?:_\d+)?>$/.test(name)
        ? _raw
        : `${service}${joint}${placeholder(map, "handle", name.toLowerCase(), replaced)}`,
  );
  text = text.replace(HANDLE_RE, (raw) =>
    placeholder(map, "handle", raw.toLowerCase(), replaced),
  );
  text = text.replace(TAG_RE, (raw) =>
    placeholder(map, "handle", raw.toLowerCase(), replaced),
  );
  // 9. Phones and IP addresses. Dates and block numbers are handled below,
  // so a phone needs a "+" or a parenthesized area code.
  text = text.replace(PHONE_RE, () => placeholder(map, "phone", "", replaced));
  text = text.replace(IPV4_RE, () => placeholder(map, "ip", "", replaced));
  text = text.replace(IPV6_RE, () => placeholder(map, "ip", "", replaced));
  // 10. Dates as day offsets, then times of day.
  const base = baseDay(options);
  const date = (year: number, month: number, day: number) => {
    replaced.date = (replaced.date ?? 0) + 1;
    return offset(base, dayNumber(year, month, day));
  };
  text = text.replace(ISO_DATE_RE, (_raw, y: string, m: string, d: string) =>
    date(Number(y), Number(m), Number(d)),
  );
  const monthIndex = (name: string) =>
    MONTHS.indexOf(name.toLowerCase().slice(0, 3)) + 1;
  text = text.replace(
    MONTH_DAY_RE,
    (_raw, name: string, d: string, y: string | undefined) =>
      date(y ? Number(y) : (base?.year ?? 2000), monthIndex(name), Number(d)),
  );
  text = text.replace(
    DAY_MONTH_RE,
    (_raw, d: string, name: string, y: string | undefined) =>
      date(y ? Number(y) : (base?.year ?? 2000), monthIndex(name), Number(d)),
  );
  text = text.replace(SLASH_DATE_RE, () => {
    replaced.date = (replaced.date ?? 0) + 1;
    return `<${EVAL_PLACEHOLDER.date}>`;
  });
  text = text.replace(TIME_RE, () => placeholder(map, "time", "", replaced));
  // Block numbers.
  text = text.replace(
    BLOCK_RE,
    (_raw, word: string, joint: string, number: string) =>
      `${word}${joint}${placeholder(map, "block", number, replaced)}`,
  );
  // 11. Display names.
  const names = (list: string[], kind: "member" | "team") => {
    for (const name of [...new Set(list.map((n) => n.trim()))]
      .filter((n) => n.length >= 3)
      .sort((a, b) => b.length - a.length)) {
      const pattern = new RegExp(
        `(?<![\\p{L}\\p{N}_<])${escapeRegex(name)}(?![\\p{L}\\p{N}_>])`,
        "giu",
      );
      text = text.replace(pattern, () => placeholder(map, kind, "", replaced));
    }
  };
  names(options.names.member, "member");
  names(options.names.team, "team");
  // 12. Amounts.
  const units = new Set([...EVAL_AMOUNT_UNITS, ...options.amountUnits]);
  const [dollars, withUnit] = amountPatterns(units);
  text = text.replace(dollars, (_raw, n: string) => `~$${roundAmount(n).slice(1)}`);
  text = text.replace(
    withUnit,
    (_raw, n: string, space: string, unit: string) =>
      `${roundAmount(n)}${space}${unit}`,
  );
  for (const match of text.matchAll(LONG_NUMBER_RE))
    checks.push({
      kind: "number",
      excerpt: text
        .slice(Math.max(0, match.index - 20), match.index + 30)
        .slice(0, 60),
    });
  return { text, replaced, checks: checks.slice(0, 20) };
}

export const RESIDUAL_KINDS = [
  "address",
  "transaction",
  "email",
  "ens",
  "handle",
  "phone",
  "ip",
  "url-query",
  "date",
  "block",
] as const;
export type ResidualKind = (typeof RESIDUAL_KINDS)[number];
export const RESIDUAL_TEXT: Record<ResidualKind, string> = {
  address: "a wallet address",
  transaction: "a transaction hash",
  email: "an email address",
  ens: "an ENS name",
  handle: "a handle",
  phone: "a phone number",
  ip: "an IP address",
  "url-query": "a link with tracking details",
  date: "a date",
  block: "a block number",
};

/** Identifiers the rules would still replace, plus links that keep a query
 * or fragment. Empty for a fully de-identified text. */
export function residualIdentifiers(
  text: string,
  options: Pick<DeidOptions, "keepAddresses" | "keepHosts">,
): ResidualKind[] {
  const found = new Set<ResidualKind>();
  for (const match of text.match(URL_RE) ?? []) {
    try {
      const url = new URL(match.replace(/[.,;:!?]+$/, ""));
      if (url.search || url.hash) found.add("url-query");
      if (/\/(?:tx|transaction|txs)\//i.test(url.pathname))
        found.add("transaction");
    } catch {
      /* not a link */
    }
  }
  if (EMAIL_RE.test(text)) found.add("email");
  EMAIL_RE.lastIndex = 0;
  const withoutEmails = text.replace(EMAIL_RE, " ");
  if ((withoutEmails.match(ENS_RE) ?? []).length) found.add("ens");
  ENS_RE.lastIndex = 0;
  if ((text.match(HEX_LONG_RE) ?? []).length) found.add("transaction");
  for (const address of text.match(EVM_RE) ?? [])
    if (!options.keepAddresses.has(address.toLowerCase())) found.add("address");
  for (const run of text.match(BASE58_RE) ?? []) {
    const bytes = decodes(run);
    if (bytes === 64) found.add("transaction");
    if (bytes === 32 && !options.keepAddresses.has(run)) found.add("address");
  }
  const noLinks = withoutEmails.replace(URL_RE, " ");
  if (
    (noLinks.match(HANDLE_RE) ?? []).length ||
    (noLinks.match(TAG_RE) ?? []).length ||
    [...noLinks.matchAll(NAMED_HANDLE_RE)].some(
      (match) => !/^<[A-Z]+(?:_\d+)?>$/.test(match[3]),
    )
  )
    found.add("handle");
  if ((noLinks.match(PHONE_RE) ?? []).length) found.add("phone");
  if (
    (noLinks.match(IPV4_RE) ?? []).length ||
    (noLinks.match(IPV6_RE) ?? []).length
  )
    found.add("ip");
  if (
    (noLinks.match(ISO_DATE_RE) ?? []).length ||
    (noLinks.match(MONTH_DAY_RE) ?? []).length ||
    (noLinks.match(DAY_MONTH_RE) ?? []).length ||
    (noLinks.match(SLASH_DATE_RE) ?? []).length
  )
    found.add("date");
  if (
    [...noLinks.matchAll(BLOCK_RE)].some((match) => /^\d+$/.test(match[3]))
  )
    found.add("block");
  for (const pattern of [
    URL_RE,
    EMAIL_RE,
    ENS_RE,
    HEX_LONG_RE,
    EVM_RE,
    BASE58_RE,
    HANDLE_RE,
    TAG_RE,
    NAMED_HANDLE_RE,
    PHONE_RE,
    IPV4_RE,
    IPV6_RE,
    ISO_DATE_RE,
    MONTH_DAY_RE,
    DAY_MONTH_RE,
    SLASH_DATE_RE,
    BLOCK_RE,
  ])
    pattern.lastIndex = 0;
  return RESIDUAL_KINDS.filter((kind) => found.has(kind));
}

/** One case's de-identification pass: a shared placeholder map, the running
 * counts of what was replaced and what a person should check, and `clean`
 * for each text (cut to `EVAL_LIMITS.turnChars`). The eval draft and the
 * improvement copy (support-corpus-build.ts) both use it. */
export type CaseCleaner = {
  map: PlaceholderMap;
  replaced: Partial<Record<PlaceholderKind, number>>;
  checks: DeidCheck[];
  clean(text: string): string;
  /** A block becomes `<BLOCK_n>`, a time its day offset. */
  point(value: SupportPoint | undefined): string | null;
};
export function caseCleaner(options: DeidOptions): CaseCleaner {
  const map = createPlaceholderMap();
  const replaced: Partial<Record<PlaceholderKind, number>> = {};
  const checks: DeidCheck[] = [];
  const clean = (text: string) => {
    const result = deidentifyText(text, map, options);
    for (const [kind, n] of Object.entries(result.replaced))
      replaced[kind as PlaceholderKind] =
        (replaced[kind as PlaceholderKind] ?? 0) + (n ?? 0);
    checks.push(...result.checks);
    return result.text.slice(0, EVAL_LIMITS.turnChars);
  };
  const point = (value: SupportPoint | undefined): string | null => {
    if (!value) return null;
    if (value.block !== undefined)
      return clean(`block ${value.block}`).replace(/^block /, "");
    if (value.time) return clean(value.time.slice(0, 10));
    return null;
  };
  return { map, replaced, checks, clean, point };
}

/** De-identifies text in the case frame and evidence rows with one cleaner.
 * Evidence omits its link, author and exact block and time.
 * The caller leaves out withdrawn and replaced evidence rows. */
export function deidentifyCaseParts(
  parts: { frame: SupportCaseFrame | null; evidence: readonly SupportEvidence[] },
  cleaner: CaseCleaner,
): { frame: EvalFrame | null; evidence: EvalEvidence[] } {
  const { clean, point } = cleaner;
  const frame = parts.frame;
  const evalFrame: EvalFrame | null = frame
    ? {
        product: frame.product
          ? {
              key: clean(frame.product.key),
              label: frame.product.label ? clean(frame.product.label) : null,
              network: frame.product.network ?? frame.network?.value ?? null,
              address: frame.product.address
                ? clean(frame.product.address)
                : null,
            }
          : null,
        metric: frame.metric
          ? {
              key: clean(frame.metric.key),
              label: frame.metric.label ? clean(frame.metric.label) : null,
            }
          : null,
        window: frame.window
          ? {
              key: clean(frame.window.key),
              label: frame.window.label ? clean(frame.window.label) : null,
              from: point(frame.window.from),
              to: point(frame.window.to),
            }
          : null,
        reported: frame.reported
          ? { value: clean(frame.reported.value), where: clean(frame.reported.where) }
          : null,
      }
    : null;
  const evidence: EvalEvidence[] = parts.evidence
    .slice(0, EVAL_LIMITS.evidence)
    .map((row, index) => ({
      id: `e${index + 1}`,
      source: clean(row.source),
      label: clean(row.sourceLabel ?? row.metric.label ?? row.metric.key).slice(0, 80),
      value: clean(`${row.value.text}${row.value.unit ? ` ${row.value.unit}` : ""}`).slice(0, 200),
      product: clean(row.product.key),
      metric: clean(row.metric.key),
      window: clean(row.window.key),
      ...(row.observed.block !== undefined
        ? { block: point({ block: row.observed.block })! }
        : {}),
      ...(row.observed.time ? { at: point({ time: row.observed.time })! } : {}),
    }));
  return { frame: evalFrame, evidence };
}

/* ---------------------------------------------------------------------- */
/* Eval case (templ-eval/1)                                                */
/* ---------------------------------------------------------------------- */

export const EVAL_ACTIONS = ["answer", "clarify", "handoff"] as const;
export type EvalAction = (typeof EVAL_ACTIONS)[number];
export const EVAL_STATES = ["candidate", "golden", "retired"] as const;
export type EvalState = (typeof EVAL_STATES)[number];
export const EVAL_ORIGINS = ["reply-label", "review", "import", "manual"] as const;
export type EvalOrigin = (typeof EVAL_ORIGINS)[number];

export type EvalTurn = { role: "member" | "agent" | "person"; text: string };
export type EvalContext = {
  network: SupportNetwork | null;
  action: string | null;
  page: string | null;
};
export type EvalTag = { key: string; label: string | null };
export type EvalFrame = {
  product: (EvalTag & { network: SupportNetwork | null; address: string | null }) | null;
  metric: EvalTag | null;
  window: (EvalTag & { from: string | null; to: string | null }) | null;
  reported: { value: string; where: string } | null;
};
/** An evidence row without its link, author or exact block and time. */
export type EvalEvidence = {
  /** "e1", "e2"... within the case. */
  id: string;
  source: string;
  label: string;
  value: string;
  product?: string;
  metric?: string;
  window?: string;
  /** A `<BLOCK_n>` placeholder. */
  block?: string;
  /** A day offset (`D+n`). */
  at?: string;
};
export type EvalProfileRef = {
  network: SupportNetwork;
  address: string;
  label: string;
  kind: string;
  status: string;
  generation: string | null;
  visibility: "member-safe" | "staff-only";
};
export type EvalExpected = {
  action: EvalAction;
  answer: string | null;
  handoffReason: SupportHandoffReason | null;
  mustMention: string[];
  mustNotMention: string[];
};
export type EvalCase = {
  schema: typeof EVAL_SCHEMA;
  id: `ev-${string}`;
  version: number;
  state: EvalState;
  origin: EvalOrigin;
  savedOn: string;
  updatedOn: string;
  category: string | null;
  tags: string[];
  handoffReason: SupportHandoffReason | null;
  diagnosisRules: string[];
  labels: ReplyLabel[];
  input: {
    turns: EvalTurn[];
    context: EvalContext;
    frame: EvalFrame | null;
    evidence: EvalEvidence[];
    profile: EvalProfileRef[];
  };
  evaluated: { role: "agent" | "person"; text: string } | null;
  expected: EvalExpected;
  notes: Partial<Record<RubricItem, string>>;
};
/** What a person saves from the dialog: the case body without id, state,
 * version or dates. */
export type EvalCaseBody = Omit<
  EvalCase,
  "schema" | "id" | "version" | "state" | "origin" | "savedOn" | "updatedOn"
>;
export type EvalCaseSummary = {
  id: `ev-${string}`;
  version: number;
  state: EvalState;
  origin: EvalOrigin;
  savedOn: string;
  category: string | null;
  labels: ReplyLabel[];
  /** The first member turn, at most 80 characters. */
  firstTurn: string;
  /** The newest result, if any run scored it. */
  lastResult: { runId: string; pass: boolean; at: string } | null;
  /** Set when a later keep-list change makes the export withhold it. */
  withheld?: true;
};
/** The server's draft for "Save as eval case". */
export type EvalDraft = EvalCaseBody & {
  thread: string;
  seq: number;
  message: number;
  candidateAnswer: string | null;
  replaced: Partial<Record<PlaceholderKind, number>>;
  checks: DeidCheck[];
};

const EVAL_ID = /^ev-[0-9a-f]{16}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[A-Za-z0-9 .:/_+~<>#&()-]{1,120}$/;
const HANDOFF = /^[a-z][a-z-]{1,30}$/;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const textOk = (value: unknown, max: number, min = 1): value is string =>
  typeof value === "string" &&
  value.length >= min &&
  value.length <= max &&
  !CONTROL.test(value);
const nullable = <T>(value: unknown, check: (v: unknown) => v is T) =>
  value === null || check(value);
const token = (value: unknown): value is string =>
  typeof value === "string" && TOKEN.test(value);
const network = (value: unknown): value is SupportNetwork =>
  typeof value === "string" &&
  (value === "solana" || /^eip155:[1-9][0-9]{0,15}$/.test(value));
const exactKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

function checkedTag(value: unknown): EvalTag | null | undefined {
  if (value === null) return null;
  if (!isPlain(value) || !exactKeys(value, ["key", "label"])) return undefined;
  if (!token(value.key) || !nullable(value.label, token)) return undefined;
  return { key: value.key, label: (value.label as string | null) ?? null };
}
function checkedFrame(value: unknown): EvalFrame | null | undefined {
  if (value === null) return null;
  if (!isPlain(value) || !exactKeys(value, ["product", "metric", "window", "reported"]))
    return undefined;
  let product: EvalFrame["product"] = null;
  if (value.product !== null && value.product !== undefined) {
    const p = value.product;
    if (!isPlain(p) || !exactKeys(p, ["key", "label", "network", "address"]))
      return undefined;
    const tag = checkedTag({ key: p.key, label: p.label ?? null });
    if (!tag || !nullable(p.network ?? null, network) || !nullable(p.address ?? null, token))
      return undefined;
    product = {
      ...tag,
      network: (p.network as SupportNetwork | null) ?? null,
      address: (p.address as string | null) ?? null,
    };
  }
  const metric = checkedTag(value.metric ?? null);
  if (metric === undefined) return undefined;
  let window: EvalFrame["window"] = null;
  if (value.window !== null && value.window !== undefined) {
    const w = value.window;
    if (!isPlain(w) || !exactKeys(w, ["key", "label", "from", "to"])) return undefined;
    const tag = checkedTag({ key: w.key, label: w.label ?? null });
    if (!tag || !nullable(w.from ?? null, token) || !nullable(w.to ?? null, token))
      return undefined;
    window = { ...tag, from: (w.from as string | null) ?? null, to: (w.to as string | null) ?? null };
  }
  let reported: EvalFrame["reported"] = null;
  if (value.reported !== null && value.reported !== undefined) {
    const r = value.reported;
    if (!isPlain(r) || !exactKeys(r, ["value", "where"])) return undefined;
    if (!textOk(r.value, 120) || !token(r.where)) return undefined;
    reported = { value: r.value, where: r.where };
  }
  return { product, metric, window, reported };
}
function checkedEvidenceRow(value: unknown): EvalEvidence | null {
  if (!isPlain(value)) return null;
  const keys = ["id", "source", "label", "value", "product", "metric", "window", "block", "at"];
  if (!exactKeys(value, keys)) return null;
  if (typeof value.id !== "string" || !/^e[1-9][0-9]?$/.test(value.id)) return null;
  if (!token(value.source) || !textOk(value.label, 80) || !textOk(value.value, 200))
    return null;
  for (const key of ["product", "metric", "window"] as const)
    if (value[key] !== undefined && !token(value[key])) return null;
  if (value.block !== undefined && !/^<BLOCK_\d{1,3}>$/.test(String(value.block)))
    return null;
  if (value.at !== undefined && !/^(?:D[+-]\d{1,5}|<DATE>)$/.test(String(value.at)))
    return null;
  return { ...(value as EvalEvidence) };
}
function checkedProfileRef(value: unknown): EvalProfileRef | null {
  if (!isPlain(value)) return null;
  if (
    !exactKeys(value, ["network", "address", "label", "kind", "status", "generation", "visibility"]) ||
    !network(value.network) ||
    !token(value.address) ||
    !textOk(value.label, 60) ||
    !token(value.kind) ||
    !token(value.status) ||
    !nullable(value.generation ?? null, token) ||
    (value.visibility !== "member-safe" && value.visibility !== "staff-only")
  )
    return null;
  return {
    network: value.network,
    address: value.address,
    label: value.label,
    kind: value.kind,
    status: value.status,
    generation: (value.generation as string | null) ?? null,
    visibility: value.visibility,
  };
}
function checkedPhrases(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > EVAL_LIMITS.phrases) return null;
  if (!value.every((item) => textOk(item, EVAL_LIMITS.phraseChars))) return null;
  return [...(value as string[])];
}

/** The body a person saves or edits, checked for shape and limits. */
export function checkedEvalBody(raw: unknown): EvalCaseBody | null {
  if (!isPlain(raw)) return null;
  const input = raw.input;
  if (!isPlain(input)) return null;
  if (!Array.isArray(input.turns) || input.turns.length < 1 || input.turns.length > EVAL_LIMITS.turns)
    return null;
  const turns: EvalTurn[] = [];
  for (const turn of input.turns) {
    if (!isPlain(turn) || !exactKeys(turn, ["role", "text"])) return null;
    if (!["member", "agent", "person"].includes(turn.role as string)) return null;
    if (!textOk(turn.text, EVAL_LIMITS.turnChars)) return null;
    turns.push({ role: turn.role as EvalTurn["role"], text: turn.text });
  }
  const context = input.context;
  if (!isPlain(context) || !exactKeys(context, ["network", "action", "page"])) return null;
  if (
    !nullable(context.network ?? null, network) ||
    !nullable(context.action ?? null, token) ||
    !nullable(context.page ?? null, token)
  )
    return null;
  const frame = checkedFrame(input.frame ?? null);
  if (frame === undefined) return null;
  if (!Array.isArray(input.evidence) || input.evidence.length > EVAL_LIMITS.evidence) return null;
  const evidence: EvalEvidence[] = [];
  for (const row of input.evidence) {
    const checked = checkedEvidenceRow(row);
    if (!checked) return null;
    evidence.push(checked);
  }
  if (!Array.isArray(input.profile) || input.profile.length > EVAL_LIMITS.profileRefs) return null;
  const profile: EvalProfileRef[] = [];
  for (const ref of input.profile) {
    const checked = checkedProfileRef(ref);
    if (!checked) return null;
    profile.push(checked);
  }
  let evaluated: EvalCase["evaluated"] = null;
  if (raw.evaluated !== null && raw.evaluated !== undefined) {
    const e = raw.evaluated;
    if (!isPlain(e) || !exactKeys(e, ["role", "text"])) return null;
    if ((e.role !== "agent" && e.role !== "person") || !textOk(e.text, EVAL_LIMITS.answerChars))
      return null;
    evaluated = { role: e.role, text: e.text };
  }
  const expected = raw.expected;
  if (!isPlain(expected)) return null;
  if (!EVAL_ACTIONS.includes(expected.action as EvalAction)) return null;
  const action = expected.action as EvalAction;
  const answer = expected.answer ?? null;
  if (!nullable(answer, (v): v is string => textOk(v, EVAL_LIMITS.answerChars))) return null;
  if (action !== "handoff" && answer === null) return null;
  const handoffReason = expected.handoffReason ?? null;
  if (!nullable(handoffReason, (v): v is string => typeof v === "string" && HANDOFF.test(v)))
    return null;
  if (action === "handoff" && handoffReason === null) return null;
  const mustMention = checkedPhrases(expected.mustMention ?? []);
  const mustNotMention = checkedPhrases(expected.mustNotMention ?? []);
  if (!mustMention || !mustNotMention) return null;
  const labels = checkedReplyLabels(raw.labels ?? []);
  if (!labels) return null;
  if (!nullable(raw.category ?? null, (v): v is string => textOk(v, 60))) return null;
  if (!Array.isArray(raw.tags ?? []) || (raw.tags as unknown[] ?? []).length > EVAL_LIMITS.tags)
    return null;
  const tags = (raw.tags ?? []) as unknown[];
  if (!tags.every((tag) => textOk(tag, 60))) return null;
  if (!nullable(raw.handoffReason ?? null, (v): v is string => typeof v === "string" && HANDOFF.test(v)))
    return null;
  const rules = (raw.diagnosisRules ?? []) as unknown[];
  if (!Array.isArray(rules) || rules.length > 16 || !rules.every((rule) => typeof rule === "string" && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(rule)))
    return null;
  const notes: Partial<Record<RubricItem, string>> = {};
  const rawNotes = raw.notes ?? {};
  if (!isPlain(rawNotes)) return null;
  for (const [item, note] of Object.entries(rawNotes)) {
    if (!RUBRIC_ITEMS.includes(item as RubricItem)) return null;
    if (!textOk(note, EVAL_LIMITS.noteChars)) return null;
    notes[item as RubricItem] = note;
  }
  const body: EvalCaseBody = {
    category: (raw.category as string | null) ?? null,
    tags: tags as string[],
    handoffReason: (raw.handoffReason as SupportHandoffReason | null) ?? null,
    diagnosisRules: rules as string[],
    labels,
    input: {
      turns,
      context: {
        network: (context.network as SupportNetwork | null) ?? null,
        action: (context.action as string | null) ?? null,
        page: (context.page as string | null) ?? null,
      },
      frame,
      evidence,
      profile,
    },
    evaluated,
    expected: {
      action,
      answer: answer as string | null,
      handoffReason: handoffReason as SupportHandoffReason | null,
      mustMention,
      mustNotMention,
    },
    notes,
  };
  if (new TextEncoder().encode(JSON.stringify(body)).length > EVAL_LIMITS.caseBytes)
    return null;
  return body;
}

/** A whole stored or imported case. */
export function checkedEvalCase(raw: unknown): EvalCase | null {
  if (!isPlain(raw)) return null;
  if (raw.schema !== EVAL_SCHEMA) return null;
  if (typeof raw.id !== "string" || !EVAL_ID.test(raw.id)) return null;
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return null;
  if (!EVAL_STATES.includes(raw.state as EvalState)) return null;
  if (!EVAL_ORIGINS.includes(raw.origin as EvalOrigin)) return null;
  if (typeof raw.savedOn !== "string" || !DATE.test(raw.savedOn)) return null;
  if (typeof raw.updatedOn !== "string" || !DATE.test(raw.updatedOn)) return null;
  const {
    schema: _schema,
    id: _id,
    version: _version,
    state: _state,
    origin: _origin,
    savedOn: _saved,
    updatedOn: _updated,
    kind: _kind,
    ...rest
  } = raw;
  const body = checkedEvalBody(rest);
  if (!body) return null;
  return {
    schema: EVAL_SCHEMA,
    id: raw.id as `ev-${string}`,
    version: raw.version as number,
    state: raw.state as EvalState,
    origin: raw.origin as EvalOrigin,
    savedOn: raw.savedOn,
    updatedOn: raw.updatedOn,
    ...body,
  };
}

/** Every text field of a case body, for the phrase and residual checks. */
export function evalTexts(body: EvalCaseBody): string[] {
  const out: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  for (const value of [
    body.category, body.tags, body.handoffReason, body.diagnosisRules, body.labels,
    body.input, body.evaluated, body.expected, body.notes,
  ]) collect(value);
  return out.filter(Boolean);
}
/** The residual kinds across a whole case body. Frame and profile
 * addresses are the kept product addresses the caller passes in. */
export function residualInBody(
  body: EvalCaseBody,
  options: Pick<DeidOptions, "keepAddresses" | "keepHosts">,
): ResidualKind[] {
  const found = new Set<ResidualKind>();
  for (const text of evalTexts(body))
    for (const kind of residualIdentifiers(text, options)) found.add(kind);
  const keep = options.keepAddresses;
  for (const ref of body.input.profile)
    if (!keep.has(ref.network === "solana" ? ref.address : ref.address.toLowerCase()))
      found.add("address");
  const product = body.input.frame?.product;
  if (product?.address && !keep.has(product.network === "solana" ? product.address : product.address.toLowerCase()) && !/^<ADDR_\d+>$/.test(product.address))
    found.add("address");
  return RESIDUAL_KINDS.filter((kind) => found.has(kind));
}

/* ---------------------------------------------------------------------- */
/* Export and runs                                                         */
/* ---------------------------------------------------------------------- */

export type EvalExportHeader = {
  kind: "templ-eval-header";
  schema: typeof EVAL_SCHEMA;
  exportedAt: string;
  set: "golden" | "all";
  count: number;
  rubric: {
    version: 1;
    items: { id: RubricItem; label: string; check: string }[];
    pass: string;
  };
  labels: ReplyLabel[];
  actions: EvalAction[];
  placeholders: string[];
  post: string;
};
export function evalExportHeader(input: {
  exportedAt: string;
  set: "golden" | "all";
  count: number;
}): EvalExportHeader {
  return {
    kind: "templ-eval-header",
    schema: EVAL_SCHEMA,
    exportedAt: input.exportedAt,
    set: input.set,
    count: input.count,
    rubric: {
      version: 1,
      items: RUBRIC_ITEMS.map((id) => ({ id, ...RUBRIC_TEXT[id] })),
      pass: "The action matches and no item fails.",
    },
    labels: [...REPLY_LABELS],
    actions: [...EVAL_ACTIONS],
    placeholders: Object.values(EVAL_PLACEHOLDER),
    post: "POST /rooms/{room}/conversations/evals/runs",
  };
}
/** One export line for a case: never a thread, principal, name or link. */
export const evalExportLine = (value: EvalCase) =>
  JSON.stringify({ kind: "templ-eval-case", ...value });

export type EvalRunResultInput = {
  id: `ev-${string}`;
  caseVersion: number;
  pass: boolean;
  items: Record<RubricItem, RubricScore>;
  action?: EvalAction;
  output?: string;
  notes?: string;
};
export type EvalRunInput = {
  clientRunId: string;
  agent: { name: string; version: string; model?: string; promptSha256?: string };
  scorer: { name: "templ-reference" | "custom"; version: string };
  set: "golden" | "all";
  exportedAt: string;
  results: EvalRunResultInput[];
};
export type EvalRunView = {
  id: `run-${string}`;
  postedAt: string;
  poster: "person" | "agent";
  agent: EvalRunInput["agent"];
  scorer: EvalRunInput["scorer"];
  set: "golden" | "all";
  total: number;
  passed: number;
  byItem: Record<RubricItem, { pass: number; fail: number; na: number }>;
  /** Passed in the previous run of the same agent name at the same case
   * version, and fail now. */
  regressions: string[];
  newPasses: string[];
  /** Ids not in the store; not counted in `total`. */
  unknownCases: number;
  /** Results still arriving in later parts of the same run. */
  open?: true;
};

const LABEL60 = /^[A-Za-z0-9 ._:/+-]{1,60}$/;
/** A run body (or one part of it) checked for shape and limits. */
export function checkedEvalRunInput(raw: unknown): EvalRunInput | null {
  if (!isPlain(raw)) return null;
  if (typeof raw.clientRunId !== "string" || !/^[A-Za-z0-9._:-]{8,80}$/.test(raw.clientRunId))
    return null;
  const agent = raw.agent;
  if (!isPlain(agent) || !exactKeys(agent, ["name", "version", "model", "promptSha256"]))
    return null;
  if (typeof agent.name !== "string" || !LABEL60.test(agent.name)) return null;
  if (typeof agent.version !== "string" || !LABEL60.test(agent.version)) return null;
  if (agent.model !== undefined && (typeof agent.model !== "string" || !/^[A-Za-z0-9 ._:/+-]{1,80}$/.test(agent.model)))
    return null;
  if (agent.promptSha256 !== undefined && (typeof agent.promptSha256 !== "string" || !/^[0-9a-f]{64}$/.test(agent.promptSha256)))
    return null;
  const scorer = raw.scorer;
  if (!isPlain(scorer) || !exactKeys(scorer, ["name", "version"])) return null;
  if (scorer.name !== "templ-reference" && scorer.name !== "custom") return null;
  if (typeof scorer.version !== "string" || !LABEL60.test(scorer.version)) return null;
  if (raw.set !== "golden" && raw.set !== "all") return null;
  if (typeof raw.exportedAt !== "string" || !Number.isFinite(Date.parse(raw.exportedAt)))
    return null;
  if (!Array.isArray(raw.results) || raw.results.length < 1 || raw.results.length > EVAL_LIMITS.runResults)
    return null;
  const results: EvalRunResultInput[] = [];
  const seen = new Set<string>();
  for (const row of raw.results) {
    if (!isPlain(row) || !exactKeys(row, ["id", "caseVersion", "pass", "items", "action", "output", "notes"]))
      return null;
    if (typeof row.id !== "string" || !EVAL_ID.test(row.id) || seen.has(row.id)) return null;
    seen.add(row.id);
    if (!Number.isSafeInteger(row.caseVersion) || (row.caseVersion as number) < 1) return null;
    if (typeof row.pass !== "boolean") return null;
    const items = row.items;
    if (!isPlain(items) || Object.keys(items).length !== RUBRIC_ITEMS.length) return null;
    for (const item of RUBRIC_ITEMS)
      if (!RUBRIC_SCORES.includes(items[item] as RubricScore)) return null;
    if (row.action !== undefined && !EVAL_ACTIONS.includes(row.action as EvalAction)) return null;
    if (row.output !== undefined && !textOk(row.output, EVAL_LIMITS.outputChars, 0)) return null;
    if (row.notes !== undefined && !textOk(row.notes, EVAL_LIMITS.noteChars, 0)) return null;
    results.push({
      id: row.id as `ev-${string}`,
      caseVersion: row.caseVersion as number,
      pass: row.pass,
      items: items as Record<RubricItem, RubricScore>,
      ...(row.action !== undefined ? { action: row.action as EvalAction } : {}),
      ...(row.output !== undefined ? { output: row.output as string } : {}),
      ...(row.notes !== undefined ? { notes: row.notes as string } : {}),
    });
  }
  return {
    clientRunId: raw.clientRunId,
    agent: {
      name: agent.name,
      version: agent.version,
      ...(agent.model !== undefined ? { model: agent.model as string } : {}),
      ...(agent.promptSha256 !== undefined ? { promptSha256: agent.promptSha256 as string } : {}),
    },
    scorer: { name: scorer.name, version: scorer.version },
    set: raw.set,
    exportedAt: raw.exportedAt,
    results,
  };
}
