import { featureOn, supportKnowledgeOn } from "./workspace-flags";
import type { KnowledgeEnv } from "./support-knowledge-client";
import {
  SUPPORT_IDENTITY_LABELS,
  identityOf,
} from "@templ/chat/support-identity";
/** The case routes: a thread's cases with their frame, evidence and drafts,
 * the agents' Ask AI list, and the workflow actions that write them.
 *
 * Who may do what, checked on every request against current authority:
 * - A person on the team (the manager or a current `handleConversations`
 *   grant) reads cases, writes frames and evidence, asks the AI, cancels
 *   and dismisses. Withdrawing another writer's row needs the manager or a
 *   support lead.
 * - The workspace's registered AI agent reads cases, writes frames and
 *   evidence, lists and answers Ask AI requests. With the AI off for a
 *   request, it can't see the thread at all.
 * - Members, widget sessions, billing-only staff, revoked staff and
 *   outsiders get the same 404 as for a thread they can't read.
 *
 * Nothing here posts a message, counts usage, reaches the member or grants
 * access. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  SUPPORT_DRAFT_LIMITS,
  type SupportCaseDetail,
  type SupportCaseList,
  type SupportCaseView,
} from "@templ/chat/support-drafts";
import type { SupportCase } from "@templ/chat/support";
import { HttpError, json } from "./common";
import {
  DIAGNOSIS_NETWORKS_HEADER,
  enabledFromHeader,
} from "./support-diagnosis";
import { staffRefusal } from "./product-entitlements";
import { parseIfLatest, assertLatest } from "./support-handoff";
import { applyCaseEvent, readCaseRef } from "./support-cases";
import { readThreadCases, type CaseThreadId } from "./support-case-data";
import {
  cancelAiDraft,
  caseDraftCount,
  declineAiDraft,
  dismissAiDraft,
  draftRequestPage,
  problemKinds,
  readCaseDrafts,
  readCaseRequests,
  requestAiDraft,
  requestView,
  writeAiDraft,
} from "./support-drafts";
import {
  addCaseEvidence,
  caseEvidenceSummary,
  readCaseEvidence,
  readCaseFrame,
  saveCaseFrame,
  withdrawCaseEvidence,
} from "./support-evidence-store";
import {
  agentState,
  readAiState,
  recordSupportActivity,
  supportRecord,
  supportSettings,
  type SupportRecord,
} from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
/** The conversation module's one access predicate, bound to this request. */
export type CaseRouteDeps = {
  authorize(id: string): Promise<{
    record: TeamConversationRecord;
    role: "member" | "team";
  }>;
  /** Whether this viewer may read the thread now (the same predicate). */
  canRead(id: string): Promise<boolean>;
  /** Team authority now: the manager or a current handling grant. */
  team: boolean;
};

const DRAFT_REQUESTS = /^\/conversations\/draft-requests$/;
const CASES = /^\/conversations\/(tc-[0-9a-f]{32})\/cases$/;
const PENDING_CURSOR =
  /^support-draft-pending-v1:[0-9]{16}:tc-[0-9a-f]{32}:[0-9a-f-]{36}$/;
/** Workflow actions this module owns. */
export const CASE_WORKFLOW_ACTIONS = [
  "frame",
  "evidence",
  "withdraw-evidence",
  "draft-request",
  "draft-cancel",
  "draft-decline",
  "draft",
  "draft-dismiss",
] as const;
const toolsNotFound = () => new HttpError(404, "Support tools not found.");
const iso = (at: number) => new Date(at).toISOString();

function caseView(
  c: SupportCase,
  extra: { evidence: number; drafts: number; framed: boolean },
): SupportCaseView {
  return {
    ...(c.entry ? { entry: c.entry } : {}),
    identity: identityOf({ level: c.access }),
    identityLabel: SUPPORT_IDENTITY_LABELS[identityOf({ level: c.access })],
    seq: c.seq,
    openedAt: iso(c.openedAt),
    state: c.resolvedAt === null ? "open" : "resolved",
    resolvedAt: c.resolvedAt === null ? null : iso(c.resolvedAt),
    resolvedBy: c.resolvedBy,
    handoff:
      c.handoffAt === null
        ? null
        : {
            at: iso(c.handoffAt),
            reason: c.handoffReason,
            by: c.handoffBy,
            open: c.handoffOpen,
          },
    confirmation: c.confirmation,
    counts: {
      memberMessages: c.counts.memberMessages,
      humanReplies: c.counts.humanReplies,
      botReplies: c.counts.botReplies,
      notes: c.counts.notes,
    },
    ...extra,
  };
}
async function caseExtras(storage: Storage, thread: string, seq: number) {
  const summary = await caseEvidenceSummary(storage, thread, seq);
  return {
    ...summary,
    drafts: await caseDraftCount(storage, thread, seq),
  };
}

/** Feature routes the conversation module calls before its own routes:
 * `GET /conversations/draft-requests` and `GET /conversations/<tc>/cases`.
 * Null for any other path. */
