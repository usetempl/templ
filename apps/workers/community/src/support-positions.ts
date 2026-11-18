/** Position reads and the proven-wallet legacy trigger.
 *
 * The team asks Templ to read the member's position in a vault or receipt
 * token from the protocol profile, at the proven wallet only: the one the
 * member proved with Sign-In With Ethereum or Sign In With Solana. A wallet
 * the member's app reported without proof is never read. The request is
 * queued; the room alarm reads the chain outside any storage transaction
 * through the transaction check's read layer and budget, and writes the
 * values as evidence rows on the request's case (source "chain"), labeled
 * with the product, the metric and the block.
 *
 * The legacy trigger reads the proven wallet's balances of older receipt
 * tokens in the profile; a holding brings that entry's legacy facts to the
 * team (trigger "wallet"). Members never see any of it, and nothing here
 * signs or sends. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type {
  LegacyFact,
  ProfileContract,
  ProfileMatch,
  ProfileStatus,
} from "@templ/chat/protocol-profile";
import type {
  SupportEvidence,
  SupportEvidenceInput,
} from "@templ/chat/support-evidence";
import type { SupportNetwork } from "@templ/chat/support";
import { HttpError, json } from "./common";
import { readProductSupport, PRODUCT_STATE_KEY } from "./product-entitlements";
import { createRpcBudget, RPC_BUDGET, type RpcBudgetEnv } from "./rpc-budget";
import { addCaseEvidence } from "./support-evidence-store";
import { legacyFactsFor } from "./legacy-facts";
import { knowledgeCall, type KnowledgeEnv } from "./support-knowledge-client";
import type { KnowledgeActor } from "./support-knowledge";
import { pad16 } from "./support-follow-ups";
import { enabledWatchNetworks } from "./support-watches";
import { supportRecord } from "./support-workflow";
import { readCase } from "./support-case-data";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import { wakeRoomAt } from "./room-alarm";
import { uuidv7 } from "./uuidv7";
import type { DiagnosisEnv } from "./tx-diagnosis/chains";
import {
  formatUnits,
  readEvmPosition,
  readSplBalance,
  type PositionReadDeps,
} from "./tx-diagnosis/positions";

type Storage = DurableObjectTransaction;
export const POSITION_JOB_PREFIX = "support-position-job-v1:";
export const POSITION_RESULT_PREFIX = "support-position-v1:";
const POSITION_QUOTA_PREFIX = "support-position-quota-v1:";
/** Position reads a workspace may queue per UTC day: the transaction
 * check's per-room daily limit, lower for a workspace never funded. */
export const POSITION_READS_PER_DAY = FEATURE_LIMITS.diagnosisRunsPerRoomPerDay;
export const FREE_POSITION_READS_PER_DAY =
  FEATURE_LIMITS.freeDiagnosisRunsPerRoomPerDay;
/** The day's limit, as the check decides it. */
export const positionReadsPerDay = (funded: boolean) =>
  funded ? POSITION_READS_PER_DAY : FREE_POSITION_READS_PER_DAY;
/** Older receipt tokens one legacy trigger reads at most. */
export const LEGACY_TOKENS_PER_READ = 8;
/** Position jobs one alarm invocation runs. */
export const POSITION_JOBS_PER_INVOCATION = 2;
const THREAD = /^tc-[0-9a-f]{32}$/;
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const JOB_KEY =
  /^support-position-job-v1:([0-9]{16}):(tc-[0-9a-f]{32}):([0-9a-f-]{36})$/;

export type PositionJob = {
  id: string;
  kind: "position" | "legacy";
  thread: string;
  seq: number;
  network: SupportNetwork;
  /** The profile entry to read (position only). */
  token: string | null;
  compareBlock: number | null;
  wallet: string;
  requestedBy: ChatPrincipalId;
  requestedByAgent: boolean;
  requestedAt: number;
};
export type PositionResult = {
  id: string;
  kind: "position" | "legacy";
  seq: number;
  network: SupportNetwork;
  state: "queued" | "done" | "unavailable";
  reason: string | null;
  /** Evidence row ids ("E<n>") the read wrote. */
  evidence: string[];
  /** Legacy trigger: older products the wallet holds. */
  legacyFacts?: LegacyFact[];
  /** These facts were read with the agent's profile audience. */
  agentView?: true;
  /** Generated evidence used the agent's member-safe profile view. */
  agentEvidence?: true;
  requestedAt: string;
  finishedAt: string | null;
};
const resultKey = (thread: string, id: string) =>
  `${POSITION_RESULT_PREFIX}${thread}:${id}`;
