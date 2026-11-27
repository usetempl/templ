import {
  countStandardTicket,
  standardCaseEvent,
} from "./product-standard-plan";
import {
  openUsageCase,
  recordUsageFeature,
  noteUsageAnswer,
  updateUsageCase,
} from "./product-usage-billing";
import type { TemplStaffEnv } from "./templ-staff";
/** Case ledger: one metadata record per member request ("case") in a
 * support thread. The awaiting index, the Needs reply view, the pulse and
 * the manager report all read it.
 *
 * A case holds times, counts and flags only. It never holds message, note or
 * tag text, a wallet address or a transaction hash. It never grants access
 * and never touches billing, usage or admission.
 *
 * Callers write inside the room transaction that changed the thread, so a
 * refused write rolls its case back with it. This module never sets the room
 * alarm itself; it only asks for an earlier wake-up through `wakeRoomAt`.
 * It imports only types from support-workflow.ts and team-conversations.ts
 * and reads their rows by key, so it adds no module cycle. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import { PRODUCT_LIMITS } from "@templ/chat/plans";
import {
  SUPPORT_AI_MODE_CAUSES,
  SUPPORT_AI_MODES,
  SUPPORT_HANDOFF_REASONS,
  SUPPORT_LIMITS,
  SUPPORT_REPORT_WINDOWS,
  SUPPORT_TIME_SPENT,
  type SupportAiMode,
  type SupportAiModeCause,
  type SupportCase,
  type SupportCaseAi,
  type SupportCaseAccess,
  type SupportCaseCloser,
  type SupportCaseContributions,
  type SupportCaseExclusion,
  type SupportCaseReopenReason,
  type SupportHandoffBy,
  type SupportHandoffReason,
  type SupportPulseV2,
  type SupportReport,
  type SupportReportWindow,
  type SupportSettings,
  type SupportState,
  type SupportTimeSpent,
} from "@templ/chat/support";
import { readStoredSupportContext } from "@templ/chat/support-context";
import { HttpError, type Env } from "./common";
import { updateAbandonDue, clearAbandonDue } from "./support-abandon";
import { wakeRoomAt } from "./room-alarm";
import type { AgentState } from "./support-agent-presence";
import { canaryPrincipal } from "./support-canary";
import {
  chargeCaseEvent,
  chargeRef,
  syncCaseContributions,
} from "./product-charges";
import { supportStorage } from "./support-storage";
import {
  readRetentionHolds,
  type RetentionHolds,
  type SafetyEnv,
} from "./safety";
import { waitingOnMember } from "./support-member-wait";
import { supportTurn, type TurnView } from "./support-turn";
import type { SupportRecord } from "./support-workflow";
import type { TeamConversationRecord } from "./team-conversations";

type Storage = DurableObjectTransaction;
type ReadStorage = Pick<Storage, "get" | "list">;

/** `support-case-v1:<tc-id>:<seq pad 8>` → `SupportCase`. */
export const CASE_PREFIX = "support-case-v1:";
/** `support-case-open-v1:<openedAt pad 16>:<tc-id>:<seq pad 8>` → `true`:
 * the date index for report windows and pruning. */
export const CASE_OPENED_PREFIX = "support-case-open-v1:";
/** `support-awaiting-v1:<since pad 16>:<tc-id>` → `{ seq, handoff?, ai? }`:
 * at most one per thread, oldest wait first. `ai` is the case's AI mode,
 * absent while the request follows the workspace default. */
export const AWAITING_PREFIX = "support-awaiting-v1:";
/** The room's migration marker. */
export const LEDGER_KEY = "support-case-ledger-v1";
/** `support-team-wait-v1:<since pad 16>:<tc-id>:<seq pad 8>` → `true`: a
 * case with an open follow-up, from the moment its first one opened. The
 * pulse and the report count threads here as waiting on the team. */
export const TEAM_WAIT_PREFIX = "support-team-wait-v1:";
/** Escalation markers the alert lanes write per case
 * (`support-escalated-v1:<tc-id>:<seq pad 8>`); removed with the thread. */
export const ESCALATED_PREFIX = "support-escalated-v1:";
/** Overdue follow-ups (`support-follow-up-overdue-v1:…`), counted by the
 * pulse. The follow-up module writes and removes them. */
export const FOLLOW_UP_OVERDUE_PREFIX = "support-follow-up-overdue-v1:";
const WORKFLOW_PREFIX = "support-workflow-v1:";
const RECORD_PREFIX = "conversation-v1:";
const SETTINGS_KEY = "support-settings-v1";
const DAY = 86_400_000;
/** Message rows a synthesized case reads to find the current wait. */
const TRAILING_ROWS = 20;
const THREAD = /^tc-[0-9a-f]{32}$/;

/** Ledger fields on the thread's support record. Absent on records written
 * before the ledger (not yet migrated). */
export type LedgerFields = {
  ledgerVersion?: 1;
  /** Latest case; 0 when the thread never had a member request. */
  caseSeq?: number;
  /** Highest retained charge sequence after recovery. */
  caseSeqFloor?: number;
  /** Mirrors the latest case; the awaiting index key uses it. */
  awaitingSince?: number | null;
  /** The current wait follows an answer the member said did not solve it. */
  notSolved?: boolean;
};
type LedgerRecord = SupportRecord & LedgerFields;
type MemberExclusion = Exclude<SupportCaseExclusion, "spam">;

/** Follow-up counts of one case: counts and times only. Absent until the
 * case's first follow-up event. The follow-up module owns the follow-ups
 * themselves and sends the counts after each change. */
export type SupportCaseFollowUps = {
  created: number;
  done: number;
  cancelled: number;
  reopened: number;
  /** Open and blocked follow-ups now. */
  open: number;
  firstCreatedAt: number | null;
  /** The last done or cancelled. */
  lastClosedAt: number | null;
  /** When open went from 0 to more; null while none is open. */
  waitingOnTeamSince: number | null;
  /** Folded when open returns to 0. */
  waitingOnTeamMs: number;
  overdue: number;
  updatesMissed: number;
};
/** A stored case as this module reads it: the shared shape plus the
 * follow-up counts. */
export type LedgerCase = SupportCase & {
  followUps?: SupportCaseFollowUps;
};
/** What one event did to the thread's cases, for the hooks that act on it
 * (alerts, escalation). Callers that don't need it ignore it. */
export type CaseTransition = {
  /** The case the event touched; null when it touched none. */
  seq: number | null;
  opened: boolean;
  reopened: boolean;
  closed: boolean;
  handoffOpened: boolean;
  awaitingBefore: number | null;
  awaitingAfter: number | null;
  excluded: SupportCaseExclusion[];
};
/** Removes one case's rows of a feature store within `budget` keys and
 * returns how many it deleted. The ledger calls each before it deletes a
 * pruned case, so no feature keeps rows for a case that is gone. */
export type CaseDataDeleter = (
  storage: Storage,
  thread: string,
  seq: number,
  budget: number,
) => Promise<number>;
/** Events aimed at one case by its number rather than the latest case. */
export type ScopedCaseEvent =
  /** A person asked the AI agent for a draft (Ask AI). */
  | { kind: "ai-draft-request"; seq: number; at: number; mode: SupportAiMode }
  /** The AI agent wrote a draft: an Ask AI answer, a suggestion or a held
   * reply. */
  | {
      kind: "ai-draft";
      seq: number;
      at: number;
      mode: SupportAiMode;
      actor?: ChatPrincipalId;
    }
  /** A person replied with a draft. */
  | {
      kind: "ai-draft-used";
      seq: number;
      at: number;
      mode: SupportAiMode;
      edited: boolean;
    }
  | {
      kind: "follow-up";
      seq: number;
      at: number;
      change: "created" | "closed" | "reopened" | "overdue" | "update-missed";
      closedAs?: "done" | "cancelled";
      /** Open and blocked follow-ups in this case after the change, counted
       * by the caller. */
      open: number;
    };

/** Everything that changes a case. Each caller passes what it already knows
 * inside its own transaction; `at` is the request time. */
export type CaseEvent =
  | {
      kind: "member-message";
      at: number;
      entry?: "hosted";
      access: SupportCaseAccess;
      /** The worker checked this member's current wallet session. */
      walletVerified?: boolean;
      exclusion: MemberExclusion | null;
      spam: boolean;
      /** The support state was "resolved" before this message. */
      wasResolved: boolean;
      stopped: boolean;
    }
  | {
      kind: "team-reply";
      at: number;
      bot: boolean;
      /** An accepted registered agent reply with answer provenance. */
      aiAnswer?: boolean;
      /** The worker proved this reply came from the workspace's managed agent. */
      managed?: boolean;
      /** The server matched a current registered bot to Templ's workspace binding. */
      templ?: boolean;
      actor?: ChatPrincipalId;
      /** Private server-captured scripted qualification. It grants no staff permission. */
      scriptedProducer?:
        | import("./standard-monthly-trial-access").StandardMonthlySyntheticProducer
        | null;
    }
  | {
      kind: "status";
      at: number;
      previous: SupportState;
      state: SupportState;
      by: SupportCaseCloser;
      stopped: boolean;
      /** Who changed it, when a person or an AI agent did: the charge
       * ledger labels Templ's managed agent "Templ AI". */
      actor?: ChatPrincipalId;
    }
  | { kind: "assign"; at: number; assigned: boolean }
  | { kind: "note"; at: number }
  | { kind: "context"; at: number; network: boolean; transaction: boolean }
  | { kind: "verification-requested"; at: number }
  | { kind: "wallet-verified"; at: number }
  | { kind: "stop"; at: number; stopped: boolean }
  | {
      kind: "handoff";
      at: number;
      reason: SupportHandoffReason;
      by: SupportHandoffBy;
    }
  | {
      kind: "handoff-cleared";
      at: number;
      /** "ai-mode": a person took over from the AI or let it answer. */
      by: "reply" | "assign" | "resolve" | "ai-mode";
    }
  | {
      kind: "confirm";
      at: number;
      answer: "solved" | "not-solved";
      reopened: boolean;
    }
  | { kind: "time-spent"; at: number; bucket: SupportTimeSpent }
  /** The request's AI mode changed. Metadata only: the enforced mode lives
   * on the conversation record, so a rebuilt case never lets a bot in. */
  | {
      kind: "ai-mode";
      at: number;
      mode: SupportAiMode;
      previous: SupportAiMode;
      by: "person" | "rule";
      cause: SupportAiModeCause;
    }
  | ScopedCaseEvent;

