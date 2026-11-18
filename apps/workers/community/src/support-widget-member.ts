import {
  readProductState,
  standardPlanForState,
  productMode,
} from "./product-entitlements";
/** The widget's member reads and writes on a thread:
 *
 * - The member removes one detail they shared (the note, the network, one
 *   transaction or one typed app field). The thread's activity log records
 *   which field went, never its value.
 * - The wait line, "The team usually replies in about 2 hours", from the
 *   case ledger's median first reply by a person over 30 days. Nothing is
 *   answered below 20 answered requests, and the answer is a rounded
 *   duration, never a count.
 * - The sources of the managed AI agent's replies, as a member sees them:
 *   titles, and links only to sites the team listed.
 * - The details the member shared, for the widget's list.
 *
 * Mounted in `supportThreadRoute`, after the room checked
 * that the viewer is this thread's member or on its team. Every answer
 * reads current records; nothing here grants access or reaches a chain. */
import { guestFollowUpThread } from "./guest-follow-up";
import type { ChatMessage } from "@templ/chat/index";
import {
  SupportContextError,
  contextTargetLabel,
  parseContextTarget,
  readStoredSupportContext,
  removeSupportContext,
  supportContextView,
} from "@templ/chat/support-context";
import { HttpError, json } from "./common";
import { readCasesOpened } from "./support-case-data";
import { provenancePage } from "./support-drafts";
import {
  contextTransactions,
  memberDiagnosisEvidence,
  readThreadDiagnoses,
} from "./support-diagnosis";
import { managedPrincipal } from "./managed-agent/principal";
import { messageKey } from "./message-store";
import {
  recordSupportActivity,
  supportRecord,
  supportSettings,
  readAiState,
} from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
const DAY = 86_400_000;

/** The wait line's window, sample floor, read size and how long one
 * answer is reused for the workspace. */
export const WAIT_LINE = {
  windowDays: 30,
  /** Below this many answered requests the line is hidden. */
  sampleFloor: 20,
  /** The newest requests read in the window. */
  sampleLimit: 500,
  reuseMs: 10 * 60_000,
} as const;
/** One answer per workspace for `reuseMs`: members asking in a burst read
 * the ledger once. It holds a rounded duration, never a request. */
const waitAnswers = new Map<
  string,
  { at: number; wait: { minutes: number } | null }
>();
/** Sources shown under one reply, and replies read per call. */
export const MEMBER_SOURCES = { perReply: 5, messagesPerRead: 20 } as const;

/** The median wait, rounded the way the widget says it: 5-minute steps
 * under an hour, whole hours under two days, whole days after. */
export function roundedWaitMinutes(ms: number): number {
  const minutes = Math.max(1, ms / 60_000);
  if (minutes < 60) return Math.min(60, Math.ceil(minutes / 5) * 5);
  if (minutes < 48 * 60) return Math.round(minutes / 60) * 60;
  return Math.round(minutes / 1440) * 1440;
}

/** The median first reply by a person over the newest answered requests
 * opened in the window, with held time left out and excluded requests
 * (spam, tests, staff previews, the canary) skipped. Null below the floor. */
export async function memberWaitLine(
  storage: Pick<DurableObjectStorage, "get" | "list">,
  now: number,
): Promise<{ minutes: number } | null> {
  const cases = await readCasesOpened(storage, {
    from: now - WAIT_LINE.windowDays * DAY,
    to: now + 1,
    limit: WAIT_LINE.sampleLimit,
    newest: true,
  });
  const waits = cases
    .map((entry) => entry.case)
    .filter((c) => c.excluded.length === 0 && c.firstHumanReplyAt !== null)
    .map((c) => Math.max(0, c.firstHumanReplyAt! - c.openedAt))
    .sort((a, b) => a - b);
  if (waits.length < WAIT_LINE.sampleFloor) return null;
  const middle = waits.length >> 1;
  const median =
    waits.length % 2 ? waits[middle] : (waits[middle - 1] + waits[middle]) / 2;
  return { minutes: roundedWaitMinutes(median) };
}

