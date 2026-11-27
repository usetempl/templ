/** Case-scoped follow-ups with one owner, a due date and a member line, and watches that close on chain state.
 *
 * A follow-up is team work that continues after an answer: a type, one
 * owner (a person on the team or a specialist) or a routing group, an
 * optional due date, an optional GitHub or Linear link, a state, and a line
 * the member sees with a next-update date. A follow-up records that people
 * outside Templ will do something. It grants no wallet authority and causes
 * no transaction; a watch only reads chain state.
 *
 * Pure rules, labels and shapes, with type-only imports, so the worker, the
 * inbox and the agent client apply the same checks. Nothing here reads
 * storage, reads a chain or signs. */
import type { ChatPrincipalId } from "./principal";
import type { DiagnosisReadSource } from "./diagnosis/types";
import type { SupportHandoffReason, SupportNetwork } from "./support";

export const SUPPORT_FOLLOW_UP_TYPES = [
  "strategy",
  "access",
  "recovery",
  "decision",
  "bug",
] as const;
export type SupportFollowUpType = (typeof SUPPORT_FOLLOW_UP_TYPES)[number];
export const SUPPORT_FOLLOW_UP_STATES = [
  "open",
  "blocked",
  "done",
  "cancelled",
] as const;
export type SupportFollowUpState = (typeof SUPPORT_FOLLOW_UP_STATES)[number];
/** Who added it: a person, a routing rule after a handoff, or the
 * workspace's registered AI agent. */
export type SupportFollowUpSource = "person" | "route" | "agent";

/** Staff labels for types. */
export const FOLLOW_UP_TYPE_LABELS: Record<SupportFollowUpType, string> = {
  strategy: "Strategy action",
  access: "Access change",
  recovery: "Fund recovery",
  decision: "Internal decision",
  bug: "Bug",
};
/** The member line a type uses unless a person writes another. Each passes
 * followUpLabelRisk (unit-tested). */
export const FOLLOW_UP_DEFAULT_LABELS: Record<SupportFollowUpType, string> = {
  strategy: "Strategy review",
  access: "Access change",
  recovery: "Recovery review",
  decision: "Decision",
  bug: "Bug review",
};
export const FOLLOW_UP_STATE_LABELS: Record<SupportFollowUpState, string> = {
  open: "Open",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};
/** The fixed title a routed follow-up gets: a handoff carries a code, never
 * text, so nothing a member or an AI agent wrote reaches the group queue. */
export const FOLLOW_UP_ROUTE_TITLES: Record<SupportHandoffReason, string> = {
  quote: "Quote request (handed off)",
  privacy: "Privacy request (handed off)",
  account: "Account question (handed off)",
  billing: "Billing question (handed off)",
  legal: "Legal request (handed off)",
  safety: "Security or safety (handed off)",
  transaction: "Transaction question (handed off)",
  bug: "Possible bug (handed off)",
  person: "Asked for a person (handed off)",
  unsure: "Unsure (handed off)",
  other: "Other (handed off)",
  strategy: "Strategy action (handed off)",
  access: "Access or permission change (handed off)",
  recovery: "Fund or account recovery (handed off)",
  decision: "Needs a team decision (handed off)",
  internal: "Needs internal information (handed off)",
};
export const FOLLOW_UP_LIMITS = {
  perCase: 20,
  openPerWorkspace: 2_000,
  writesPerDay: 5_000,
  titleChars: 120,
  labelChars: 48,
  linkChars: 300,
  dependsOn: 5,
  groups: 10,
  groupMembers: 25,
  groupNameChars: 40,
  nextUpdateMaxDays: 30,
  dueMaxDays: 90,
  defaultNextUpdateDays: 3,
  mentionAccessDays: 14,
  doneLineDays: 7,
  alarmBatch: 100,
  /** A watch that has not closed after this many days blocks its follow-up
   * and tells the owner. */
  watchMaxDays: 30,
  queuePage: 50,
  queuePageMax: 100,
} as const;