type AwaitingValue = {
  seq: number;
  handoff?: true;
  ai?: SupportAiMode;
  notSolved?: true;
};
type LedgerMarker = {
  schemaVersion: 1;
  state: "running" | "ready";
  /** Backfill cursor: the last `conversation-v1:` key done. */
  after?: string;
  startedAt: number;
  readyAt?: number;
  /** When the last full prune pass finished. */
  prunedAt?: number;
  /** Prune cursor inside a pass: the last `support-case-open-v1:` key read. */
  pruneAfter?: string;
};

const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const naturalOrNull = (value: unknown) => value === null || natural(value);
const oneOf = <T>(list: readonly T[], value: unknown): value is T =>
  (list as readonly unknown[]).includes(value);
const pad8 = (value: number) => String(value).padStart(8, "0");
const pad16 = (value: number) => String(value).padStart(16, "0");
const iso = (at: number) => new Date(at).toISOString();
const workflowKey = (thread: string) => `${WORKFLOW_PREFIX}${thread}`;
const caseKey = (thread: string, seq: number) =>
  `${CASE_PREFIX}${thread}:${pad8(seq)}`;
const caseOpenedKey = (openedAt: number, thread: string, seq: number) =>
  `${CASE_OPENED_PREFIX}${pad16(openedAt)}:${thread}:${pad8(seq)}`;
const awaitingKey = (since: number, thread: string) =>
  `${AWAITING_PREFIX}${pad16(since)}:${thread}`;
const teamWaitKey = (since: number, thread: string, seq: number) =>
  `${TEAM_WAIT_PREFIX}${pad16(since)}:${thread}:${pad8(seq)}`;

const ACCESS: readonly SupportCaseAccess[] = [
  "app",
  "anonymous",
  "connected",
  "signed",
];
const EXCLUSIONS: readonly SupportCaseExclusion[] = [
  "canary",
  "install-preview",
  "spam",
  "staff-preview",
  "test-account",
];
const REOPEN_REASONS: readonly SupportCaseReopenReason[] = [
  "member-message",
  "member-reopen",
  "team-reopen",
  "member-not-solved",
];
const CLOSERS: readonly SupportCaseCloser[] = ["member", "person", "bot"];
const HANDOFF_BY: readonly SupportHandoffBy[] = ["agent", "person", "member"];
const SOURCES: readonly SupportCase["source"][] = [
  "live",
  "backfill",
  "repaired",
];
const LEVELS = { anonymous: 0, connected: 1, signed: 2 } as const;
const CASE_AI_KEYS = [
  "changes",
  "draftRequests",
  "drafts",
  "draftsEdited",
  "draftsUsed",
  "mode",
  "restrictedAt",
  "restrictedCause",
];

/** Absent on cases written before the AI mode, or with no change yet. */
function checkedCaseAi(value: unknown): value is SupportCaseAi | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ai = value as SupportCaseAi;
  const keys = Object.keys(ai).sort();
  return (
    keys.length === CASE_AI_KEYS.length &&
    keys.every((key, index) => key === CASE_AI_KEYS[index]) &&
    oneOf(SUPPORT_AI_MODES, ai.mode) &&
    naturalOrNull(ai.restrictedAt) &&
    (ai.restrictedCause === null ||
      oneOf(SUPPORT_AI_MODE_CAUSES, ai.restrictedCause)) &&
    [
      ai.changes,
      ai.draftRequests,
      ai.drafts,
      ai.draftsUsed,
      ai.draftsEdited,
    ].every(natural)
  );
}

function checkedContributions(c: SupportCase): boolean {
  if (c.contributions === undefined) return true;
  if (
    !c.contributions ||
    typeof c.contributions !== "object" ||
    Array.isArray(c.contributions)
  )
    return false;
  return Object.entries(c.contributions).every(
    ([key, at]) =>
      ["transactionCheckAt", "walletVerifiedAt", "aiAnswerAt"].includes(key) &&
      natural(at) &&
      at >= c.openedAt,
  );
}

function addContribution(
  c: SupportCase,
  kind: keyof SupportCaseContributions,
  at: number,
): void {
  if (!natural(at) || at < c.openedAt || c.resolvedAt !== null) return;
  (c.contributions ??= {})[kind] ??= at;
}

/** Attaches a completed worker step to its case in the same transaction.
 * No route accepts this operation from a client. */
export async function recordCaseContribution(
  storage: Pick<Storage, "get" | "put">,
  thread: string,
  seq: number,
  kind: keyof SupportCaseContributions,
  at: number,
  env: TemplStaffEnv = {},
): Promise<void> {
  const c = checkedCase(await storage.get(caseKey(thread, seq)), thread, seq);
  if (!c || c.resolvedAt !== null || !natural(at) || at < c.openedAt) return;
  addContribution(c, kind, at);
  await storage.put(caseKey(thread, seq), c);
  await syncCaseContributions(storage as Storage, c, at);
  if (kind === "walletVerifiedAt")
    await recordUsageFeature(
      storage as Storage,
      await chargeRef(storage, thread, seq),
      "walletVerification",
      at,
      env,
    );
}

/** A stored case, or null when any field fails its check. */
export function checkedCase(
  raw: unknown,
  thread: string,
  seq: number,
): SupportCase | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as SupportCase;
  const context = c.context as Partial<SupportCase["context"]> | undefined;
  const counts = c.counts as Partial<SupportCase["counts"]> | undefined;
  const excluded = c.excluded as unknown;
  if (
    c.schemaVersion !== 1 ||
    (c.entry !== undefined && c.entry !== "hosted") ||
    !THREAD.test(thread) ||
    c.thread !== thread ||
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    c.seq !== seq ||
    !oneOf(SOURCES, c.source) ||
    !natural(c.openedAt) ||
    !natural(c.lastMemberAt) ||
    !natural(c.waitingOnMemberMs) ||
    !natural(c.reopens) ||
    !oneOf(ACCESS, c.access) ||
    !oneOf(ACCESS, c.verification) ||
    ![
      c.verificationRequestedAt,
      c.verifiedAt,
      c.firstReplyAt,
      c.firstHumanReplyAt,
      c.firstBotReplyAt,
      c.lastReplyAt,
      c.lastHumanReplyAt,
      c.awaitingSince,
      c.handoffAt,
      c.handoffClearedAt,
      c.waitingOnMemberSince,
      c.resolvedAt,
      c.firstResolvedAt,
      c.lastReopenAt,
      c.stoppedAt,
      c.confirmedAt,
    ].every(naturalOrNull) ||
    !context ||
    typeof context !== "object" ||
    !naturalOrNull(context.sharedAt) ||
    typeof context.network !== "boolean" ||
    typeof context.transaction !== "boolean" ||
    (c.handoffReason !== null &&
      !oneOf(SUPPORT_HANDOFF_REASONS, c.handoffReason)) ||
    (c.handoffBy !== null && !oneOf(HANDOFF_BY, c.handoffBy)) ||
    typeof c.handoffOpen !== "boolean" ||
    (c.resolvedBy !== null && !oneOf(CLOSERS, c.resolvedBy)) ||
    (c.lastReopenReason !== null &&
      !oneOf(REOPEN_REASONS, c.lastReopenReason)) ||
    (c.confirmation !== null &&
      c.confirmation !== "solved" &&
      c.confirmation !== "not-solved") ||
    (c.timeSpent !== null && !oneOf(SUPPORT_TIME_SPENT, c.timeSpent)) ||
    !counts ||
    typeof counts !== "object" ||
    ![
      counts.memberMessages,
      counts.humanReplies,
      counts.botReplies,
      counts.notes,
      counts.assignments,
    ].every(natural) ||
    !Array.isArray(excluded) ||
    excluded.length > EXCLUSIONS.length ||
    excluded.some(
      (entry, index) =>
        !oneOf(EXCLUSIONS, entry) ||
        (index > 0 && !(String(excluded[index - 1]) < entry)),
    ) ||
    c.incident !== null ||
    !checkedContributions(c) ||
    (c.billingManagedReplyAt !== undefined &&
      (!natural(c.billingManagedReplyAt) ||
        c.billingManagedReplyAt < c.openedAt)) ||
    !checkedCaseAi(c.ai) ||
    !checkedFollowUps((c as LedgerCase).followUps)
  )
    return null;
  return c;
}
const FOLLOW_UP_KEYS = [
  "cancelled",
  "created",
  "done",
  "firstCreatedAt",
  "lastClosedAt",
  "open",
  "overdue",
  "reopened",
  "updatesMissed",
  "waitingOnTeamMs",
  "waitingOnTeamSince",
];
/** Absent on cases with no follow-up event yet. */
function checkedFollowUps(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const f = value as SupportCaseFollowUps;
  const keys = Object.keys(f).sort();
  return (
    keys.length === FOLLOW_UP_KEYS.length &&
    keys.every((key, index) => key === FOLLOW_UP_KEYS[index]) &&
    [
      f.created,
      f.done,
      f.cancelled,
      f.reopened,
      f.open,
      f.waitingOnTeamMs,
      f.overdue,
      f.updatesMissed,
    ].every(natural) &&
    [f.firstCreatedAt, f.lastClosedAt, f.waitingOnTeamSince].every(
      naturalOrNull,
    ) &&
    f.open > 0 === (f.waitingOnTeamSince !== null)
  );
}

