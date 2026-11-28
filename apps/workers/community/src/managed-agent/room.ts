import { HOSTED_SOCIAL_REPLIES } from "@templ/chat/support-ai-interactions";
import { CRYPTO_MONTHLY_BUDGET_CENTS, CRYPTO_SUPPORT_MODEL, prepaidSupportModel } from "@templ/chat/support-models";
import { CRYPTO_SUPPORT_WORKSPACE } from "../crypto-support";
import type { SupportAiGrounding } from "@templ/chat/support-drafts";
import { cryptoServiceReplies } from "./crypto-triage";
import { CRYPTO_LINK_LIMITS, cryptoLinkProblem } from "../crypto-links";
import type { StandardPrepaidPeriod } from "@templ/chat/standard-plan";
import { GROUNDED_POLICY, groundedMemberTurn } from "./grounded";
import { cryptoCaseWallets, resolveCryptoLookup } from "../crypto-lookup-target";
import { chainTargetSha256, lookupState, type CryptoLookupState } from "./crypto-chain-facts";
import { cryptoChatLanguageState } from "../crypto-chat-language";
import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { prepaidAiMode } from "../product-prepaid-ai";
import {
  sponsoredSupport,
  readPrepaidAccount,
  readStarterAiLimit,
  starterAiRemaining,
} from "../product-prepaid";
import { isOperatorAdmin } from "../operator-admin";
import { probePrepaidGptCount } from "./gpt";
import {
  assertBrainAnswerSources,
  storageReadGrant,
  type StorageBillingEnv,
} from "../brain-storage-billing";
import {
  acceptManagedQualification,
  MANAGED_QUALIFICATION_TRIAL,
} from "../managed-agent-trial-access";
import { featureOn, managedResolutionBillingOn, type WorkspaceFlagEnv } from "../workspace-flags";
import { modelDiagnosisFacts } from "@templ/chat/diagnosis/model-facts";
import { sharedTransactionHashes } from "../support-secret-sinks";
/** Managed AI in the room: the manager's switch, the routes, the checks on
 * the managed account's own writes, and the job queue that wakes the
 * runner. Called at the top of the room's conversation routes.
 *
 * Routes (all under /conversations):
 * - `managed` GET the settings page's view (the manager and support leads);
 *   POST `{ enabled, confirmed }` (the owner or an Admin, valid session).
 * - `managed/golden` GET the golden gate over the Quality page's golden
 *   set and its last run; POST `{ action: "run" }` asks for a check (the
 *   manager and leads; paced by the knowledge object).
 * - `managed/state?thread=<tc>` GET what the runner needs of one request
 *   (the managed account only, and only while it is on the team).
 * - `<tc>/managed/check` POST a dry run of the reply checks (people on the
 *   team). It writes nothing.
 *
 * Before an existing route: the managed account's reply (`<tc>/messages`)
 * and draft (`<tc>/workflow` action `draft`) must carry `managed` with its
 * claims; the checks in checks.ts run on the stored evidence and profile,
 * then the field is removed and the route answers as for any AI agent.
 *
 * After every other route returns null, a member's message or a person's
 * Ask AI question queues a job in the same transaction (rolled back with
 * the write), and the room alarm hands it to the knowledge object, which
 * runs it. Nothing polls. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import {
  MANAGED_AGENT_LIMITS,
  MANAGED_AGENT_MODEL,
  type ManagedAgentState,
  type ManagedAgentView,
} from "@templ/chat/managed-agent";
import { metricKeyBindings } from "@templ/chat/metric-keys";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { ProfileMetric } from "@templ/chat/protocol-profile";
import type { ChatMessage } from "@templ/chat/index";
import { HttpError, json } from "../common";
import { requireWorkspaceAdminHeaders } from "../privileged-auth";
import { activeProductOrderForm } from "../product-order-forms";
import { managedModelAvailable, type ManagedModelEnv } from "./anthropic";
import {
  PRODUCT_STATE_KEY,
  readProductState,
  standardPlanForState,
} from "../product-entitlements";
import { productGrants, type ProductGrantsEnv } from "../product-grants";
import { wakeRoomAt, type RoomAlarmContext } from "../room-alarm";
import {
  PROVENANCE_PREFIX,
  provenanceKey,
  type StoredProvenance,
} from "../support-drafts";
import { assertLatest, parseIfLatest } from "../support-handoff";
import { messageKey } from "../message-store";
import { readCase, type CaseThreadId } from "../support-case-data";
import {
  citableDiagnoses,
  currentCaseChecks,
  diagnosisPending,
  diagnosisNetworkEnabled,
  enabledFromHeader,
  DIAGNOSIS_NETWORKS_HEADER,
  readThreadDiagnoses,
} from "../support-diagnosis";
import { readCaseEvidence, readCaseFrame } from "../support-evidence-store";
import { knowledgeCall, type KnowledgeEnv } from "../support-knowledge-client";
import { readAiState, supportRecord } from "../support-workflow";
import { lastAssistantPause, readSupportProfiles } from "../support-contact-profiles";
import { encryptedCaseExists } from "../support-encryption";
import { threadFacts } from "../support-diagnosis-route";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "../team-conversations";
import { checkedReplyMeta, managedReplyVerdict, verdictError } from "./checks";
import { managedKnowledgeCall } from "./knowledge-client";
import { managedPrincipal } from "./principal";

type Storage = DurableObjectTransaction;
export type ManagedRoomEnv = KnowledgeEnv &
  ProductGrantsEnv &
  ManagedModelEnv & {
    MANAGED_AGENT_ENABLED?: string;
    MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
  };
export type ManagedRouteDeps = {
  authorize(id: string): Promise<{
    record: TeamConversationRecord;
    role: "member" | "team";
  }>;
  /** Team authority now: the manager or a current handling grant. */
  team: boolean;
};

