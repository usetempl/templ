/** Members' reports that an AI answer didn't help, and the list where the
 * workspace's owner and Admins review them.
 *
 * - The thread's member reports one AI answer in their own thread, with an
 *   optional reason. The member is the thread's only reporter, so one report
 *   per message is one per viewer and message. A repeat returns the same
 *   answer and changes nothing.
 * - The worker checks that the message is in this thread, that a current or
 *   retained AI agent of this workspace wrote it and that a case holds it.
 *   The report goes on that case's quality record and is deleted with it.
 *   It names no reporter, copies no answer text and keeps no session,
 *   address or IP data.
 * - Nothing here sends an alert or event, reaches an export, the improvement
 *   copy or a model, or changes the case's AI mode, handoff or billing.
 * - Only the owner and Admins read the list and mark a report reviewed.
 *   Everyone else gets the same 404 as an outsider.
 *
 * Writes need the `aiAnswerReports` and `quality` workspace flags, read from
 * the room's stored flags in the same transaction. The widget's policy
 * answer offers reports with the same two flags, so a workspace without
 * them reads no report states. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  ANSWER_REPORT_LIMITS,
  type SupportAnswerReportItem,
} from "@templ/chat/support-quality";
import { HttpError, json } from "./common";
import { managedPrincipal } from "./managed-agent/principal";
import { readMessage } from "./message-store";
import { SUPPORT_REFUSAL } from "./product-entitlements";
import { refusePhrase } from "./secret-guard";
import { readThreadCases, type CaseRead } from "./support-case-data";
import {
  ANSWER_REPORT_PREFIX,
  answerReportKey,
  readQuality,
  storedAnswerReports,
  writableQuality,
  writeQuality,
  type QualityViewer,
  type StoredAnswerReport,
} from "./support-quality";
import {
  readConversation,
  type ConversationContext,
  type TeamConversationRecord,
} from "./team-conversations";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";

type Storage = DurableObjectTransaction;
type Gate = { available: boolean; writable?: boolean };
const DAY = 86_400_000;
const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;
const LIST_KEY =
  /^support-answer-report-v1:(open|done):([0-9]{16}):(tc-[0-9a-f]{32}):([0-9]{8}):([0-9]{16})$/;
/** Answers one reports read may ask about, as many as a sources read. */
const READ_MESSAGES = 20;
const iso = (value: number) => new Date(value).toISOString();
const notReportable = () =>
  new HttpError(
    404,
    "This answer can't be reported.",
    undefined,
    "report-unavailable",
  );

/** Both flags, for the widget's policy answer, from the workspace flags the
 * widget settings hold. The room still checks its own on every read and
 * report. */
export const answerReportsOffered = (env: WorkspaceFlagEnv) =>
  featureOn(env, undefined, "aiAnswerReports") &&
  featureOn(env, undefined, "quality");

/** Both flags, from the room's stored flags in this transaction. */
export async function answerReportsOn(
  storage: Pick<Storage, "get">,
  context: Pick<ConversationContext, "mediaEnv">,
): Promise<boolean> {
  return (
    (await featureOn(context.mediaEnv, storage, "aiAnswerReports")) &&
    (await featureOn(context.mediaEnv, storage, "quality"))
  );
}

const threadCases = (storage: Storage, record: TeamConversationRecord) =>
  readThreadCases(storage, record.id as `tc-${string}`, { limit: 100 });

/** The case an AI answer in this thread belongs to: the newest case opened
 * before it. Null when the message is gone or deleted, no current or
 * retained AI agent of this workspace wrote it, or no case holds it
 * (Templ's check included). */
async function answerCase(
  storage: Storage,
  context: Pick<ConversationContext, "bots">,
  record: TeamConversationRecord,
  cases: readonly CaseRead[],
  message: number,
): Promise<CaseRead | null> {
  const row = await readMessage(storage, record.id, message);
  if (!row || "deletedAt" in row) return null;
  const author = row.author as ChatPrincipalId;
  if (
    author !== (await managedPrincipal(record.room)) &&
    !(context.bots ?? []).includes(author)
  )
    return null;
  const createdAt = Date.parse(row.createdAt);
  const read = cases.find((entry) => entry.case.openedAt <= createdAt);
  return read && !read.case.excluded.includes("canary") ? read : null;
}

