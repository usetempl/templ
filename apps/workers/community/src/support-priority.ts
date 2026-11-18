import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import type { ChatPrincipalId, AuthMethod } from "@templ/chat/principal";
import {
  beginPriorityCaptureWindow,
  type PriorityCaptureEnv,
} from "./priority-trial-capture";
import { isSolanaAddress } from "@templ/chat/solana";
import {
  profileAddress,
  profileNetwork,
  profileKey,
  type ProfileMatch,
  type ProfileContract,
} from "@templ/chat/protocol-profile";
import {
  PRIORITY_CACHE_MS,
  PRIORITY_CONTRACT_LIMIT,
  PRIORITY_COPY,
  PRIORITY_HANDOFF_LABELS,
  PRIORITY_DEFAULTS,
  type PriorityCase,
  type PriorityPosition,
  type PrioritySettings,
} from "@templ/chat/support-priority";
import { HttpError, json } from "./common";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import { positionReadsPerDay } from "./support-positions";
import { readProductSupport } from "./product-entitlements";
import { readCase } from "./support-case-data";
import {
  openIndexReady,
  openIndexRecords,
  LIST_SCAN_RECORDS,
} from "./support-open-index";
import {
  supportRecord,
  readSupportSummary,
  teamSummaryInput,
  type SupportRecord,
} from "./support-workflow";
import {
  conversationAuthority,
  conversationView,
  canReadConversation,
  readConversation,
  type ConversationContext,
  type TeamConversationRecord,
} from "./team-conversations";
import { featureOn } from "./workspace-flags";
import {
  PRIORITY_DEPOSIT_SCOPE,
  priorityDepositInScope,
  priorityNetworkInScope,
} from "./support-priority-scope";

type Storage = DurableObjectTransaction;
export const PRIORITY_SETTINGS_KEY = "support-priority-settings-v1";
export const PRIORITY_POSITION_PREFIX = "support-priority-position-v1:";
export const PRIORITY_PROOF_PREFIX = "support-priority-proof-v1:";
export const PRIORITY_PENDING_PREFIX = "support-priority-pending-v1:";
const LEASE_PREFIX = "support-priority-lease-v1:";
export const PRIORITY_PHASE_HEADER = "X-Support-Priority-Phase";
const THREAD_PATH = /^\/conversations\/(tc-[0-9a-f]{32})\/priority$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
type Wallet = PriorityPosition["wallet"];
type Proof = { room: string; wallet: Wallet };
type CachedPosition = {
  proof: Proof;
  contracts: string;
  position: PriorityPosition;
  checkedAt: number;
};
export type PriorityReadPlan = {
  depositScope: typeof PRIORITY_DEPOSIT_SCOPE;
  thread: string;
  room: string;
  wallet: Wallet;
  settings: PrioritySettings;
  lease: string;
};
export const priorityContractsKey = (
  settings: Pick<PrioritySettings, "contracts">,
) =>
  `${PRIORITY_DEPOSIT_SCOPE}:deposits:${settings.contracts.map(profileKey).sort().join("|")}`;
const sameWallet = (a: Wallet, b: Wallet) =>
  a.network === b.network && a.address === b.address;
const sameProof = (a: Proof, b: Proof) =>
  a.room === b.room && sameWallet(a.wallet, b.wallet);
const staffError = () => new HttpError(403, "You need current team access.");

export async function prioritySettings(
  storage: Pick<Storage, "get">,
): Promise<PrioritySettings> {
  return (
    (await storage.get<PrioritySettings>(PRIORITY_SETTINGS_KEY)) ?? {
      ...PRIORITY_DEFAULTS,
      contracts: [],
    }
  );
}