export const MANAGED_SETTINGS_KEY = "managed-agent-v1";
export const MANAGED_JOB_PREFIX = "managed-job-v1:";
const MEMBER_THREAD_PREFIX = "conversation-member-v1:";
const THREAD = /^tc-[0-9a-f]{32}$/;
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ROUTE = /^\/conversations\/managed(?:\/(golden|state))?$/;
const CHECK = /^\/conversations\/(tc-[0-9a-f]{32})\/managed\/check$/;
const WRITE = /^\/conversations\/(tc-[0-9a-f]{32})\/(messages|workflow)$/;
const RESOLVE = /^\/conversations\/(tc-[0-9a-f]{32})\/resolve$/;
const ASK = "/conversations/ask";
const pad15 = (value: number) => String(value).padStart(15, "0");
const iso = (at: number) => new Date(at).toISOString();
const notFound = () => new HttpError(404, "Support tools not found.");

type StoredSettings = {
  v: 1;
  enabled: boolean;
  updatedAt: number | null;
  updatedBy: ChatPrincipalId | null;
};
export type ManagedJob = {
  v: 1;
  id: string;
  kind: "ask-ai" | "member-message" | "handoff-learning";
  /** The thread, or null for a member's first message (`ask`): the alarm
   * finds the member's thread once the write committed. */
  thread: string | null;
  member: ChatPrincipalId | null;
  /** The Ask AI request id. */
  request: string | null;
  /** The channel-independent room learning job; never a model-supplied id. */
  learningId?: string;
  at: number;
};

const envOf = (context: ConversationContext) =>
  context.mediaEnv as unknown as ManagedRoomEnv;

export async function readManagedSettings(
  storage: Pick<Storage, "get">,
): Promise<StoredSettings> {
  const stored = await storage.get<StoredSettings>(MANAGED_SETTINGS_KEY);
  if (stored && stored.v === 1 && typeof stored.enabled === "boolean") {
    if (stored.enabled && (await readSupportProfiles(storage))?.assistantEnabled === false)
      return { ...stored, enabled: false };
    return stored;
  }
  return { v: 1, enabled: false, updatedAt: null, updatedBy: null };
}

/** A current ordered managed AI service or an unrevoked managed-agent grant.
 * Stored order forms retain their native validation and end-date checks. */
export async function managedGrant(
  storage: Pick<Storage, "get">,
  env: ProductGrantsEnv & WorkspaceFlagEnv,
  now: number,
  room?: string,
): Promise<{ active: boolean; endsAt: string | null }> {
  if (await cryptoResearchGrant(storage, env, room)) return { active: true, endsAt: null };
  const orderForm = await activeProductOrderForm(storage, now);
  if (orderForm?.service === "managed-ai")
    return { active: true, endsAt: iso(orderForm.endsAt) };
  if (!(await storage.get(PRODUCT_STATE_KEY)))
    return { active: false, endsAt: null };
  const product = await readProductState(storage, now, env);
  const standard = standardPlanForState(product);
  if (standard?.status === "paid" && standard.period)
    return { active: true, endsAt: iso(standard.period.endsAt) };
  if (
    standard?.status === "demo" &&
    !(product.exemptUntil !== null && now < product.exemptUntil)
  )
    return { active: false, endsAt: null };
  const list = productGrants(env);
  if (!list.ok) return { active: false, endsAt: null };
  const state = product;
  const ends = state.grants
    .filter(
      (grant) =>
        grant.kind === "managed-agent" &&
        grant.endsAt > now &&
        !list.revoked.has(grant.id),
    )
    .map((grant) => grant.endsAt);
  if (!ends.length) return { active: false, endsAt: null };
  return { active: true, endsAt: iso(Math.max(...ends)) };
}

/** Whether the request comes from this workspace's managed account acting
 * as a registered AI agent. */
async function isManagedActor(context: ConversationContext) {
  return Boolean(context.isBot) && (await isManagedPrincipal(context));
}

/** Keep status restrictions after bot registration is removed. Identity grants no access. */
async function isManagedPrincipal(context: ConversationContext) {
  if (!context.viewer.principalId) return false;
  const principal = await managedPrincipal(context.room);
  return (
    context.viewer.principalId === principal &&
    context.aliases.includes(principal)
  );
}

/** The workspace's cap for this month in cents: FEATURE_LIMITS for one
 * workspace, 0 meaning no calls. */
export const workspaceCapCents = () =>
  Math.max(0, FEATURE_LIMITS.managedAgentMonthlySpendUsdCents);