/** The member's view of the sources behind the managed AI agent's replies
 * on this thread: at most five per reply, each a title, with its link only
 * when it is https on a site the team listed. Replies by anyone else,
 * drafts and deleted replies show none. */
export async function memberSources(
  storage: Storage,
  record: TeamConversationRecord,
  ids: readonly string[],
): Promise<Record<string, { title: string; url?: string }[]>> {
  const wanted = [...new Set(ids)]
    .filter((id) => /^[1-9][0-9]{0,14}$/.test(id))
    .slice(0, MEMBER_SOURCES.messagesPerRead);
  if (!wanted.length) return {};
  const provenance = await provenancePage(storage, record.id, wanted, () =>
    supportSettings(storage),
  );
  const found = Object.keys(provenance);
  if (!found.length) return {};
  const managed = await managedPrincipal(record.room);
  const rows = await storage.get<ChatMessage>(
    found.map((id) => messageKey(record.id, Number(id))),
  );
  const out: Record<string, { title: string; url?: string }[]> = {};
  for (const id of found) {
    const view = provenance[id];
    const message = rows.get(messageKey(record.id, Number(id)));
    if (
      !message ||
      message.author !== managed ||
      view.kind !== "reply" ||
      !view.ai?.sources.length
    )
      continue;
    const listed = view.ai.sources
      .filter((source) => typeof source.title === "string" && source.title)
      .slice(0, MEMBER_SOURCES.perReply)
      .map((source) => ({
        title: source.title.slice(0, 200),
        ...(typeof source.url === "string" &&
        source.url.startsWith("https://") &&
        view.links[source.id] === true
          ? { url: source.url }
          : {}),
      }));
    if (listed.length) out[id] = listed;
  }
  return out;
}

/** Check citations reveal only the stored check's user-safe lines. The caller
 * has checked current thread access. Deleted messages and drafts reveal none. */
export async function memberCheckSources(
  storage: Storage,
  record: TeamConversationRecord,
  ids: readonly string[],
): Promise<Record<string, { id: string; evidence: string[] }[]>> {
  const wanted = [...new Set(ids)]
    .filter((id) => /^[1-9][0-9]{0,14}$/.test(id))
    .slice(0, MEMBER_SOURCES.messagesPerRead);
  if (!wanted.length) return {};
  const provenance = await provenancePage(storage, record.id, wanted, () =>
    supportSettings(storage),
  );
  const data = await supportRecord(storage, record);
  const shared = contextTransactions(data.context);
  const checks = new Map(
    (await readThreadDiagnoses(storage, record.id as `tc-${string}`)).map(
      (row) => [row.id, row],
    ),
  );
  const messages = await storage.get<ChatMessage>(
    wanted.map((id) => messageKey(record.id, Number(id))),
  );
  const out: Record<string, { id: string; evidence: string[] }[]> = {};
  for (const id of wanted) {
    const view = provenance[id];
    const message = messages.get(messageKey(record.id, Number(id)));
    if (
      !view ||
      !message ||
      (view.kind === "assisted" && view.fromDraft?.edited !== false)
    )
      continue;
    const cited = [
      ...new Set([
        ...(view.diagnosisCitations ?? []).flatMap((row) => row.diagnoses),
        ...(view.ai?.sources ?? [])
          .filter((source) => source.kind === "diagnosis")
          .map((source) => source.id),
      ]),
    ].slice(0, MEMBER_SOURCES.perReply);
    const safe = cited.flatMap((checkId) => {
      const check = checks.get(checkId);
      if (
        !check || check.caseSeq !== view.case || data.caseSeq !== view.case ||
        !shared.some(({ subject }) =>
          check.diagnosis.kind === subject.kind &&
          (subject.kind === "solana"
            ? subject.signature === check.diagnosis.subject
            : subject.hash.toLowerCase() === check.diagnosis.subject.toLowerCase()),
        )
      ) return [];
      const evidence = memberDiagnosisEvidence(check.diagnosis);
      return evidence.length ? [{ id: check.id, evidence }] : [];
    });
    if (safe.length) out[id] = safe;
  }
  return out;
}

