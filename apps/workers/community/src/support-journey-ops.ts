import { SUPPORT_APP_ACTIONS } from "@templ/chat/support-app-context";
import { effectivePermissions } from "@templ/chat/moderation-permissions";
import { SUPPORT_LIMITS, type SupportCase } from "@templ/chat/support";
import { HttpError, json } from "./common";
import { readCaseRef } from "./support-cases";
import { supportRecord } from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
const caseKey = (c: SupportCase) =>
  `support-case-v1:${c.thread}:${String(c.seq).padStart(8, "0")}`;

/** Counts real human compose intervals. Heartbeats extend an interval only to their expiry. */
export async function recordComposeTime(
  storage: Storage,
  record: TeamConversationRecord,
  context: ConversationContext,
  composing: boolean,
) {
  if (context.isBot || !context.viewer.principalId) return;
  const data = await supportRecord(storage, record);
  if (!data.caseSeq) return;
  const c = await readCaseRef(storage, record, data, data.caseSeq);
  if (c.resolvedAt !== null || c.abandonedAt != null) return;
  const key = `support-compose-v1:${record.id}:${context.viewer.principalId}`;
  const prior = await storage.get<{
    seq: number;
    start: number;
    through: number;
    counted: number;
  }>(key);
  const current =
    prior?.seq === c.seq && prior.through >= context.now ? prior : null;
  c.metrics ??= {};
  // Only elapsed time between observed heartbeats or a stop is measured.
  if (prior?.seq === c.seq) {
    const through = Math.min(
      context.now,
      prior.through,
      prior.start + SUPPORT_LIMITS.composeIntervalMaxMinutes * 60_000,
    );
    c.metrics.handlingMs =
      (c.metrics.handlingMs ?? 0) + Math.max(0, through - prior.counted);
  }
  if (composing)
    await storage.put(key, {
      seq: c.seq,
      start: current?.start ?? context.now,
      counted: context.now,
      through: context.now + 45_000,
    });
  else await storage.delete(key);
  await storage.put(caseKey(c), c);
}

export async function journeyOpsRoute(
  storage: Storage,
  context: ConversationContext,
  authorize: (
    id: string,
  ) => Promise<{ record: TeamConversationRecord; role: "member" | "team" }>,
): Promise<Response | null> {
  const match = /^\/conversations\/(tc-[0-9a-f]{32})\/(archive|outcome)$/.exec(
    context.pathname,
  );
  if (!match) return null;
  const { record, role } = await authorize(match[1]);
  if (context.method !== "POST")
    throw new HttpError(405, "This action needs a POST request.");
  const data = await supportRecord(storage, record);
  if (match[2] === "archive") {
    if (
      role !== "team" ||
      context.isBot ||
      (!context.viewer.isManager &&
        !effectivePermissions(context.viewer.permissions).includes(
          "manageSupport",
        ))
    )
      throw new HttpError(403, "Only a support lead can archive a case.");
    if (!["resolved", "abandoned", "spam"].includes(data.state))
      throw new HttpError(409, "Resolve the case before archiving it.");
    if (record.archivedAt === undefined) {
      record.archivedAt = context.now;
      record.revision++;
      await storage.put(`conversation-v1:${record.id}`, record);
      context.pendingAudit.push({
        actor: context.viewer.principalId!,
        action: "support.case.archived",
        channelId: record.id,
      });
      context.pending.push({
        type: "conversation.updated",
        channelId: record.id,
        conversationRevision: record.revision,
      });
    }
    return json({
      ok: true,
      archivedAt: new Date(record.archivedAt).toISOString(),
    });
  }
  if (role !== "member" || context.headers.get("X-Support-Widget") !== "member")
    throw new HttpError(404, "Not found.");
  if (!data.caseSeq) throw new HttpError(409, "Send your question first.");
  const c = await readCaseRef(storage, record, data, data.caseSeq);
  c.metrics ??= {};
  if (
    typeof context.body.consent === "boolean" &&
    context.body.action === undefined
  ) {
    c.metrics.outcomeConsent = context.body.consent;
    if (!context.body.consent) delete c.metrics.actionCompleted;
    await storage.put(caseKey(c), c);
    return json({ ok: true, case: c.seq });
  }
  if (context.body.case !== c.seq)
    throw new HttpError(409, "This result belongs to another case.");
  if (c.metrics.outcomeConsent !== true)
    throw new HttpError(403, "Choose whether to share the result first.");
  if (
    !(SUPPORT_APP_ACTIONS as readonly unknown[]).includes(
      context.body.action,
    ) ||
    !["completed", "failed"].includes(String(context.body.status))
  )
    throw new HttpError(400, "Choose an action and its result.");
  c.metrics.actionCompleted = context.body.status === "completed";
  await storage.put(caseKey(c), c);
  return json({ ok: true });
}