function blankCase(
  thread: string,
  seq: number,
  source: SupportCase["source"],
  openedAt: number,
  access: SupportCaseAccess,
  entry?: SupportCase["entry"],
): SupportCase {
  return {
    ...(entry ? { entry } : {}),
    schemaVersion: 1,
    thread,
    seq,
    source,
    openedAt,
    access,
    verification: access,
    verificationRequestedAt: null,
    verifiedAt: null,
    context: { sharedAt: null, network: false, transaction: false },
    firstReplyAt: null,
    firstHumanReplyAt: null,
    firstBotReplyAt: null,
    lastMemberAt: openedAt,
    lastReplyAt: null,
    lastHumanReplyAt: null,
    awaitingSince: null,
    handoffAt: null,
    handoffReason: null,
    handoffBy: null,
    handoffOpen: false,
    handoffClearedAt: null,
    waitingOnMemberMs: 0,
    waitingOnMemberSince: null,
    resolvedAt: null,
    resolvedBy: null,
    firstResolvedAt: null,
    reopens: 0,
    lastReopenAt: null,
    lastReopenReason: null,
    stoppedAt: null,
    confirmation: null,
    confirmedAt: null,
    timeSpent: null,
    counts: {
      memberMessages: 0,
      humanReplies: 0,
      botReplies: 0,
      notes: 0,
      assignments: 0,
    },
    excluded: [],
    incident: null,
  };
}
const exclusions = (list: readonly SupportCaseExclusion[]) =>
  [...new Set(list)].sort();
/** The member's current exclusion replaces the one stored; spam stays. */
const refreshed = (
  list: readonly SupportCaseExclusion[],
  exclusion: MemberExclusion | null,
) =>
  exclusions([
    ...list.filter((entry) => entry === "spam"),
    ...(exclusion ? [exclusion] : []),
  ]);
/** Highest widget level seen; a case opened from the app stays "app". */
function higher(
  current: SupportCaseAccess,
  next: SupportCaseAccess,
): SupportCaseAccess {
  if (current === "app" || next === "app") return current;
  return LEVELS[next] > LEVELS[current] ? next : current;
}
/** Flags only: whether the member shared a checked network or transaction. */
function contextFlags(value: unknown) {
  const view = readStoredSupportContext(value);
  return view && view !== "unreadable"
    ? {
        network: view.network !== undefined,
        transaction: (view.transactions?.length ?? 0) > 0,
      }
    : { network: false, transaction: false };
}
const awaitingValue = (c: SupportCase): AwaitingValue => ({
  seq: c.seq,
  ...(c.handoffOpen ? { handoff: true as const } : {}),
  ...(c.ai ? { ai: c.ai.mode } : {}),
  ...(c.confirmation === "not-solved" &&
  c.confirmedAt !== null &&
  c.confirmedAt >= (c.lastReplyAt ?? 0)
    ? { notSolved: true as const }
    : {}),
});
const unanswered = (c: SupportCase) => c.lastMemberAt > (c.lastReplyAt ?? 0);
/** Starts a wait unless one is already running (it keeps its start). */
const wait = (c: SupportCase, at: number) => {
  c.awaitingSince ??= at;
};
function foldWaiting(c: SupportCase, at: number) {
  if (c.waitingOnMemberSince === null) return;
  c.waitingOnMemberMs += Math.max(0, at - c.waitingOnMemberSince);
  c.waitingOnMemberSince = null;
}
function clearHandoff(c: SupportCase, at: number) {
  if (!c.handoffOpen) return;
  c.handoffOpen = false;
  c.handoffClearedAt = at;
}
function close(c: SupportCase, at: number, by: SupportCaseCloser | null) {
  c.resolvedAt = at;
  c.resolvedBy = by;
  c.firstResolvedAt ??= at;
  foldWaiting(c, at);
  clearHandoff(c, at);
  c.awaitingSince = null;
}
function reopen(c: SupportCase, at: number, reason: SupportCaseReopenReason) {
  c.resolvedAt = null;
  c.resolvedBy = null;
  c.resolvedByPrincipal = null;
  c.abandonedAt = null;
  c.reopens++;
  c.lastReopenAt = at;
  c.lastReopenReason = reason;
  c.excluded = c.excluded.filter((entry) => entry !== "spam");
}

/* Marker                                                                  */

function checkedMarker(raw: unknown): LedgerMarker | null {
  const marker = raw as LedgerMarker | undefined;
  if (
    !marker ||
    typeof marker !== "object" ||
    marker.schemaVersion !== 1 ||
    (marker.state !== "running" && marker.state !== "ready") ||
    !natural(marker.startedAt) ||
    (marker.after !== undefined &&
      (typeof marker.after !== "string" ||
        !marker.after.startsWith(RECORD_PREFIX))) ||
    (marker.pruneAfter !== undefined &&
      (typeof marker.pruneAfter !== "string" ||
        !marker.pruneAfter.startsWith(CASE_OPENED_PREFIX))) ||
    (marker.readyAt !== undefined && !natural(marker.readyAt)) ||
    (marker.prunedAt !== undefined && !natural(marker.prunedAt))
  )
    return null;
  return marker;
}
/** "absent" before the room's first ledger touch. An unreadable marker reads
 * as "running", so nothing that waits for "ready" trusts it. */
export async function ledgerState(
  storage: Pick<Storage, "get">,
): Promise<"absent" | "running" | "ready"> {
  const raw = await storage.get(LEDGER_KEY);
  if (raw === undefined) return "absent";
  return checkedMarker(raw)?.state ?? "running";
}
/** A room without threads is ready at once; any other room starts the
 * backfill. Migrated threads are skipped, so restarting is safe. */
async function startMarker(
  storage: Storage,
  now: number,
): Promise<LedgerMarker> {
  const threads = await storage.list({ prefix: RECORD_PREFIX, limit: 1 });
  const marker: LedgerMarker = threads.size
    ? { schemaVersion: 1, state: "running", startedAt: now }
    : { schemaVersion: 1, state: "ready", startedAt: now, readyAt: now };
  await storage.put(LEDGER_KEY, marker);
  return marker;
}
/** The marker's state, creating it when absent or unreadable. A running
 * backfill asks the room alarm to start within a second. */
export async function ensureLedgerMarker(
  storage: Storage,
  now: number,
): Promise<"running" | "ready"> {
  const marker = checkedMarker(await storage.get(LEDGER_KEY));
  if (marker) return marker.state;
  const started = await startMarker(storage, now);
  if (started.state === "running") await wakeRoomAt(storage, now + 1_000);
  return started.state;
}

/* Synthesis (lazy on first touch, and the backfill)                       */

/** The thread as it stood before the event that first touched it. Callers
 * have already applied that event to the support record (a member message
 * sets `requestedAt`, a status change sets `state`), so the ledger rebuilds
 * from the event's own facts and ignores rows written at or after it. */
type Prior = {
  at: number;
  state: SupportState;
  /** The event's own message is the thread's first member request. */
  firstRequest: boolean;
  /** Reopens the caller already counted for this event. */
  reopened: number;
};
function priorFor(event: CaseEvent, data: LedgerRecord): Prior {
  if (event.kind === "member-message")
    return {
      at: event.at,
      state:
        data.state === "spam"
          ? "spam"
          : event.wasResolved
            ? "resolved"
            : data.state,
      firstRequest: (data.firstRequestedAt ?? event.at) >= event.at,
      reopened: event.wasResolved ? 1 : 0,
    };
  return {
    at: event.at,
    state: event.kind === "status" ? event.previous : data.state,
    firstRequest: false,
    reopened: 0,
  };
}
type Row = { author: string; at: number };
/** The thread's newest rows, newest first, through the support storage
 * wrapper (it reads archived partitions). Author and time only. */