/** "<seq>-<n>": the request (case) and the follow-up's creation number in it. */
export const FOLLOW_UP_ID = /^([1-9][0-9]{0,7})-([1-9][0-9]?)$/;
export function followUpId(seq: number, n: number): string {
  return `${seq}-${n}`;
}
export function parseFollowUpId(
  value: unknown,
): { seq: number; n: number } | null {
  if (typeof value !== "string") return null;
  const match = FOLLOW_UP_ID.exec(value);
  if (!match) return null;
  const n = Number(match[2]);
  if (n > FOLLOW_UP_LIMITS.perCase) return null;
  return { seq: Number(match[1]), n };
}

/** The same patterns the diagnosis member-safety check refuses, copied so
 * this module stays free of runtime imports. A parity test keeps them
 * equal. */
const MEMBER_LINE_CHECKS: readonly [string, RegExp][] = [
  ["control", /[\p{Cc}\p{Cf}]/u],
  ["link", /https?:\/\/|\bwww\./i],
  [
    "domain",
    /\b[a-z0-9-]+\.(?:com|io|xyz|org|net|app|fi|finance|exchange|link|gg|co)\b/i,
  ],
  ["address", /0x[0-9a-fA-F]{40}/],
  ["hash", /0x[0-9a-fA-F]{64}/],
  ["base58", /[1-9A-HJ-NP-Za-km-z]{32,}/],
  [
    "action",
    /\b(?:sign|signing|approve|approving|revoke|send|resend|submit|retry|try again|speed up|cancel|click|tap|visit|go to|connect|import|paste|enter|share|download|install|scan|claim|refund|reimburse|compensat\w*|guarantee\w*|seed|private key|recovery phrase|mnemonic|secret|password)\b/i,
  ],
];
/** Member-visible label check. Null when safe; otherwise the first rule it
 * breaks: "type", "empty", "length", then the member-safety rules above. */
export function followUpLabelRisk(text: unknown): string | null {
  if (typeof text !== "string") return "type";
  if (!text.trim()) return "empty";
  if (text.length > FOLLOW_UP_LIMITS.labelChars) return "length";
  for (const [name, pattern] of MEMBER_LINE_CHECKS)
    if (pattern.test(text)) return name;
  return null;
}
const TITLE_CHECKS: readonly [string, RegExp][] = [
  ["control", /[\p{Cc}\p{Cf}]/u],
  ["address", /0x[0-9a-fA-F]{40}/],
  ["hash", /0x[0-9a-fA-F]{64}/],
  ["base58", /[1-9A-HJ-NP-Za-km-z]{32,}/],
];
/** Team-only title check: "type", "empty", "length", "control", "address",
 * "hash" or "base58". Wallets and hashes belong in notes, which are
 * case-scoped. */
export function followUpTitleRisk(text: unknown): string | null {
  if (typeof text !== "string") return "type";
  if (!text.trim()) return "empty";
  if (text.length > FOLLOW_UP_LIMITS.titleChars) return "length";
  for (const [name, pattern] of TITLE_CHECKS)
    if (pattern.test(text)) return name;
  return null;
}
/** https only, host exactly github.com, www.github.com or linear.app, no
 * userinfo, no port, at most linkChars. Returns the URL's href or null. */
export function followUpLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > FOLLOW_UP_LIMITS.linkChars)
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  if (!["github.com", "www.github.com", "linear.app"].includes(url.hostname))
    return null;
  return url.href.length > FOLLOW_UP_LIMITS.linkChars ? null : url.href;
}
/** A dependency list for a follow-up at `order` in its case: ids of the
 * same case, earlier in order, no duplicates, at most `dependsOn` entries,
 * no cycle. Null when valid. */