/** Templ's cap across every workspace, from the worker var. */
export function templCapCents(env: {
  MANAGED_AGENT_SPEND_CAP_USD_CENTS?: string;
}) {
  const value = Number(env.MANAGED_AGENT_SPEND_CAP_USD_CENTS);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
/** The kill switch: anything but "true" stops every model call. */
export const killSwitchOn = (env: { MANAGED_AGENT_ENABLED?: string }) =>
  featureOn(env, undefined, "managedAgent");

/** Production native support uses the funded GPT policy. Legacy Claude never activates with its global flag. */
export function nativeModelAvailable(
  env: ManagedModelEnv & { APP_ORIGIN?: string },
  prepaid: boolean,
) {
  if (prepaid)
    return Boolean(
      env.AI &&
      /^[a-z0-9][a-z0-9-]{0,63}$/.test(env.MANAGED_AGENT_GATEWAY_ID ?? ""),
    );
  return (
    env.APP_ORIGIN !== "https://usetempl.com" && managedModelAvailable(env)
  );
}
/** Why the managed agent makes no call now, from the room's side, or
 * "ready". Spend is checked again, with the real counters, before each
 * call. A paid period passes its funds stop from `prepaidFundsStop`. */
export function managedState(input: {
  enabled: boolean;
  onTeam: boolean;
  grant: boolean;
  env: ManagedRoomEnv;
  usedCents: number;
  prepaid?: boolean;
  prepaidStop?: "no-budget" | "workspace-cap" | null;
}): ManagedAgentState {
  if (!input.enabled) return "off";
  if (!input.onTeam) return "not-on-team";
  if (!input.grant) return "no-grant";
  if (!killSwitchOn(input.env)) return "kill-switch";
  if (!nativeModelAvailable(input.env, Boolean(input.prepaid))) return "no-key";
  const cap = workspaceCapCents();
  if (input.prepaid && input.prepaidStop) return input.prepaidStop;
  if (!input.prepaid && !cap) return "no-budget";
  if (
    !input.prepaid &&
    input.usedCents + MANAGED_AGENT_LIMITS.reserveCentsPerCall > cap
  )
    return "workspace-cap";
  if (!templCapCents(input.env)) return "templ-cap";
  return "ready";
}

async function onTeam(
  context: ConversationContext,
  principal: ChatPrincipalId,
) {
  return (
    (context.registeredBots ?? []).includes(principal) &&
    Boolean(await context.isSupportStaff?.(principal))
  );
}

/** Clarifying questions the managed account sent on this member request,
 * from its reply provenance (deleted with each message). */
export async function clarifyingAsked(
  storage: Pick<Storage, "list" | "get">,
  thread: string,
  seq: number,
  principal: ChatPrincipalId,
  cryptoDesk = false,
) {
  const listed = await storage.list<{
    case?: number;
    author?: string;
    ai?: { reason?: string } | null;
  }>({ prefix: `${PROVENANCE_PREFIX}${thread}:`, limit: 1_000 });
  let count = 0;
  for (const [key, stored] of listed) {
    if (stored?.case !== seq || stored.author !== principal || stored.ai?.reason !== "clarifying-question") continue;
    if (!cryptoDesk) { count++; continue; }
    const id = Number(key.split(":").at(-1));
    const sent = await storage.get<ChatMessage>(messageKey(thread, id));
    if (sent?.text !== HOSTED_SOCIAL_REPLIES.offTopic && !cryptoServiceReplies.has(sent?.text ?? "")) count++;
  }
  return count;
}

async function profileBindings(
  env: KnowledgeEnv,
  room: string,
  principal: string,
  team: boolean,
) {
  // Only Ask AI drafts can cite Team-only metrics.
  const { metrics } = await knowledgeCall<{ metrics: ProfileMetric[] }>(
    env,
    room,
    "profile.metrics.list",
    { principal, role: team ? "staff" : "bot" },
  );
  return metricKeyBindings(metrics);
}

async function cryptoResearchGrant(storage: Pick<Storage, "get">, env: WorkspaceFlagEnv, room?: string) {
  return room === "room:" + CRYPTO_SUPPORT_WORKSPACE && await sponsoredSupport(storage) && await featureOn(env, storage, "cryptoSupportResearch");
}
/** Network reads need the desk's research grant and their own audited desk flag. */
async function cryptoChainFactsOn(storage: Storage, context: ConversationContext) {
  return (await cryptoResearchGrant(storage, envOf(context), context.room)) &&
    (await featureOn(envOf(context), storage, "cryptoDeskChainFacts"));
}
/** The member's current turn, read as written, selects at most one target from
 * its own text and the wallets verified in this thread. Staff text, other
 * threads and an incomplete turn select nothing. */
export async function cryptoLookupState(
  storage: Pick<Storage, "list">,
  record: TeamConversationRecord,
  current: { openedAt: number; memberMessages: number },
): Promise<CryptoLookupState | null> {
  const rows = [...(await storage.list<ChatMessage>({
    prefix: `channel-message:${record.id}:`,
    reverse: true,
    limit: MANAGED_AGENT_LIMITS.messagesRead,
  })).values()].reverse();
  const latest = rows.at(-1);
  const members = new Set<string>([record.member, ...(record.formerMembers ?? [])]);
  if (!latest || !members.has(latest.author)) return null;
  const turn = groundedMemberTurn(rows, members, current.openedAt, current.memberMessages);
  if (turn.incomplete || !turn.text) return null;
  // A short follow-up such as "Ethereum" can complete the member's previous turn in this case.
  let at = rows.length - 1;
  while (at >= 0 && members.has(rows[at].author)) at--;
  while (at >= 0 && !members.has(rows[at].author)) at--;
  const previous: string[] = [];
  for (; at >= 0 && members.has(rows[at].author) && Date.parse(rows[at].createdAt) >= current.openedAt; at--)
    previous.unshift(rows[at].text);
  return lookupState(
    resolveCryptoLookup(turn.text, cryptoCaseWallets(record), previous.length ? previous.join("\n") : undefined),
    { id: latest.id, revision: latest.revision ?? 1 },
  );
}
/** A chain answer holds only while the same message selects the same case target. */
export async function chainLookupMatches(
  lookup: CryptoLookupState | null,
  thread: string,
  seq: number,
  latestId: string | null,
  binding: { from?: unknown; targetSha256?: unknown },
) {
  return lookup?.selection.kind === "lookup" &&
    lookup.latest.id === latestId &&
    lookup.selection.from === binding.from &&
    (await chainTargetSha256(thread, seq, lookup.selection)) === binding.targetSha256;
}
async function groundedPeriod(storage: Storage, context: ConversationContext) {
  if (await cryptoResearchGrant(storage, envOf(context), context.room)) return "sponsored" as const;
  const selected = await prepaidAiMode(storage, context.now, envOf(context));
  const period = selected.period;
  return selected.mode === "prepaid" &&
    period?.readinessPolicy === GROUNDED_POLICY &&
    context.now >= period.startsAt &&
    context.now < period.endsAt
    ? period
    : null;
}
/** The funds refusals paid admission (`reservePrepaidAi`) makes before any
 * hold: no room left under Starter's monthly limit after settled and reserved
 * usage, or no included credit or prepaid cash. Reads the ledger only; each
 * request is still held against its own maximum. Included credit is a
 * month's budget, so a Plus month without funds has used it up. */
export async function prepaidFundsStop(
  storage: Pick<Storage, "get">,
  period: StandardPrepaidPeriod,
): Promise<"no-budget" | "workspace-cap" | null> {
  if ((await starterAiRemaining(storage, period)) === 0n)
    return BigInt(period.includedAiCreditUsdNanos) > 0n || (await readStarterAiLimit(storage)) ? "workspace-cap" : "no-budget";
  const { cashAvailableUsdNanos } = await readPrepaidAccount(storage);
  if (BigInt(period.includedAiAvailableUsdNanos) + BigInt(cashAvailableUsdNanos) > 0n)
    return null;
  return BigInt(period.includedAiCreditUsdNanos) > 0n ? "workspace-cap" : "no-budget";
}
async function groundedVerdict(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  text: string,
  managed: unknown,
  close = false,
) {
  const raw = managed as Record<string, unknown> | null;
  const provenance = context.body.provenance as
    | {
        sources?: { id?: unknown }[];
        tools?: unknown;
        reason?: unknown;
        grounding?: SupportAiGrounding;
      }
    | undefined;
  const token = raw?.grounded;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join() !==
      "claims,clarifying,comparisons,grounded" ||
    !Array.isArray(raw.claims) ||
    raw.claims.length ||
    !Array.isArray(raw.comparisons) ||
    raw.comparisons.length ||
    typeof raw.clarifying !== "boolean" ||
    typeof token !== "string" ||
    !/^[a-f0-9]{32}$/.test(token) ||
    !Array.isArray(provenance?.sources) ||
    provenance.grounding?.receiptId !== token
  )
    throw new HttpError(
      409,
      "This answer needs a current source check.",
      undefined,
      "grounded-answer-unverified",
    );
  const seq = (await supportRecord(storage, record)).caseSeq ?? 0;
  const latestId = await storage.get<number>(`channel-sequence:${record.id}`);
  const latest = latestId
    ? await storage.get<ChatMessage>(messageKey(record.id, latestId))
    : null;
  const checked = await managedKnowledgeCall<{
    ok: boolean;
    clarifying?: boolean;
    summaryOnly?: boolean;
    chain?: { from?: unknown; targetSha256?: unknown };
  }>(envOf(context), context.room, "grounded.verify", {
    receipt: token,
    thread: record.id,
    case: seq,
    text,
    latest:
      latestId && latest
        ? { id: String(latestId), revision: latest.revision ?? 1 }
        : null,
    sourceIds: provenance.sources.map((source) => source.id),
    sources: provenance.sources,
    grounding: provenance.grounding,
    draft:
      context.pathname.endsWith("/workflow") && context.body.action === "draft",
    close,
    storageGrant: await storageReadGrant(
      storage,
      envOf(context) as StorageBillingEnv,
      context.now,
    ),
  });
  if (!checked.ok || checked.clarifying !== raw.clarifying)
    throw new HttpError(
      409,
      "This answer needs a current source check.",
      undefined,
      "grounded-answer-unverified",
    );
  // Network facts answer only the turn and wallets that selected them. A revoked
  // flag, removed wallet, edited or newer message, or new case refuses the reply.
  if (checked.chain !== undefined) {
    const current = await readCase(storage, { thread: record.id as CaseThreadId, seq });
    if (
      !current ||
      !(await cryptoChainFactsOn(storage, context)) ||
      !(await chainLookupMatches(
        await cryptoLookupState(storage, record, {
          openedAt: current.case.openedAt,
          memberMessages: current.case.counts.memberMessages,
        }),
        record.id,
        seq,
        latestId ? String(latestId) : null,
        checked.chain,
      ))
    )
      throw new HttpError(
        409,
        "This answer needs a current source check.",
        undefined,
        "grounded-answer-unverified",
      );
  }
  if (
    raw.clarifying &&
    (await clarifyingAsked(
      storage,
      record.id,
      seq,
      await managedPrincipal(context.room),
      context.room === "room:" + CRYPTO_SUPPORT_WORKSPACE,
    )) >= MANAGED_AGENT_LIMITS.clarifyingPerCase
  )
    return { ok: false as const, reason: "clarify-used" as const };
  return { ok: true as const };
}
/** The verdict on a reply in `thread`'s current request. */
async function verdictFor(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  text: unknown,
  managed: unknown,
  principal: ChatPrincipalId,
  team = false,
) {
  if (
    typeof text === "string" &&
    (await isManagedActor(context)) &&
    (await groundedPeriod(storage, context))
  )
    return groundedVerdict(storage, context, record, text, managed);
  const meta = checkedReplyMeta(managed);
  if (!meta || typeof text !== "string")
    throw new HttpError(
      400,
      "Send the reply's numbers with it.",
      undefined,
      "managed-meta",
    );
  const data = await supportRecord(storage, record);
  const seq = data.caseSeq ?? 0;
  const evidence = seq
    ? (
        await readCaseEvidence(storage, record.id, seq, team ? "team" : "agent")
      ).rows.map((row) => ({
        n: row.n,
        product: { key: row.product.key },
        metric: { key: row.metric.key },
        window: { key: row.window.key },
        value: row.value,
        withdrawn: Boolean(row.withdrawn),
        supersededBy: row.supersededBy ?? null,
      }))
    : [];
  const bindings = meta.claims.length
    ? await profileBindings(envOf(context), context.room, principal, team)
    : new Map();
  return managedReplyVerdict({
    text,
    meta,
    bindings,
    evidence,
    diagnoses: await citableDiagnoses(
      storage,
      record.id,
      enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
    ),
    clarifyingAsked: meta.clarifying
      ? await clarifyingAsked(storage, record.id, seq, principal, context.room === "room:" + CRYPTO_SUPPORT_WORKSPACE)
      : 0,
  });
}