export function checkedPrioritySettings(
  body: Record<string, unknown>,
): PrioritySettings {
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "topHolderUsd",
          "largeHolderUsd",
          "replyTargetMinutes",
          "contracts",
          "expectedPrincipalId",
        ].includes(key),
    )
  )
    throw new HttpError(400, "Choose known priority settings.");
  const { topHolderUsd, largeHolderUsd, replyTargetMinutes, contracts } = body;
  if (
    typeof topHolderUsd !== "number" ||
    !Number.isFinite(topHolderUsd) ||
    topHolderUsd <= 0 ||
    topHolderUsd > 1e12 ||
    typeof largeHolderUsd !== "number" ||
    !Number.isFinite(largeHolderUsd) ||
    largeHolderUsd <= 0 ||
    largeHolderUsd >= topHolderUsd
  )
    throw new HttpError(
      400,
      "Top deposits must be above Large deposits. Use positive USD values.",
    );
  if (
    !Number.isSafeInteger(replyTargetMinutes) ||
    Number(replyTargetMinutes) < 1 ||
    Number(replyTargetMinutes) > 1440
  )
    throw new HttpError(400, "Choose a reply target from 1 to 1,440 minutes.");
  if (!Array.isArray(contracts) || contracts.length > PRIORITY_CONTRACT_LIMIT)
    throw new HttpError(400, "Choose up to 16 deposit contracts.");
  const seen = new Set<string>();
  const refs = contracts.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, "Choose a deposit contract.");
    const input = value as Record<string, unknown>;
    const network = profileNetwork(input.network);
    const address = network ? profileAddress(network, input.address) : null;
    if (
      !network ||
      !priorityNetworkInScope(network) ||
      !address ||
      Object.keys(input).some((key) => !["network", "address"].includes(key))
    )
      throw new HttpError(400, "Choose a deposit contract.");
    const ref = { network, address };
    if (seen.has(profileKey(ref)))
      throw new HttpError(400, "Choose each deposit contract once.");
    seen.add(profileKey(ref));
    return ref;
  });
  if (new Set(refs.map((ref) => ref.network)).size > 8)
    throw new HttpError(400, "Choose up to 8 networks.");
  return {
    topHolderUsd,
    largeHolderUsd,
    replyTargetMinutes: Number(replyTargetMinutes),
    contracts: refs,
  };
}

/** The workspace stores proof separately from all member-facing records. */
export async function priorityProof(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
  data: SupportRecord,
): Promise<Proof | null> {
  const stored = await storage.get<Proof>(
    `${PRIORITY_PROOF_PREFIX}${record.id}`,
  );
  if (stored?.room === record.room && stored.wallet?.address) return stored;
  if (data.wallet?.address && data.wallet.authenticatedAt && data.wallet.origin)
    return {
      room: record.room,
      wallet: {
        network: data.wallet.network === "solana" ? "solana" : "evm",
        address:
          data.wallet.network === "solana"
            ? data.wallet.address
            : data.wallet.address.toLowerCase(),
      },
    };
  if (data.appWallet && isSolanaAddress(data.appWallet.address))
    return {
      room: record.room,
      wallet: { network: "solana", address: data.appWallet.address },
    };
  return null;
}

export async function rememberPriorityProof(
  storage: Storage,
  record: TeamConversationRecord,
  wallet: Wallet,
): Promise<void> {
  if (
    (wallet.network !== "evm" && wallet.network !== "solana") ||
    (wallet.network === "evm"
      ? !EVM.test(wallet.address)
      : !isSolanaAddress(wallet.address))
  )
    return;
  const proof: Proof = {
    room: record.room,
    wallet: {
      ...wallet,
      address:
        wallet.network === "evm"
          ? wallet.address.toLowerCase()
          : wallet.address,
    },
  };
  const previous = await storage.get<Proof>(
    `${PRIORITY_PROOF_PREFIX}${record.id}`,
  );
  await storage.put(`${PRIORITY_PROOF_PREFIX}${record.id}`, proof);
  if (!previous || !sameProof(previous, proof))
    await storage.put(`${PRIORITY_PENDING_PREFIX}${record.id}`, true);
}