export function followUpDependencyError(
  list: readonly { id: string; order: number; dependsOn: readonly string[] }[],
  candidate: { id: string; order: number; dependsOn: readonly string[] },
): "unknown" | "later" | "duplicate" | "too-many" | "cycle" | null {
  if (candidate.dependsOn.length > FOLLOW_UP_LIMITS.dependsOn)
    return "too-many";
  if (new Set(candidate.dependsOn).size !== candidate.dependsOn.length)
    return "duplicate";
  const byId = new Map(list.map((item) => [item.id, item]));
  byId.set(candidate.id, candidate);
  for (const id of candidate.dependsOn) {
    if (id === candidate.id) return "cycle";
    const target = byId.get(id);
    if (!target) return "unknown";
    if (target.order >= candidate.order) return "later";
  }
  // Walk the graph from the candidate: any path back to it is a cycle.
  const seen = new Set<string>();
  const stack = [...candidate.dependsOn];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === candidate.id) return "cycle";
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(byId.get(id)?.dependsOn ?? []));
  }
  return null;
}
/** The step the member sees. Among member-visible follow-ups that are open
 * or blocked, the lowest `order` whose dependencies are all done or
 * cancelled; when none qualifies, the lowest `order` among them; null when
 * none is open or blocked. */
export function currentFollowUp<
  T extends {
    id: string;
    order: number;
    state: SupportFollowUpState;
    memberVisible: boolean;
    dependsOn: readonly string[];
  },
>(list: readonly T[]): T | null {
  const byId = new Map(list.map((item) => [item.id, item]));
  const active = list
    .filter(
      (item) =>
        item.memberVisible &&
        (item.state === "open" || item.state === "blocked"),
    )
    .sort((a, b) => a.order - b.order);
  if (!active.length) return null;
  const ready = active.find((item) =>
    item.dependsOn.every((id) => {
      const state = byId.get(id)?.state;
      return state === "done" || state === "cancelled" || state === undefined;
    }),
  );
  return ready ?? active[0];
}

/* Calendar days in the workspace's time zone                               */

export const FOLLOW_UP_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
function validZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return "UTC";
  }
}
function zoneParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}
/** The zone's offset from UTC at an instant, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = zoneParts(ms, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(ms / 1000) * 1000;
}
const pad2 = (value: number) => String(value).padStart(2, "0");
/** "YYYY-MM-DD" today in `timeZone` (UTC for an invalid zone). */
export function zonedToday(nowMs: number, timeZone: string): string {
  const p = zoneParts(nowMs, validZone(timeZone));
  return `${String(p.year).padStart(4, "0")}-${pad2(p.month)}-${pad2(p.day)}`;
}
/** A real calendar day in "YYYY-MM-DD" form. */
export function isFollowUpDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = FOLLOW_UP_DAY.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 2000 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
/** Local midnight of `day` in the zone, in epoch ms. The offset is taken at
 * the UTC guess and again at the corrected instant, so a DST change on that
 * day lands on the right side. */
function zonedMidnight(day: string, timeZone: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, date);
  const first = guess - zoneOffset(guess, timeZone);
  const second = guess - zoneOffset(first, timeZone);
  return second;
}
/** Start and end (exclusive) of a calendar day in a zone, in epoch ms. */
export function zonedDayBounds(
  day: string,
  timeZone: string,
): { start: number; end: number } {
  const zone = validZone(timeZone);
  return {
    start: zonedMidnight(day, zone),
    end: zonedMidnight(addDays(day, 1), zone),
  };
}
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, date) + days * DAY_MS);
  return `${String(next.getUTCFullYear()).padStart(4, "0")}-${pad2(
    next.getUTCMonth() + 1,
  )}-${pad2(next.getUTCDate())}`;
}
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const upperFirst = (text: string) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;
/** The member line, in English with a fixed month table:
 *   waiting, date ahead    "Waiting on the team: {Label}. Next update by {Mon} {D}."
 *   waiting, no/past date  "Waiting on the team: {Label}."
 *   done                   "Done: {Label}." */
export function followUpMemberText(
  line: {
    state: "waiting" | "done";
    label: string;
    nextUpdateOn: string | null;
    nextUpdateUntil: number | null;
  },
  nowMs: number,
): string {
  const label = upperFirst(line.label.trim());
  if (line.state === "done") return `Done: ${label}.`;
  if (
    line.nextUpdateOn &&
    isFollowUpDay(line.nextUpdateOn) &&
    (line.nextUpdateUntil === null || nowMs < line.nextUpdateUntil)
  ) {
    const [, month, day] = line.nextUpdateOn.split("-").map(Number);
    return `Waiting on the team: ${label}. Next update by ${MONTHS[month - 1]} ${day}.`;
  }
  return `Waiting on the team: ${label}.`;
}