async function recentRows(
  storage: ReadStorage,
  thread: string,
  before = Number.POSITIVE_INFINITY,
): Promise<Row[]> {
  const rows = await storage.list<{ author?: unknown; createdAt?: unknown }>({
    prefix: `channel-message:${thread}:`,
    reverse: true,
    limit: TRAILING_ROWS + 1,
  });
  const output: Row[] = [];
  for (const row of rows.values()) {
    const at =
      typeof row?.createdAt === "string" ? Date.parse(row.createdAt) : NaN;
    if (typeof row?.author !== "string" || !natural(at) || at >= before)
      continue;
    output.push({ author: row.author, at });
    if (output.length === TRAILING_ROWS) break;
  }
  return output;
}
async function testAccounts(storage: Pick<Storage, "get">) {
  const settings = await storage.get<{ testAccounts?: unknown }>(SETTINGS_KEY);
  return Array.isArray(settings?.testAccounts)
    ? (settings.testAccounts as unknown[])
    : [];
}
/** One case rebuilt from the thread's support record and newest rows. */
async function synthesizedCase(
  storage: ReadStorage,
  record: TeamConversationRecord,
  data: LedgerRecord,
  now: number,
  input: {
    seq: number;
    source: "backfill" | "repaired";
    prior?: Prior;
    canary?: ChatPrincipalId | null;
    openedAt?: number;
  },
): Promise<SupportCase> {
  const { seq, prior } = input;
  const state = prior?.state ?? data.state;
  const closed = state === "resolved" || state === "spam";
  const canary = input.canary != null && input.canary === record.member;
  const awaitable =
    state === "open" &&
    !record.stopped &&
    (prior !== undefined || record.state === "open") &&
    !canary;
  const rows =
    awaitable || (closed && prior)
      ? await recentRows(storage, record.id, prior?.at)
      : [];
  const members = new Set<string>([
    record.member,
    ...(record.formerMembers ?? []),
  ]);
  let trailing = 0;
  while (trailing < rows.length && members.has(rows[trailing].author))
    trailing++;
  const openedAt =
    input.openedAt ??
    (seq === 1
      ? (data.firstRequestedAt ?? data.requestedAt)
      : data.requestedAt) ??
    now;
  const c = blankCase(
    record.id,
    seq,
    input.source,
    openedAt,
    data.access?.level ?? (data.wallet ? "signed" : "app"),
  );
  c.verificationRequestedAt = natural(data.verificationRequestedAt)
    ? data.verificationRequestedAt
    : null;
  c.context = { sharedAt: null, ...contextFlags(data.context) };
  c.firstHumanReplyAt =
    seq === 1 && natural(data.firstResponseMs)
      ? openedAt + data.firstResponseMs
      : null;
  c.firstReplyAt = c.firstHumanReplyAt;
  c.lastMemberAt = prior
    ? (rows.find((row) => members.has(row.author))?.at ?? openedAt)
    : (data.lastMemberMessageAt ?? openedAt);
  c.lastHumanReplyAt = natural(data.lastStaffReplyAt)
    ? data.lastStaffReplyAt
    : null;
  c.lastReplyAt =
    rows.find((row) => !members.has(row.author))?.at ?? c.lastHumanReplyAt;
  c.reopens = Math.max(0, data.reopened - (prior?.reopened ?? 0));
  // The oldest row of the member's trailing run, or the 20th row when all
  // 20 are theirs.
  c.awaitingSince = awaitable && trailing > 0 ? rows[trailing - 1].at : null;
  if (record.stopped) c.stoppedAt = record.stoppedAt ?? now;
  if (closed) {
    const resolvedAt =
      record.resolvedBy?.at ??
      (prior ? rows[0]?.at : undefined) ??
      record.lastMessageAt ??
      now;
    c.resolvedAt = resolvedAt;
    c.firstResolvedAt = resolvedAt;
    c.resolvedBy = record.resolvedBy
      ? record.resolvedBy.kind === "member"
        ? "member"
        : "person"
      : null;
  }
  const excluded: SupportCaseExclusion[] = [];
  if (state === "spam") excluded.push("spam");
  if ((await testAccounts(storage)).includes(record.member))
    excluded.push("test-account");
  if (canary) excluded.push("canary");
  c.excluded = exclusions(excluded);
  return c;
}
async function synthesize(
  storage: Storage,
  record: TeamConversationRecord,
  data: LedgerRecord,
  now: number,
  options: { prior?: Prior; canary?: ChatPrincipalId | null },
) {
  const mirror = natural(data.awaitingSince) ? data.awaitingSince : null;
  data.ledgerVersion = 1;
  if (data.requestedAt === null || options.prior?.firstRequest) {
    // Outreach only, or the event is the first member request: no case yet.
    if (mirror !== null) await storage.delete(awaitingKey(mirror, record.id));
    data.caseSeq = 0;
    data.awaitingSince = null;
    return;
  }
  const c = await synthesizedCase(storage, record, data, now, {
    seq: 1,
    source: "backfill",
    prior: options.prior,
    canary: options.canary,
  });
  await storage.put(caseKey(record.id, 1), c);
  await storage.put(caseOpenedKey(c.openedAt, record.id, 1), true);
  if (mirror !== null && mirror !== c.awaitingSince)
    await storage.delete(awaitingKey(mirror, record.id));
  if (c.awaitingSince !== null)
    await storage.put(
      awaitingKey(c.awaitingSince, record.id),
      awaitingValue(c),
    );
  data.caseSeq = 1;
  data.awaitingSince = c.awaitingSince;
}
/** Builds the ledger of a thread written before it: one case for the
 * latest request, with its current wait. Writes the case, its indexes and
 * the support record. */
export async function synthesizeThreadLedger(
  storage: Storage,
  record: TeamConversationRecord,
  data: SupportRecord & LedgerFields,
  now: number,
  options: { canary?: ChatPrincipalId | null } = {},
): Promise<void> {
  await synthesize(storage, record, data, now, options);
  await storage.put(workflowKey(record.id), data);
}

/* Events                                                                  */

/** The latest case, or null when there is none (never requested, or pruned).
 * A case that fails its checks is rebuilt with `source: "repaired"`. */
async function latestCase(
  storage: Storage,
  record: TeamConversationRecord,
  data: LedgerRecord,
  at: number,
  prior?: Prior,
): Promise<{
  c: SupportCase | null;
  staleSince: number | null;
  repaired: boolean;
}> {
  const seq = data.caseSeq ?? 0;
  if (!Number.isSafeInteger(seq) || seq < 1)
    return { c: null, staleSince: null, repaired: false };
  const raw = await storage.get(caseKey(record.id, seq));
  if (raw === undefined) return { c: null, staleSince: null, repaired: false };
  const checked = checkedCase(raw, record.id, seq);
  if (checked)
    return { c: checked, staleSince: checked.awaitingSince, repaired: false };
  const broken = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof SupportCase, unknown>
  >;
  const c = await synthesizedCase(storage, record, data, at, {
    seq,
    source: "repaired",
    prior,
    openedAt: natural(broken.openedAt) ? broken.openedAt : undefined,
  });
  await storage.put(caseOpenedKey(c.openedAt, record.id, seq), true);
  console.warn(
    JSON.stringify({
      event: "TEMPL_SUPPORT_CASE_REPAIRED",
      conversation: record.id,
      seq,
    }),
  );
  return {
    c,
    staleSince: natural(broken.awaitingSince) ? broken.awaitingSince : null,
    repaired: true,
  };
}
function reusesMemberCase(
  latest: SupportCase | null,
  at: number,
  spam: boolean,
) {
  return (
    latest !== null &&
    (spam ||
      latest.resolvedAt === null ||
      (!latest.excluded.includes("spam") &&
        at - latest.resolvedAt <= SUPPORT_LIMITS.caseReopenDays * DAY))
  );
}
/** Reads request admission and the member-message case boundary.
 * Call before writing the message, inside its storage transaction. */
export async function memberMessageAdmission(
  storage: Storage,
  record: TeamConversationRecord,
  data: SupportRecord & LedgerFields,
  at: number,
): Promise<{ newRequest: boolean; newCase: boolean }> {
  if (data.ledgerVersion !== 1)
    await synthesizeThreadLedger(storage, record, data, at);
  const { c, repaired } = await latestCase(storage, record, data, at);
  if (c && repaired) await storage.put(caseKey(record.id, c.seq), c);
  return {
    newRequest: c === null || c.resolvedAt !== null,
    newCase: !reusesMemberCase(c, at, data.state === "spam"),
  };
}
/** Applies one event to the thread's latest case. Returns the case to save,
 * or null when the event changes nothing (a thread with no case takes only
 * a member message). */
