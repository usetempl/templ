/** Case frames and evidence rows: team-only facts a person or a registered AI agent records on a case.
 *
 * A case frame names what one member request is about: the product, the
 * network, the metric, the time window, the value the member reported and
 * the question the team must settle. Evidence rows are the facts the team or
 * its AI agent looked up, each with its source and the block or time it
 * belongs to. Both are keyed by the case (`<thread>:<seq>`), never shown to
 * the member, never counted and never sent anywhere.
 *
 * Pure functions with no I/O, so the worker, the inbox and the agent client
 * apply the same rules. Nothing here grants access, reads a chain or signs. */
import { isSolanaAddress } from "./solana";
import { parseSupportNetwork } from "./support-context";
import type { ChatPrincipalId } from "./principal";
import type { SupportNetwork } from "./support";

export const SUPPORT_EVIDENCE_LIMITS = {
  rowsPerCase: 50,
  rowsPerWrite: 10,
  keyChars: 80,
  labelBytes: 80,
  valueBytes: 64,
  numberChars: 40,
  unitBytes: 16,
  noteBytes: 280,
  linkChars: 300,
  sourceLabelBytes: 80,
  frameValueBytes: 40,
  placeBytes: 120,
  questionBytes: 280,
  /** A stored frame, serialized. */
  frameBytes: 4096,
} as const;
/** Tag keys: lowercase, digits and . _ : / -. Comparisons use exact equality. */
export const TAG_KEY = /^[a-z0-9][a-z0-9._:/-]{0,79}$/;
/** Where an evidence row's fact came from. */
export const SUPPORT_EVIDENCE_SOURCES = [
  "chain",
  "indexer",
  "frontend",
  "api",
  "docs",
  "screenshot",
  "member",
  "other",
] as const;
export type SupportEvidenceSource = (typeof SUPPORT_EVIDENCE_SOURCES)[number];
/** Where the member saw the value they reported. */
export const SUPPORT_SEEN_WHERE = [
  "screenshot",
  "frontend",
  "indexer",
  "chain",
  "message",
  "other",
] as const;
export type SupportSeenWhere = (typeof SUPPORT_SEEN_WHERE)[number];
export const SUPPORT_FRAME_FIELDS = [
  "product",
  "network",
  "metric",
  "window",
  "reported",
  "question",
] as const;
export type SupportFrameField = (typeof SUPPORT_FRAME_FIELDS)[number];

/** A block, a time, or both. A block is a positive safe integer; a time is
 * ISO UTC ending in Z. */
export type SupportPoint = { block?: number; time?: string };
export type SupportTag = { key: string; label?: string };
export type SupportProduct = SupportTag & {
  address?: string;
  network?: SupportNetwork;
};
export type SupportWindow = SupportTag & {
  from?: SupportPoint;
  to?: SupportPoint;
};
/** Who set a frame field: the member's app, a person on the team or the
 * registered AI agent. */
export type SupportFieldSource = {
  by: "member" | "person" | "agent";
  at: string;
  author?: ChatPrincipalId;
};
export type SupportReported = {
  value: string;
  unit?: string;
  where: SupportSeenWhere;
  place?: string;
  seenAt?: string;
};
export type SupportCaseFrame = {
  case: number;
  revision: number;
  product?: SupportProduct & SupportFieldSource;
  network?: { value: SupportNetwork } & SupportFieldSource;
  metric?: SupportTag & SupportFieldSource;
  window?: SupportWindow & SupportFieldSource;
  reported?: SupportReported & SupportFieldSource;
  /** Staff only: what the team must settle. */
  question?: { text: string } & SupportFieldSource;
  updatedAt: string;
};
export type SupportEvidence = {
  /** "E" + n, the display id. */
  id: string;
  /** 1..50 within the case. */
  n: number;
  case: number;
  at: string;
  by: "agent" | "person";
  author: ChatPrincipalId;
  source: SupportEvidenceSource;
  /** A short name for the source, such as "vault index" or "Base RPC". */
  sourceLabel?: string;
  product: SupportProduct;
  metric: SupportTag;
  window: SupportWindow;
  /** The block or time the value belongs to. */
  observed: SupportPoint;
  value: { text: string; number?: string; unit?: string };
  /** https only. */
  link?: string;
  /** A screenshot id in this thread. */
  attachment?: string;
  note?: string;
  /** n of an earlier row in this case that this row replaces. */
  supersedes?: number;
  /** Worked out on read from the row that replaced this one. */
  supersededBy?: number;
  withdrawn?: { at: string; by: ChatPrincipalId };
};
export type SupportEvidenceInput = Omit<
  SupportEvidence,
  "id" | "n" | "case" | "at" | "by" | "author" | "supersededBy" | "withdrawn"
