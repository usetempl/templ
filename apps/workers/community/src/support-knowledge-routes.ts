import { PRODUCT_STATE_KEY, readProductState, standardPlanForState } from "./product-entitlements";
import { STANDARD_PLAN_KEY } from "./product-standard-plan";
import { workspaceClosing } from "./workspace-deletion";
import { managedKnowledgeCall } from "./managed-agent/knowledge-client";
import { hasStorageAgreement, acceptStorageAgreement, storageBillingView, storageLedgerPage, storageReadGrant, withdrawStorageAgreement, type StorageBillingEnv } from "./brain-storage-billing";
import { featureOn, supportKnowledgeOn } from "./workspace-flags";
import { learnedCorrectionAvailable, learnedReplyCorrection } from "./support-learning-correction";
/** The knowledge and answer-quality routes, called at the top of the room's
 * conversation routes. Every route checks the
 * viewer's current team authority on each call; members, billing-only
 * holders, revoked staff, outsiders and widget sessions get the same 404.
 * A few checks run before an existing route and then hand it on (they
 * return null): the required category before a resolve, when a category
 * was set, and the transaction rule before a member's context share or an
 * AI agent's reply.
 *
 * Routes (all under /conversations):
 * - `<tc>/review` GET labels and reviews; POST label, sample, take,
 *   assign-review, score, skip.
 * - `<tc>/evals` POST preview, save, delete-copies.
 * - `<tc>/legacy` GET the request's profile matches and legacy facts; POST
 *   a staff address check.
 * - `quality` GET overview (runs sampling), POST settings or the pilot
 *   sampling preset; `reviews`, `trends`, `gaps`, `pilot-preset`.
 * - `answer-reports` GET the answers users reported, POST reviewed: the
 *   owner and Admins only (support-answer-reports.ts).
 * - `evals…` (support-evals.ts), `profile…` (profile-routes.ts),
 *   `knowledge…` (below). */
import {
  PILOT_QUALITY_PRESET,
  TREND_WINDOWS,
  type TrendWindow,
} from "@templ/chat/support-quality";
import {
  KNOWLEDGE_ERAS,
  profileAddress,
  profileNetwork,
  type KnowledgeEraTag,
} from "@templ/chat/protocol-profile";
import { HttpError, errorBody, json } from "./common";
import { aiDraftsOnlyError } from "./support-ai-mode";
import { legacyFactsFor, caseProfileRefs } from "./legacy-facts";
import { requirePrivilegedHeaders, requireWorkspaceAdminHeaders } from "./privileged-auth";
import { PROFILE_ROUTE, profileRoute } from "./profile-routes";
import { refusePhrase } from "./secret-guard";
import {
  EVALS_ROUTE,
  evalsRoute,
  threadEvalAction,
  unlinkDeletedThreads,
} from "./support-evals";
import {
  knowledgeActor,
  knowledgeCall,
  type KnowledgeEnv,
} from "./support-knowledge-client";
import {
  applyTransactionRule,
  liftIfDue,
  pilotPresetRoute,
} from "./support-pilot-preset";
import {
  QUALITY_SETTINGS_KEY,
  checkedSettingsBody,
  gapAction,
  knowledgeGaps,
  labelReply,
  leadOnly,
  monthOf,
  noteCategorySet,
  peopleOnly,
  pruneQualityCounters,
  qualityOverview,
  qualitySettings,
  qualityViewer,
  qualityViews,
  reconcileSampling,
  requireCategoryBeforeResolve,
  reviewAction,
  reviewQueuePage,
  supportTrends,
  toolsNotFound,
  type QualityViewer,
} from "./support-quality";
import { supportRecord, writeSupportContext } from "./support-workflow";
import {
  answerReportPage,
  answerReportsOn,
  reviewAnswerReport,
} from "./support-answer-reports";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

type Storage = DurableObjectTransaction;
type Authorized = {
  record: TeamConversationRecord;
  role: "member" | "team";
};
export type KnowledgeQualityDeps = {
  authorize: (id: string) => Promise<Authorized>;
};
const THREAD_ROUTE = /^\/conversations\/(tc-[0-9a-f]{32})\/(review|evals|legacy)$/;
const ROOM_ROUTE =
  /^\/conversations\/(quality|reviews|trends|gaps|pilot-preset|answer-reports)$/;