const jobKey = (at: number, thread: string, id: string) =>
  `${POSITION_JOB_PREFIX}${pad16(at)}:${thread}:${id}`;
const iso = (at: number) => new Date(at).toISOString();

function positionView(row: PositionResult, isBot: boolean) {
  if (!isBot || !row.legacyFacts) return row;
  return {
    ...row,
    legacyFacts:
      row.agentView === true && Array.isArray(row.legacyFacts)
        ? row.legacyFacts
            .filter((fact) => fact?.visibility === "member-safe")
            .map(({ staffNote: _note, ...fact }) => fact)
        : [],
  };
}

/** Position-generated rows keep their server-recorded audience. Ordinary
 * team-supplied case facts have no position result and remain available. */
export async function agentPositionEvidence(
  storage: Pick<Storage, "list">,
  thread: string,
  seq: number,
  rows: SupportEvidence[],
): Promise<SupportEvidence[]> {
  if (!rows.length) return rows;
  const results = await storage.list<PositionResult>({
    prefix: `${POSITION_RESULT_PREFIX}${thread}:`,
  });
  const hidden = new Set<string>();
  for (const result of results.values()) {
    if (
      !result ||
      !Number.isSafeInteger(result.seq) ||
      result.seq < 1 ||
      !Array.isArray(result.evidence) ||
      result.evidence.length > 50 ||
      !result.evidence.every(
        (id) => typeof id === "string" && /^E(?:[1-9]|[1-4][0-9]|50)$/.test(id),
      ) ||
      (result.agentEvidence !== undefined &&
        typeof result.agentEvidence !== "boolean")
    )
      throw new HttpError(503, "Case evidence could not be verified.");
    if (result.seq === seq && result.agentEvidence !== true)
      for (const id of result.evidence) hidden.add(id);
  }
  return rows.filter((row) => !hidden.has(row.id));
}

/** The member's proven wallet on a network family, or null. */
function provenWallet(
  data: Awaited<ReturnType<typeof supportRecord>>,
  network: SupportNetwork,
): string | null {
  const solana = network === "solana";
  const wallet = data.wallet as
    | { network?: string; address?: string }
    | undefined;
  if (wallet?.address) {
    const walletSolana = wallet.network === "solana";
    if (walletSolana === solana)
      return solana ? wallet.address : wallet.address.toLowerCase();
  }
  if (solana && data.appWallet?.network === "solana")
    return data.appWallet.address;
  return null;
}
const refusal = (status: number, reason: string, message: string) =>
  new HttpError(status, message, undefined, reason);

/** `GET|POST /conversations/<tc>/positions` for the team (people and the
 * registered AI agent). */