/** The member-detail step of `supportThreadRoute`. Null leaves the request to
 * the route's own actions. */
export async function widgetMemberThreadRoute(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  gate: { available: boolean; writable?: boolean },
): Promise<Response | null> {
  const guest = await guestFollowUpThread(storage, context, record, role);
  if (guest) return guest;
  if (context.method === "GET") {
    const view = context.query.get("view");
    if (view === "wait") {
      const kept = waitAnswers.get(record.room);
      if (kept && context.now - kept.at < WAIT_LINE.reuseMs)
        return json({ wait: kept.wait });
      const wait = await memberWaitLine(storage, context.now);
      if (waitAnswers.size >= 1000) waitAnswers.clear();
      waitAnswers.set(record.room, { at: context.now, wait });
      return json({ wait });
    }
    // The details the member shared, as the thread holds them now: the
    // widget's list with Remove. Nothing else of the workflow comes with it.
    if (view === "context") {
      const data = await supportRecord(storage, record);
      const held = readStoredSupportContext(data.context);
      if (role === "member")
        return json({ context: held === "unreadable" ? null : held });
      const product = await readProductState(
        storage,
        context.now,
        context.mediaEnv,
      );
      const mode = productMode(product);
      return json({
        context: held === "unreadable" ? null : held,
        canUseTemplAi:
          gate.available &&
          gate.writable === true &&
          !record.stopped &&
          record.state === "open" &&
          (await readAiState(storage, record, data)).effective.mode !== "off" &&
          mode !== "paused" &&
          mode !== "suspended" &&
          standardPlanForState(product)?.status !== "demo",
      });
    }
    if (view === "sources")
      return json({
        sources: await memberSources(
          storage,
          record,
          (context.query.get("messages") ?? "").split(","),
        ),
        checks: await memberCheckSources(
          storage,
          record,
          (context.query.get("messages") ?? "").split(","),
        ),
      });
    return null;
  }
  if (
    context.method !== "POST" ||
    context.body.action !== "context" ||
    context.body.remove === undefined
  )
    return null;
  // Only the member takes back what they shared. It needs no plan: a
  // member can always remove their own details.
  if (role !== "member")
    throw new HttpError(
      403,
      "Only the user can remove what they shared.",
      undefined,
      "member-only",
    );
  if (!gate.available)
    throw new HttpError(503, "Support tools are being tested.");
  if (context.viewer.banned)
    throw new HttpError(403, "You cannot change this case right now.");
  let target;
  try {
    target = parseContextTarget(context.body.remove);
  } catch (error) {
    if (error instanceof SupportContextError)
      throw new HttpError(400, error.message, undefined, error.reason);
    throw error;
  }
  const data = await supportRecord(storage, record);
  const held = readStoredSupportContext(data.context);
  if (held === "unreadable")
    throw new HttpError(
      409,
      "Your shared details can't be read right now. Ask the team to remove them.",
      undefined,
      "context-unreadable",
    );
  const next = removeSupportContext(held, target);
  if (!next)
    throw new HttpError(
      404,
      "That detail isn't shared with the team.",
      undefined,
      "context-not-shared",
    );
  data.context = next;
  // The activity entry names the field, never its value; it saves the
  // thread's support record with the change.
  await recordSupportActivity(storage, record.id, data, {
    actor: context.viewer.principalId!,
    action: "context",
    at: context.now,
    detail: `removed:${contextTargetLabel(target)}`,
  });
  return json({ context: supportContextView(next) });
}
