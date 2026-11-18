/** Transaction-check routes in the room, for the team only.
 *
 *   GET  /conversations/<tc>/diagnosis            the list (or one: ?id=dx-…)
 *   POST /conversations/<tc>/diagnosis            a run, a rating
 *
 * A run is two room calls the edge makes around its chain reads: `prepare`
 * (authorize, cache, quotas, lease) and `commit` (authorize again, check the
 * input against the lease, run the engine, store). The phase comes from a
 * header only the edge sets. Members, guests, widget sessions, outsiders,
 * revoked staff and an AI agent on an AI-off request get the same 404. A
 * registered AI agent reads facts and claims, with steps only for handoff, and
 * may run checks; only people rate them.
 *
 * Automatic runs (a member's consented share, an Ask AI request) are queued
 * here, in the same transaction as the write that caused them, and run by
 * the room alarm after it commits. */
import type { DiagnosisNetwork } from "@templ/chat/diagnosis/types";
import { isDiagnosisId } from "@templ/chat/support-diagnosis";
import { HttpError, json } from "./common";
import { readProductSupport } from "./product-entitlements";
import { wakeRoomAt } from "./room-alarm";
import {
  DIAGNOSIS_LEASE_HEADER,
  DIAGNOSIS_NETWORKS_HEADER,
  DIAGNOSIS_PHASE_HEADER,
  abortDiagnosis,
  commitDiagnosis,
  diagnosisList,
  diagnosisResponses,
  diagnosisView,
  enabledFromHeader,
  parseClientId,
  parseRunSubject,
  planDiagnosis,
  queueDiagnosisJob,
  rateDiagnosis,
  readLease,
  type DiagnosisCoverage,
  type DiagnosisThreadFacts,
} from "./support-diagnosis";
import { supportRecord, type SupportRecord } from "./support-workflow";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { DIAGNOSIS_READ_LIMITS } from "./tx-diagnosis/budgets";
import { keyGuardNetworks, type DiagnosisEnv } from "./tx-diagnosis/chains";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list"
>;

const PATH = /^\/conversations\/(tc-[0-9a-f]{32})\/diagnosis$/;
const WORKFLOW = /^\/conversations\/(tc-[0-9a-f]{32})\/workflow$/;
const notFound = () => new HttpError(404, "Case not found.");

export type DiagnosisRouteDeps = {
  /** The conversation module's one predicate (404 on any failure). */
  authorize(id: string): Promise<{
    record: TeamConversationRecord;
    role: "member" | "team";
  }>;
};

export async function diagnosisCoverage(
  storage: Storage,
  now: number,
): Promise<DiagnosisCoverage> {
  const access = await readProductSupport(storage as never, now);
  return { enabled: access.enabled, funded: access.funded };
}

export function threadFacts(
  record: TeamConversationRecord,
  data: SupportRecord,
): DiagnosisThreadFacts {
  const signed = data.wallet
    ? {
        network: data.wallet.network,
        address: data.wallet.address,
        ...(data.wallet.network === "evm"
          ? { chainId: data.wallet.chainId }
          : {}),
        authenticatedAt: data.wallet.authenticatedAt,
      }
    : null;
  const claimedWallet = data.access?.claimedWallet;
  const claimed = claimedWallet
    ? {
        network: claimedWallet.network,
        address: claimedWallet.address,
        ...(claimedWallet.network === "evm"
          ? { chainId: claimedWallet.chainId }
          : {}),
      }
    : null;
  return {
    thread: record.id,
    member: record.member,
    caseSeq: data.caseSeq ?? 0,
    context: data.context,
    wallet: { signed, claimed },
  };
}

async function wake(storage: Storage, at: number) {
  const alarm = storage as unknown as {
    getAlarm?: () => Promise<number | null>;
    setAlarm?: (at: number) => Promise<void>;
  };
  if (
    typeof alarm.getAlarm === "function" &&
    typeof alarm.setAlarm === "function"
  )
    await wakeRoomAt(alarm as never, at);
}

/** Queues the automatic run a write asks for. It runs only if the write
 * commits: a failed request rolls the job back with it. */
async function queueAutomatic(
  storage: Storage,
  context: ConversationContext,
  enabled: DiagnosisNetwork[],
) {
  if (context.method !== "POST" || !enabled.length) return;
  const actor = context.viewer.principalId ?? null;
  const body = context.body;
  const workflow = WORKFLOW.exec(context.pathname);
  let job: Parameters<typeof queueDiagnosisJob>[1] | null = null;
  if (
    context.pathname === "/conversations/ask" &&
    body.context !== undefined &&
    body.contextConsent === true &&
    actor
  )
    job = {
      kind: "member-share",
      thread: null,
      member: actor,
      actor: null,
      at: context.now,
    };
  else if (workflow && body.action === "context" && body.consent === true)
    job = {
      kind: "member-share",
      thread: workflow[1],
      member: null,
      actor: null,
      at: context.now,
    };
  else if (workflow && body.action === "draft-request" && actor)
    job = {
      kind: "ask-ai",
      thread: workflow[1],
      member: null,
      actor,
      at: context.now,
    };
  if (!job) return;
  await queueDiagnosisJob(storage as never, job);
  await wake(storage, context.now + 1_000);
}