export async function positionRoute(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  rest: string | null,
): Promise<Response> {
  if (rest !== null) throw new HttpError(404, "Support tools not found.");
  if (context.method === "GET") {
    const rows = await storage.list<PositionResult>({
      prefix: `${POSITION_RESULT_PREFIX}${record.id}:`,
      reverse: true,
      limit: 10,
    });
    return json({
      positions: [...rows.values()].map((row) =>
        positionView(row, Boolean(context.isBot)),
      ),
      networks: enabledWatchNetworks(context.headers),
    });
  }
  if (context.method !== "POST")
    throw new HttpError(404, "Support tools not found.");
  const body = context.body;
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "clientId",
          "kind",
          "case",
          "network",
          "token",
          "compareBlock",
          "expectedPrincipalId",
        ].includes(key),
    )
  )
    throw refusal(
      400,
      "position-invalid",
      "This read has a field Templ doesn't know.",
    );
  const clientId =
    typeof body.clientId === "string" ? body.clientId.toLowerCase() : "";
  if (!CLIENT_ID.test(clientId))
    throw refusal(400, "position-invalid", "Send a valid read request id.");
  const kind =
    body.kind === "legacy"
      ? "legacy"
      : body.kind === undefined || body.kind === "position"
        ? "position"
        : null;
  if (!kind)
    throw refusal(400, "position-invalid", "Choose a position or legacy read.");
  const network = body.network as SupportNetwork;
  if (!enabledWatchNetworks(context.headers).includes(network))
    throw refusal(
      409,
      "position-network",
      "Templ doesn't read that network yet.",
    );
  const access = (await storage.get(PRODUCT_STATE_KEY))
    ? await readProductSupport(storage, context.now)
    : null;
  if (!access?.enabled)
    throw refusal(
      403,
      "support-paused",
      "Support is paused until the workspace's balance is topped up.",
    );
  const existing = await storage.get<PositionResult>(
    resultKey(record.id, clientId),
  );
  if (existing)
    return json(
      { position: positionView(existing, Boolean(context.isBot)) },
      200,
    );
  const data = await supportRecord(storage, record);
  const seq = body.case === undefined ? (data.caseSeq ?? 0) : Number(body.case);
  if (
    !Number.isSafeInteger(seq) ||
    seq < 1 ||
    !(await readCase(storage, { thread: record.id as `tc-${string}`, seq }))
  )
    throw refusal(404, "case-not-found", "Case not found.");
  const wallet = provenWallet(data, network);
  if (!wallet)
    throw refusal(
      409,
      "position-no-proof",
      "The user hasn't proven a wallet on this network, so Templ can't read their position.",
    );
  let token: string | null = null;
  if (kind === "position") {
    if (
      typeof body.token !== "string" ||
      (network === "solana"
        ? body.token.length > 44
        : !EVM_ADDRESS.test(body.token))
    )
      throw refusal(
        400,
        "position-token",
        "Choose a vault or token from your protocol profile.",
      );
    token = network === "solana" ? body.token : body.token.toLowerCase();
  }
  const compareBlock =
    body.compareBlock === undefined || body.compareBlock === null
      ? null
      : Number(body.compareBlock);
  if (
    compareBlock !== null &&
    (network === "solana" ||
      !Number.isSafeInteger(compareBlock) ||
      compareBlock < 1)
  )
    throw refusal(
      400,
      "position-block",
      "Choose an earlier block number on this chain.",
    );
  const day = iso(context.now).slice(0, 10);
  const used =
    (await storage.get<number>(`${POSITION_QUOTA_PREFIX}${day}`)) ?? 0;
  const limit = positionReadsPerDay(access.funded);
  if (used >= limit)
    throw refusal(
      429,
      "position-limit",
      `Templ read positions ${limit} times today in this workspace. More are available at 00:00 UTC.`,
    );
  await storage.put(`${POSITION_QUOTA_PREFIX}${day}`, used + 1);
  await storage.delete(
    `${POSITION_QUOTA_PREFIX}${iso(context.now - 2 * 86_400_000).slice(0, 10)}`,
  );
  const job: PositionJob = {
    id: clientId,
    kind,
    thread: record.id,
    seq,
    network,
    token,
    compareBlock,
    wallet,
    requestedBy: context.viewer.principalId!,
    requestedByAgent: Boolean(context.isBot),
    requestedAt: context.now,
  };
  const result: PositionResult = {
    id: clientId,
    kind,
    seq,
    network,
    state: "queued",
    reason: null,
    evidence: [],
    requestedAt: iso(context.now),
    finishedAt: null,
  };
  await storage.put(jobKey(context.now, record.id, clientId), job);
  await storage.put(resultKey(record.id, clientId), result);
  await wakeRoomAt(storage as never, context.now + 1_000);
  return json({ position: result }, 202);
}

/* ---------------------------------------------------------------------- */
/* Reads in the room alarm                                                  */
/* ---------------------------------------------------------------------- */