/** Headers come from the worker's checked wallet session, never chat text. */
export async function rememberPrioritySession(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  data: SupportRecord,
): Promise<void> {
  if (!featureOn(context.mediaEnv, undefined, "priorityFeed")) return;
  if (context.headers.get("X-Support-Widget") === "member") {
    if (
      context.headers.get("X-Support-Access-Level") === "signed" &&
      data.wallet
    )
      await rememberPriorityProof(storage, record, {
        network: data.wallet.network === "solana" ? "solana" : "evm",
        address: data.wallet.address,
      });
    return;
  }
  const method = context.headers.get(
    "X-Session-Auth-Method",
  ) as AuthMethod | null;
  const at = Number(context.headers.get("X-Session-Authenticated-At"));
  if (!Number.isSafeInteger(at) || at <= 0 || at > context.now) return;
  const address =
    method === "wallet"
      ? context.headers.get("X-Verified-Wallet")
      : method === "solana"
        ? context.headers.get("X-Verified-Solana-Wallet")
        : null;
  if (address)
    await rememberPriorityProof(storage, record, {
      network: method === "solana" ? "solana" : "evm",
      address,
    });
}

export async function cachedPriorityPosition(
  storage: Pick<Storage, "get">,
  record: TeamConversationRecord,
  proof: Proof | null,
  settings: PrioritySettings,
): Promise<PriorityPosition | undefined> {
  if (!proof) return undefined;
  const cache = await storage.get<CachedPosition>(
    `${PRIORITY_POSITION_PREFIX}${record.id}`,
  );
  return cache &&
    sameProof(cache.proof, proof) &&
    cache.contracts === priorityContractsKey(settings)
    ? cache.position
    : undefined;
}

export function priorityScore(input: {
  thread: string;
  caseSeq: number;
  verified: boolean;
  claimedWallet: boolean;
  position?: PriorityPosition;
  waitingSince: number;
  reopened: boolean;
  repeat: boolean;
  handoff: string | null;
  settings: PrioritySettings;
  now: number;
}): PriorityCase {
  let score = 0;
  const reasons: string[] = [];
  let tier: PriorityCase["tier"];
  if (input.verified) {
    reasons.push(PRIORITY_COPY.verified);
    if (input.position?.state === "ready" && input.position.usd !== null) {
      const usd = input.position.usd;
      if (usd >= input.settings.topHolderUsd) {
        tier = PRIORITY_COPY.topHolder;
        score += 400;
      } else if (usd >= input.settings.largeHolderUsd) {
        tier = PRIORITY_COPY.largeHolder;
        score += 200;
      }
      reasons.push(
        usd > 0 ? `Deposits about $${compactUsd(usd)}` : "Deposits $0",
      );
    } else if (input.position?.state === "unavailable") {
      reasons.push("Deposits unavailable");
    }
  }
  const minutes = Math.max(
    0,
    Math.floor((input.now - input.waitingSince) / 60_000),
  );
  reasons.push(`Waiting ${minutes} min`);
  score += Math.min(1e6, (minutes / input.settings.replyTargetMinutes) * 100);
  if (input.reopened) {
    reasons.push(PRIORITY_COPY.reopened);
    score += 80;
  }
  if (input.repeat) {
    reasons.push(PRIORITY_COPY.repeat);
    score += 40;
  }
  if (input.handoff && Object.hasOwn(PRIORITY_HANDOFF_LABELS, input.handoff)) {
    reasons.push(
      PRIORITY_HANDOFF_LABELS[
        input.handoff as keyof typeof PRIORITY_HANDOFF_LABELS
      ],
    );
    score +=
      input.handoff === "safety"
        ? 120
        : input.handoff === "transaction"
          ? 90
          : input.handoff === "person"
            ? 60
            : 40;
  }
  return {
    thread: input.thread,
    caseSeq: input.caseSeq,
    score,
    reasons,
    claimedWallet: input.claimedWallet,
    ...(input.verified && input.position ? { position: input.position } : {}),
    ...(tier ? { tier } : {}),
  };
}