>;
/** A frame field's value before who and when are added. */
export type SupportFrameValues = {
  product: SupportProduct;
  network: { value: SupportNetwork };
  metric: SupportTag;
  window: SupportWindow;
  reported: SupportReported;
  question: { text: string };
};
export type SupportFrameChange = {
  set: Partial<SupportFrameValues>;
  clear: SupportFrameField[];
};

export type SupportEvidenceReason =
  | "invalid-frame"
  | "invalid-evidence"
  | "invalid-app-context";
export class SupportEvidenceError extends Error {
  readonly reason: SupportEvidenceReason;
  constructor(reason: SupportEvidenceReason, message: string) {
    super(message);
    this.name = "SupportEvidenceError";
    this.reason = reason;
  }
}
export const INVALID_FRAME_MESSAGE =
  "Check the request details. Keys use lowercase letters, digits and . _ : / - and stay within 80 characters.";
export const INVALID_EVIDENCE_MESSAGE =
  "Each evidence row needs a source, product, metric, window, a block or time, and a value.";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const NUMBER = /^-?\d{1,30}(\.\d{1,30})?$/;
/** The first block of the first chain Templ reads: nothing is older. */
const EARLIEST = Date.parse("2009-01-03T00:00:00Z");
const HOUR = 3_600_000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).length;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T>(list: readonly T[], value: unknown): value is T =>
  (list as readonly unknown[]).includes(value);

type Fail = (message?: string) => never;
const failWith =
  (reason: SupportEvidenceReason, fallback: string): Fail =>
  (message = fallback) => {
    throw new SupportEvidenceError(reason, message);
  };
const frameFail = failWith("invalid-frame", INVALID_FRAME_MESSAGE);
const evidenceFail = failWith("invalid-evidence", INVALID_EVIDENCE_MESSAGE);

/** Plain text within a byte limit: trimmed, not empty, no control
 * characters. `lines` allows newline and tab. */
function plain(
  value: unknown,
  limit: number,
  fail: Fail,
  lines = false,
): string {
  if (typeof value !== "string") fail();
  const text = (value as string).trim();
  if (
    !text ||
    bytes(text) > limit ||
    (lines ? CONTROL : LINE_CONTROL).test(text)
  )
    fail();
  return text;
}
function optionalPlain(
  value: unknown,
  limit: number,
  fail: Fail,
  lines = false,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return plain(value, limit, fail, lines);
}

/** A tag key from a label: lowercase, spaces to "-", characters outside the
 * key alphabet dropped, at most 80 characters. An empty result throws. */
export function tagKey(label: string): string {
  const key = label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._:/-]/g, "")
    .replace(/^[._:/-]+/, "")
    .slice(0, SUPPORT_EVIDENCE_LIMITS.keyChars);
  if (!TAG_KEY.test(key))
    throw new SupportEvidenceError(
      "invalid-frame",
      "Use a label with at least one letter or digit.",
    );
  return key;
}

/** The address's family matches the network's: an EVM address on an
 * eip155 network, a Solana address on Solana. */
function addressFits(address: string, network: SupportNetwork): boolean {
  return network === "solana"
    ? isSolanaAddress(address)
    : EVM_ADDRESS.test(address);
}
/** The product key: `<network>/<address>` (EVM lowercased, Solana as sent)
 * when both are known, so every writer lands on the same key for the same
 * contract. Otherwise the given key. */
export function productKey(product: {
  key?: string;
  address?: string;
  network?: SupportNetwork;
}): string {
  if (product.address && product.network)
    return `${product.network}/${
      product.network === "solana"
        ? product.address
        : product.address.toLowerCase()
    }`;
  if (product.key && TAG_KEY.test(product.key)) return product.key;
  throw new SupportEvidenceError("invalid-frame", INVALID_FRAME_MESSAGE);
}