export type PositionReaders = {
  evm: typeof readEvmPosition;
  spl: typeof readSplBalance;
  profile(
    env: KnowledgeEnv,
    room: string,
    op: "lookup" | "legacy-tokens",
    args: { network: SupportNetwork; address?: string },
    actor: KnowledgeActor,
  ): Promise<ProfileMatch[]>;
  legacy: typeof legacyFactsFor;
};
export function positionReaders(deps: PositionReadDeps = {}): PositionReaders {
  return {
    evm: (env, input) => readEvmPosition(env, input, deps),
    spl: (env, input) => readSplBalance(env, input, deps),
    async profile(env, room, op, args, actor) {
      if (op === "lookup") {
        const { matches } = await knowledgeCall<{ matches: ProfileMatch[] }>(
          env,
          room,
          "profile.lookup",
          actor,
          { refs: [{ network: args.network, address: args.address }] },
        );
        return matches;
      }
      const out: ProfileMatch[] = [];
      for (const status of [
        "deprecated",
        "withdraw-only",
        "migrated",
      ] as ProfileStatus[]) {
        const { contracts } = await knowledgeCall<{
          contracts: ProfileContract[];
        }>(env, room, "profile.list", actor, {
          network: args.network,
          kind: "receipt-token",
          status,
        });
        for (const contract of contracts ?? [])
          out.push({ ...contract, successorLabel: null } as ProfileMatch);
        if (out.length >= LEGACY_TOKENS_PER_READ) break;
      }
      return out.slice(0, LEGACY_TOKENS_PER_READ);
    },
    legacy: legacyFactsFor,
  };
}
type Outcome =
  | { state: "done"; rows: SupportEvidenceInput[]; legacyFacts?: LegacyFact[] }
  | { state: "unavailable"; reason: string };