/** For the widget's reports read: "available" or "reported" for each AI
 * answer among `ids` that the member may report, earlier answers included.
 * Nothing while either flag is off, the workspace is paused, the member
 * can't write or the thread holds encrypted cases. */
export async function memberAnswerReports(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  gate: Gate,
  ids: readonly string[],
): Promise<{ reports?: Record<string, "available" | "reported"> }> {
  if (
    !gate.available ||
    gate.writable !== true ||
    context.viewer.banned ||
    context.viewer.mutedUntil ||
    record.encryptedCases ||
    !(await answerReportsOn(storage, context))
  )
    return {};
  const reports: Record<string, "available" | "reported"> = {};
  const wanted = [...new Set(ids)]
    .filter((id) => MESSAGE_ID.test(id))
    .slice(0, READ_MESSAGES);
  const cases = wanted.length ? await threadCases(storage, record) : [];
  for (const id of wanted) {
    const read = await answerCase(storage, context, record, cases, Number(id));
    if (!read) continue;
    const held = storedAnswerReports(
      await readQuality(storage, read.thread, read.seq),
    );
    if (held.some((report) => report.message === Number(id)))
      reports[id] = "reported";
    else if (held.length < ANSWER_REPORT_LIMITS.perCase)
      reports[id] = "available";
  }
  return { reports };
}

/** The optional reason: trimmed plain text of at most `reasonChars`,
 * screened like the member's messages before it is stored. Null when empty. */
async function reportReason(value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null;
  const reason = typeof value === "string" ? value.trim() : null;
  if (
    reason === null ||
    reason.length > ANSWER_REPORT_LIMITS.reasonChars ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(reason)
  )
    throw new HttpError(
      400,
      `Use up to ${ANSWER_REPORT_LIMITS.reasonChars} characters of plain text.`,
      undefined,
      "report-reason",
    );
  if (!reason) return null;
  await refusePhrase(reason, "sent");
  return reason;
}

/** `POST <tc>/workflow {action: "report-answer", message, reason?}` from
 * the thread's member. */
export async function reportAnswer(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  gate: Gate,
): Promise<Response> {
  if (!(await answerReportsOn(storage, context)))
    throw new HttpError(404, "Support action not found.");
  if (role !== "member")
    throw new HttpError(
      403,
      "Only the user can report an answer.",
      undefined,
      "member-only",
    );
  if (!gate.available)
    throw new HttpError(503, "Support tools are being tested.");
  if (context.viewer.banned || context.viewer.mutedUntil)
    throw new HttpError(403, "You cannot change this case right now.");
  if (gate.writable !== true)
    throw new HttpError(403, SUPPORT_REFUSAL, undefined, "support-paused");
  const message = Number(context.body.message);
  if (
    !Number.isSafeInteger(message) ||
    !MESSAGE_ID.test(String(context.body.message))
  )
    throw new HttpError(
      400,
      "Choose an answer to report.",
      undefined,
      "invalid-message",
    );
  const reason = await reportReason(context.body.reason);
  if (record.encryptedCases) throw notReportable();
  const read = await answerCase(
    storage,
    context,
    record,
    await threadCases(storage, record),
    message,
  );
  if (!read) throw notReportable();
  if (
    storedAnswerReports(await readQuality(storage, read.thread, read.seq)).some(
      (report) => report.message === message,
    )
  )
    return json({ reported: true });
  const q = await writableQuality(storage, read.thread, read.seq, context.now);
  const reports = storedAnswerReports(q);
  if (reports.length >= ANSWER_REPORT_LIMITS.perCase)
    throw new HttpError(
      409,
      "This case has too many reported answers.",
      undefined,
      "report-limit",
    );
  const report: StoredAnswerReport = {
    message,
    at: context.now,
    reason,
    reviewedAt: null,
    reviewedBy: null,
  };
  q.memberReports = [...reports, report];
  await writeQuality(storage, q);
  await storage.put(answerReportKey(read.thread, read.seq, report), true);
  return json({ reported: true });
}