export async function caseFeatureRoute(
  storage: Storage,
  context: ConversationContext,
  deps: CaseRouteDeps,
): Promise<Response | null> {
  if (context.method !== "GET") return null;
  if (DRAFT_REQUESTS.test(context.pathname)) {
    if (!featureOn(context.mediaEnv, undefined, "aiDrafts"))
      throw toolsNotFound();
    if (!context.viewer.principalId || !deps.team) throw toolsNotFound();
    const after = context.query.get("after");
    if (after !== null && !PENDING_CURSOR.test(after))
      throw new HttpError(400, "Invalid cursor.");
    const limit = Number(
      context.query.get("limit") ?? SUPPORT_DRAFT_LIMITS.listPage,
    );
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SUPPORT_DRAFT_LIMITS.listPage
    )
      throw new HttpError(400, "Choose a limit from 1 to 50.");
    return json(
      await draftRequestPage(storage, {
        after,
        limit,
        now: context.now,
        visible: (thread) => deps.canRead(thread),
      }),
    );
  }
  const match = CASES.exec(context.pathname);
  if (!match) return null;
  const { record, role } = await deps.authorize(match[1]);
  // Members read their own thread, never its case data.
  if (role !== "team") throw toolsNotFound();
  const data = await supportRecord(storage, record);
  const seqParam = context.query.get("seq");
  if (seqParam !== null) {
    const c = await readCaseRef(storage, record, data, Number(seqParam));
    const evidence = await readCaseEvidence(
      storage,
      record.id,
      c.seq,
      context.isBot ? "agent" : "team",
    );
    const drafts = await readCaseDrafts(
      storage,
      record.id,
      c.seq,
      [record.member, ...(record.formerMembers ?? [])],
      () => supportSettings(storage),
      context.isBot ? "agent" : "team",
    );
    const detail: SupportCaseDetail = {
      case: caseView(c, await caseExtras(storage, record.id, c.seq)),
      frame: await readCaseFrame(storage, record.id, c.seq),
      evidence: evidence.rows,
      drafts: drafts.drafts,
      requests: await readCaseRequests(storage, record.id, c.seq, context.now),
      unreadable: evidence.unreadable + drafts.unreadable,
    };
    return json(detail);
  }
  const beforeParam = context.query.get("before");
  const before = beforeParam === null ? undefined : Number(beforeParam);
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1))
    throw new HttpError(400, "Invalid cursor.");
  if (data.ledgerVersion !== 1)
    // Reading builds nothing: a thread the ledger hasn't reached lists none.
    return json({ cases: [], nextBefore: null } satisfies SupportCaseList);
  const page = await readThreadCases(storage, record.id as CaseThreadId, {
    limit: SUPPORT_DRAFT_LIMITS.casesPerPage + 1,
    before,
  });
  const shown = page.slice(0, SUPPORT_DRAFT_LIMITS.casesPerPage);
  const cases: SupportCaseView[] = [];
  for (const entry of shown)
    cases.push(
      caseView(entry.case, await caseExtras(storage, record.id, entry.seq)),
    );
  return json({
    cases,
    nextBefore:
      page.length > SUPPORT_DRAFT_LIMITS.casesPerPage
        ? shown[shown.length - 1].seq
        : null,
  } satisfies SupportCaseList);
}

/** The workflow actions of this module on `POST /conversations/<tc>/workflow`.
 * Null for any other action, so the workflow route goes on. */