function network(value: unknown, fail: Fail): SupportNetwork {
  const parsed =
    typeof value === "number"
      ? parseSupportNetwork(`eip155:${value}`)
      : parseSupportNetwork(value);
  if (!parsed) fail();
  return parsed as SupportNetwork;
}
function tag(value: unknown, fail: Fail): SupportTag {
  if (!isPlain(value)) fail();
  const input = value as Record<string, unknown>;
  const label = optionalPlain(
    input.label,
    SUPPORT_EVIDENCE_LIMITS.labelBytes,
    fail,
  );
  let key: string | undefined;
  if (input.key !== undefined) {
    if (typeof input.key !== "string" || !TAG_KEY.test(input.key)) fail();
    key = input.key as string;
  } else if (label) {
    try {
      key = tagKey(label);
    } catch {
      fail();
    }
  }
  if (!key) fail();
  return { key: key!, ...(label ? { label } : {}) };
}
function point(value: unknown, fail: Fail, now: number): SupportPoint {
  if (!isPlain(value)) fail();
  const input = value as Record<string, unknown>;
  const out: SupportPoint = {};
  if (input.block !== undefined) {
    if (!Number.isSafeInteger(input.block) || (input.block as number) < 1)
      fail();
    out.block = input.block as number;
  }
  if (input.time !== undefined) {
    const time = input.time;
    const at =
      typeof time === "string" && TIME.test(time) ? Date.parse(time) : NaN;
    if (!Number.isFinite(at) || at < EARLIEST || at > now + HOUR) fail();
    out.time = time as string;
  }
  if (out.block === undefined && out.time === undefined) fail();
  return out;
}
function product(value: unknown, fail: Fail): SupportProduct {
  if (!isPlain(value)) fail();
  const input = value as Record<string, unknown>;
  const label = optionalPlain(
    input.label,
    SUPPORT_EVIDENCE_LIMITS.labelBytes,
    fail,
  );
  const chain =
    input.network === undefined || input.network === null
      ? undefined
      : network(input.network, fail);
  let address: string | undefined;
  if (input.address !== undefined && input.address !== null) {
    if (typeof input.address !== "string" || !chain) fail();
    if (!addressFits(input.address as string, chain!)) fail();
    address =
      chain === "solana"
        ? (input.address as string)
        : (input.address as string).toLowerCase();
  }
  let key: string;
  if (address) key = productKey({ address, network: chain });
  else key = tag({ key: input.key, label }, fail).key;
  return {
    key,
    ...(label ? { label } : {}),
    ...(address ? { address } : {}),
    ...(chain ? { network: chain } : {}),
  };
}
function windowOf(value: unknown, fail: Fail, now: number): SupportWindow {
  const base = tag(value, fail);
  const input = value as Record<string, unknown>;
  return {
    ...base,
    ...(input.from !== undefined ? { from: point(input.from, fail, now) } : {}),
    ...(input.to !== undefined ? { to: point(input.to, fail, now) } : {}),
  };
}
function reported(value: unknown, fail: Fail, now: number): SupportReported {
  if (!isPlain(value)) fail();
  const input = value as Record<string, unknown>;
  if (!oneOf(SUPPORT_SEEN_WHERE, input.where)) fail();
  const unit = optionalPlain(
    input.unit,
    SUPPORT_EVIDENCE_LIMITS.unitBytes,
    fail,
  );
  const place = optionalPlain(
    input.place,
    SUPPORT_EVIDENCE_LIMITS.placeBytes,
    fail,
  );
  let seenAt: string | undefined;
  if (input.seenAt !== undefined && input.seenAt !== null) {
    const at =
      typeof input.seenAt === "string" && TIME.test(input.seenAt)
        ? Date.parse(input.seenAt)
        : NaN;
    if (!Number.isFinite(at) || at < EARLIEST || at > now + HOUR) fail();
    seenAt = input.seenAt as string;
  }
  return {
    value: plain(input.value, SUPPORT_EVIDENCE_LIMITS.frameValueBytes, fail),
    ...(unit ? { unit } : {}),
    where: input.where as SupportSeenWhere,
    ...(place ? { place } : {}),
    ...(seenAt ? { seenAt } : {}),
  };
}

/** `{ set?, clear? }` of a frame write. A field set to null is cleared;
 * clearing and setting one field at once is refused. */
