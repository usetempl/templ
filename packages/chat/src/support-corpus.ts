/** Templ's de-identified improvement copy of finished requests
 * (`templ-corpus/1`): the row shape, its checker, the purposes a corpus
 * reader must name, the time buckets and the rule-based shadow label.
 *
 * Browser-safe: no storage, SDK, RPC or word list. The pipeline that turns
 * a request into a row runs only in the workspace's room object
 * (support-corpus-build.ts). A row is de-identified, not anonymous:
 * on-chain facts can sometimes point back to a wallet, so a row stays
 * personal data with its own access list, retention and deletion.
 *
 * A row never holds a thread id, message id, member or staff id, wallet,
 * website, IP data, internal note, file or file name. Its `ref` (an HMAC of
 * the case under a key only the room holds) lets the room delete it; nothing
 * outside the room can turn a ref back into a thread. */
import { CORPUS_LIMITS } from "./plans";
import type { SupportNetwork } from "./support";
import {
  EVAL_LIMITS,
  type EvalEvidence,
  type EvalFrame,
} from "./support-eval";
import { REPLY_LABELS, type ReplyLabel } from "./support-quality";

export const CORPUS_SCHEMA = "templ-corpus/1";
/** The rule set that built a row. A change to the rules bumps it. */
export const CORPUS_RULES = "corpus-rules/1";
/** The widget line that tells a member about the copy. A request is copied
 * only when its opening message was sent while this version showed. */
export const CORPUS_NOTICE_VERSION = 1;
/** Placeholders the improvement copy adds to the eval set's. */
export const CORPUS_PLACEHOLDER = {
  number: "<NUM>",
  id: "<ID>",
  name: "<NAME>",
} as const;

/** Why a corpus reader reads rows. Every read names one and is logged. */
export const CORPUS_PURPOSES = [
  "eval-build",
  "rule-calibration",
  "resolution-audit",
  "gap-analysis",
  "leak-sample",
] as const;
export type CorpusPurpose = (typeof CORPUS_PURPOSES)[number];
export const isCorpusPurpose = (value: unknown): value is CorpusPurpose =>
  typeof value === "string" &&
  (CORPUS_PURPOSES as readonly string[]).includes(value);

export const CORPUS_DURATION_BUCKETS = [
  "<5m",
  "5-30m",
  "30m-2h",
  "2-8h",
  "8-24h",
  "1-3d",
  "3-7d",
  ">7d",
] as const;
export type CorpusDuration = (typeof CORPUS_DURATION_BUCKETS)[number];
const MINUTE = 60_000;
const BUCKET_ENDS = [
  5 * MINUTE,
  30 * MINUTE,
  120 * MINUTE,
  480 * MINUTE,
  1_440 * MINUTE,
  4_320 * MINUTE,
  10_080 * MINUTE,
];
/** A duration as its bucket; null for no value or a negative one. */
export function durationBucket(ms: number | null | undefined): CorpusDuration | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0)
    return null;
  const index = BUCKET_ENDS.findIndex((end) => ms < end);
  return CORPUS_DURATION_BUCKETS[index === -1 ? BUCKET_ENDS.length : index];
}