export const KNOWLEDGE_ROUTE =
  /^\/conversations\/knowledge(?:\/(search|context|guidance|practice|storage|storage-ledger|kb-[0-9a-f]{16}))?$/;
const PRE_ROUTE = /^\/conversations\/(tc-[0-9a-f]{32})\/(resolve|workflow|messages)$/;
const ASK_ROUTE = "/conversations/ask";

const envOf = (context: ConversationContext) => context.mediaEnv as unknown as KnowledgeEnv;

/** Checks that run before an existing route, which then answers. */
async function beforeExistingRoute(
  storage: Storage,
  context: ConversationContext,
  deps: KnowledgeQualityDeps,
  match: RegExpExecArray,
): Promise<Response | null> {
  if (context.method !== "POST") return null;
  const [, id, sub] = match;
  const body = context.body;
  // Only the requests these checks are about read anything more.
  const relevant =
    sub === "messages"
      ? Boolean(context.isBot)
      : sub === "resolve"
        ? body.resolved === true
        : body.action === "context" ||
          body.action === "tags" ||
          (body.action === "status" && body.status === "resolved");
  if (!relevant) return null;
  let authorized: Authorized;
  try {
    authorized = await deps.authorize(id);
  } catch {
    return null; // The route itself answers 404.
  }
  const { record, role } = authorized;
  if (sub === "messages") {
    // The drafts-only week lifts before an AI agent's reply once it is over.
    if (context.isBot && role === "team") await liftIfDue(storage, context.now, context);
    // An AI agent's reply on a request where the member shared a
    // transaction: the rule moves it to drafts first, and the refusal is
    // answered here so the move commits.
    if (
      context.isBot &&
      role === "team" &&
      (await applyTransactionRule(storage, context, record, false))
    )
      return json(errorBody(aiDraftsOnlyError(), ""), 409);
    return null;
  }
  if (role === "member") {
    if (sub === "workflow" && body.action === "context" && body.consent === true) {
      let transactions = 0;
      try {
        const data = await supportRecord(storage, record);
        transactions = (await writeSupportContext(data.context, body.context, context.headers, await featureOn(context.mediaEnv, storage, "supportDiagnostics"))).transactions?.length ?? 0;
      } catch {
        return null; // The route refuses the context itself.
      }
      if (transactions > 0) await applyTransactionRule(storage, context, record, true);
    }
    return null;
  }
  const resolving =
    (sub === "resolve" && body.resolved === true) ||
    (sub === "workflow" && body.action === "status" && body.status === "resolved");
  if (resolving) await requireCategoryBeforeResolve(storage, context, record, body.category);
  else if (sub === "workflow" && body.action === "tags")
    await noteCategorySet(storage, record, body.category, context.now);
  return null;
}