/* Chain-state watches                                                      */

/** What a watch waits for under the selected transaction-check read policy.
 * EVM: a settled transaction or a block number reached. Solana: a finalized
 * signature (no block-number watch). Any network: a time reached. A reverted
 * or failed transaction blocks the follow-up; it never closes it. */
export type SupportFollowUpWatch =
  | { kind: "tx"; network: SupportNetwork; hash: string }
  | { kind: "block"; network: `eip155:${number}`; number: number }
  | { kind: "time"; at: string };
export type SupportFollowUpWatchState =
  | "watching"
  | "closed"
  | "failed"
  | "expired";
/** How the watch stands, team views only. `lastResult` is a fixed code. */
export type SupportFollowUpWatchView = SupportFollowUpWatch & {
  /** The source used for the last check. Absent on legacy paired watches. */
  readSource?: DiagnosisReadSource;
  state: SupportFollowUpWatchState;
  setAt: string;
  lastCheckedAt: string | null;
  lastResult:
    | "pending"
    | "not-mined"
    | "confirming"
    | "settled"
    | "reverted"
    | "failed"
    | "reached"
    | "unavailable"
    | "not-configured"
    | null;
};
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const SOLANA_SIGNATURE_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EIP155 = /^eip155:([1-9][0-9]{0,15})$/;
/** A watch from an API body. Shapes only: the worker also checks the
 * network is on for checks, the signature decodes to 64 bytes and the time
 * is ahead and within watchMaxDays. Null when invalid. */
export function parseFollowUpWatch(
  value: unknown,
): SupportFollowUpWatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort().join(",");
  if (input.kind === "tx") {
    if (keys !== "hash,kind,network") return null;
    if (input.network === "solana")
      return typeof input.hash === "string" &&
        SOLANA_SIGNATURE_SHAPE.test(input.hash)
        ? { kind: "tx", network: "solana", hash: input.hash }
        : null;
    if (typeof input.network !== "string" || !EIP155.test(input.network))
      return null;
    if (typeof input.hash !== "string") return null;
    const hash = input.hash.toLowerCase();
    return EVM_HASH.test(hash)
      ? {
          kind: "tx",
          network: input.network as `eip155:${number}`,
          hash,
        }
      : null;
  }
  if (input.kind === "block") {
    if (keys !== "kind,network,number") return null;
    if (typeof input.network !== "string" || !EIP155.test(input.network))
      return null;
    if (
      typeof input.number !== "number" ||
      !Number.isSafeInteger(input.number) ||
      input.number < 1
    )
      return null;
    return {
      kind: "block",
      network: input.network as `eip155:${number}`,
      number: input.number,
    };
  }
  if (input.kind === "time") {
    if (keys !== "at,kind") return null;
    if (
      typeof input.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z$/.test(
        input.at,
      )
    )
      return null;
    const at = Date.parse(input.at);
    return Number.isFinite(at)
      ? { kind: "time", at: new Date(at).toISOString() }
      : null;
  }
  return null;
}

/* Views                                                                    */

/** The member line on a conversation. Members, the team and specialists get
 * the same object. It carries no owner, title, note, link or due date. */