export function parseFrameInput(
  value: unknown,
  now = Date.now(),
): SupportFrameChange {
  if (!isPlain(value)) frameFail();
  const input = value as Record<string, unknown>;
  const set: Partial<SupportFrameValues> = {};
  const clear = new Set<SupportFrameField>();
  if (input.clear !== undefined) {
    if (
      !Array.isArray(input.clear) ||
      input.clear.some((field) => !oneOf(SUPPORT_FRAME_FIELDS, field))
    )
      frameFail();
    for (const field of input.clear as SupportFrameField[]) clear.add(field);
  }
  if (input.set !== undefined) {
    if (!isPlain(input.set)) frameFail();
    const fields = input.set as Record<string, unknown>;
    for (const [field, raw] of Object.entries(fields)) {
      if (!oneOf(SUPPORT_FRAME_FIELDS, field)) frameFail();
      if (raw === null) {
        clear.add(field as SupportFrameField);
        continue;
      }
      if (clear.has(field as SupportFrameField)) frameFail();
      switch (field as SupportFrameField) {
        case "product":
          set.product = product(raw, frameFail);
          break;
        case "network":
          set.network = { value: network(raw, frameFail) };
          break;
        case "metric":
          set.metric = tag(raw, frameFail);
          break;
        case "window":
          set.window = windowOf(raw, frameFail, now);
          break;
        case "reported":
          set.reported = reported(raw, frameFail, now);
          break;
        case "question":
          set.question = {
            text: plain(
              raw,
              SUPPORT_EVIDENCE_LIMITS.questionBytes,
              frameFail,
              true,
            ),
          };
          break;
      }
    }
  }
  for (const field of clear) if (field in set) frameFail();
  if (!Object.keys(set).length && !clear.size) frameFail();
  return { set, clear: [...clear] };
}

/** An https link with a DNS host: no user info, no IP literal, at most 300
 * characters. */
export function checkedLink(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length > SUPPORT_EVIDENCE_LIMITS.linkChars ||
    LINE_CONTROL.test(value)
  )
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !host.includes(".") ||
    host.startsWith("[") ||
    /^[0-9.]+$/.test(host) ||
    !/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(host)
  )
    return null;
  return url.toString();
}
const ATTACHMENT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One evidence row as a writer sends it. The store adds the id, the case,
 * the author and the time, and checks `supersedes` and `attachment` against
 * the case. */
export function parseEvidenceInput(
  value: unknown,
  now = Date.now(),
): SupportEvidenceInput {
  if (!isPlain(value)) evidenceFail();
  const input = value as Record<string, unknown>;
  if (!oneOf(SUPPORT_EVIDENCE_SOURCES, input.source)) evidenceFail();
  const sourceLabel = optionalPlain(
    input.sourceLabel,
    SUPPORT_EVIDENCE_LIMITS.sourceLabelBytes,
    evidenceFail,
  );
  if (!isPlain(input.value)) evidenceFail();
  const raw = input.value as Record<string, unknown>;
  const text = plain(
    raw.text,
    SUPPORT_EVIDENCE_LIMITS.valueBytes,
    evidenceFail,
  );
  let number: string | undefined;
  if (raw.number !== undefined && raw.number !== null) {
    if (
      typeof raw.number !== "string" ||
      raw.number.length > SUPPORT_EVIDENCE_LIMITS.numberChars ||
      !NUMBER.test(raw.number)
    )
      evidenceFail();
    number = raw.number as string;
  }
  const unit = optionalPlain(
    raw.unit,
    SUPPORT_EVIDENCE_LIMITS.unitBytes,
    evidenceFail,
  );
  let link: string | undefined;
  if (input.link !== undefined && input.link !== null) {
    const checked = checkedLink(input.link);
    if (!checked)
      evidenceFail("Links must be https addresses with a site name.");
    link = checked!;
  }
  let attachment: string | undefined;
  if (input.attachment !== undefined && input.attachment !== null) {
    if (
      typeof input.attachment !== "string" ||
      !ATTACHMENT.test(input.attachment)
    )
      evidenceFail();
    attachment = input.attachment as string;
  }
  const note = optionalPlain(
    input.note,
    SUPPORT_EVIDENCE_LIMITS.noteBytes,
    evidenceFail,
    true,
  );
  let supersedes: number | undefined;
  if (input.supersedes !== undefined && input.supersedes !== null) {
    if (
      !Number.isSafeInteger(input.supersedes) ||
      (input.supersedes as number) < 1 ||
      (input.supersedes as number) > SUPPORT_EVIDENCE_LIMITS.rowsPerCase
    )
      evidenceFail();
    supersedes = input.supersedes as number;
  }
  return {
    source: input.source as SupportEvidenceSource,
    ...(sourceLabel ? { sourceLabel } : {}),
    product: product(input.product, evidenceFail),
    metric: tag(input.metric, evidenceFail),
    window: windowOf(input.window, evidenceFail, now),
    observed: point(input.observed, evidenceFail, now),
    value: {
      text,
      ...(number !== undefined ? { number } : {}),
      ...(unit ? { unit } : {}),
    },
    ...(link ? { link } : {}),
    ...(attachment ? { attachment } : {}),
    ...(note ? { note } : {}),
    ...(supersedes !== undefined ? { supersedes } : {}),
  };
}