export async function knowledgeQualityRoute(
  storage: Storage,
  context: ConversationContext,
  deps: KnowledgeQualityDeps,
): Promise<Response | null> {
  const path = context.pathname;
  // A new request: the pilot preset's drafts-only week lifts first when it
  // is over (one read otherwise), then the route answers.
  if (path === ASK_ROUTE) {
    if (context.method === "POST") await liftIfDue(storage, context.now, context);
    return null;
  }
  const pre = PRE_ROUTE.exec(path);
  if (pre) return beforeExistingRoute(storage, context, deps, pre);
  const thread = THREAD_ROUTE.exec(path);
  const room = ROOM_ROUTE.exec(path);
  const evals = EVALS_ROUTE.exec(path);
  const profile = PROFILE_ROUTE.exec(path);
  const knowledge = KNOWLEDGE_ROUTE.exec(path);
  if (!thread && !room && !evals && !profile && !knowledge) return null;
  if (context.method !== "GET" && context.method !== "POST") throw toolsNotFound();
  const viewer = qualityViewer(context);
  if (!viewer) throw toolsNotFound();
  const env = envOf(context);
  const retainedStorageControl = knowledge && viewer.manager && !viewer.bot &&
    ((knowledge[1] === "storage" && (context.method === "GET" || context.body.action === "withdraw-agreement")) ||
      (knowledge[1] === "storage-ledger" && context.method === "GET")) &&
    await hasStorageAgreement(storage);
  if (
    !retainedStorageControl && !(knowledge
      ? supportKnowledgeOn(context.mediaEnv)
      : featureOn(context.mediaEnv, undefined, profile ? "protocolProfile" : "quality"))
  )
    throw toolsNotFound();
  if (thread) {
    const [, id, sub] = thread;
    const { record, role } = await deps.authorize(id);
    if (role !== "team") throw toolsNotFound();
    if (sub === "review") return reviewRoute(storage, env, context, viewer, record);
    if (sub === "evals") {
      if (context.method !== "POST") throw toolsNotFound();
      return threadEvalAction(storage, env, context, viewer, record);
    }
    return legacyRoute(storage, env, context, viewer, record);
  }
  if (evals) {
    const response = await evalsRoute(storage, env, context, viewer, evals);
    if (!evals[1] && viewer.lead)
      await unlinkDeletedThreads(storage, env, context, viewer).catch(() => 0);
    return response;
  }
  if (profile) return profileRoute(env, context, viewer, profile);
  if (knowledge) return knowledgeRoute(storage, env, context, viewer, knowledge);
  switch (room![1]) {
    case "quality":
      return qualityRoute(storage, context, viewer);
    case "reviews": {
      if (context.method !== "GET") throw toolsNotFound();
      if (viewer.bot) throw peopleOnly();
      await reconcileSampling(storage, context);
      const view = context.query.get("view");
      return json(
        await reviewQueuePage(
          storage,
          context,
          viewer,
          view === "mine" || view === "done" ? view : "open",
          context.query.get("after"),
        ),
      );
    }
    case "trends": {
      if (context.method !== "GET") throw toolsNotFound();
      if (!viewer.lead)
        throw new HttpError(
          403,
          "Only the manager or a support lead can read support reporting.",
          undefined,
          "lead-only",
        );
      const window = context.query.get("window") ?? "30d";
      if (!TREND_WINDOWS.includes(window as TrendWindow))
        throw new HttpError(400, "Choose 30, 90 or 180 days.", undefined, "trends-window");
      return json(await supportTrends(storage, window as TrendWindow, context.now));
    }
    case "gaps": {
      if (!viewer.lead) throw leadOnly();
      if (context.method === "GET")
        return json(
          await knowledgeGaps(storage, context.query.get("month") ?? monthOf(context.now), context.now),
        );
      return json(await gapAction(storage, context.body, context.now));
    }
    case "answer-reports": {
      // Support leads, other staff and AI agents learn nothing here.
      if (!viewer.admin || !featureOn(context.mediaEnv, undefined, "aiAnswerReports"))
        throw toolsNotFound();
      if (context.method === "GET")
        return json(
          await answerReportPage(
            storage,
            context,
            context.query.get("view") === "done" ? "done" : "open",
            context.query.get("after"),
          ),
        );
      if (!(await answerReportsOn(storage, context))) throw toolsNotFound();
      const { record, role } = await deps.authorize(String(context.body.thread ?? ""));
      if (role !== "team") throw toolsNotFound();
      return json({
        report: await reviewAnswerReport(storage, context, viewer, record, context.body),
      });
    }
    default:
      return pilotPresetRoute(storage, context, viewer);
  }
}