const SOURCE_LABEL = "Templ read, two providers";
function tokenLabel(entry: ProfileMatch | undefined, fallback: string) {
  return (entry?.label ?? fallback).slice(0, 60);
}
async function runJob(
  env: DiagnosisEnv & KnowledgeEnv,
  room: string,
  job: PositionJob,
  readers: PositionReaders,
  now: number,
): Promise<Outcome> {
  const time = iso(now);
  const actor: KnowledgeActor = {
    principal: job.requestedBy,
    role: job.requestedByAgent ? "bot" : "staff",
  };
  if (job.kind === "position") {
    const [entry] = await readers
      .profile(
        env,
        room,
        "lookup",
        {
          network: job.network,
          address: job.token!,
        },
        actor,
      )
      .catch(() => [] as ProfileMatch[]);
    if (!entry || !["vault", "receipt-token", "token"].includes(entry.kind))
      return { state: "unavailable", reason: "not-in-profile" };
    const product = {
      key: `${job.network}/${job.token}`,
      label: tokenLabel(entry, "Profile token"),
      address: job.token!,
      network: job.network,
    };
    if (job.network === "solana") {
      const read = await readers.spl(env, {
        owner: job.wallet,
        mint: job.token!,
      });
      if (read.kind !== "ok")
        return { state: "unavailable", reason: read.reason };
      const text = formatUnits(read.amount, entry.decimals ?? read.decimals);
      return {
        state: "done",
        rows: [
          {
            source: "chain",
            sourceLabel: SOURCE_LABEL,
            product,
            metric: { key: "token-balance", label: "token balance" },
            window: { key: "point", label: "at finalized commitment" },
            observed: { time },
            value: {
              text: `${text} ${entry.symbol ?? ""}`.trim().slice(0, 60),
              number: text,
              ...(entry.symbol ? { unit: entry.symbol.slice(0, 16) } : {}),
            },
          },
        ],
      };
    }
    const read = await readers.evm(env, {
      network: job.network as `eip155:${number}`,
      token: job.token!,
      wallet: job.wallet,
      conversion: entry.conversion ?? null,
      compareBlock: job.compareBlock,
    });
    if (read.kind !== "ok")
      return { state: "unavailable", reason: read.reason };
    const decimals = entry.decimals ?? 18;
    const rows: SupportEvidenceInput[] = [];
    const add = (
      block: number,
      key: string,
      label: string,
      raw: string,
      unit: string | null,
    ) => {
      const text = formatUnits(raw, decimals);
      rows.push({
        source: "chain",
        sourceLabel: SOURCE_LABEL,
        product,
        metric: { key, label },
        window: { key: "point", label: "at one block" },
        observed: { block, time },
        value: {
          text: `${text}${unit ? ` ${unit}` : ""}`.slice(0, 60),
          number: text,
          ...(unit ? { unit: unit.slice(0, 16) } : {}),
        },
      });
    };
    for (const point of read.points) {
      add(point.block, "shares", "share balance", point.shares, entry.symbol);
      if (point.assets !== null)
        add(point.block, "assets", "position value", point.assets, null);
      if (point.pricePerShare !== null)
        add(
          point.block,
          "price-per-share",
          "price per share",
          point.pricePerShare,
          null,
        );
      if (point.totalAssets !== null)
        add(
          point.block,
          "total-assets",
          "vault total assets",
          point.totalAssets,
          null,
        );
    }
    return { state: "done", rows: rows.slice(0, 10) };
  }
  // Legacy trigger: older receipt tokens the proven wallet holds.
  const tokens = await readers
    .profile(env, room, "legacy-tokens", { network: job.network }, actor)
    .catch(() => [] as ProfileMatch[]);
  if (!tokens.length) return { state: "done", rows: [], legacyFacts: [] };
  const held: ProfileMatch[] = [];
  const rows: SupportEvidenceInput[] = [];
  for (const token of tokens.slice(0, LEGACY_TOKENS_PER_READ)) {
    let raw: string | null = null;
    let decimals = token.decimals ?? 18;
    if (job.network === "solana") {
      const read = await readers.spl(env, {
        owner: job.wallet,
        mint: token.address,
      });
      if (read.kind !== "ok")
        return { state: "unavailable", reason: read.reason };
      raw = read.amount;
      decimals = token.decimals ?? read.decimals;
    } else {
      const read = await readers.evm(env, {
        network: job.network as `eip155:${number}`,
        token: token.address,
        wallet: job.wallet,
        conversion: null,
        compareBlock: null,
      });
      if (read.kind !== "ok")
        return { state: "unavailable", reason: read.reason };
      raw = read.points[0]?.shares ?? "0";
      const point = read.points[0];
      if (point && BigInt(point.shares) > 0n && rows.length < 10) {
        const text = formatUnits(point.shares, decimals);
        rows.push({
          source: "chain",
          sourceLabel: SOURCE_LABEL,
          product: {
            key: `${job.network}/${token.address}`,
            label: tokenLabel(token, "Older token"),
            address: token.address,
            network: job.network,
          },
          metric: { key: "shares", label: "share balance" },
          window: { key: "point", label: "at one block" },
          observed: { block: point.block, time: iso(now) },
          value: { text, number: text },
        });
      }
    }
    if (raw !== null && BigInt(raw) > 0n) {
      held.push(token);
      if (job.network === "solana" && rows.length < 10) {
        const text = formatUnits(raw, decimals);
        rows.push({
          source: "chain",
          sourceLabel: SOURCE_LABEL,
          product: {
            key: `${job.network}/${token.address}`,
            label: tokenLabel(token, "Older token"),
            address: token.address,
            network: job.network,
          },
          metric: { key: "token-balance", label: "token balance" },
          window: { key: "point", label: "at finalized commitment" },
          observed: { time: iso(now) },
          value: { text, number: text },
        });
      }
    }
  }
  const { legacyFacts } = held.length
    ? await readers
        .legacy(
          env,
          room,
          {
            principal: job.requestedBy,
            role: job.requestedByAgent ? "bot" : "staff",
          },
          held.map((token) => ({
            ref: { network: token.network, address: token.address },
            trigger: "wallet" as const,
          })),
        )
        .catch(() => ({ legacyFacts: [] as LegacyFact[] }))
    : { legacyFacts: [] as LegacyFact[] };
  return { state: "done", rows, legacyFacts };
}
async function commitJob(
  storage: Storage,
  job: PositionJob,
  outcome: Outcome,
  now: number,
) {
  const key = resultKey(job.thread, job.id);
  const result = await storage.get<PositionResult>(key);
  if (!result) return;
  const record = await storage.get<TeamConversationRecord>(
    `conversation-v1:${job.thread}`,
  );
  if (!record || record.deleting) {
    await storage.delete(key);
    return;
  }
  if (outcome.state === "unavailable") {
    await storage.put(key, {
      ...result,
      state: "unavailable",
      reason: outcome.reason,
      finishedAt: iso(now),
    });
    return;
  }
  let evidence: string[] = [];
  if (outcome.rows.length) {
    try {
      const written = await addCaseEvidence(storage, {
        thread: job.thread,
        seq: job.seq,
        rows: outcome.rows,
        clientId: job.id,
        writer: {
          by: job.requestedByAgent ? "agent" : "person",
          author: job.requestedBy,
        },
        attachments: [],
        now,
      });
      evidence = written.rows.map((row) => row.id);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await storage.put(key, {
        ...result,
        state: "unavailable",
        reason: error.reason ?? "evidence-refused",
        finishedAt: iso(now),
      });
      return;
    }
  }
  await storage.put(key, {
    ...result,
    state: "done",
    reason: null,
    evidence,
    ...(job.requestedByAgent ? { agentEvidence: true as const } : {}),
    ...(outcome.legacyFacts
      ? {
          legacyFacts: outcome.legacyFacts,
          ...(job.requestedByAgent ? { agentView: true as const } : {}),
        }
      : {}),
    finishedAt: iso(now),
  });
}
/** Runs up to POSITION_JOBS_PER_INVOCATION queued reads. Called by the
 * `support-watches` alarm consumer; returns its next due time or null. */