function transition(
  latest: SupportCase | null,
  record: TeamConversationRecord,
  data: LedgerRecord,
  event: Exclude<CaseEvent, ScopedCaseEvent>,
): { c: SupportCase | null; opened: boolean } {
  const at = event.at;
  const open = latest && latest.resolvedAt === null ? latest : null;
  const nextSeq = Math.max(data.caseSeq ?? 0, data.caseSeqFloor ?? 0) + 1;
  switch (event.kind) {
    case "member-message": {
      if (event.spam) {
        if (latest) {
          latest.counts.memberMessages++;
          latest.lastMemberAt = Math.max(latest.lastMemberAt, at);
          return { c: latest, opened: false };
        }
        // Closed at open: a spam request is never waiting.
        const c = blankCase(
          record.id,
          nextSeq,
          "live",
          at,
          event.access,
          event.entry,
        );
        c.context = { sharedAt: null, ...contextFlags(data.context) };
        c.counts.memberMessages = 1;
        c.excluded = exclusions([
          "spam",
          ...(event.exclusion ? [event.exclusion] : []),
        ]);
        c.resolvedAt = at;
        c.firstResolvedAt = at;
        return { c, opened: true };
      }
      let c: SupportCase;
      let opened = false;
      if (open) {
        c = open;
        if (c.abandonedAt != null) reopen(c, at, "member-message");
        foldWaiting(c, at);
      } else if (reusesMemberCase(latest, at, false)) {
        c = latest!;
        reopen(c, at, "member-message");
      } else {
        c = blankCase(
          record.id,
          nextSeq,
          "live",
          at,
          event.access,
          event.entry,
        );
        c.context = { sharedAt: null, ...contextFlags(data.context) };
        if (record.handoff) {
          c.handoffAt = record.handoff.at;
          c.handoffReason = record.handoff.reason;
          c.handoffBy = record.handoff.by;
          c.handoffOpen = true;
        }
        opened = true;
      }
      c.counts.memberMessages++;
      c.lastMessageBy = "member";
      c.lastMemberAt = at;
      c.verification = higher(c.verification, event.access);
      if (event.walletVerified) addContribution(c, "walletVerifiedAt", at);
      c.excluded = refreshed(
        c.excluded,
        c.billingExclusion === "staff-preview" ||
          c.billingExclusion === "install-preview"
          ? c.billingExclusion
          : event.exclusion,
      );
      if (!event.stopped) wait(c, at);
      return { c, opened };
    }
    case "team-reply": {
      if (!open) return { c: null, opened: false };
      open.lastMessageBy = "team";
      open.firstReplyAt ??= at;
      open.lastReplyAt = at;
      open.metrics ??= {};
      open.metrics.clarifyTurns =
        open.counts.humanReplies + open.counts.botReplies;
      open.metrics.contextReadyAt = Math.max(
        open.lastMemberAt,
        open.metrics.lastContextAt ?? 0,
      );
      if (event.bot) {
        if (event.aiAnswer) addContribution(open, "aiAnswerAt", at);
        open.counts.botReplies++;
        open.firstBotReplyAt ??= at;
        // A handed-off request waits for a person.
        if (!open.handoffOpen) open.awaitingSince = null;
      } else {
        open.counts.humanReplies++;
        open.firstHumanReplyAt ??= at;
        open.lastHumanReplyAt = at;
        clearHandoff(open, at);
        open.awaitingSince = null;
      }
      return { c: open, opened: false };
    }
    case "status": {
      if (event.previous === event.state || !latest)
        return { c: null, opened: false };
      const c = latest;
      if (event.state === "abandoned") {
        c.abandonedAt ??= at;
        foldWaiting(c, at);
        clearHandoff(c, at);
        c.awaitingSince = null;
        return { c, opened: false };
      }
      if (event.state === "resolved" || event.state === "spam") {
        c.abandonedAt = null;
        c.resolvedByPrincipal =
          event.actor ?? (event.by === "member" ? record.member : null);
        if (c.resolvedAt === null) close(c, at, event.by);
        else if (event.state === "resolved" && c.excluded.includes("spam")) {
          c.resolvedAt = at;
          c.resolvedBy = event.by;
          c.firstResolvedAt ??= at;
        }
        c.excluded =
          event.state === "spam"
            ? exclusions([...c.excluded, "spam"])
            : c.excluded.filter((entry) => entry !== "spam");
        c.awaitingSince = null;
        return { c, opened: false };
      }
      if (c.resolvedAt !== null) {
        const byMember = event.by === "member";
        reopen(c, at, byMember ? "member-reopen" : "team-reopen");
        if (
          event.state === "open" &&
          !event.stopped &&
          (byMember || unanswered(c))
        )
          wait(c, at);
      } else if (event.state === "open") {
        foldWaiting(c, at);
        if (!event.stopped && unanswered(c)) wait(c, at);
      }
      if (event.state === "waiting") {
        c.waitingOnMemberSince ??= at;
        c.awaitingSince = null;
      }
      return { c, opened: false };
    }
    case "assign":
      if (!latest || !event.assigned) return { c: null, opened: false };
      latest.counts.assignments++;
      return { c: latest, opened: false };
    case "note":
      if (!latest) return { c: null, opened: false };
      latest.counts.notes++;
      return { c: latest, opened: false };
    case "context":
      if (!latest) return { c: null, opened: false };
      latest.context.sharedAt ??= at;
      latest.metrics ??= {};
      latest.metrics.lastContextAt = at;
      latest.context.network ||= event.network;
      latest.context.transaction ||= event.transaction;
      return { c: latest, opened: false };
    case "verification-requested":
      if (!latest) return { c: null, opened: false };
      latest.verificationRequestedAt ??= at;
      return { c: latest, opened: false };
    case "wallet-verified":
      if (!latest) return { c: null, opened: false };
      addContribution(latest, "walletVerifiedAt", at);
      latest.verifiedAt ??= at;
      latest.verification = higher(latest.verification, "signed");
      return { c: latest, opened: false };
    case "stop":
      if (!latest) return { c: null, opened: false };
      if (event.stopped) {
        latest.stoppedAt = at;
        latest.awaitingSince = null;
      } else {
        latest.stoppedAt = null;
        if (open && unanswered(open)) wait(open, at);
      }
      return { c: latest, opened: false };
    case "handoff":
      if (!open) return { c: null, opened: false };
      open.handoffAt ??= at;
      open.handoffReason = event.reason;
      open.handoffBy = event.by;
      open.handoffOpen = true;
      open.handoffClearedAt = null;
      // A handoff is never an answer: the request keeps (or starts) its wait.
      if (!record.stopped) wait(open, at);
      return { c: open, opened: false };
    case "handoff-cleared":
      if (!latest) return { c: null, opened: false };
      clearHandoff(latest, at);
      // Taking, assigning, taking over from the AI or letting it answer
      // keeps the member waiting; a person's reply or the resolution ends
      // the wait.
      if (event.by === "reply" || event.by === "resolve")
        latest.awaitingSince = null;
      return { c: latest, opened: false };
    case "ai-mode": {
      if (!latest) return { c: null, opened: false };
      const ai: SupportCaseAi = latest.ai ?? {
        mode: event.mode,
        changes: 0,
        restrictedAt: null,
        restrictedCause: null,
        draftRequests: 0,
        drafts: 0,
        draftsUsed: 0,
        draftsEdited: 0,
      };
      ai.mode = event.mode;
      ai.changes++;
      if (
        ai.restrictedAt === null &&
        event.previous === "answers" &&
        event.mode !== "answers"
      ) {
        ai.restrictedAt = at;
        ai.restrictedCause = event.cause;
      }
      latest.ai = ai;
      // A mode change is never an answer: the wait stays as it is.
      return { c: latest, opened: false };
    }
    case "confirm":
      if (!latest) return { c: null, opened: false };
      latest.confirmation = event.answer;
      latest.confirmedAt = at;
      if (event.answer === "not-solved" && open && !record.stopped) {
        foldWaiting(latest, at);
        wait(latest, at);
      }
      if (event.reopened) latest.lastReopenReason = "member-not-solved";
      return { c: latest, opened: false };
    case "time-spent":
      if (!latest) return { c: null, opened: false };
      latest.timeSpent = event.bucket;
      return { c: latest, opened: false };
  }
}
/** Keeps exactly one awaiting key for the thread, matching the latest case.
 * The support record's mirror names any key a previous write left. The key
 * is rewritten whenever its value changes, so an AI mode change on a waiting
 * request moves it between Needs you and AI is handling at once. */
async function writeAwaiting(
  storage: Storage,
  thread: string,
  c: SupportCase,
  data: LedgerRecord,
  before: { since: number | null; value: string | null },
) {
  const since = c.excluded.includes("canary") ? null : c.awaitingSince;
  const mirror = natural(data.awaitingSince) ? data.awaitingSince : null;
  for (const old of new Set([before.since, mirror]))
    if (old !== null && old !== since)
      await storage.delete(awaitingKey(old, thread));
  const value = awaitingValue(c);
  if (
    since !== null &&
    (since !== before.since ||
      since !== mirror ||
      before.value !== JSON.stringify(value))
  )
    await storage.put(awaitingKey(since, thread), value);
  c.awaitingSince = since;
  data.awaitingSince = since;
  data.notSolved = since !== null && value.notSolved === true;
}
const isScoped = (event: CaseEvent): event is ScopedCaseEvent =>
  event.kind === "ai-draft-request" ||
  event.kind === "ai-draft" ||
  event.kind === "ai-draft-used" ||
  event.kind === "follow-up";
const blankAi = (mode: SupportAiMode): SupportCaseAi => ({
  mode,
  changes: 0,
  restrictedAt: null,
  restrictedCause: null,
  draftRequests: 0,
  drafts: 0,
  draftsUsed: 0,
  draftsEdited: 0,
});
const blankFollowUps = (): SupportCaseFollowUps => ({
  created: 0,
  done: 0,
  cancelled: 0,
  reopened: 0,
  open: 0,
  firstCreatedAt: null,
  lastClosedAt: null,
  waitingOnTeamSince: null,
  waitingOnTeamMs: 0,
  overdue: 0,
  updatesMissed: 0,
});
/** Draft counters and follow-up counts on one case by its number. They
 * never touch the wait, the handoff or the counts the report reads. A case
 * that is gone or unreadable takes nothing: these are metadata, and the
 * feature's own record stays the authority. */
async function applyScopedEvent(
  storage: Storage,
  record: TeamConversationRecord,
  event: ScopedCaseEvent,
): Promise<SupportCase | null> {
  if (!Number.isSafeInteger(event.seq) || event.seq < 1) return null;
  const c = checkedCase(
    await storage.get(caseKey(record.id, event.seq)),
    record.id,
    event.seq,
  ) as LedgerCase | null;
  if (!c) return null;
  if (event.kind === "follow-up") {
    const f = (c.followUps ??= blankFollowUps());
    if (event.change === "created") {
      f.created++;
      f.firstCreatedAt ??= event.at;
    } else if (event.change === "closed") {
      if (event.closedAs === "cancelled") f.cancelled++;
      else f.done++;
      f.lastClosedAt = event.at;
    } else if (event.change === "reopened") f.reopened++;
    else if (event.change === "overdue") f.overdue++;
    else f.updatesMissed++;
    f.open = natural(event.open) ? event.open : f.open;
    // The canary never waits on anyone.
    if (f.open > 0 && f.waitingOnTeamSince === null) {
      f.waitingOnTeamSince = event.at;
      if (!c.excluded.includes("canary"))
        await storage.put(teamWaitKey(event.at, record.id, c.seq), true);
    } else if (f.open === 0 && f.waitingOnTeamSince !== null) {
      f.waitingOnTeamMs += Math.max(0, event.at - f.waitingOnTeamSince);
      await storage.delete(teamWaitKey(f.waitingOnTeamSince, record.id, c.seq));
      f.waitingOnTeamSince = null;
    }
  } else {
    const ai = (c.ai ??= blankAi(event.mode));
    if (event.kind === "ai-draft-request") ai.draftRequests++;
    else if (event.kind === "ai-draft") ai.drafts++;
    else {
      ai.draftsUsed++;
      if (event.edited) ai.draftsEdited++;
    }
  }
  await storage.put(caseKey(record.id, c.seq), c);
  return c;
}
/** Mutates `data`, then writes the case, the indexes and
 * `support-workflow-v1:<id>`. Callers that also save `data` afterwards
 * write the same object again. A member message is never refused because
 * of ledger state: an unreadable case is rebuilt, never thrown. Returns
 * what the event did, for the hooks that act on it. */