export type SupportFollowUpLine = {
  state: "waiting" | "done";
  label: string;
  /** YYYY-MM-DD in the workspace time zone; null once past. */
  nextUpdateOn: string | null;
  /** When this line last changed (drives unread). */
  at: string;
  /** followUpMemberText(); the widget renders only this. */
  text: string;
};
export type SupportFollowUp = {
  id: string;
  seq: number;
  order: number;
  type: SupportFollowUpType;
  title: string;
  publicLabel: string;
  memberVisible: boolean;
  owner: ChatPrincipalId | null;
  group: string | null;
  dependsOn: string[];
  state: SupportFollowUpState;
  dueAt: string | null;
  nextUpdateOn: string | null;
  link: string | null;
  overdue: boolean;
  updateMissed: boolean;
  /** The step the member sees now. */
  current: boolean;
  source: SupportFollowUpSource;
  /** The handoff reason a routed follow-up came from. */
  reason: SupportHandoffReason | null;
  watch: SupportFollowUpWatchView | null;
  createdAt: string;
  createdBy: ChatPrincipalId;
  updatedAt: string;
  revision: number;
  closedAt: string | null;
  closedBy: ChatPrincipalId | "watch" | null;
};
export type SupportFollowUpCaseView = {
  seq: number;
  openedAt: string;
  resolvedAt: string | null;
  waitingOnTeam: boolean;
};
export type SupportFollowUpList = {
  followUps: SupportFollowUp[];
  cases: SupportFollowUpCaseView[];
  line: SupportFollowUpLine | null;
  /** SUPPORT_FOLLOW_UPS_ENABLED and the workflow is writable. */
  available: boolean;
  /** Chain-state watches can be set (the checks and their networks are on). */
  watchNetworks: SupportNetwork[];
  /** Stored follow-ups that failed their check. */
  unreadable: number;
  /** Their ids, at most 20, so a person on the team can remove one. */
  unreadableIds: string[];
  /** The workspace's time zone: next-update dates are days in it. */
  timeZone: string;
};
/** What a group member sees before taking a follow-up: its type, the
 * handoff reason, its age and due date. Never the title, owner, link, member
 * line or dependencies. */
export type SupportFollowUpGroupRow = Pick<
  SupportFollowUp,
  | "id"
  | "seq"
  | "type"
  | "reason"
  | "group"
  | "state"
  | "dueAt"
  | "createdAt"
  | "revision"
  | "overdue"
>;
export type SupportFollowUpRow = {
  /** tc- id. */
  conversation: string;
  followUp: SupportFollowUp | SupportFollowUpGroupRow;
  /** False for a group row the viewer must take before reading. */
  readable: boolean;
  ageMs: number;
};
export type SupportFollowUpQueueView = "open" | "overdue" | "mine" | "group";
export type SupportFollowUpOwnerCount = {
  owner: ChatPrincipalId | null;
  group: string | null;
  open: number;
  blocked: number;
  overdue: number;
  oldestAt: string;
};
export type SupportFollowUpQueue = {
  view: SupportFollowUpQueueView;
  rows: SupportFollowUpRow[];
  owners: SupportFollowUpOwnerCount[];
  nextCursor: string | null;
  /** False when more than openPerWorkspace + 1 keys were seen. */
  complete: boolean;
};
export type SupportFollowUpGroup = {
  /** "g-" and 8 lowercase hex. */
  id: string;
  name: string;
  members: ChatPrincipalId[];
};
export type SupportFollowUpRoute = {
  reason: SupportHandoffReason;
  type: SupportFollowUpType;
  group: string;
  publicLabel: string | null;
  nextUpdateDays: number;
  dueDays: number | null;
  memberVisible: boolean;
};
export type SupportFollowUpSettings = {
  revision: number;
  groups: SupportFollowUpGroup[];
  routes: SupportFollowUpRoute[];
};
/** `GET /conversations/follow-up-settings`: the settings, who may be
 * picked, and whether the viewer may change them. */
export type SupportFollowUpSettingsView = SupportFollowUpSettings & {
  /** "unreadable" when the stored settings failed their check: routing is
   * off and a save replaces them. */
  status: "ok" | "unreadable";
  eligible: { staff: ChatPrincipalId[]; specialists: ChatPrincipalId[] };
  /** Routes: the manager or a support lead. */
  canEditRoutes: boolean;
  /** Group membership: the manager only. */
  canEditGroups: boolean;
};
/** A specialist's reason to read one request. */
export type SupportSpecialistAccess = {
  via: ("owner" | "mention")[];
  /** When a mention's access ends; null when only ownership applies. */
  until: string | null;
  /** The first message of the request they may read. */
  from: string;
};
export const GROUP_ID = /^g-[0-9a-f]{8}$/;