const CRYPTO_LINK_REFUSAL = "AI replies on this desk can link only to reviewed pages.";
/** The desk's AI links only to reviewed pages, whatever its sources say.
 * Fixed desk replies are Templ's own text. */
function unreviewedCryptoLink(context: ConversationContext) {
  return (
    context.room === "room:" + CRYPTO_SUPPORT_WORKSPACE &&
    typeof context.body.text === "string" &&
    !cryptoServiceReplies.has(context.body.text) &&
    cryptoLinkProblem(context.body.text, CRYPTO_LINK_LIMITS.inline + CRYPTO_LINK_LIMITS.sources) !== null
  );
}

function isLead(context: ConversationContext, team: boolean) {
  return (
    !context.isBot &&
    (context.viewer.isManager ||
      (team && context.viewer.permissions.includes("manageSupport")))
  );
}

async function settingsView(
  storage: Storage,
  context: ConversationContext,
): Promise<ManagedAgentView> {
  const env = envOf(context);
  const principal = await managedPrincipal(context.room);
  const settings = await readManagedSettings(storage);
  const grant = await managedGrant(storage, env, context.now, context.room);
  const status = await managedKnowledgeCall<{
    spend: { month: string; usedCents: number };
    golden: ManagedAgentView["golden"];
  }>(env, context.room, "status");
  const team = await onTeam(context, principal);
  const period = await groundedPeriod(storage, context);
  const prepaid = Boolean(period);
  return {
    principal,
    settings: {
      enabled: settings.enabled,
      updatedAt: settings.updatedAt === null ? null : iso(settings.updatedAt),
    },
    state: managedState({
      enabled: settings.enabled,
      onTeam: team,
      grant: grant.active,
      env,
      usedCents: prepaid ? 0 : status.spend.usedCents,
      prepaid,
      prepaidStop: period && period !== "sponsored" ? await prepaidFundsStop(storage, period) : null,
    }),
    onTeam: team,
    grant,
    spend: { ...status.spend, capCents: period === "sponsored" ? CRYPTO_MONTHLY_BUDGET_CENTS : workspaceCapCents() },
    golden: status.golden,
    model: period === "sponsored" ? CRYPTO_SUPPORT_MODEL : period ? prepaidSupportModel(period.aiRateCardVersion) : MANAGED_AGENT_MODEL,
    aiCredit: prepaid && period !== "sponsored",
  };
}