export async function applyCaseEvent(
  storage: Storage,
  record: TeamConversationRecord,
  data: SupportRecord & LedgerFields,
  event: CaseEvent,
  env: TemplStaffEnv = {},
): Promise<CaseTransition> {
  if (data.ledgerVersion !== 1)
    await synthesize(storage, record, data, event.at, {
      prior: priorFor(event, data),
    });
  if (isScoped(event)) {
    const c = await applyScopedEvent(storage, record, event);
    if (c && event.kind === "ai-draft")
      await recordUsageFeature(
        storage,
        await chargeRef(storage, c.thread, c.seq),
        "aiDraft",
        event.at,
        env,
        event.actor,
      );
    data.ledgerVersion = 1;
    data.caseSeq ??= 0;
    await storage.put(workflowKey(record.id), data);
    const since = natural(data.awaitingSince) ? data.awaitingSince : null;
    return {
      seq: c?.seq ?? null,
      opened: false,
      reopened: false,
      closed: false,
      handoffOpened: false,
      awaitingBefore: since,
      awaitingAfter: since,
      excluded: c ? [...c.excluded] : [],
    };
  }
  const {
    c: latest,
    staleSince,
    repaired,
  } = await latestCase(storage, record, data, event.at, priorFor(event, data));
  // Read before `transition` changes the case in place. A rebuilt case
  // always rewrites its key: the stored value can't be trusted.
  const before = {
    since: staleSince,
    value: latest && !repaired ? JSON.stringify(awaitingValue(latest)) : null,
  };
  const was = latest
    ? {
        seq: latest.seq,
        resolved: latest.resolvedAt !== null,
        reopens: latest.reopens,
        handoff: latest.handoffOpen,
      }
    : null;
  const { c, opened } = transition(latest, record, data, event);
  if (c) {
    // The canary's checks are never waiting requests.
    if (c.excluded.includes("canary")) c.awaitingSince = null;
    await storage.put(caseKey(record.id, c.seq), c);
    if (opened) {
      await storage.put(caseOpenedKey(c.openedAt, record.id, c.seq), true);
      data.caseSeq = c.seq;
    }
    await writeAwaiting(storage, record.id, c, data, before);
  }
  data.ledgerVersion = 1;
  data.caseSeq ??= 0;
  await storage.put(workflowKey(record.id), data);
  const same = c !== null && was !== null && was.seq === c.seq;
  const result: CaseTransition = {
    seq: c?.seq ?? null,
    opened,
    reopened:
      c !== null &&
      !opened &&
      same &&
      (c.reopens > was!.reopens ||
        (event.kind === "confirm" && event.reopened)),
    closed: c !== null && c.resolvedAt !== null && !(same && was!.resolved),
    handoffOpened: c !== null && c.handoffOpen && !(same && was!.handoff),
    awaitingBefore: before.since,
    awaitingAfter: c ? c.awaitingSince : before.since,
    excluded: c ? [...c.excluded] : [],
  };
  // Keep the silence deadline with each case change.
  // The due index contains case identifiers and times only.
  if (c) {
    await updateAbandonDue(storage, c);
    if (event.kind === "team-reply")
      await storage.put(
        `support-reply-measure-v1:${c.thread}:${String(c.seq).padStart(8, "0")}:${event.at}`,
        {
          at: event.at,
          turns: c.metrics?.clarifyTurns ?? 0,
          contextAt: c.metrics?.contextReadyAt ?? c.lastMemberAt,
        },
      );
  }
  // The charge ledger reads every case change.
  await chargeCaseEvent(
    storage,
    record,
    c,
    event,
    result,
    (next) => storage.put(caseKey(record.id, next.seq), next),
    env,
  );
  if (c) {
    const ref = await chargeRef(storage, c.thread, c.seq);
    if (result.opened) {
      await openUsageCase(storage, ref, c, env);
      await countStandardTicket(storage);
    }
    if (c.contributions?.walletVerifiedAt === event.at)
      await recordUsageFeature(
        storage,
        ref,
        "walletVerification",
        event.at,
        env,
      );
    if (event.kind === "team-reply")
      await noteUsageAnswer(storage, ref, {
        at: event.at,
        actor: event.actor,
        bot: event.bot,
        answer: event.aiAnswer === true,
      });
    await updateUsageCase(storage, ref, c, {
      at: event.at,
      reopened:
        result.reopened || (event.kind === "member-message" && !result.opened),
      memberConfirmed:
        (event.kind === "confirm" && event.answer === "solved") ||
        (event.kind === "status" &&
          event.state === "resolved" &&
          event.by === "member"),
      memberRefused: event.kind === "confirm" && event.answer === "not-solved",
    });
    if (
      (await storage.get(`product-usage-case-v1:${ref}`)) === undefined &&
      (await storage.get(
        `product-charge-v1:${c.thread}:${String(c.seq).padStart(8, "0")}`,
      )) === undefined
    )
      await standardCaseEvent(storage, ref, c, {
        at: event.at,
        managed: event.kind === "team-reply" && event.managed === true,
        scriptedProducer:
          event.kind === "team-reply" ? event.scriptedProducer : null,
        templAnswer:
          event.kind === "team-reply" &&
          event.bot &&
          event.aiAnswer === true &&
          event.templ === true,
        humanReply: event.kind === "team-reply" && !event.bot,
        unsupportedReply:
          event.kind === "team-reply" &&
          event.bot &&
          !(event.aiAnswer === true && event.templ === true),
        reopened:
          result.reopened ||
          (event.kind === "member-message" && !result.opened),
        memberConfirmed:
          (event.kind === "confirm" && event.answer === "solved") ||
          (event.kind === "status" &&
            event.state === "resolved" &&
            event.by === "member"),
      });
  }
  return result;
}
/** The case `seq` of this thread for a case-scoped write or read: the
 * thread's ledger is built first when it predates the ledger, and a case
 * that is not in this thread is 404 `case-not-found`. Grants nothing: the
 * caller already checked the viewer's current access to the thread. */
export async function readCaseRef(
  storage: Storage,
  record: TeamConversationRecord,
  data: SupportRecord & LedgerFields,
  seq: unknown,
): Promise<SupportCase> {
  const missing = () =>
    new HttpError(404, "Case not found.", undefined, "case-not-found");
  if (!Number.isSafeInteger(seq) || (seq as number) < 1) throw missing();
  if (data.ledgerVersion !== 1)
    await synthesizeThreadLedger(storage, record, data, Date.now());
  if ((seq as number) > (data.caseSeq ?? 0)) throw missing();
  const c = checkedCase(
    await storage.get(caseKey(record.id, seq as number)),
    record.id,
    seq as number,
  );
  if (!c) throw missing();
  return c;
}

/* Needs reply, pulse and report                                           */

/** The most waiting requests a count reads before it reports "more". */
const WAITING_CAP = PRODUCT_LIMITS.supportOpenRecords;
const AWAITING_KEY = /^support-awaiting-v1:([0-9]{16}):(tc-[0-9a-f]{32})$/;
const OPENED_KEY =
  /^support-case-open-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9]{8})$/;
const REPORT_DAYS = { "7d": 7, "30d": 30, "90d": 90 } as const;
/** Keys per batched read (the storage API's limit). */
const READ_BATCH = 128;

type NeedsReplyEntry = {
  key: string;
  since: number;
  thread: string;
  seq: number;
  handoff: boolean;
  notSolved: boolean;
  /** The case's AI mode; null while it follows the workspace default. */
  ai: SupportAiMode | null;
};
function awaitingEntry(key: string, value: unknown): NeedsReplyEntry | null {
  const match = AWAITING_KEY.exec(key);
  const stored = value as Partial<AwaitingValue> | undefined;
  if (
    !match ||
    !stored ||
    typeof stored !== "object" ||
    !Number.isSafeInteger(stored.seq) ||
    stored.seq! < 1
  )
    return null;
  const since = Number(match[1]);
  if (!natural(since)) return null;
  return {
    key,
    since,
    thread: match[2],
    seq: stored.seq!,
    handoff: stored.handoff === true,
    notSolved: stored.notSolved === true,
    // An unreadable mode counts as AI off: the request then needs a
    // person, the safe side for a count that drives alerts.
    ai:
      stored.ai === undefined
        ? null
        : oneOf(SUPPORT_AI_MODES, stored.ai)
          ? stored.ai
          : "off",
  };
}
/** What the pulse and the index views need to split Needs reply. */
export type TurnInput = {
  assistantPaused?: boolean;
  /** The workspace default for new requests. */
  aiDefault: SupportAiMode;
  agent: AgentState;
  now: number;
};
/** The turn of a waiting request from its awaiting row alone: "person" or
 * "ai", never "member". The index views skip rows for another view before
 * reading them; the thread record stays the authority for each row shown. */
export function awaitingTurn(
  entry: NeedsReplyEntry,
  input: TurnInput,
): TurnView {
  return supportTurn({
    state: "open",
    awaitingSince: entry.since,
    // The row keeps no handoff reason; only the turn is used here.
    handoffReason: entry.handoff ? "other" : null,
    notSolved: entry.notSolved,
    aiMode: input.assistantPaused ? "off" : entry.ai ?? input.aiDefault,
    agentDraftAt: null,
    agent: input.agent,
    now: input.now,
  })!;
}
function openedEntry(key: string) {
  const match = OPENED_KEY.exec(key);
  if (!match) return null;
  const openedAt = Number(match[1]);
  const seq = Number(match[3]);
  return natural(openedAt) && seq >= 1
    ? { openedAt, thread: match[2], seq }
    : null;
}
/** One page of the awaiting index, oldest wait first. `after` is the last
 * `key` of the previous page. The ids are for the room's own authorized
 * reads; the caller shows each thread only after its usual checks. */
export async function needsReplyPage(
  storage: Pick<Storage, "list">,
  after: string | null,
  limit: number,
): Promise<NeedsReplyEntry[]> {
  const rows = await storage.list<unknown>({
    prefix: AWAITING_PREFIX,
    limit,
    ...(after ? { startAfter: after } : {}),
  });
  const page: NeedsReplyEntry[] = [];
  for (const [key, value] of rows) {
    const entry = awaitingEntry(key, value);
    if (entry) page.push(entry);
  }
  return page;
}
const TEAM_WAIT_KEY =
  /^support-team-wait-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9]{8})$/;
/** Distinct threads under the team-wait index, up to the cap. */
async function waitingOnTeam(storage: Pick<Storage, "list">) {
  const rows = await storage.list<unknown>({
    prefix: TEAM_WAIT_PREFIX,
    limit: WAITING_CAP + 1,
  });
  const threads = new Set<string>();
  for (const key of rows.keys()) {
    const match = TEAM_WAIT_KEY.exec(key);
    if (match) threads.add(match[2]);
  }
  return {
    threads,
    count: Math.min(threads.size, WAITING_CAP),
    more: rows.size > WAITING_CAP,
  };
}
/** The team's live queue: counts and times only. The response names no
 * thread, person or message. The split between Needs you and AI is
 * handling comes from the rows already read, with no extra read. */