export async function runPositionJobs(
  context: {
    state: DurableObjectState;
    env: DiagnosisEnv & KnowledgeEnv & { ROOMS?: DurableObjectNamespace };
  },
  now: number,
  readers: PositionReaders = positionReaders(),
): Promise<number | null> {
  const { state } = context;
  const native = await state.storage.get<{ room: { id: string } }>(
    "native-room",
  );
  if (!native) return null;
  const room = `room:${native.room.id}`;
  const rows = await state.storage.list<PositionJob>({
    prefix: POSITION_JOB_PREFIX,
    limit: POSITION_JOBS_PER_INVOCATION + 1,
  });
  let ran = 0;
  for (const [key, job] of rows) {
    if (ran >= POSITION_JOBS_PER_INVOCATION) break;
    const match = JOB_KEY.exec(key);
    await state.storage.delete(key);
    if (!match || !job || !THREAD.test(job.thread)) continue;
    ran++;
    const budgetEnv = {
      ...context.env,
      ...(context.env.ROOMS
        ? { [RPC_BUDGET]: createRpcBudget(context.env as never) }
        : {}),
    } as DiagnosisEnv & KnowledgeEnv & RpcBudgetEnv;
    if (context.env.ROOMS && budgetEnv[RPC_BUDGET])
      budgetEnv[RPC_BUDGET].setRoom(context.env.ROOMS.get(state.id), native.room.id, work => state.waitUntil(work()));
    let outcome: Outcome;
    try {
      outcome = await runJob(budgetEnv, room, job, readers, Date.now());
    } catch {
      outcome = { state: "unavailable", reason: "provider-error" };
    }
    await state.storage.transaction((tx) =>
      commitJob(tx, job, outcome, Date.now()),
    );
  }
  return rows.size > ran ? now + 1_000 : null;
}
/** A deleted thread's position results and queued reads. */
export async function deleteThreadPositions(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  let deleted = 0;
  const results = await storage.list({
    prefix: `${POSITION_RESULT_PREFIX}${thread}:`,
    limit: budget,
  });
  for (const key of results.keys()) if (await storage.delete(key)) deleted++;
  const jobs = await storage.list({ prefix: POSITION_JOB_PREFIX, limit: 200 });
  for (const key of jobs.keys())
    if (
      deleted < budget &&
      key.includes(`:${thread}:`) &&
      (await storage.delete(key))
    )
      deleted++;
  return deleted;
}