/** The managed AI routes and the pre-checks on the managed account's own
 * writes. Null for any other request. */
export async function managedRoomRoute(
  storage: Storage,
  context: ConversationContext,
  deps: ManagedRouteDeps,
): Promise<Response | null> {
  const { method, pathname } = context;
  if (
    (context.body.provenance as { grounding?: unknown } | undefined)
      ?.grounding !== undefined &&
    (!(await isManagedActor(context)) ||
      !(await groundedPeriod(storage, context)))
  )
    throw new HttpError(
      400,
      "Only native paid AI can attach a source-check receipt.",
      undefined,
      "grounded-provenance",
    );
  const workflow = WRITE.exec(pathname);
  if (
    workflow?.[2] === "workflow" &&
    method === "POST" &&
    ["status", "solved", "confirm"].includes(String(context.body.action)) &&
    (await isManagedPrincipal(context))
  )
    throw new HttpError(
      403,
      "Managed AI must use its checked resolve path.",
      undefined,
      "managed-close-path",
    );
  const resolve = RESOLVE.exec(pathname);
  if (resolve && method === "POST" && (await isManagedPrincipal(context))) {
    const { record, role } = await deps.authorize(resolve[1]);
    if (role !== "team") throw notFound();
    await assertManagedClose(storage, context, record);
    // The ordinary resolve route writes the actor, confirmation, alerts and charge.
    return null;
  }
  const route = ROUTE.exec(pathname);
  if (route) {
    const sub = route[1];
    if (sub === "state") {
      if (method !== "GET" || !(await isManagedActor(context)) || !deps.team)
        throw notFound();
      return json(await runnerState(storage, context, deps));
    }
    if (!isLead(context, deps.team)) throw notFound();
    const env = envOf(context);
    if (sub === "golden") {
      if (method === "GET")
        return json(
          await managedKnowledgeCall(env, context.room, "golden.get"),
        );
      if (method !== "POST") throw notFound();
      // The cases are the Quality page's golden set; this only asks for a
      // check, which the knowledge object paces.
      if (context.body.action !== "run")
        throw new HttpError(400, "Choose run.", undefined, "golden-action");
      if (await groundedPeriod(storage, context))
        throw new HttpError(
          409,
          "Paid AI checks each answer against current sources. The previous model's test runner is unavailable for this plan.",
          undefined,
          "grounded-policy",
        );
      const result = await managedKnowledgeCall(
        env,
        context.room,
        "golden.run",
        {},
      );
      context.pendingAudit.push({
        actor: context.viewer.principalId!,
        action: "support.settings",
        target: "managed-golden",
        after: { op: "run" },
      });
      return json(result);
    }
    if (method === "GET") {
      if (context.query.get("input-token-probe") === "1") {
        if (
          !canManageWorkspace(context.viewer, context.isBot) ||
          !context.viewer.principalId ||
          !isOperatorAdmin(
            context.mediaEnv,
            context.viewer.principalId,
            context.aliases,
          )
        )
          throw notFound();
        if (!env.AI || !env.MANAGED_AGENT_GATEWAY_ID)
          throw new HttpError(503, "AI token counting is unavailable.");
        return json(
          await probePrepaidGptCount(env.AI, env.MANAGED_AGENT_GATEWAY_ID),
        );
      }
      return json(await settingsView(storage, context));
    }
    if (method !== "POST") throw notFound();
    if (!canManageWorkspace(context.viewer, context.isBot))
      throw new HttpError(403, "Only workspace admins can change managed AI.");
    requireWorkspaceAdminHeaders(
      context.headers,
      context.viewer.isManager,
      context.body.confirmed,
      context.now,
    );
    if (typeof context.body.enabled !== "boolean")
      throw new HttpError(
        400,
        "Choose on or off.",
        undefined,
        "managed-enabled",
      );
    if (context.body.trialAgreement !== undefined) {
      if (!context.viewer.isManager)
        throw new HttpError(
          403,
          "Only the owner can accept service agreements.",
        );
      await acceptManagedQualification(
        storage,
        env,
        context.viewer.principalId,
        context.body.trialAgreement,
        context.now,
      );
      context.pendingAudit.push({
        actor: context.viewer.principalId!,
        action: "support.settings",
        target: "managed-trial-acceptance",
        after: {
          documentSha256: MANAGED_QUALIFICATION_TRIAL.documentSha256,
          revision: 1,
          authorizationSha256: MANAGED_QUALIFICATION_TRIAL.authorizationSha256,
        },
      });
    }
    const before = await readManagedSettings(storage);
    const next: StoredSettings = {
      v: 1,
      enabled: context.body.enabled,
      updatedAt: context.now,
      updatedBy: context.viewer.principalId,
    };
    await storage.put(MANAGED_SETTINGS_KEY, next);
    if (!next.enabled) await dropJobs(storage);
    context.pendingAudit.push({
      actor: context.viewer.principalId!,
      action: "support.settings",
      target: "managed-agent",
      before: { enabled: before.enabled },
      after: { enabled: next.enabled },
    });
    return json(await settingsView(storage, context));
  }
  const check = CHECK.exec(pathname);
  if (check) {
    if (method !== "POST" || context.isBot) throw notFound();
    const { record, role } = await deps.authorize(check[1]);
    if (role !== "team") throw notFound();
    if (unreviewedCryptoLink(context))
      return json(
        { error: CRYPTO_LINK_REFUSAL, reason: "crypto-link-unreviewed", problems: [], then: "handoff" },
        409,
      );
    const principal = await managedPrincipal(context.room);
    const verdict = await verdictFor(
      storage,
      context,
      record,
      context.body.text,
      context.body.managed,
      principal,
    );
    if (verdict.ok) return json({ ok: true });
    const error = verdictError(verdict);
    // Written for the team: the problems and what the runner does next.
    return json(
      {
        error: error.message,
        reason: error.reason,
        problems:
          verdict.reason === "metric-claim-refused" ? verdict.problems : [],
        then: "handoff",
      },
      409,
    );
  }
  const write = WRITE.exec(pathname);
  if (
    write?.[2] === "workflow" &&
    method === "POST" &&
    context.body.action === "evidence" &&
    (await isManagedActor(context))
  ) {
    const { role } = await deps.authorize(write[1]);
    if (role !== "team") throw notFound();
    const sources = (
      context.body.provenance as { sources?: unknown } | undefined
    )?.sources;
    if (!Array.isArray(sources) || sources.length > 8)
      throw new HttpError(
        409,
        "Answer sources are unavailable.",
        undefined,
        "storage-source-unavailable",
      );
    await assertBrainAnswerSources(
      storage,
      envOf(context) as StorageBillingEnv,
      await managedPrincipal(context.room),
      sources,
      context.now,
    );
  }
  if (
    write &&
    method === "POST" &&
    (write[2] === "messages" || context.body.action === "draft") &&
    (await isManagedActor(context))
  ) {
    const { record, role } = await deps.authorize(write[1]);
    if (role !== "team") throw notFound();
    if (unreviewedCryptoLink(context))
      throw new HttpError(409, CRYPTO_LINK_REFUSAL, undefined, "crypto-link-unreviewed");
    const env = envOf(context);
    const provenance = context.body.provenance as
      | { reason?: unknown }
      | undefined;
    if (
      write[2] === "messages" &&
      provenance?.reason === "answer" &&
      typeof context.body.text === "string" &&
      context.body.text.trim() &&
      (await featureOn(env, storage, "resolutionBilling")) &&
      !(await managedResolutionBillingOn(env, storage))
    )
      throw new HttpError(
        409,
        "Managed AI cannot answer this case now.",
        undefined,
        "managed-billing-unavailable",
      );
    const principal = await managedPrincipal(context.room);
    const verdict = await verdictFor(
      storage,
      context,
      record,
      context.body.text,
      context.body.managed,
      principal,
      write[2] === "workflow" && typeof context.body.request === "string",
    );
    if (!verdict.ok) throw verdictError(verdict);
    await assertBrainAnswerSources(
      storage,
      env as StorageBillingEnv,
      principal,
      (context.body.provenance as { sources?: unknown } | undefined)?.sources,
      context.now,
    );
    delete context.body.managed;
  }
  return null;
}