async function reviewRoute(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  record: TeamConversationRecord,
): Promise<Response> {
  if (context.method === "GET") {
    const raw = context.query.get("seq");
    const seq = raw === null ? null : Number(raw);
    if (seq !== null && (!Number.isSafeInteger(seq) || seq < 1))
      throw new HttpError(400, "Choose a case number.", undefined, "invalid-seq");
    const cases = await qualityViews(storage, record, seq);
    // Eval copies saved from these requests; the object may be unavailable,
    // and the labels still answer.
    const copies = await knowledgeCall<{
      evals: { id: string; state: "candidate" | "golden" | "retired"; seq: number }[];
    }>(
      env,
      context.room,
      "evals.bySource",
      knowledgeActor(viewer),
      { thread: record.id },
    ).catch(() => null);
    return json({
      ...(await learnedCorrectionAvailable(storage, context, viewer) ? { learningReviewAvailable: true } : {}),
      cases: cases.map((c) => ({
        ...c,
        ...(copies
          ? {
              evals: copies.evals
                .filter((copy) => copy.seq === c.seq)
                .map(({ id, state }) => ({ id, state })),
            }
          : {}),
      })),
    });
  }
  const action = context.body.action;
  if (action === "review-learned-sources" || action === "pause-learned-source")
    return json(await learnedReplyCorrection(storage, env, context, viewer, record));
  if (action === "label")
    return json({
      quality: await labelReply(storage, context, viewer, record, {
        message: context.body.message,
        labels: context.body.labels,
      }),
    });
  return json({ quality: await reviewAction(storage, context, viewer, record, context.body) });
}

async function legacyRoute(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  record: TeamConversationRecord,
): Promise<Response> {
  const refs = await caseProfileRefs(storage, record.id);
  if (context.method === "POST") {
    const network = profileNetwork(context.body.network ?? "eip155:1");
    const address = network ? profileAddress(network, context.body.address) : null;
    if (!network || !address)
      throw new HttpError(400, "Enter a contract address.", undefined, "profile-refs");
    refs.push({ ref: { network, address }, trigger: "address-check" });
  }
  return json(await legacyFactsFor(env, context.room, knowledgeActor(viewer), refs));
}

async function qualityRoute(
  storage: Storage,
  context: ConversationContext,
  viewer: QualityViewer,
): Promise<Response> {
  if (context.method === "GET") {
    await liftIfDue(storage, context.now, context);
    await reconcileSampling(storage, context).catch(() => 0);
    await pruneQualityCounters(storage, context.now);
    return json(await qualityOverview(storage, context, viewer));
  }
  if (viewer.bot) throw peopleOnly();
  if (!viewer.admin) throw new HttpError(403, "Only workspace admins can change AI review settings.");
  requireWorkspaceAdminHeaders(context.headers, viewer.manager, context.body.confirmed, context.now);
  const current = await qualitySettings(storage);
  let next;
  if (context.body.preset === "pilot") {
    next = {
      ...current,
      sampling: {
        ...current.sampling,
        randomPercent: PILOT_QUALITY_PRESET.randomPercent,
        rules: [...PILOT_QUALITY_PRESET.rules],
        weeklyCap: PILOT_QUALITY_PRESET.weeklyCap,
      },
      requireCategory: PILOT_QUALITY_PRESET.requireCategory,
    };
  } else {
    const { schemaVersion: _v, ...rest } = context.body as Record<string, unknown>;
    next = await checkedSettingsBody(storage, context, {
      ...current,
      ...rest,
      ...(rest.sampling && typeof rest.sampling === "object" && !Array.isArray(rest.sampling)
        ? { sampling: { ...current.sampling, ...rest.sampling } }
        : {}),
    });
  }
  // Requests that closed under the old sampling get their decision under
  // it first, so turning sampling on never reaches back.
  if (JSON.stringify(next.sampling) !== JSON.stringify(current.sampling))
    await reconcileSampling(storage, context);
  await storage.put(QUALITY_SETTINGS_KEY, next);
  const fields = (["sampling", "requireCategory", "evalAgentAccess"] as const).filter(
    (field) => JSON.stringify(next[field]) !== JSON.stringify(current[field]),
  );
  context.pendingAudit.push({
    actor: viewer.principal,
    action: "support.settings",
    target: "quality",
    after: { fields },
  });
  return json(await qualityOverview(storage, context, viewer));
}