/* ---------------------------------------------------------------------- */
/* Stored values (read-time checks; fail closed)                           */
/* ---------------------------------------------------------------------- */

const ISO = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const principal = (value: unknown): value is ChatPrincipalId =>
  typeof value === "string" && value.length > 0 && value.length <= 200;
/** Re-parses a stored tag, product, window or point with the input rules,
 * so a stored value that no longer passes is unreadable. */
function reparse<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
const FAR_FUTURE = Number.MAX_SAFE_INTEGER / 2;
function checkedSource(value: Record<string, unknown>): boolean {
  return (
    (value.by === "member" || value.by === "person" || value.by === "agent") &&
    ISO(value.at) &&
    (value.author === undefined || principal(value.author))
  );
}
const withoutSource = (value: Record<string, unknown>) => {
  const { by: _by, at: _at, author: _author, ...rest } = value;
  return rest;
};

/** A stored frame for case `seq`, or null when any field fails its check. */
export function checkedFrame(
  raw: unknown,
  seq: number,
): SupportCaseFrame | null {
  if (!isPlain(raw)) return null;
  if (
    raw.case !== seq ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 1 ||
    !ISO(raw.updatedAt)
  )
    return null;
  for (const key of Object.keys(raw))
    if (
      !["case", "revision", "updatedAt", ...SUPPORT_FRAME_FIELDS].includes(key)
    )
      return null;
  for (const field of SUPPORT_FRAME_FIELDS) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!isPlain(value) || !checkedSource(value)) return null;
    const body = withoutSource(value);
    const ok = reparse(() =>
      parseFrameInput(
        {
          set: {
            [field]:
              field === "network"
                ? body.value
                : field === "question"
                  ? body.text
                  : body,
          },
        },
        FAR_FUTURE,
      ),
    );
    if (!ok) return null;
  }
  return raw as unknown as SupportCaseFrame;
}

/** A stored evidence row `n` of case `seq`, or null when any field fails
 * its check. `supersededBy` is never stored. */
export function checkedEvidence(
  raw: unknown,
  seq: number,
  n: number,
): SupportEvidence | null {
  if (!isPlain(raw)) return null;
  if (
    raw.n !== n ||
    raw.id !== `E${n}` ||
    raw.case !== seq ||
    !ISO(raw.at) ||
    (raw.by !== "agent" && raw.by !== "person") ||
    !principal(raw.author) ||
    raw.supersededBy !== undefined ||
    (raw.withdrawn !== undefined &&
      (!isPlain(raw.withdrawn) ||
        !ISO(raw.withdrawn.at) ||
        !principal(raw.withdrawn.by))) ||
    (raw.supersedes !== undefined &&
      (!Number.isSafeInteger(raw.supersedes) ||
        (raw.supersedes as number) >= n))
  )
    return null;
  const {
    id: _id,
    n: _n,
    case: _case,
    at: _at,
    by: _by,
    author: _author,
    withdrawn: _withdrawn,
    ...input
  } = raw;
  const parsed = reparse(() => parseEvidenceInput(input, FAR_FUTURE));
  if (!parsed) return null;
  if (JSON.stringify(sortKeys(parsed)) !== JSON.stringify(sortKeys(input)))
    return null;
  return raw as unknown as SupportEvidence;
}
/** Key order does not matter for a stored row's equality with its parse. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlain(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key])]),
  );
}

/** Rows as a reader sees them: `supersededBy` filled from the rows that
 * replaced them, oldest first. */
export function withSupersededBy(rows: SupportEvidence[]): SupportEvidence[] {
  const by = new Map<number, number>();
  for (const row of rows)
    if (row.supersedes !== undefined && !row.withdrawn)
      by.set(row.supersedes, row.n);
  return rows
    .map((row) =>
      by.has(row.n) ? { ...row, supersededBy: by.get(row.n)! } : row,
    )
    .sort((a, b) => a.n - b.n);
}