/** A managed close follows one accepted answer, with current authority and review. */
async function assertManagedClose(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
) {
  const principal = await managedPrincipal(context.room);
  const env = envOf(context);
  const unavailable = () =>
    new HttpError(
      409,
      "Managed AI cannot resolve this case now.",
      undefined,
      "managed-close-unavailable",
    );
  if (
    context.body.resolved !== true ||
    !Number.isSafeInteger(context.body.case) ||
    (context.body.case as number) < 1
  )
    throw new HttpError(
      400,
      "Send the answered case number.",
      undefined,
      "managed-close-case",
    );
  const latest = parseIfLatest(context.body.ifLatest);
  if (!latest)
    throw new HttpError(
      400,
      "Send the accepted reply and revision.",
      undefined,
      "managed-close-reply",
    );
  if (
    !(await readManagedSettings(storage)).enabled ||
    !killSwitchOn(env) ||
    !(await onTeam(context, principal)) ||
    !(await managedGrant(storage, env, context.now, context.room)).active
  )
    throw unavailable();
  const { data, effective } = await readAiState(storage, record);
  if (
    effective.mode !== "answers" ||
    record.stopped ||
    record.handoff ||
    !["open", "resolved"].includes(data.state) ||
    data.caseSeq !== context.body.case
  )
    throw unavailable();
  const current = await readCase(storage, {
    thread: record.id as CaseThreadId,
    seq: context.body.case as number,
  });
  if (
    !current ||
    current.case.abandonedAt != null ||
    current.case.confirmation === "not-solved" ||
    current.case.handoffOpen
  )
    throw unavailable();
  // A retry may confirm the same close. It never substitutes a member or another closer.
  if (
    record.state === "resolved" &&
    (record.resolvedBy?.kind !== "team" ||
      record.resolvedBy.principalId !== principal)
  )
    throw unavailable();
  await assertLatest(storage, record.id, latest);
  const reply = await storage.get<ChatMessage>(
    messageKey(record.id, Number(latest.id)),
  );
  const provenance = await storage.get<StoredProvenance>(
    provenanceKey(record.id, latest.id),
  );
  const answerAt = current.case.contributions?.aiAnswerAt;
  if (
    !reply ||
    typeof reply.text !== "string" ||
    !reply.text.trim() ||
    reply.author !== principal ||
    !provenance ||
    provenance.v !== 1 ||
    provenance.case !== current.seq ||
    provenance.kind !== "reply" ||
    provenance.author !== principal ||
    provenance.ai?.reason !== "answer" ||
    provenance.ai.confidence !== "high" ||
    !Array.isArray(provenance.problems) ||
    provenance.problems.length ||
    !Number.isSafeInteger(provenance.at) ||
    !Number.isSafeInteger(answerAt) ||
    answerAt! < current.case.openedAt ||
    answerAt! > provenance.at ||
    provenance.at !== Date.parse(reply.createdAt) ||
    provenance.at < current.case.lastMemberAt ||
    provenance.at > context.now ||
    !current.case.billingReplies
  )
    throw new HttpError(
      409,
      "This case needs an accepted managed answer first.",
      undefined,
      "managed-close-answer",
    );
  if (await groundedPeriod(storage, context)) {
    const receiptId = provenance.ai.grounding?.receiptId;
    const checked =
      receiptId &&
      (await managedKnowledgeCall<{ ok: boolean }>(
        env,
        context.room,
        "grounded.verify",
        {
          receipt: receiptId,
          thread: record.id,
          case: current.seq,
          text: reply.text,
          sourceIds: provenance.ai.sources.map((source) => source.id),
          sources: provenance.ai.sources,
          grounding: provenance.ai.grounding,
          close: true,
          storageGrant: await storageReadGrant(
            storage,
            env as StorageBillingEnv,
            context.now,
          ),
        },
      ));
    if (!checked || !checked.ok) throw unavailable();
  } else {
    const golden = await managedKnowledgeCall<{ state: string }>(
      env,
      context.room,
      "golden.get",
    );
    if (golden.state !== "passed") throw unavailable();
  }
}