function compactUsd(value: number): string {
  if (value >= 1e9) return `${Number((value / 1e9).toFixed(1))}B`;
  if (value >= 1e6) return `${Number((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `${Number((value / 1e3).toFixed(1))}k`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

async function staffAccess(
  storage: Storage,
  context: ConversationContext,
  thread?: string,
) {
  if (
    context.isBot ||
    context.headers.get("X-Support-Widget") === "member" ||
    !conversationAuthority(context.viewer).team
  )
    throw staffError();
  if (thread && !(await canReadConversation(storage, context, thread)))
    throw staffError();
}

export async function priorityRoute(
  storage: Storage,
  context: ConversationContext,
): Promise<Response | null> {
  const feed = context.pathname === "/conversations/priorities";
  const settingsRoute = context.pathname === "/conversations/priority-settings";
  const thread = THREAD_PATH.exec(context.pathname)?.[1];
  if (!feed && !settingsRoute && !thread) return null;
  await staffAccess(storage, context, thread);
  if (!featureOn(context.mediaEnv, undefined, "priorityFeed"))
    throw new HttpError(404, "Support tools not found.");
  if (settingsRoute) {
    if (context.method === "GET") {
      const contracts: ProfileContract[] = [];
      if (canManageWorkspace(context.viewer, context.isBot)) {
        let after: string | undefined;
        do {
          const page = await knowledgeCall<{
            contracts: ProfileContract[];
            next: string | null;
          }>(
            context.mediaEnv as KnowledgeEnv,
            context.room,
            "profile.list",
            { principal: context.viewer.principalId!, role: context.viewer.isManager ? "manager" : "staff", workspaceAdmin: true },
            { after },
          );
          contracts.push(...page.contracts.filter(priorityDepositInScope));
          after = page.next ?? undefined;
        } while (after && contracts.length < 10_000);
      }
      return json({ settings: await prioritySettings(storage), contracts });
    }
    if (context.method !== "POST")
      throw new HttpError(404, "Support tools not found.");
    if (!canManageWorkspace(context.viewer, context.isBot))
      throw new HttpError(
        403,
        "Only workspace admins can change priority settings.",
      );
    if (!context.viewer.isManager)
      requireWorkspaceAdminHeaders(context.headers, false, true, context.now);
    const settings = checkedPrioritySettings(context.body);
    if (settings.contracts.length) {
      const { matches } = await knowledgeCall<{ matches: ProfileMatch[] }>(
        context.mediaEnv as KnowledgeEnv,
        context.room,
        "profile.lookup",
        { principal: context.viewer.principalId!, role: context.viewer.isManager ? "manager" : "staff", workspaceAdmin: true },
        { refs: settings.contracts },
      );
      if (
        settings.contracts.some(
          (ref) =>
            !matches.some(
              (entry) =>
                profileKey(entry) === profileKey(ref) &&
                priorityDepositInScope(entry),
            ),
        )
      )
        throw new HttpError(
          400,
          "Choose supported deposit contracts from your app profile.",
        );
    }
    await storage.put(PRIORITY_SETTINGS_KEY, settings);
    context.pendingAudit.push({
      actor: context.viewer.principalId!,
      action: "support.settings",
      target: "priority",
      after: {
        fields: [
          "topHolderUsd",
          "largeHolderUsd",
          "replyTargetMinutes",
          "contracts",
        ],
        contracts: settings.contracts.length,
      },
    });
    return json({ settings });
  }
  if (thread) {
    const record = await readConversation(storage, thread);
    if (!record || record.room !== context.room) throw staffError();
    const phase = context.headers.get(PRIORITY_PHASE_HEADER);
    if (phase === "prepare") {
      const plan = await preparePriorityRead(
        storage,
        record,
        context.now,
        "open",
        context.viewer.principalId!,
      );
      let capture = null;
      try {
        const proof = await priorityProof(
          storage,
          record,
          await supportRecord(storage, record),
        );
        capture = await beginPriorityCaptureWindow(
          storage,
          context.mediaEnv as PriorityCaptureEnv,
          {
            thread,
            wallet: proof?.wallet ?? null,
            contracts: (await prioritySettings(storage)).contracts,
          },
          context.now,
        );
      } catch {
        /* An unavailable capture cannot change ordinary case access. */
      }
      return json({ plan, ...(capture ? { capture } : {}) });
    }
    if (phase === "commit")
      return json({
        saved: await commitPriorityRead(
          storage,
          context.body,
          context.now,
          context.viewer.principalId!,
        ),
      });
    throw new HttpError(404, "Support tools not found.");
  }
  if (context.method !== "GET")
    throw new HttpError(404, "Support tools not found.");
  const settings = await prioritySettings(storage);
  const rows = (await openIndexReady(storage))
    ? await openIndexRecords(storage, null)
    : await storage.list<TeamConversationRecord>({
        prefix: "conversation-v1:",
        limit: LIST_SCAN_RECORDS,
      });
  const cases: PriorityCase[] = [];
  const summaryInput = await teamSummaryInput(storage, context);
  for (const raw of rows.values()) {
    const record = raw as TeamConversationRecord;
    if (
      !record?.id ||
      record.room !== context.room ||
      record.state !== "open" ||
      record.deleting ||
      record.archivedAt ||
      !(await canReadConversation(storage, context, record.id))
    )
      continue;
    const summary = await readSupportSummary(
      storage,
      record,
      context.viewer.principalId!,
      summaryInput,
    );
    if (
      summary.turn !== "person" ||
      !["open", "waiting"].includes(summary.state)
    )
      continue;
    const data = await supportRecord(storage, record);
    const proof = await priorityProof(storage, record, data);
    const position = await cachedPriorityPosition(
      storage,
      record,
      proof,
      settings,
    );
    const caseData = data.caseSeq
      ? (
          await readCase(storage, {
            thread: record.id as `tc-${string}`,
            seq: data.caseSeq,
          })
        )?.case
      : null;
    const priority = priorityScore({
      thread: record.id,
      caseSeq: data.caseSeq ?? 0,
      verified: Boolean(proof),
      claimedWallet: !proof && Boolean(data.access?.claimedWallet),
      position,
      waitingSince:
        data.awaitingSince ?? data.lastMemberMessageAt ?? record.createdAt,
      reopened: Boolean(caseData?.reopens),
      repeat:
        (data.caseSeq ?? 0) > 1 || Boolean(record.linkedConversations?.length),
      handoff: record.handoff?.reason ?? null,
      settings,
      now: context.now,
    });
    priority.conversation = {
      ...conversationView(
        record,
        "team",
        context.viewer,
        context.headers.get("X-Conversations") === "true",
        { aliases: context.aliases, canClaim: true },
      ),
      support: summary,
    };
    cases.push(priority);
  }
  cases.sort((a, b) => b.score - a.score || a.thread.localeCompare(b.thread));
  return json({ cases, settings });
}

export async function preparePriorityRead(
  storage: Storage,
  record: TeamConversationRecord,
  now: number,
  reason: "verification" | "open",
  actor: ChatPrincipalId | null = null,
): Promise<PriorityReadPlan | null> {
  const proof = await priorityProof(
    storage,
    record,
    await supportRecord(storage, record),
  );
  if (!proof || record.deleting) return null;
  const settings = await prioritySettings(storage);
  if (!settings.contracts.length) return null;
  const cached = await cachedPriorityPosition(storage, record, proof, settings);
  const cachedRow = await storage.get<CachedPosition>(
    `${PRIORITY_POSITION_PREFIX}${record.id}`,
  );
  if (
    reason === "open" &&
    cachedRow &&
    sameProof(cachedRow.proof, proof) &&
    cachedRow.contracts === priorityContractsKey(settings) &&
    now - cachedRow.checkedAt <= PRIORITY_CACHE_MS
  )
    return null;
  if (
    cached &&
    (reason === "verification" ||
      (cachedRow && now - cachedRow.checkedAt <= PRIORITY_CACHE_MS))
  )
    return null;
  const active = await storage.get<{ expires: number; depositScope?: string }>(
    `${LEASE_PREFIX}${record.id}`,
  );
  if (active?.depositScope === PRIORITY_DEPOSIT_SCOPE && active.expires > now)
    return null;
  const day = new Date(now).toISOString().slice(0, 10);
  const quotaKey = `support-position-quota-v1:${day}`;
  const used = (await storage.get<number>(quotaKey)) ?? 0;
  const coverage = await readProductSupport(storage, now);
  if (used >= positionReadsPerDay(coverage.funded)) return null;
  await storage.put(quotaKey, used + 1);
  await storage.delete(
    `support-position-quota-v1:${new Date(now - 2 * 86_400_000).toISOString().slice(0, 10)}`,
  );
  const lease = crypto.randomUUID();
  const plan: PriorityReadPlan = {
    depositScope: PRIORITY_DEPOSIT_SCOPE,
    thread: record.id,
    room: record.room,
    wallet: proof.wallet,
    settings,
    lease,
  };
  await storage.put(`${LEASE_PREFIX}${record.id}`, {
    ...plan,
    actor,
    expires: now + 60_000,
  });
  return plan;
}

export async function commitPriorityRead(
  storage: Storage,
  body: Record<string, unknown>,
  now: number,
  actor: ChatPrincipalId | null = null,
): Promise<boolean> {
  if (typeof body.thread !== "string" || typeof body.lease !== "string")
    return false;
  const key = `${LEASE_PREFIX}${body.thread}`;
  const held = await storage.get<
    PriorityReadPlan & { actor: ChatPrincipalId | null; expires: number }
  >(key);
  if (
    !held ||
    held.depositScope !== PRIORITY_DEPOSIT_SCOPE ||
    held.lease !== body.lease ||
    held.actor !== actor ||
    held.expires < now
  )
    return false;
  await storage.delete(key);
  const record = await readConversation(storage, body.thread);
  if (!record || record.deleting || record.room !== held.room) return false;
  const proof = await priorityProof(
    storage,
    record,
    await supportRecord(storage, record),
  );
  const settings = await prioritySettings(storage);
  if (
    !proof ||
    !sameWallet(proof.wallet, held.wallet) ||
    priorityContractsKey(settings) !== priorityContractsKey(held.settings)
  )
    return false;
  const position = body.position as PriorityPosition | undefined;
  if (
    !position ||
    !sameWallet(position.wallet, held.wallet) ||
    !["ready", "unavailable"].includes(position.state) ||
    typeof position.estimated !== "boolean" ||
    (position.usd !== null &&
      (typeof position.usd !== "number" ||
        !Number.isFinite(position.usd) ||
        position.usd < 0)) ||
    !Number.isFinite(Date.parse(position.asOf)) ||
    Date.parse(position.asOf) > now + 1000
  )
    return false;
  await storage.put(`${PRIORITY_POSITION_PREFIX}${record.id}`, {
    proof,
    contracts: priorityContractsKey(settings),
    position,
    checkedAt: now,
  } satisfies CachedPosition);
  return true;
}

export async function deleteThreadPriority(
  storage: Pick<Storage, "delete">,
  thread: string,
): Promise<void> {
  for (const prefix of [
    PRIORITY_POSITION_PREFIX,
    PRIORITY_PROOF_PREFIX,
    PRIORITY_PENDING_PREFIX,
    LEASE_PREFIX,
  ])
    await storage.delete(`${prefix}${thread}`);
}