async function knowledgeRoute(
  storage: Storage,
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  match: RegExpExecArray,
): Promise<Response> {
  const [, item] = match;
  const actor = knowledgeActor(viewer);
  const call = (op: string, args: Record<string, unknown> = {}) =>
    knowledgeCall(env, context.room, op, actor, args);
  if (item === "practice") {
    if (!viewer.admin || viewer.bot || !await featureOn(context.mediaEnv, storage, "trialAiPractice") ||
        !await storage.get(PRODUCT_STATE_KEY) || !await storage.get(STANDARD_PLAN_KEY) || await workspaceClosing(storage)) throw toolsNotFound();
    const state = await readProductState(storage, context.now, context.mediaEnv);
    const plan = standardPlanForState(state);
    if (plan?.status !== "demo" || plan.period || !plan.starterAvailable || (state.exemptUntil && state.exemptUntil > context.now)) throw toolsNotFound();
    if (context.method === "GET") return json(await managedKnowledgeCall(env, context.room, "trial.practice"));
    if (context.method !== "POST") throw toolsNotFound();
    const { question, requestId } = context.body;
    if (typeof question !== "string" || !question.trim() || question.length > 800) throw new HttpError(400, "Enter a product question of up to 800 characters.");
    await refusePhrase(question, "sent");
    return json(await managedKnowledgeCall(env, context.room, "trial.practice", { question, requestId }));
  }
  if (item === "storage") {
    if (!viewer.manager || viewer.bot) throw toolsNotFound();
    if (!featureOn(context.mediaEnv, undefined, "brainStorage") &&
        !((context.method === "GET" || context.body.action === "withdraw-agreement") && await hasStorageAgreement(storage)))
      throw toolsNotFound();
    const billingEnv = { ...context.mediaEnv, ...env } as StorageBillingEnv;
    const view = async () => ({ ...await call("knowledge.storage.get"), billing: await storageBillingView(storage, billingEnv, context.now) });
    if (context.method === "GET") return json(await view());
    requirePrivilegedHeaders(context.headers, context.body.confirmed, context.now);
    if (context.body.expectedPrincipalId !== viewer.principal)
      throw new HttpError(409, "Your account changed. Review the storage agreement again.", undefined, "storage-account-changed");
    if (context.body.action === "accept-agreement") {
      await acceptStorageAgreement(storage, billingEnv, {
        principal: viewer.principal, requestId: context.body.requestId, agreementId: context.body.agreementId,
        revision: context.body.revision, documentSha256: context.body.documentSha256, termsSha256: context.body.termsSha256,
      }, context.now);
      context.pendingAudit.push({ actor: viewer.principal, action: "support.settings", target: "brain-storage-agreement", after: { op: "accept", agreementId: context.body.agreementId, revision: context.body.revision, documentSha256: context.body.documentSha256 } });
      return json(await view());
    }
    if (context.body.action === "withdraw-agreement") {
      await withdrawStorageAgreement(storage, billingEnv, viewer.principal, context.now);
      context.pendingAudit.push({ actor: viewer.principal, action: "support.settings", target: "brain-storage-agreement", after: { op: "withdraw" } });
      return json(await view());
    }
    throw new HttpError(400, "Choose a storage agreement action.");
  }
  if (item === "storage-ledger") {
    if (context.method !== "GET" || !viewer.manager || viewer.bot ||
        (!featureOn(context.mediaEnv, undefined, "brainStorage") && !await hasStorageAgreement(storage))) throw toolsNotFound();
    return json(await storageLedgerPage(storage, context.query.get("after")));
  }
  if (item === "guidance") {
    if (context.method === "GET") {
      if (!viewer.admin && !viewer.bot)
        throw new HttpError(403, "Ask a workspace admin for access.", undefined, "admin-only");
      const guidance = await call("knowledge.guidance.get");
      return json({ text: guidance.text, revision: guidance.revision,
        ...(await featureOn(context.mediaEnv, storage, "aiInteractionImprovements")
          ? { interactionPolicy: "bounded-v1" } : {}),
      });
    }
    if (!viewer.admin)
      throw new HttpError(403, "Ask a workspace admin for access.", undefined, "admin-only");
    requireWorkspaceAdminHeaders(context.headers, viewer.manager, context.body.confirmed, context.now);
    await refusePhrase(context.body.text, "saved");
    const result = await call("knowledge.guidance.set", { text: context.body.text });
    context.pendingAudit.push({ actor: viewer.principal, action: "support.settings", target: "ai-guidance", after: { revision: result.revision } });
    return json(result);
  }
  if (item === "context") {
    if (context.method !== "GET") throw toolsNotFound();
    return json(await call("knowledge.context", {
      after: context.query.get("after") ?? undefined,
      version: context.query.get("version") ?? undefined,
      storageGrant: await storageReadGrant(storage, { ...context.mediaEnv, ...env } as StorageBillingEnv, context.now),
    }));
  }
  if (item === "search") {
    if (context.method !== "POST") throw toolsNotFound();
    const eras = Array.isArray(context.body.eras)
      ? context.body.eras.filter((era): era is KnowledgeEraTag =>
          (KNOWLEDGE_ERAS as readonly string[]).includes(String(era)),
        )
      : undefined;
    return json(
      await call("knowledge.query", {
        text: context.body.text,
        limit: context.body.limit,
        eras,
        addresses: context.body.addresses,
        audience: context.body.audience === "team" ? "team" : "member",
        storageGrant: await storageReadGrant(storage, { ...context.mediaEnv, ...env } as StorageBillingEnv, context.now),
      }),
    );
  }
  if (context.method === "GET") {
    if (viewer.bot) throw peopleOnly();
    if (item) {
      if (!viewer.admin) throw new HttpError(403, "Ask a workspace admin for access.", undefined, "admin-only");
      return json(await call("knowledge.get", { id: item }));
    }
    return json(await call("knowledge.list", {
      after: context.query.get("after") ?? undefined,
      q: context.query.get("q") ?? undefined,
      kind: context.query.get("kind") ?? undefined,
      status: context.query.get("status") ?? undefined,
    }));
  }
  if (!viewer.admin)
    throw new HttpError(403, "Ask a workspace admin for access.", undefined, "admin-only");
  if (!viewer.manager) requireWorkspaceAdminHeaders(context.headers, false, true, context.now);
  const body = context.body;
  const audit = (op: string) =>
    context.pendingAudit.push({
      actor: viewer.principal,
      action: "support.settings",
      target: "knowledge",
      after: { op },
    });
  if (item) {
    if (body.action === "remove") {
      const result = await call("knowledge.remove", { id: item });
      audit("remove");
      return json(result);
    }
    if (body.action === "refresh") return json(await call("knowledge.refresh", { id: item }));
    if (body.action === "update") {
      const result = await call("knowledge.update", {
        id: item,
        era: body.era,
        visibility: body.visibility,
        addresses: body.addresses,
        title: body.title,
        text: body.text,
        ifUpdatedAt: body.ifUpdatedAt,
      });
      audit("update");
      return json(result);
    }
    throw new HttpError(400, "Choose update, refresh or remove.", undefined, "knowledge-action");
  }
  const tags = { era: body.era, visibility: body.visibility, addresses: body.addresses };
  let result: unknown;
  if (body.action === "add-doc") {
    result = await call("knowledge.add", { kind: "doc", url: body.url, title: body.title, ...tags });
  } else if (body.action === "add-sitemap") {
    result = await call("knowledge.sitemap", { url: body.url, ...tags });
  } else if (body.action === "add-faq") {
    await refusePhrase(body.title, "saved");
    await refusePhrase(body.text, "saved");
    result = await call("knowledge.add", { kind: "faq", title: body.title, text: body.text, ...tags });
  } else if (body.action === "add-saved-reply") {
    const id = typeof body.id === "string" && body.id.length <= 80 ? body.id : "";
    const reply = id
      ? await storage.get<{ id: string; title: string; text: string }>(`support-saved-reply-v1:${id}`)
      : undefined;
    if (!reply) throw new HttpError(404, "Saved reply not found.", undefined, "saved-reply-missing");
    result = await call("knowledge.add", {
      kind: "saved-reply",
      title: reply.title,
      text: reply.text,
      ref: reply.id,
      ...tags,
    });
  } else
    throw new HttpError(
      400,
      "Choose a docs page, a sitemap, an FAQ entry or a saved reply.",
      undefined,
      "knowledge-action",
    );
  audit(String(body.action));
  return json(result, 201);
}