/** What the runner reads of one request before it answers. */
async function runnerState(
  storage: Storage,
  context: ConversationContext,
  deps: ManagedRouteDeps,
) {
  const thread = context.query.get("thread");
  const principal = await managedPrincipal(context.room);
  const settings = await readManagedSettings(storage);
  const grant = await managedGrant(storage, envOf(context), context.now, context.room);
  const paidPeriod = await groundedPeriod(storage, context);
  const base = {
    principal,
    prepaid: Boolean(paidPeriod),
    ...(paidPeriod && paidPeriod !== "sponsored" ? { prepaidModel: prepaidSupportModel(paidPeriod.aiRateCardVersion) } : {}),
    sponsoredResearch: paidPeriod === "sponsored",
    readinessPolicy: paidPeriod ? GROUNDED_POLICY : "golden_v1",
    enabled: settings.enabled,
    grant: grant.active,
    storageGrant: await storageReadGrant(
      storage,
      envOf(context) as StorageBillingEnv,
      context.now,
    ),
    onTeam: await onTeam(context, principal),
  };
  if (thread === null) return base;
  if (!THREAD.test(thread)) throw notFound();
  // The same predicate as every read: AI off hides the request (404).
  const { record } = await deps.authorize(thread);
  const { data, effective } = await readAiState(storage, record);
  const seq = data.caseSeq ?? 0;
  if (record.encryptedCases && await encryptedCaseExists(storage, record.id, seq)) throw notFound();
  const currentCase = seq
    ? await readCase(storage, { thread: record.id as CaseThreadId, seq })
    : null;
  const frame = seq ? await readCaseFrame(storage, record.id, seq) : null;
  const evidence = seq
    ? (await readCaseEvidence(storage, record.id, seq)).rows
    : [];
  const cryptoLookup =
    paidPeriod === "sponsored" && currentCase && effective.mode === "answers" &&
    (await cryptoChainFactsOn(storage, context))
      ? await cryptoLookupState(storage, record, {
          openedAt: currentCase.case.openedAt,
          memberMessages: currentCase.case.counts.memberMessages,
        })
      : null;
  // The chat language the member chose on the desk's page, bound to the newest message.
  const cryptoLanguage = paidPeriod === "sponsored" && currentCase
    ? await cryptoChatLanguageState(storage, context, record.id, seq)
    : null;
  return {
    ...base,
    ...(cryptoLookup ? { cryptoLookup } : {}),
    ...(cryptoLanguage ? { cryptoLanguage } : {}),
    thread: record.id,
    member: record.member,
    formerMembers: record.formerMembers ?? [],
    state: record.state,
    stopped: record.stopped,
    handoff: Boolean(record.handoff),
    mode: effective.mode,
    caseSeq: seq,
    caseOpenedAt: currentCase?.case.openedAt ?? null,
    caseMemberMessages: currentCase?.case.counts.memberMessages ?? null,
    sharedHashes: await sharedTransactionHashes(storage, record.id),
    frame,
    evidence,
    memberEvidence: seq
      ? (await readCaseEvidence(storage, record.id, seq, "agent")).rows
      : [],
    diagnoses: seq
      ? await currentChecks(
          storage,
          record.id,
          seq,
          enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
        )
      : [],
    diagnosisRunning: await diagnosisPending(
      storage,
      threadFacts(record, data),
      enabledFromHeader(context.headers.get(DIAGNOSIS_NETWORKS_HEADER)),
      context.now,
    ),
    clarifyingAsked: seq
      ? await clarifyingAsked(storage, record.id, seq, principal, context.room === "room:" + CRYPTO_SUPPORT_WORKSPACE)
      : 0,
  };
}

/** The newest check of each transaction in the case: a later check
 * replaces an earlier one, so only the newest one can hand the case to a
 * person. Stored checks come newest first. */
export async function currentChecks(
  storage: Storage,
  thread: string,
  seq: number,
  enabled: import("@templ/chat/diagnosis/types").DiagnosisNetwork[],
) {
  const stored = await readThreadDiagnoses(storage, thread as `tc-${string}`);
  const citable = new Map(
    (await citableDiagnoses(storage, thread, enabled)).map((item) => [
      item.id,
      item.numbers,
    ]),
  );
  return currentCaseChecks(stored, seq)
    .filter((row) => diagnosisNetworkEnabled(row.diagnosis, enabled))
    .map((row) => {
      const facts = modelDiagnosisFacts(row.diagnosis);
      return {
        id: row.id,
        section: row.section,
        status: row.diagnosis.status,
        reason: row.diagnosis.reason,
        needsPerson: row.diagnosis.needsPerson,
        subject: row.diagnosis.subject,
        reading: [
          facts.whatHappened,
          ...facts.findings,
          ...(facts.memberDraft ? [facts.memberDraft] : []),
        ],
        evidence: facts.memberEvidence.map((value) => ({
          section: "chain",
          observedAt: row.diagnosis.checkedAt,
          value,
        })),
        numbers: citable.get(row.id) ?? [],
      };
    });
}