export async function caseWorkflowAction(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  gate: { available: boolean; writable: boolean },
): Promise<Response | null> {
  if (context.method !== "POST") return null;
  const action = context.body.action;
  if (!(CASE_WORKFLOW_ACTIONS as readonly unknown[]).includes(action))
    return null;
  if (role !== "team") throw toolsNotFound();
  if (
    typeof action === "string" &&
    action.startsWith("draft") &&
    !featureOn(context.mediaEnv, undefined, "aiDrafts")
  )
    throw toolsNotFound();
  if (!gate.available)
    throw new HttpError(503, "Support tools are being tested.");
  if (context.viewer.banned || context.viewer.mutedUntil)
    throw new HttpError(403, "You cannot change this case right now.");
  if (!gate.writable) throw staffRefusal();
  const actor = context.viewer.principalId as ChatPrincipalId;
  const isBot = Boolean(context.isBot);
  const writer = {
    by: isBot ? ("agent" as const) : ("person" as const),
    author: actor,
  };
  const canManage =
    context.viewer.isManager ||
    context.viewer.permissions.includes("manageSupport");
  const { data, effective } = await readAiState(storage, record);
  const log = (
    action:
      | "frame"
      | "evidence"
      | "evidence-withdrawn"
      | "draft-request"
      | "draft-dismissed",
    detail?: string,
  ) =>
    recordSupportActivity(storage, record.id, data, {
      actor,
      action,
      at: context.now,
      detail,
    });
  const base = {
    thread: record.id,
    record,
    data,
    actor,
    isBot,
    now: context.now,
  };
  switch (action as (typeof CASE_WORKFLOW_ACTIONS)[number]) {
    case "frame": {
      const c = await readCaseRef(storage, record, data, context.body.case);
      const saved = await saveCaseFrame(storage, {
        thread: record.id,
        seq: c.seq,
        body: { set: context.body.set, clear: context.body.clear },
        ifRevision: context.body.ifRevision,
        writer,
        now: context.now,
      });
      await log("frame", saved.fields.join(",").slice(0, 200));
      return json({ frame: saved.frame });
    }
    case "evidence": {
      const c = await readCaseRef(storage, record, data, context.body.case);
      const added = await addCaseEvidence(storage, {
        thread: record.id,
        seq: c.seq,
        rows: context.body.rows,
        clientId: context.body.clientId,
        writer,
        attachments: (data as SupportRecord).attachments.map((item) => item.id),
        now: context.now,
      });
      if (added.created) await log("evidence", String(added.rows.length));
      const visible = isBot
        ? (
            await readCaseEvidence(storage, record.id, c.seq, "agent")
          ).rows.filter((row) =>
            added.rows.some((addedRow) => addedRow.n === row.n),
          )
        : added.rows;
      return json({ evidence: visible }, added.created ? 201 : 200);
    }
    case "withdraw-evidence": {
      const c = await readCaseRef(storage, record, data, context.body.case);
      if (
        isBot &&
        !(await readCaseEvidence(storage, record.id, c.seq, "agent")).rows.some(
          (row) => row.n === context.body.n,
        )
      )
        throw toolsNotFound();
      const row = await withdrawCaseEvidence(storage, {
        thread: record.id,
        seq: c.seq,
        n: context.body.n,
        actor,
        any: !isBot && canManage,
        now: context.now,
      });
      await log("evidence-withdrawn", row.id);
      return json({ evidence: row });
    }
    case "draft-request": {
      const c = await readCaseRef(storage, record, data, data.caseSeq ?? 0);
      const asked = await requestAiDraft(storage, {
        ...base,
        body: context.body,
        caseSeq: c.seq,
        agentRegistered: (await agentState(context)).registered,
        mode: effective.mode,
      });
      if (asked.created) {
        await applyCaseEvent(
          storage,
          record,
          data,
          {
            kind: "ai-draft-request",
            seq: c.seq,
            at: context.now,
            mode: effective.mode,
          },
          context.mediaEnv,
        );
        await log("draft-request");
      }
      return json({ request: requestView(asked.request, context.now, true) });
    }
    case "draft-cancel": {
      const request = await cancelAiDraft(storage, {
        ...base,
        body: context.body,
        canManage,
      });
      await storage.put(`support-workflow-v1:${record.id}`, data);
      return json({ request: requestView(request, context.now, true) });
    }
    case "draft-decline": {
      const request = await declineAiDraft(storage, {
        ...base,
        body: context.body,
      });
      await storage.put(`support-workflow-v1:${record.id}`, data);
      return json({ request: requestView(request, context.now, true) });
    }
    case "draft": {
      const seq = data.caseSeq ?? 0;
      const c = await readCaseRef(storage, record, data, seq);
      const written = await writeAiDraft(storage, {
        ...base,
        body: context.body,
        caseSeq: c.seq,
        mode: effective.mode,
        knowledge: supportKnowledgeOn(context.mediaEnv)
          ? { env: context.mediaEnv as unknown as KnowledgeEnv, room: context.room, actor }
          : undefined,
        diagnosisNetworks: enabledFromHeader(
          context.headers.get(DIAGNOSIS_NETWORKS_HEADER),
        ),
        assertLatest: async (value) => {
          const ifLatest = parseIfLatest(value);
          if (!ifLatest)
            throw new HttpError(
              400,
              "Send the user message the draft answers.",
            );
          await assertLatest(storage, record.id, ifLatest);
          return ifLatest;
        },
      });
      if (written.created) {
        await applyCaseEvent(
          storage,
          record,
          data,
          {
            kind: "ai-draft",
            actor,
            seq: c.seq,
            at: context.now,
            mode: effective.mode,
          },
          context.mediaEnv,
        );
      }
      const drafts = await readCaseDrafts(
        storage,
        record.id,
        c.seq,
        [record.member, ...(record.formerMembers ?? [])],
        () => supportSettings(storage),
        isBot ? "agent" : "team",
        { actor, writtenDraft: written.draft },
      );
      const view = drafts.drafts.find((entry) => entry.id === written.draft.id);
      return json({ draft: view ?? null }, written.created ? 201 : 200);
    }
    case "draft-dismiss": {
      const seq = data.caseSeq ?? 0;
      const c = await readCaseRef(storage, record, data, seq);
      const draft = await dismissAiDraft(storage, {
        ...base,
        body: context.body,
        caseSeq: c.seq,
      });
      await log(
        "draft-dismissed",
        draft.kind === "held-reply" ? problemKinds(draft.problems) : undefined,
      );
      const drafts = await readCaseDrafts(
        storage,
        record.id,
        c.seq,
        [record.member, ...(record.formerMembers ?? [])],
        () => supportSettings(storage),
        isBot ? "agent" : "team",
      );
      return json({
        draft: drafts.drafts.find((entry) => entry.id === draft.id) ?? null,
      });
    }
  }
}