export async function supportPulse(
  storage: Storage,
  open: number,
  now: number,
  turn: Omit<TurnInput, "now">,
): Promise<SupportPulseV2> {
  const marker = await ensureLedgerMarker(storage, now);
  const rows = await storage.list<unknown>({
    prefix: AWAITING_PREFIX,
    limit: WAITING_CAP + 1,
  });
  const entries = [...rows]
    .map(([key, value]) => awaitingEntry(key, value))
    .filter((entry) => entry !== null);
  const more = entries.length > WAITING_CAP;
  const newestRow = [
    ...(
      await storage.list<unknown>({
        prefix: AWAITING_PREFIX,
        reverse: true,
        limit: 1,
      })
    ).entries(),
  ][0];
  const newest =
    (newestRow ? awaitingEntry(newestRow[0], newestRow[1]) : null) ??
    (more ? null : (entries.at(-1) ?? null));
  const counted = entries.slice(0, WAITING_CAP);
  const input = { ...turn, now };
  const person = (entry: NeedsReplyEntry) =>
    awaitingTurn(entry, input).turn === "person";
  const needsYou = counted.filter(person).length;
  // Oldest first: the first person row read is the oldest one. The newest
  // is the reverse read's row when it needs a person, else the newest one
  // read (exact unless more rows wait than were read).
  const oldestPerson = entries.find(person) ?? null;
  const newestPerson =
    [
      ...(newestRow ? [awaitingEntry(newestRow[0], newestRow[1])] : []),
      ...[...entries].reverse(),
    ].find((entry) => entry !== null && person(entry)) ?? null;
  const team = await waitingOnTeam(storage);
  const member = await waitingOnMember(storage);
  const overdue = await storage.list<unknown>({
    prefix: FOLLOW_UP_OVERDUE_PREFIX,
    limit: WAITING_CAP + 1,
  });
  return {
    schemaVersion: 2,
    needsReply: counted.length,
    needsReplyMore: more,
    oldestWaitingSince: entries[0] ? iso(entries[0].since) : null,
    newestWaitingSince: newest ? iso(newest.since) : null,
    handedOff: counted.filter((entry) => entry.handoff).length,
    needsYou,
    needsYouOldestSince: oldestPerson ? iso(oldestPerson.since) : null,
    needsYouNewestSince: newestPerson ? iso(newestPerson.since) : null,
    aiHandling: counted.length - needsYou,
    agentRegistered: turn.agent.registered,
    agentActive: turn.agent.active,
    agentSeenAt: turn.agent.seenAt === null ? null : iso(turn.agent.seenAt),
    open,
    complete: marker === "ready",
    at: iso(now),
    waitingOnMember: member.count,
    waitingOnMemberMore: member.more,
    waitingOnTeam: team.count,
    waitingOnTeamMore: team.more,
    followUpsOverdue: Math.min(overdue.size, WAITING_CAP),
    followUpsOverdueMore: overdue.size > WAITING_CAP,
  };
}
/** The true median; an even count averages the two middle values. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}
/** Requests opened in the window, read from the date index (newest 5,000),
 * plus what is waiting now. Spam, test accounts, staff previews and the
 * canary are counted apart; a member listed as a test account today is left
 * out of every request of theirs. */
/** Report schema 3: schema 2 plus answered requests and follow-up totals. */
export type SupportReportV3 = Omit<SupportReport, "schemaVersion"> & {
  schemaVersion: 3;
  /** Cases opened in the window with a first reply of any kind. */
  answered: number;
  /** Requests with an open follow-up now, excluded cases left out. Not
   * windowed. */
  waitingOnTeam: number;
  /** Sums over cases opened in the window. */
  followUpsCreated: number;
  followUpsDone: number;
  updatesMissed: number;
  /** Over cases opened in the window whose follow-ups are all closed with at
   * least one done: last close minus first creation. */
  medianFollowUpMs: number | null;
};
export async function supportCaseReport(
  storage: Storage,
  settings: Pick<SupportSettings, "testAccounts">,
  window: SupportReportWindow,
  now: number,
): Promise<SupportReportV3> {
  if (!oneOf(SUPPORT_REPORT_WINDOWS, window))
    throw new HttpError(
      400,
      "Choose 7, 30 or 90 days, or all.",
      undefined,
      "report-window",
    );
  const marker = await ensureLedgerMarker(storage, now);
  const from = window === "all" ? null : now - REPORT_DAYS[window] * DAY;
  const scan = SUPPORT_LIMITS.reportCaseScan;
  const index = await storage.list<unknown>({
    prefix: CASE_OPENED_PREFIX,
    ...(from === null ? {} : { start: `${CASE_OPENED_PREFIX}${pad16(from)}` }),
    reverse: true,
    limit: scan + 1,
  });
  const testers = new Set<string>(settings.testAccounts);
  const members = new Map<string, string | null>();
  /** The thread's member, or null when the thread is gone or being deleted. */
  const memberOf = async (thread: string) => {
    if (!members.has(thread)) {
      const record = await storage.get<Partial<TeamConversationRecord>>(
        `${RECORD_PREFIX}${thread}`,
      );
      members.set(
        thread,
        record &&
          typeof record === "object" &&
          record.id === thread &&
          record.deleting !== true &&
          typeof record.member === "string"
          ? record.member
          : null,
      );
    }
    return members.get(thread)!;
  };
  const left = async (c: SupportCase) => {
    const member = await memberOf(c.thread);
    return member === null
      ? null
      : c.excluded.length > 0 || testers.has(member);
  };
  const report: SupportReportV3 = {
    schemaVersion: 3,
    window,
    from: from === null ? null : iso(from),
    to: iso(now),
    requests: 0,
    unanswered: 0,
    resolved: 0,
    reopened: 0,
    medianFirstResponseMs: null,
    medianFirstReplyMs: null,
    excluded: 0,
    truncated: index.size > scan,
    complete: marker === "ready",
    includesArchivedHistory: false,
    answered: 0,
    waitingOnTeam: 0,
    followUpsCreated: 0,
    followUpsDone: 0,
    updatesMissed: 0,
    medianFollowUpMs: null,
  };
  const firstHuman: number[] = [];
  const firstAny: number[] = [];
  const followUpSpans: number[] = [];
  const opened = [...index.keys()]
    .slice(0, scan)
    .map(openedEntry)
    .filter((entry) => entry !== null);
  for (let offset = 0; offset < opened.length; offset += READ_BATCH) {
    const batch = opened.slice(offset, offset + READ_BATCH);
    const cases = await storage.get<unknown>(
      batch.map((entry) => caseKey(entry.thread, entry.seq)),
    );
    for (const entry of batch) {
      const c = checkedCase(
        cases.get(caseKey(entry.thread, entry.seq)),
        entry.thread,
        entry.seq,
      );
      // An index row whose case is gone or moved is not a request.
      if (!c || c.openedAt !== entry.openedAt) continue;
      const out = await left(c);
      if (out === null) continue;
      if (out) {
        report.excluded++;
        continue;
      }
      report.requests++;
      if (c.resolvedAt !== null) report.resolved++;
      if (c.reopens > 0) report.reopened++;
      if (c.firstHumanReplyAt !== null)
        firstHuman.push(Math.max(0, c.firstHumanReplyAt - c.openedAt));
      if (c.firstReplyAt !== null) {
        report.answered++;
        firstAny.push(Math.max(0, c.firstReplyAt - c.openedAt));
      }
      const f = (c as LedgerCase).followUps;
      if (f) {
        report.followUpsCreated += f.created;
        report.followUpsDone += f.done;
        report.updatesMissed += f.updatesMissed;
        if (
          f.open === 0 &&
          f.done > 0 &&
          f.firstCreatedAt !== null &&
          f.lastClosedAt !== null
        )
          followUpSpans.push(Math.max(0, f.lastClosedAt - f.firstCreatedAt));
      }
    }
  }
  report.medianFirstResponseMs = median(firstHuman);
  report.medianFirstReplyMs = median(firstAny);
  report.medianFollowUpMs = median(followUpSpans);
  const counted = new Set<string>();
  for (const key of (
    await storage.list<unknown>({
      prefix: TEAM_WAIT_PREFIX,
      limit: WAITING_CAP + 1,
    })
  ).keys()) {
    const match = TEAM_WAIT_KEY.exec(key);
    if (!match || counted.has(match[2])) continue;
    const c = checkedCase(
      await storage.get(caseKey(match[2], Number(match[3]))),
      match[2],
      Number(match[3]),
    ) as LedgerCase | null;
    if (!c?.followUps || c.followUps.open === 0) continue;
    if ((await left(c)) !== false) continue;
    counted.add(match[2]);
    report.waitingOnTeam++;
  }
  for (const entry of await needsReplyPage(storage, null, WAITING_CAP + 1)) {
    const c = checkedCase(
      await storage.get(caseKey(entry.thread, entry.seq)),
      entry.thread,
      entry.seq,
    );
    if (!c || c.resolvedAt !== null || c.awaitingSince !== entry.since)
      continue;
    if ((await left(c)) === false) report.unanswered++;
  }
  return report;
}

/* Retention and the ledger's alarm consumer                               */

/** The index keys a stored case row names: its awaiting row, its date
 * index row and its team-wait row. Read from the raw value, so a row that
 * fails its checks still takes its index rows with it. */
function caseIndexKeys(thread: string, seq: number, raw: unknown): string[] {
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof LedgerCase, unknown>
  >;
  const followUps = (
    stored.followUps && typeof stored.followUps === "object"
      ? stored.followUps
      : {}
  ) as Partial<SupportCaseFollowUps>;
  const valid = Number.isSafeInteger(seq) && seq >= 1;
  return [
    ...(natural(stored.awaitingSince)
      ? [awaitingKey(stored.awaitingSince, thread)]
      : []),
    ...(natural(stored.openedAt) && valid
      ? [caseOpenedKey(stored.openedAt, thread, seq)]
      : []),
    ...(natural(followUps.waitingOnTeamSince) && valid
      ? [teamWaitKey(followUps.waitingOnTeamSince, thread, seq)]
      : []),
    ...(valid ? [`${ESCALATED_PREFIX}${thread}:${pad8(seq)}`] : []),
  ];
}
/** Deletes up to `budget` keys of a thread being deleted: each case with
 * its index rows and the rows `deleters` keep for it, the case row last so
 * an interrupted pass resumes from it. Returns the keys deleted; a result
 * equal to `budget` can mean more remain. */