async function dropJobs(storage: Pick<Storage, "list" | "delete">) {
  const listed = await storage.list({ prefix: MANAGED_JOB_PREFIX, limit: 128 });
  if (listed.size) await storage.delete([...listed.keys()]);
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

/** Wakes native AI for an eligible accepted human answer. This stays in
 * the reply transaction; the existing outbox makes model calls later. */
export async function wakeLearningJob(
  storage: Storage,
  context: ConversationContext,
  input: { id: string; thread: string; at: number; origin: ChatPrincipalId },
): Promise<void> {
  if (!(await readManagedSettings(storage)).enabled) return;
  if (input.origin !== await managedPrincipal(context.room)) return;
  if (!(await featureOn(envOf(context), storage, "handoffLearning"))) return;
  const id = crypto.randomUUID();
  const job: ManagedJob = {
    v: 1,
    id,
    kind: "handoff-learning",
    thread: input.thread,
    member: null,
    request: null,
    learningId: input.id,
    at: input.at,
  };
  await storage.put(`${MANAGED_JOB_PREFIX}${pad15(context.now)}:${id}`, job);
  await wake(storage, context.now + 500);
}

/** Queues the job a write asks for, in the write's own transaction: a
 * member's message, or a person's Ask AI question. Only while the manager
 * has managed AI on; one storage read otherwise. */
export async function queueManagedJob(
  storage: Storage,
  context: ConversationContext,
  deps: Pick<ManagedRouteDeps, "team">,
): Promise<void> {
  if (context.method !== "POST" || context.body.encryptedRecord !== undefined) return;
  const actor = context.viewer.principalId;
  if (!actor) return;
  const { pathname, body } = context;
  const write = WRITE.exec(pathname);
  let job: Omit<ManagedJob, "v" | "id" | "at"> | null = null;
  const person = !context.isBot;
  if (pathname === ASK && person && !deps.team)
    job = {
      kind: "member-message",
      thread: null,
      member: actor,
      request: null,
    };
  else if (write && write[2] === "messages" && person && !deps.team)
    job = {
      kind: "member-message",
      thread: write[1],
      member: null,
      request: null,
    };
  else if (
    write &&
    write[2] === "workflow" &&
    body.action === "draft-request" &&
    person &&
    deps.team &&
    typeof body.clientId === "string" &&
    CLIENT_ID.test(body.clientId.toLowerCase())
  )
    job = {
      kind: "ask-ai",
      thread: write[1],
      member: null,
      request: body.clientId.toLowerCase(),
    };
  if (!job) return;
  if (!(await readManagedSettings(storage)).enabled) return;
  const id = crypto.randomUUID();
  const stored: ManagedJob = { v: 1, id, at: context.now, ...job };
  await storage.put(`${MANAGED_JOB_PREFIX}${pad15(context.now)}:${id}`, stored);
  await wake(storage, context.now + 500);
  // The member sees "AI agent is typing" at once, as with an agent that
  // polls, but only when the managed agent will run: on the team, under a
  // grant, with Templ's switch on.
  if (job.kind === "member-message" && context.typing) {
    const env = envOf(context);
    const principal = await managedPrincipal(context.room);
    if (
      killSwitchOn(env) &&
      nativeModelAvailable(
        env,
        Boolean(await groundedPeriod(storage, context)),
      ) &&
      (await onTeam(context, principal)) &&
      (await managedGrant(storage, env, context.now, context.room)).active
    )
      context.typing.presence.note({
        principal,
        aliases: [principal],
        registeredBot: true,
        team: true,
        request: job.thread
          ? { thread: job.thread, sub: "messages" }
          : { filter: "needs-reply" },
        now: context.now,
      });
  }
}

function checkedJob(raw: unknown): ManagedJob | null {
  if (!raw || typeof raw !== "object") return null;
  const job = raw as ManagedJob;
  if (
    job.v !== 1 ||
    typeof job.id !== "string" ||
    !["ask-ai", "member-message", "handoff-learning"].includes(job.kind) ||
    !(job.thread === null || THREAD.test(job.thread)) ||
    !(
      job.member === null || normalizeChatPrincipal(job.member) === job.member
    ) ||
    !(job.request === null || CLIENT_ID.test(job.request)) ||
    !Number.isSafeInteger(job.at) ||
    (job.kind === "handoff-learning" &&
      (typeof job.learningId !== "string" || !/^[a-f0-9]{64}$/.test(job.learningId)))
  )
    return null;
  return job;
}

/** Room alarm consumer: hands queued jobs to the knowledge object, which
 * runs them in its own alarm. A job for a member's first message finds the
 * member's thread here. Jobs from a workspace that turned managed AI off
 * are dropped. */
export async function managedJobsAlarm(
  context: Pick<RoomAlarmContext, "state" | "env">,
  now: number,
): Promise<number | null> {
  const storage = context.state.storage;
  const listed = await storage.list<unknown>({
    prefix: MANAGED_JOB_PREFIX,
    limit: MANAGED_AGENT_LIMITS.jobsQueued,
  });
  if (!listed.size) return null;
  const settings = await readManagedSettings(storage);
  const native = await storage.get<{ room: { id: string; manager: string } }>(
    "native-room",
  );
  if (!settings.enabled || !native) {
    await storage.delete([...listed.keys()]);
    return null;
  }
  const jobs: ManagedJob[] = [];
  const pausedAt = await lastAssistantPause(storage);
  for (const raw of listed.values()) {
    const job = checkedJob(raw);
    if (!job || job.at <= pausedAt) continue;
    if (job.thread === null && job.member) {
      const thread = await storage.get<string>(
        `${MEMBER_THREAD_PREFIX}${job.member}`,
      );
      if (!thread || !THREAD.test(thread)) continue;
      job.thread = thread;
    }
    if (job.thread) {
      const record = await storage.get<TeamConversationRecord>(`conversation-v1:${job.thread}`);
      if (record?.encryptedCases && await encryptedCaseExists(storage, record.id, (await supportRecord(storage, record)).caseSeq ?? 0)) continue;
    }
    // One job per thread and kind: the latest message is what gets read.
    const same = jobs.findIndex(
      (other) =>
        other.thread === job.thread &&
        other.kind === job.kind &&
        other.request === job.request,
    );
    if (same >= 0) jobs[same] = job;
    else jobs.push(job);
  }
  const room = `room:${native.room.id}`;
  if (jobs.length)
    try {
      await managedKnowledgeCall(
        context.env as unknown as KnowledgeEnv,
        room,
        "jobs.add",
        { manager: native.room.manager, jobs },
      );
    } catch {
      return now + 60_000;
    }
  await storage.delete([...listed.keys()]);
  const more = await storage.list({ prefix: MANAGED_JOB_PREFIX, limit: 1 });
  return more.size ? now + 1_000 : null;
}