const reportItem = (
  thread: string,
  seq: number,
  report: StoredAnswerReport,
): SupportAnswerReportItem => ({
  thread,
  seq,
  message: report.message,
  reportedAt: iso(report.at),
  reason: report.reason,
  reviewedAt: report.reviewedAt === null ? null : iso(report.reviewedAt),
});

/** A list row's report while it still holds: the thread is in this
 * workspace and not being deleted, and the report has the row's state and
 * time. Reviewed rows leave after `reviewedDays`. */
async function listedReport(
  storage: Storage,
  context: Pick<ConversationContext, "room" | "now">,
  match: RegExpExecArray | null,
): Promise<SupportAnswerReportItem | null> {
  if (!match) return null;
  const [, state, at, thread, seqText, messageText] = match;
  const record = await readConversation(storage, thread);
  if (record?.room !== context.room) return null;
  const seq = Number(seqText);
  const time = Number(at);
  const report = storedAnswerReports(
    await readQuality(storage, thread, seq),
  ).find((entry) => entry.message === Number(messageText));
  if (
    !report ||
    (state === "open"
      ? report.reviewedAt !== null || report.at !== time
      : report.reviewedAt !== time ||
        time < context.now - ANSWER_REPORT_LIMITS.reviewedDays * DAY)
  )
    return null;
  return reportItem(thread, seq, report);
}

/** One page of the list, newest first. Each row is checked again against
 * its thread and record, and a row that no longer holds leaves the index.
 * The cursor moves past every row read, so older reports stay reachable
 * however many rows a page drops. */
export async function answerReportPage(
  storage: Storage,
  context: Pick<ConversationContext, "room" | "now">,
  view: "open" | "done",
  after: string | null,
): Promise<{ items: SupportAnswerReportItem[]; next: string | null }> {
  const prefix = `${ANSWER_REPORT_PREFIX}${view}:`;
  const rows = await storage.list({
    prefix,
    reverse: true,
    limit: ANSWER_REPORT_LIMITS.scan,
    ...(after?.startsWith(prefix) && LIST_KEY.test(after)
      ? { end: after }
      : {}),
  });
  const items: SupportAnswerReportItem[] = [];
  const stale: string[] = [];
  let next: string | null = null;
  let last: string | null = null;
  for (const key of rows.keys()) {
    last = key;
    const item = await listedReport(storage, context, LIST_KEY.exec(key));
    if (!item) {
      stale.push(key);
      continue;
    }
    items.push(item);
    if (items.length >= ANSWER_REPORT_LIMITS.page) {
      next = key;
      break;
    }
  }
  if (next === null && rows.size >= ANSWER_REPORT_LIMITS.scan) next = last;
  for (const key of stale.slice(0, 50)) await storage.delete(key);
  return { items, next };
}

/** `POST answer-reports {action: "reviewed", thread, seq, message}`: the
 * report moves to the reviewed list with who reviewed it and when.
 * Repeating it changes nothing. */
export async function reviewAnswerReport(
  storage: Storage,
  context: Pick<ConversationContext, "now">,
  viewer: QualityViewer,
  record: TeamConversationRecord,
  body: Record<string, unknown>,
): Promise<SupportAnswerReportItem> {
  if (body.action !== "reviewed")
    throw new HttpError(400, "Choose Mark reviewed.", undefined, "report-action");
  const seq = Number(body.seq);
  const message = Number(body.message);
  if (
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !Number.isSafeInteger(message) ||
    message < 1
  )
    throw new HttpError(
      400,
      "Choose a reported answer.",
      undefined,
      "invalid-report",
    );
  const q = await readQuality(storage, record.id, seq);
  const reports = storedAnswerReports(q);
  const report = reports.find((entry) => entry.message === message);
  if (!q || !report)
    throw new HttpError(404, "Report not found.", undefined, "report-not-found");
  if (report.reviewedAt === null) {
    await storage.delete(answerReportKey(record.id, seq, report));
    report.reviewedAt = context.now;
    report.reviewedBy = viewer.principal;
    q.memberReports = reports;
    await writeQuality(storage, q);
    await storage.put(answerReportKey(record.id, seq, report), true);
  }
  return reportItem(record.id, seq, report);
}