/** The ISO week (`2026-W39`) and ISO weekday (1 = Monday) of a time, in UTC. */
export function isoWeek(at: number): { week: string; weekday: number } {
  const date = new Date(at);
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = new Date(day).getUTCDay() || 7;
  const thursday = new Date(day + (4 - weekday) * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week =
    Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return { week: `${year}-W${String(week).padStart(2, "0")}`, weekday };
}

/** A network as a CAIP-2 id. */
export const corpusNetwork = (network: SupportNetwork): string =>
  network === "solana" ? "solana:mainnet" : network;

export type CorpusTurn = {
  role: "member" | "person" | "agent";
  /** Who wrote it, as a pseudonym that stays the same for one person across
   * the workspace's rows: `member-` or `staff-` and 8 hex keyed by a secret
   * only the room holds, or `ai-agent`. Nothing in the copy maps it back. */
  speaker: string;
  /** Null when the turn was dropped: its text still held something the
   * rules detect, or the request's text was withheld. */
  text: string | null;
};
const SPEAKER = {
  member: /^member-[0-9a-f]{8}$/,
  person: /^staff-[0-9a-f]{8}$/,
  agent: /^ai-agent$/,
} as const;
/** Whether a speaker pseudonym has the form its role takes. */
export const isCorpusSpeaker = (role: CorpusTurn["role"], speaker: unknown) =>
  typeof speaker === "string" && SPEAKER[role].test(speaker);
export type CorpusAccess = "guest" | "connected" | "signed-in" | "app";
export type ShadowLabel = "resolved" | "not-resolved" | "unclear";
export type CorpusCase = {
  schema: typeof CORPUS_SCHEMA;
  rules: typeof CORPUS_RULES;
  /** `ws_` and 16 hex: the workspace, keyed by Templ. Names a business,
   * never a person. */
  workspace: string;
  opened: { week: string; weekday: number };
  durations: {
    firstReply: CorpusDuration | null;
    firstHumanReply: CorpusDuration | null;
    resolve: CorpusDuration | null;
  };
  networks: string[];
  access: { first: CorpusAccess; close: CorpusAccess };
  state: "resolved" | "open-idle";
  reopens: number;
  resolvedBy: "person" | "agent" | "member" | null;
  confirmation: "solved" | "not-solved" | null;
  handoff: { reason: string; by: "agent" | "person" | "member" | null } | null;
  aiMode: "answers" | "drafts" | "off" | null;
  category: string | null;
  tags: string[];
  labels: ReplyLabel[];
  diagnosisRules: string[];
  counts: {
    memberMessages: number;
    humanReplies: number;
    agentReplies: number;
    notes: number;
  };
  turns: CorpusTurn[];
  frame: EvalFrame | null;
  evidence: EvalEvidence[];
  shadow: { label: ShadowLabel; reason: string };
  flags: {
    /** The request held a recovery phrase or key material: no text kept. */
    secretWithheld: boolean;
    turnsDropped: number;
    droppedKinds: string[];
    /** Turns whose text was shortened to fit `CORPUS_LIMITS.rowBytes`. */
    turnsCut: number;
    /** More than the allowed turns were dropped, or the row could not fit
     * `CORPUS_LIMITS.rowBytes` with text: no text kept. */
    textWithheld: boolean;
  };
};

/** What a person on the team sees about the copy: counts only. */
export type CorpusWorkspaceView = {
  /** Rows kept for this workspace now. */
  rows: number;
  /** Templ's corpus reads of this workspace's rows in the last full UTC
   * month, by purpose. */
  reads: { month: string; rows: number; purposes: CorpusPurpose[] };
};

const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !CONTROL.test(value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000;
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);
const nullOr = <T>(value: unknown, check: (v: unknown) => v is T): value is T | null =>
  value === null || check(value);
const bucket = (value: unknown): value is CorpusDuration | null =>
  value === null || oneOf(CORPUS_DURATION_BUCKETS, value);
const ACCESS = ["guest", "connected", "signed-in", "app"] as const;
const ROLES = ["member", "person", "agent"] as const;
const KEY = /^[a-z0-9][a-z0-9.:-]{0,63}$/;
const NETWORK = /^(?:eip155:[1-9][0-9]{0,15}|solana:mainnet)$/;

/** A stored or posted row, checked for shape and size. Frame and evidence
 * keep the eval shapes; their texts are checked by the residual gate, not
 * here. */
export function checkedCorpusCase(raw: unknown): CorpusCase | null {
  if (!isPlain(raw)) return null;
  const keys = [
    "schema", "rules", "workspace", "opened", "durations", "networks", "access",
    "state", "reopens", "resolvedBy", "confirmation", "handoff", "aiMode",
    "category", "tags", "labels", "diagnosisRules", "counts", "turns", "frame",
    "evidence", "shadow", "flags",
  ];
  if (!exactKeys(raw, keys)) return null;
  if (raw.schema !== CORPUS_SCHEMA || raw.rules !== CORPUS_RULES) return null;
  if (typeof raw.workspace !== "string" || !/^ws_[0-9a-f]{16}$/.test(raw.workspace))
    return null;
  const opened = raw.opened;
  if (
    !isPlain(opened) ||
    !exactKeys(opened, ["week", "weekday"]) ||
    typeof opened.week !== "string" ||
    !/^\d{4}-W\d{2}$/.test(opened.week) ||
    !Number.isSafeInteger(opened.weekday) ||
    (opened.weekday as number) < 1 ||
    (opened.weekday as number) > 7
  )
    return null;
  const durations = raw.durations;
  if (
    !isPlain(durations) ||
    !exactKeys(durations, ["firstReply", "firstHumanReply", "resolve"]) ||
    !bucket(durations.firstReply) ||
    !bucket(durations.firstHumanReply) ||
    !bucket(durations.resolve)
  )
    return null;
  if (
    !Array.isArray(raw.networks) ||
    raw.networks.length > 8 ||
    !raw.networks.every((n) => typeof n === "string" && NETWORK.test(n))
  )
    return null;
  const access = raw.access;
  if (
    !isPlain(access) ||
    !exactKeys(access, ["first", "close"]) ||
    !oneOf(ACCESS, access.first) ||
    !oneOf(ACCESS, access.close)
  )
    return null;
  if (!oneOf(["resolved", "open-idle"] as const, raw.state)) return null;
  if (!count(raw.reopens)) return null;
  if (!nullOr(raw.resolvedBy, (v): v is string => oneOf(ROLES, v))) return null;
  if (!nullOr(raw.confirmation, (v): v is string => oneOf(["solved", "not-solved"] as const, v)))
    return null;
  const handoff = raw.handoff;
  if (
    handoff !== null &&
    (!isPlain(handoff) ||
      !exactKeys(handoff, ["reason", "by"]) ||
      typeof handoff.reason !== "string" ||
      !/^[a-z][a-z-]{1,30}$/.test(handoff.reason) ||
      !nullOr(handoff.by, (v): v is string => oneOf(["agent", "person", "member"] as const, v)))
  )
    return null;
  if (!nullOr(raw.aiMode, (v): v is string => oneOf(["answers", "drafts", "off"] as const, v)))
    return null;
  if (!nullOr(raw.category, (v): v is string => text(v, 60) && v.length > 0)) return null;
  for (const list of [raw.tags, raw.labels, raw.diagnosisRules])
    if (!Array.isArray(list) || list.length > 16) return null;
  if (!(raw.tags as unknown[]).every((tag) => text(tag, 60) && (tag as string).length > 0))
    return null;
  if (!(raw.labels as unknown[]).every((label) => oneOf(REPLY_LABELS, label))) return null;
  if (!(raw.diagnosisRules as unknown[]).every((rule) => typeof rule === "string" && KEY.test(rule)))
    return null;
  const counts = raw.counts;
  if (
    !isPlain(counts) ||
    !exactKeys(counts, ["memberMessages", "humanReplies", "agentReplies", "notes"]) ||
    !Object.values(counts).every(count)
  )
    return null;
  if (!Array.isArray(raw.turns) || raw.turns.length > CORPUS_LIMITS.turns) return null;
  for (const turn of raw.turns)
    if (
      !isPlain(turn) ||
      !exactKeys(turn, ["role", "speaker", "text"]) ||
      !oneOf(ROLES, turn.role) ||
      !isCorpusSpeaker(turn.role, turn.speaker) ||
      !nullOr(turn.text, (v): v is string => text(v, EVAL_LIMITS.turnChars))
    )
      return null;
  if (raw.frame !== null && !isPlain(raw.frame)) return null;
  if (!Array.isArray(raw.evidence) || raw.evidence.length > EVAL_LIMITS.evidence)
    return null;
  if (!raw.evidence.every(isPlain)) return null;
  const shadow = raw.shadow;
  if (
    !isPlain(shadow) ||
    !exactKeys(shadow, ["label", "reason"]) ||
    !oneOf(["resolved", "not-resolved", "unclear"] as const, shadow.label) ||
    typeof shadow.reason !== "string" ||
    !KEY.test(shadow.reason)
  )
    return null;
  const flags = raw.flags;
  if (
    !isPlain(flags) ||
    !exactKeys(flags, ["secretWithheld", "turnsDropped", "droppedKinds", "turnsCut", "textWithheld"]) ||
    typeof flags.secretWithheld !== "boolean" ||
    typeof flags.textWithheld !== "boolean" ||
    !count(flags.turnsDropped) ||
    !count(flags.turnsCut) ||
    !Array.isArray(flags.droppedKinds) ||
    flags.droppedKinds.length > 16 ||
    !flags.droppedKinds.every((kind) => typeof kind === "string" && KEY.test(kind))
  )
    return null;
  const row = raw as unknown as CorpusCase;
  if (corpusRowBytes(row) > CORPUS_LIMITS.rowBytes) return null;
  return row;
}

/** A row's size as the knowledge object stores it. */
export const corpusRowBytes = (row: CorpusCase) =>
  new TextEncoder().encode(JSON.stringify(row)).length;

/** Every text a row holds, for the residual gate. */
export function corpusTexts(row: CorpusCase): string[] {
  const out: string[] = [];
  for (const turn of row.turns) if (turn.text) out.push(turn.text);
  out.push(...row.tags);
  if (row.category) out.push(row.category);
  const frame = row.frame;
  if (frame) {
    if (frame.reported) out.push(frame.reported.value);
    for (const tag of [frame.product, frame.metric, frame.window])
      if (tag) out.push(tag.key, tag.label ?? "");
    if (frame.product?.address) out.push(frame.product.address);
    if (frame.window) out.push(frame.window.from ?? "", frame.window.to ?? "");
  }
  for (const item of row.evidence)
    out.push(item.label, item.value, item.product ?? "", item.metric ?? "", item.window ?? "");
  return out.filter(Boolean);
}

/** The metadata the shadow label reads. */
export type ShadowInput = {
  state: CorpusCase["state"];
  confirmation: CorpusCase["confirmation"];
  resolvedBy: CorpusCase["resolvedBy"];
  reopens: number;
  /** Whether the member wrote last when the request settled. */
  memberLast: boolean;
  teamReplies: number;
};
/** A rule-based guess at whether the request was resolved, from metadata
 * only. It is written beside the row for rule calibration and review; it
 * never creates, changes or removes a charge and is never shown to the
 * member. */
export function shadowLabel(input: ShadowInput): CorpusCase["shadow"] {
  if (input.confirmation === "solved")
    return { label: "resolved", reason: "member-confirmed" };
  if (input.confirmation === "not-solved")
    return { label: "not-resolved", reason: "member-not-solved" };
  if (input.teamReplies === 0)
    return { label: "not-resolved", reason: "no-team-reply" };
  if (input.state === "resolved")
    return input.memberLast
      ? { label: "unclear", reason: "resolved-after-member" }
      : { label: "resolved", reason: "team-resolved-quiet" };
  return input.memberLast
    ? { label: "not-resolved", reason: "idle-member-waiting" }
    : { label: "unclear", reason: "idle-after-reply" };
}