export async function deleteThreadCases(
  storage: Storage,
  thread: string,
  budget: number,
  deleters: readonly CaseDataDeleter[] = [],
): Promise<number> {
  if (!THREAD.test(thread) || budget <= 0) return 0;
  await clearAbandonDue(storage, thread);
  let deleted = 0;
  for (const prefix of [
    `support-reply-measure-v1:${thread}:`,
    `support-compose-v1:${thread}:`,
  ]) {
    const measures = await storage.list({ prefix, limit: budget - deleted });
    for (const key of measures.keys()) if (await storage.delete(key)) deleted++;
    if (deleted >= budget) return deleted;
  }
  const rows = await storage.list<unknown>({
    prefix: `${CASE_PREFIX}${thread}:`,
    limit: budget,
  });
  for (const [key, raw] of rows) {
    const seq = Number(key.slice(key.lastIndexOf(":") + 1));
    if (Number.isSafeInteger(seq) && seq >= 1)
      for (const deleter of deleters) {
        deleted += await deleter(storage, thread, seq, budget - deleted);
        if (deleted >= budget) return deleted;
      }
    for (const item of [...caseIndexKeys(thread, seq, raw), key]) {
      if (deleted >= budget) return deleted;
      if (await storage.delete(item)) deleted++;
    }
  }
  return deleted;
}
/** Takes a thread out of Needs reply and the pulse at once, before its rows
 * are deleted. */
export async function clearThreadAwaiting(
  storage: Storage,
  thread: string,
  data: SupportRecord & LedgerFields,
): Promise<void> {
  const seq = data.caseSeq ?? 0;
  const raw =
    Number.isSafeInteger(seq) && seq >= 1
      ? await storage.get<unknown>(caseKey(thread, seq))
      : undefined;
  const stored = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof SupportCase, unknown>
  >;
  const since = new Set<number>();
  if (natural(data.awaitingSince)) since.add(data.awaitingSince);
  if (natural(stored.awaitingSince)) since.add(stored.awaitingSince);
  for (const value of since) await storage.delete(awaitingKey(value, thread));
  const c = checkedCase(raw, thread, seq);
  if (c && c.awaitingSince !== null) {
    c.awaitingSince = null;
    await storage.put(caseKey(thread, seq), c);
  }
  // Waiting on the team ends too, on any case of the thread.
  for (const [key, value] of await storage.list<unknown>({
    prefix: `${CASE_PREFIX}${thread}:`,
    limit: 100,
  })) {
    const since = (
      (value as Partial<LedgerCase> | undefined)?.followUps as
        | Partial<SupportCaseFollowUps>
        | undefined
    )?.waitingOnTeamSince;
    const number = Number(key.slice(key.lastIndexOf(":") + 1));
    if (natural(since))
      await storage.delete(teamWaitKey(since, thread, number));
  }
  if (data.awaitingSince != null) {
    data.awaitingSince = null;
    await storage.put(workflowKey(thread), data);
  }
}
type LedgerEnv = Pick<
  Env,
  "APP_ORIGIN" | "SUPPORT_PARTITIONS" | "GROUP_HISTORY_ARCHIVE_ENABLED"
> &
  Pick<SafetyEnv, "SAFETY_STORE"> & {
    TEMPL_SUPPORT_WORKSPACE?: string;
    SUPPORT_CANARY_ACCOUNT?: string;
  };
function threadRecord(
  key: string,
  raw: unknown,
): TeamConversationRecord | null {
  const record = raw as TeamConversationRecord | undefined;
  return record &&
    typeof record === "object" &&
    record.schemaVersion === 1 &&
    record.deleting !== true &&
    typeof record.id === "string" &&
    THREAD.test(record.id) &&
    key === `${RECORD_PREFIX}${record.id}` &&
    typeof record.member === "string" &&
    (record.state === "open" || record.state === "resolved") &&
    typeof record.stopped === "boolean"
    ? record
    : null;
}
function supportData(raw: unknown): LedgerRecord | null {
  const data = raw as LedgerRecord | undefined;
  return data &&
    typeof data === "object" &&
    ["open", "waiting", "resolved", "spam"].includes(data.state) &&
    naturalOrNull(data.requestedAt) &&
    natural(data.reopened)
    ? data
    : null;
}
/** Builds up to 20 pre-ledger threads per run. A partition read failure
 * throws, the transaction rolls back and the marker stays "running". */
async function backfill(
  storage: Storage,
  marker: LedgerMarker,
  canary: ChatPrincipalId | null,
  now: number,
) {
  const batch = SUPPORT_LIMITS.ledgerBackfillBatch;
  const records = await storage.list<unknown>({
    prefix: RECORD_PREFIX,
    limit: batch,
    ...(marker.after ? { startAfter: marker.after } : {}),
  });
  let after = marker.after;
  for (const [key, raw] of records) {
    after = key;
    const record = threadRecord(key, raw);
    if (!record) continue;
    const stored = await storage.get<unknown>(workflowKey(record.id));
    // No support record means no member request yet: nothing to build.
    if (stored === undefined) continue;
    const data = supportData(stored);
    if (!data) {
      console.warn(
        JSON.stringify({
          event: "TEMPL_SUPPORT_CASE_BACKFILL_SKIPPED",
          conversation: record.id,
        }),
      );
      continue;
    }
    if (data.ledgerVersion === 1) continue;
    await synthesizeThreadLedger(storage, record, data, now, { canary });
  }
  await storage.put(
    LEDGER_KEY,
    records.size < batch
      ? {
          schemaVersion: 1,
          state: "ready",
          startedAt: marker.startedAt,
          readyAt: now,
        }
      : { ...marker, after },
  );
  return now + 1_000;
}
/** Once a day, deletes up to 100 cases opened and resolved more than
 * `supportHistoryDays` ago, with their index rows. Open cases stay. */
async function prune(
  storage: Storage,
  marker: LedgerMarker,
  now: number,
  deleters: readonly CaseDataDeleter[],
  room: string,
  readHolds: (room: string) => Promise<RetentionHolds | null>,
) {
  if (
    marker.pruneAfter === undefined &&
    marker.prunedAt !== undefined &&
    now < marker.prunedAt + DAY
  )
    return marker.prunedAt + DAY;
  const cutoff = now - PRODUCT_LIMITS.supportHistoryDays * DAY;
  const batch = SUPPORT_LIMITS.casePruneBatch;
  const rows = await storage.list<unknown>({
    prefix: CASE_OPENED_PREFIX,
    end: `${CASE_OPENED_PREFIX}${pad16(cutoff + 1)}`,
    limit: batch,
    ...(marker.pruneAfter ? { startAfter: marker.pruneAfter } : {}),
  });
  let pruneAfter = marker.pruneAfter;
  /** A case whose feature rows took the whole pass budget: the pass ends
   * before it and the next run resumes at it. */
  let unfinished = false;
  /** Feature rows deleted this pass. */
  let spent = 0;
  for (const key of rows.keys()) {
    const entry = openedEntry(key);
    const raw = entry
      ? await storage.get<unknown>(caseKey(entry.thread, entry.seq))
      : undefined;
    const c = entry ? checkedCase(raw, entry.thread, entry.seq) : null;
    if (!entry || raw === undefined || (c && c.openedAt !== entry.openedAt)) {
      // An index row whose case is gone or was rebuilt at another time.
      await storage.delete(key);
      pruneAfter = key;
      continue;
    }
    if (!c || c.resolvedAt === null || c.resolvedAt > cutoff) {
      pruneAfter = key;
      continue;
    }
    // The daily ledger alarm also deletes feature content. It must check the
    // same authoritative holds as whole-thread retention before each case batch.
    const holds = await readHolds(room);
    if (!holds) return now + 3_600_000;
    if (holds.room || holds.threads.has(c.thread)) {
      pruneAfter = key;
      continue;
    }
    // Each feature's rows for the case go first, within the pass's budget.
    // Deleters are idempotent, so a case left for the next run resumes.
    for (const deleter of deleters) {
      const left = batch - spent;
      const removed =
        left > 0 ? await deleter(storage, c.thread, c.seq, left) : 0;
      spent += removed;
      if (spent >= batch) {
        unfinished = true;
        break;
      }
    }
    if (unfinished) break;
    for (const item of caseIndexKeys(c.thread, c.seq, c))
      if (item !== key) await storage.delete(item);
    await storage.delete(caseKey(c.thread, c.seq));
    await storage.delete(key);
    pruneAfter = key;
  }
  const done = rows.size < batch && !unfinished;
  const { pruneAfter: _cursor, ...rest } = marker;
  await storage.put(
    LEDGER_KEY,
    done
      ? { ...rest, prunedAt: now }
      : // Before any key: the next run starts the pass from the top.
        { ...rest, pruneAfter: pruneAfter ?? CASE_OPENED_PREFIX },
  );
  return done ? now + DAY : now + 1_000;
}
/** Room alarm consumer "support-case-ledger": backfills pre-ledger threads
 * 20 at a time, then prunes old cases once a day. Returns when it next
 * needs to run; it never sets the alarm itself. */
export async function supportCaseLedgerAlarm(
  state: Pick<DurableObjectState, "storage" | "id">,
  env: LedgerEnv,
  now: number,
  deleters: readonly CaseDataDeleter[] = [],
  readHolds: (room: string) => Promise<RetentionHolds | null> = (room) =>
    readRetentionHolds(env as SafetyEnv, room),
): Promise<number | null> {
  const native = await state.storage.get<{ room?: { id?: unknown } }>(
    "native-room",
  );
  if (!native || typeof native.room?.id !== "string") return null;
  const room = `room:${native.room.id}`;
  const current = checkedMarker(await state.storage.get(LEDGER_KEY));
  if (
    current?.state === "ready" &&
    current.pruneAfter === undefined &&
    current.prunedAt !== undefined &&
    now < current.prunedAt + DAY
  )
    return current.prunedAt + DAY;
  const canary =
    typeof native.room?.id === "string"
      ? canaryPrincipal(env, `room:${native.room.id}`)
      : null;
  return state.storage.transaction(async (local) => {
    const storage = await supportStorage(
      local,
      env,
      state.id?.toString() ?? "",
      false,
    );
    const marker =
      checkedMarker(await storage.get(LEDGER_KEY)) ??
      (await startMarker(storage, now));
    return marker.state === "running"
      ? backfill(storage, marker, canary, now)
      : prune(storage, marker, now, deleters, room, readHolds);
  });
}