/** Only a fresh, accepted member message queues its shared transaction check. */
export async function queueSharedMessageDiagnosis(
  storage: Storage,
  context: ConversationContext,
  thread: string,
): Promise<void> {
  if (!keyGuardNetworks(context.mediaEnv as unknown as DiagnosisEnv).length)
    return;
  await queueDiagnosisJob(storage as never, {
    kind: "member-share",
    thread,
    member: null,
    actor: null,
    at: context.now,
  });
  await wake(storage, context.now + 1_000);
}

export async function diagnosisRoomRoute(
  storage: Storage,
  context: ConversationContext,
  deps: DiagnosisRouteDeps,
): Promise<Response | null> {
  const enabled = enabledFromHeader(
    context.headers.get(DIAGNOSIS_NETWORKS_HEADER),
  );
  const match = PATH.exec(context.pathname);
  if (!match) {
    await queueAutomatic(
      storage,
      context,
      keyGuardNetworks(context.mediaEnv as unknown as DiagnosisEnv),
    );
    return null;
  }
  const thread = match[1];
  const { record, role } = await deps.authorize(thread);
  if (role !== "team") throw notFound();
  const now = context.now;
  const reader = { isBot: Boolean(context.isBot) };
  const coverage = await diagnosisCoverage(storage, now);
  if (context.method === "GET") {
    const id = context.query.get("id");
    const list = await diagnosisList(storage as never, thread, {
      enabled,
      reader,
      coverage,
      now,
    });
    if (id === null) return json(list);
    const one = isDiagnosisId(id)
      ? list.diagnoses.find((item) => item.id === id)
      : undefined;
    if (!one)
      throw new HttpError(
        404,
        "That check isn't in this chat.",
        undefined,
        "diagnosis-not-found",
      );
    return json({ diagnosis: one });
  }
  if (context.method !== "POST") throw notFound();
  const phase = context.headers.get(DIAGNOSIS_PHASE_HEADER);
  if (context.viewer.banned || context.viewer.mutedUntil)
    throw new HttpError(403, "You cannot change this case right now.");
  const actor = context.viewer.principalId!;
  if (phase === "rate") {
    if (reader.isBot)
      throw new HttpError(
        403,
        "Only people on the team can do that.",
        undefined,
        "person-only",
      );
    return json({
      rating: await rateDiagnosis(
        storage as never,
        thread,
        context.body,
        actor,
        now,
      ),
    });
  }
  if (phase === "abort") {
    await abortDiagnosis(
      storage as never,
      thread,
      context.body.lease,
      Number(context.body.calls) || 0,
      now,
    );
    return json({ ok: true });
  }
  if (phase === "commit") {
    const lease = await readLease(
      storage as never,
      thread,
      context.body.lease,
      now,
    );
    // The run is the caller's: another person cannot commit it.
    if (lease.actor !== actor) {
      await storage.delete(`support-diagnosis-run-v1:${thread}`);
      throw notFound();
    }
    const data = await supportRecord(storage, record);
    const outcome = await commitDiagnosis(storage as never, {
      env: context.mediaEnv,
      thread,
      lease,
      body: context.body as never,
      now,
      readContext: async () => data.context,
      writeContext: async (next) => {
        data.context = next as SupportRecord["context"];
        await storage.put(`support-workflow-v1:${record.id}`, data);
      },
    });
    if (outcome.kind === "refused-key")
      return json(
        {
          error:
            "This looks like a private key, not a transaction ID. Templ didn't check it and removed it from the shared details.",
          reason: "secret-refused",
          code: "secret-refused",
        },
        422,
      );
    if (outcome.kind !== "stored") throw notFound();
    return json(
      { diagnosis: diagnosisView(outcome.record, reader, now), cached: false },
      201,
    );
  }
  if (phase !== "prepare")
    throw new HttpError(
      503,
      "Transaction checks aren't available yet.",
      undefined,
      "diagnosis-unavailable",
    );
  if (context.headers.get("X-Support-Workflow") !== "true")
    throw new HttpError(503, "Support tools are being tested.");
  const parsed = parseRunSubject(context.body.subject);
  const clientId = parseClientId(context.body.clientId);
  const data = await supportRecord(storage, record);
  const outcome = await planDiagnosis({
    storage: storage as never,
    facts: threadFacts(record, data),
    trigger: reader.isBot ? "agent" : "staff",
    actor,
    clientId,
    subject: parsed.subject,
    staffNetwork: parsed.network,
    fromExplorer: parsed.fromExplorer,
    enabled,
    coverage,
    force: context.body.force === true,
    now,
    deadlineMs: DIAGNOSIS_READ_LIMITS.staffDeadlineMs,
  });
  if (outcome.kind === "cached")
    return diagnosisResponses.cached(outcome.record, reader, now);
  if (outcome.kind === "running")
    return diagnosisResponses.running(outcome.lease);
  const response = json({ plan: outcome.plan });
  response.headers.set(DIAGNOSIS_LEASE_HEADER, outcome.lease.id);
  return response;
}
