/** Stored transaction diagnoses, read by the inbox panel, registered AI
 * agents, follow-ups and watches, and resolved for `[dx:<id>]` citations. A
 * diagnosis states facts; it never suggests next steps to an agent. Reads
 * grant nothing: the caller has already checked the reader's current access
 * to the thread.
 *
 * The room half of a check: it plans (authorize, cache, quotas, lease) and
 * commits (re-authorize, validate, run the engine on the read input, store).
 * Chain reads happen outside the room transaction, at the edge for a person
 * or an agent and in the room alarm for automatic runs. This module never
 * imports the read layer, so room code cannot reach a provider. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { claimSet } from "@templ/chat/diagnosis/claims";
import type { CitableDiagnosis } from "@templ/chat/support-citations";
import { diagnose, parseStoredDiagnosis } from "@templ/chat/diagnosis/diagnose";
import {
  networkInfo,
  networkName,
  parseNetwork,
} from "@templ/chat/diagnosis/networks";
import { STATUS_CHIPS } from "@templ/chat/diagnosis/rules";
import type {
  Diagnosis,
  DiagnosisInput,
  DiagnosisNetwork,
  EvmNetwork,
  EvmPreviousSighting,
  Hex,
  NetworkHint,
  SolanaCommitment,
  SolanaHeight,
  WalletFacts,
} from "@templ/chat/diagnosis/types";
import {
  isEvmTransactionHash,
  isSolanaSignature,
  parseSupportNetwork,
  parseTransactionReference,
  readStoredSupportContext,
} from "@templ/chat/support-context";
import {
  DIAGNOSIS_CLIENT_ID,
  DIAGNOSIS_MIN_RERUN_MS,
  SUPPORT_DIAGNOSIS_RATINGS,
  diagnosisFreshForMs,
  diagnosisEvidenceSection,
  type SupportDiagnosisSection,
  isDiagnosisId,
  type SupportDiagnosisList,
  type SupportDiagnosisRating,
  type SupportDiagnosisTrigger,
  type SupportDiagnosisView,
} from "@templ/chat/support-diagnosis";
import { HttpError, json } from "./common";
import { recordCaseFacet } from "./support-quality";
import { recordDefiniteUsageTransaction } from "./product-usage-billing";
import { chargeRef } from "./product-charges";
import { recordCaseContribution } from "./support-cases";
import { readRpcUsage, RPC_USAGE_LIMITS } from "./usage-ledger";
import type {
  DiagnosisReads,
  DiagnosisRunPlan,
  DiagnosisSubject,
  DiagnosisTrigger,
} from "./tx-diagnosis/plan";

type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;
type Storage = Pick<DurableObjectStorage, "get" | "list" | "put" | "delete">;

export type DiagnosisThreadId = `tc-${string}`;
export type DiagnosisRead = {
  /** The id a `[dx:<id>]` citation names. */
  id: string;
  thread: DiagnosisThreadId;
  /** The case the check belongs to. */
  caseSeq: number;
  /** Facts only: the team's next steps never leave the staff view. */
  diagnosis: DiagnosisFacts;
  section: "reading";
  evidence: {
    section: SupportDiagnosisSection;
    observedAt: string;
    label: string;
    value: string;
    sourceLabel: string;
  }[];
};
/** A stored diagnosis without its team-only next steps. */
export type DiagnosisFacts = Diagnosis & {
  staff: Diagnosis["staff"] & { nextSteps: never[] };
};
const factsOnly = (diagnosis: Diagnosis): DiagnosisFacts => ({
  ...diagnosis,
  staff: { ...diagnosis.staff, nextSteps: [] },
});

/* ---------------------------------------------------------------------- */
/* Keys and records                                                        */
/* ---------------------------------------------------------------------- */

export const DIAGNOSIS_RECORD_PREFIX = "support-diagnosis-v1:";
export const DIAGNOSIS_LEASE_PREFIX = "support-diagnosis-run-v1:";
export const DIAGNOSIS_THREAD_PREFIX = "support-diagnosis-thread-v1:";
export const DIAGNOSIS_REFUSAL_PREFIX = "support-diagnosis-refusal-v1:";
export const DIAGNOSIS_JOB_PREFIX = "support-diagnosis-job-v1:";
export const DIAGNOSIS_PENDING_THREAD_PREFIX =
  "support-diagnosis-pending-thread-v1:";
export const DIAGNOSIS_PENDING_MEMBER_PREFIX =
  "support-diagnosis-pending-member-v1:";
export const DIAGNOSIS_PENDING_MS = 30 * 60_000;
export const DIAGNOSIS_QUOTA_KEY = "support-diagnosis-quota-v1";
export const DIAGNOSIS_ORPHAN_KEY = "support-diagnosis-orphan-v1";
/** Every key family a thread may hold, for thread deletion. */
export const DIAGNOSIS_THREAD_KEY_PREFIXES = [
  DIAGNOSIS_RECORD_PREFIX,
  DIAGNOSIS_LEASE_PREFIX,
  DIAGNOSIS_THREAD_PREFIX,
  DIAGNOSIS_REFUSAL_PREFIX,
  DIAGNOSIS_PENDING_THREAD_PREFIX,
] as const;
/** Edge-only headers. The worker builds every room request's headers
 * itself, so a client can never set them. */
export const DIAGNOSIS_NETWORKS_HEADER = "X-Support-Diagnosis-Networks";
export const DIAGNOSIS_PHASE_HEADER = "X-Diagnosis-Phase";
export const DIAGNOSIS_LEASE_HEADER = "X-Diagnosis-Lease";

const THREAD_ID = /^tc-[0-9a-f]{32}$/;
const pad = (value: number, width: number) =>
  String(value).padStart(width, "0");
const recordKey = (thread: string, seq: number, run: number) =>
  `${DIAGNOSIS_RECORD_PREFIX}${thread}:${pad(seq, 8)}:${pad(run, 2)}`;
const LEASE_MS = 60_000;
const INPUT_CHARS = 262_144;
const DAY_MS = 86_400_000;

type Trigger = SupportDiagnosisTrigger;
type Sighting = Omit<EvmPreviousSighting, "confirmedNonceNow">;
type StoredDiagnosisRecord = {
  v: 1;
  id: string;
  case: number;
  run: number;
  trigger: Trigger;
  actor: string | null;
  clientId: string | null;
  startedAt: number;
  at: number;
  subject: DiagnosisSubject;
  hint: NetworkHint | null;
  inputSha256: string;
  reads: Pick<
    DiagnosisReads,
    "calls" | "primaryCu" | "confirmationAttempts" | "ms" | "networks"
  >;
  /** EVM pending only: what the next check of this hash compares against. */
  sighting: Sighting | null;
  /** Solana: the first check's height and the last commitment seen. */
  solana: {
    firstCheck: SolanaHeight;
    seenAt: string;
    commitment: SolanaCommitment | null;
  } | null;
  profileRefs: string[];
  rating: { rating: SupportDiagnosisRating; by: string; at: number } | null;
  diagnosis: Diagnosis;
};
export type DiagnosisLease = {
  v: 1;
  id: string;
  conversation: string;
  case: number;
  trigger: DiagnosisTrigger;
  actor: string | null;
  clientId: string | null;
  subject: DiagnosisSubject;
  hint: NetworkHint | null;
  networks: DiagnosisNetwork[];
  walletDigest: string;
  previousDigest: string | null;
  keyGuard: boolean;
  startedAt: number;
  expiresAt: number;
  counted: { room: boolean; thread: boolean; auto: boolean; guard: boolean };
};
type ThreadCounters = {
  v: 1;
  day: string;
  runs: number;
  auto: number;
  lastRun: { case: number; run: number } | null;
};
type RoomCounters = { v: 1; day: string; runs: number; guards: number };

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const iso = (at: number) => new Date(at).toISOString();
const subjectValue = (subject: DiagnosisSubject) =>
  subject.kind === "evm" ? subject.hash : subject.signature;
const sameSubject = (a: DiagnosisSubject, b: DiagnosisSubject) =>
  a.kind === b.kind && subjectValue(a) === subjectValue(b);

function unreadableLog(conversation: string) {
  console.warn(
    JSON.stringify({
      event: "TEMPL_SUPPORT_CASE_DATA_UNREADABLE",
      kind: "diagnosis",
      conversation,
    }),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function checkedSubject(value: unknown): DiagnosisSubject | null {
  if (!isObject(value)) return null;
  if (value.kind === "evm" && isEvmTransactionHash(value.hash))
    return { kind: "evm", hash: (value.hash as string).toLowerCase() as Hex };
  if (value.kind === "solana" && isSolanaSignature(value.signature))
    return { kind: "solana", signature: value.signature as string };
  return null;
}

/** A stored record, checked field by field, or null (unreadable). */
function checkedRecord(
  raw: unknown,
  thread: string,
  seq: number,
  run: number,
): StoredDiagnosisRecord | null {
  if (!isObject(raw) || raw.v !== 1) return null;
  const subject = checkedSubject(raw.subject);
  if (
    typeof raw.id !== "string" ||
    !isDiagnosisId(raw.id) ||
    raw.case !== seq ||
    raw.run !== run ||
    !subject ||
    !["staff", "agent", "member-share", "ask-ai"].includes(
      String(raw.trigger),
    ) ||
    !Number.isSafeInteger(raw.at) ||
    !Number.isSafeInteger(raw.startedAt) ||
    !Array.isArray(raw.profileRefs)
  )
    return null;
  const diagnosis = parseStoredDiagnosis(raw.diagnosis);
  if (!diagnosis) return null;
  if (diagnosis.subject !== subjectValue(subject)) return null;
  void thread;
  return { ...(raw as unknown as StoredDiagnosisRecord), subject, diagnosis };
}

type Listed = {
  key: string;
  record: StoredDiagnosisRecord | null;
  seq: number;
  run: number;
};
async function listThreadRecords(
  storage: ReadStorage,
  thread: string,
): Promise<Listed[]> {
  const rows = await storage.list<unknown>({
    prefix: `${DIAGNOSIS_RECORD_PREFIX}${thread}:`,
    limit: 10,
  });
  const out: Listed[] = [];
  for (const [key, raw] of rows) {
    const match = /:(\d{8}):(\d{2})$/.exec(key);
    if (!match) continue;
    const seq = Number(match[1]);
    const run = Number(match[2]);
    const record = checkedRecord(raw, thread, seq, run);
    if (!record) unreadableLog(thread);
    out.push({ key, record, seq, run });
  }
  return out.sort(
    (a, b) =>
      (b.record?.at ?? 0) - (a.record?.at ?? 0) || b.key.localeCompare(a.key),
  );
}

/* ---------------------------------------------------------------------- */
/* Reads for other features                                                */
/* ---------------------------------------------------------------------- */

/** A thread's stored diagnoses, newest first, as facts without next steps.
 * Callers check the reader's current access first. */
export async function readThreadDiagnoses(
  storage: ReadStorage,
  thread: DiagnosisThreadId,
): Promise<DiagnosisRead[]> {
  if (!THREAD_ID.test(thread)) return [];
  return (await listThreadRecords(storage, thread))
    .filter((item) => item.record)
    .map((item) => ({
      id: item.record!.id,
      thread,
      caseSeq: item.seq,
      diagnosis: factsOnly(item.record!.diagnosis),
      section: "reading" as const,
      evidence: item.record!.diagnosis.staff.evidence.map((row) => ({
        section: diagnosisEvidenceSection(row.source),
        observedAt: item.record!.diagnosis.checkedAt,
        label: row.label,
        value: row.value,
        sourceLabel: row.sourceLabel,
      })),
    }));
}

/** The newest stored check of each transaction in one case. A later check
 * of the same transaction replaces the earlier one. `rows` come newest
 * first, as readThreadDiagnoses returns them. */
export function currentCaseChecks(
  rows: DiagnosisRead[],
  caseSeq: number | undefined,
): DiagnosisRead[] {
  const newest = new Map<string, DiagnosisRead>();
  for (const row of rows)
    if (row.caseSeq === caseSeq && !newest.has(row.diagnosis.subject))
      newest.set(row.diagnosis.subject, row);
  return [...newest.values()];
}

/** The checks a `[dx:<id>]` marker in this thread may cite, with the
 * numbers each states: a cited figure must be one of them. */
export async function citableDiagnoses(
  storage: ReadStorage,
  thread: string,
  enabled: DiagnosisNetwork[],
): Promise<CitableDiagnosis[]> {
  if (!THREAD_ID.test(thread)) return [];
  return (await readThreadDiagnoses(storage, thread as DiagnosisThreadId))
    .filter((item) => diagnosisNetworkEnabled(item.diagnosis, enabled))
    .map((item) => ({
      id: item.id,
      numbers: claimSet(item.diagnosis).numbers,
    }));
}

/* ---------------------------------------------------------------------- */
/* Deletion                                                                */
/* ---------------------------------------------------------------------- */

/** A case's stored checks (the case ledger's prune). */
export async function deleteCaseDiagnoses(
  storage: Storage,
  thread: string,
  seq: number,
  budget: number,
): Promise<number> {
  if (!THREAD_ID.test(thread) || budget <= 0) return 0;
  const rows = await storage.list({
    prefix: `${DIAGNOSIS_RECORD_PREFIX}${thread}:${pad(seq, 8)}:`,
    limit: budget,
  });
  for (const key of rows.keys()) await storage.delete(key);
  return rows.size;
}
/** Every check key of a thread (thread deletion), within the budget. */
export async function deleteThreadDiagnoses(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  if (!THREAD_ID.test(thread) || budget <= 0) return 0;
  let deleted = 0;
  const rows = await storage.list({
    prefix: `${DIAGNOSIS_RECORD_PREFIX}${thread}:`,
    limit: budget,
  });
  for (const key of rows.keys()) {
    await storage.delete(key);
    deleted++;
  }
  if (deleted >= budget) return deleted;
  for (const prefix of DIAGNOSIS_THREAD_KEY_PREFIXES.slice(1)) {
    const key = `${prefix}${thread}`;
    if ((await storage.get(key)) !== undefined) {
      await storage.delete(key);
      deleted++;
      if (deleted >= budget) return deleted;
    }
  }
  return deleted;
}
/** Rollback safety: removes check keys whose thread is gone, 100 keys a
 * day. A worker rolled back below this release stops deleting them with
 * threads; the next run of this sweep removes what was left. */
export async function sweepOrphanDiagnoses(
  storage: Storage,
  now: number,
): Promise<number | null> {
  const cursor = (await storage.get<{ v: 1; after: string | null; at: number }>(
    DIAGNOSIS_ORPHAN_KEY,
  )) ?? { v: 1 as const, after: null, at: 0 };
  if (cursor.at && now < cursor.at + DAY_MS && cursor.after === null)
    return cursor.at + DAY_MS;
  const rows = await storage.list({
    prefix: "support-diagnosis-",
    ...(cursor.after ? { startAfter: cursor.after } : {}),
    limit: 100,
  });
  // A workspace that never ran a check has nothing to sweep and no alarm.
  if (!rows.size && cursor.after === null && !cursor.at) return null;
  let last: string | null = null;
  for (const key of rows.keys()) {
    last = key;
    const thread = /(tc-[0-9a-f]{32})/.exec(key)?.[1];
    if (!thread) continue;
    if ((await storage.get(`conversation-v1:${thread}`)) === undefined)
      await storage.delete(key);
  }
  const done = rows.size < 100;
  await storage.put(DIAGNOSIS_ORPHAN_KEY, {
    v: 1,
    after: done ? null : last,
    at: now,
  });
  return done ? now + DAY_MS : now + 1_000;
}

/* ---------------------------------------------------------------------- */
/* Views                                                                   */
/* ---------------------------------------------------------------------- */

function explorerFor(diagnosis: Diagnosis): string | null {
  if (!diagnosis.network) return null;
  if (diagnosis.network === "solana")
    return `https://solscan.io/tx/${diagnosis.subject}`;
  const info = networkInfo(diagnosis.network);
  return info && /^0x[0-9a-f]{64}$/.test(diagnosis.subject)
    ? `https://${info.explorer}/tx/${diagnosis.subject}`
    : null;
}

/** Short facts for a user reply. Balance facts require explicit matching
 * reads recorded by the engine, rather than a failed status alone. */
export function memberDiagnosisEvidence(diagnosis: Diagnosis): string[] {
  return [...(diagnosis.member?.evidence ?? [])];
}

/** A stored check follows its network gate, including checks that could
 * not find a network for a shared transaction. */
export function diagnosisNetworkEnabled(
  diagnosis: Diagnosis,
  enabled: DiagnosisNetwork[],
): boolean {
  if (diagnosis.network) return enabled.includes(diagnosis.network);
  return diagnosis.kind === "solana"
    ? enabled.includes("solana")
    : enabled.some((network) => network !== "solana");
}

/** People get next steps. Agents get handoff steps only when needed. */
export function diagnosisView(
  record: StoredDiagnosisRecord,
  reader: { isBot: boolean },
  now: number,
): SupportDiagnosisView {
  const d = record.diagnosis;
  return {
    ...(d.readSource ? { readSource: d.readSource } : {}),
    id: record.id,
    case: record.case,
    run: record.run,
    trigger: record.trigger,
    by: record.actor,
    at: iso(record.at),
    subject:
      record.subject.kind === "evm"
        ? { kind: "evm", hash: record.subject.hash }
        : { kind: "solana", signature: record.subject.signature },
    network: d.network ? { id: d.network, name: networkName(d.network) } : null,
    explorer: explorerFor(d),
    status: d.status,
    chip: STATUS_CHIPS[d.status],
    finality: d.finality,
    category: d.category,
    reason: d.reason,
    needsPerson: d.needsPerson,
    whatHappened: d.staff.whatHappened,
    findings: d.staff.findings.map((item) => ({
      rule: item.rule,
      severity: item.severity,
      text: item.text,
      evidence: item.evidence,
    })),
    evidence: d.staff.evidence.map((item) => ({
      id: item.id,
      label: item.label,
      value: item.value,
      source: item.source,
      sourceLabel: item.sourceLabel,
      section: diagnosisEvidenceSection(item.source),
      observedAt: d.checkedAt,
    })),
    ...(reader.isBot
      ? {
          claims: claimSet(d),
          ...(d.needsPerson
            ? { handoff: { nextSteps: d.staff.nextSteps } }
            : {}),
        }
      : {
          nextSteps: d.staff.nextSteps.map((item) => ({
            id: item.id,
            text: item.text,
            needsNewTransaction: item.needsNewTransaction,
          })),
        }),
    memberDraft: d.member?.text ?? null,
    memberEvidence: memberDiagnosisEvidence(d),
    fresh: now - record.at < diagnosisFreshForMs(d.status, d.finality),
    trimmed: d.trimmed,
    rating: record.rating
      ? { rating: record.rating.rating, at: iso(record.rating.at) }
      : null,
  };
}

/* ---------------------------------------------------------------------- */
/* Counters, quotas and the headroom guard                                 */
/* ---------------------------------------------------------------------- */

async function roomCounters(
  storage: Storage,
  now: number,
): Promise<RoomCounters> {
  const raw = await storage.get<RoomCounters>(DIAGNOSIS_QUOTA_KEY);
  const day = utcDay(now);
  if (raw === undefined || (isObject(raw) && raw.day !== day))
    return { v: 1, day, runs: 0, guards: 0 };
  if (
    !isObject(raw) ||
    raw.v !== 1 ||
    !Number.isSafeInteger(raw.runs) ||
    !Number.isSafeInteger(raw.guards)
  ) {
    console.warn(
      JSON.stringify({ event: "TEMPL_DIAGNOSIS_COUNTERS_UNREADABLE" }),
    );
    throw new HttpError(
      503,
      "Transaction checks aren't available yet.",
      undefined,
      "diagnosis-unavailable",
    );
  }
  return raw;
}
async function threadCounters(
  storage: Storage,
  thread: string,
  now: number,
): Promise<ThreadCounters> {
  const raw = await storage.get<ThreadCounters>(
    `${DIAGNOSIS_THREAD_PREFIX}${thread}`,
  );
  const day = utcDay(now);
  if (raw === undefined) return { v: 1, day, runs: 0, auto: 0, lastRun: null };
  if (
    !isObject(raw) ||
    raw.v !== 1 ||
    !Number.isSafeInteger(raw.runs) ||
    !Number.isSafeInteger(raw.auto)
  ) {
    console.warn(
      JSON.stringify({ event: "TEMPL_DIAGNOSIS_COUNTERS_UNREADABLE" }),
    );
    throw new HttpError(
      503,
      "Transaction checks aren't available yet.",
      undefined,
      "diagnosis-unavailable",
    );
  }
  return raw.day === day ? raw : { ...raw, day, runs: 0, auto: 0 };
}

export type DiagnosisCoverage = { enabled: boolean; funded: boolean };
const limited = (message: string, retryAfter?: number) =>
  new HttpError(429, message, retryAfter, "diagnosis-limit");

/** A check starts only while the workspace has used at most the
 * headroom share of its 30-day RPC budget, so sign-in and payment reads keep
 * the rest. */
export async function assertDiagnosisHeadroom(storage: Storage, now: number) {
  const share = FEATURE_LIMITS.diagnosisBudgetHeadroomPercent / 100;
  for (const metric of ["primary-cu", "confirmation-attempts"] as const) {
    const usage = await readRpcUsage(storage, {
      limitCu: RPC_USAGE_LIMITS[metric],
      nowMs: now,
      metric,
    });
    if (usage.used > RPC_USAGE_LIMITS[metric] * share)
      throw limited("This workspace has used this month's transaction checks.");
  }
}

/* ---------------------------------------------------------------------- */
/* Planning                                                                */
/* ---------------------------------------------------------------------- */

export type DiagnosisThreadFacts = {
  member?: string;
  thread: string;
  caseSeq: number;
  /** The support record's context (stored shape). */
  context: unknown;
  wallet: {
    signed: {
      network: "evm" | "solana";
      address: string;
      chainId?: number;
      authenticatedAt: string;
    } | null;
    claimed: {
      network: "evm" | "solana";
      address: string;
      chainId?: number;
    } | null;
  };
};

const walletNetwork = (wallet: {
  network: "evm" | "solana";
  chainId?: number;
}): DiagnosisNetwork | null =>
  wallet.network === "solana"
    ? "solana"
    : typeof wallet.chainId === "number"
      ? parseNetwork(`eip155:${wallet.chainId}`)
      : null;

export function walletFacts(
  facts: DiagnosisThreadFacts["wallet"],
): WalletFacts {
  const signedNetwork = facts.signed ? walletNetwork(facts.signed) : null;
  const claimedNetwork = facts.claimed ? walletNetwork(facts.claimed) : null;
  return {
    signed:
      facts.signed && signedNetwork
        ? {
            network: signedNetwork,
            address:
              facts.signed.network === "evm"
                ? facts.signed.address.toLowerCase()
                : facts.signed.address,
            at: facts.signed.authenticatedAt.replace(/\.\d{3}Z$/, "Z"),
          }
        : null,
    claimed:
      facts.claimed && claimedNetwork
        ? {
            network: claimedNetwork,
            address:
              facts.claimed.network === "evm"
                ? facts.claimed.address.toLowerCase()
                : facts.claimed.address,
          }
        : null,
  };
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
const randomHex = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The shared transactions of the current context, newest first. */
export function contextTransactions(
  context: unknown,
): { subject: DiagnosisSubject; network: DiagnosisNetwork | null }[] {
  const view = readStoredSupportContext(context);
  if (!view || view === "unreadable") return [];
  const out: { subject: DiagnosisSubject; network: DiagnosisNetwork | null }[] =
    [];
  for (const tx of view.transactions ?? []) {
    if (tx.network === "solana" && isSolanaSignature(tx.hash))
      out.push({
        subject: { kind: "solana", signature: tx.hash },
        network: "solana",
      });
    else if (isEvmTransactionHash(tx.hash))
      out.push({
        subject: { kind: "evm", hash: tx.hash.toLowerCase() as Hex },
        network: tx.network
          ? parseNetwork(tx.network)
          : view.network && view.network !== "solana"
            ? parseNetwork(view.network)
            : null,
      });
  }
  return out;
}

/** Hint sources in order: the staff member's choice, the transaction's own
 * network in the shared context, the signed wallet's chain, the claimed
 * wallet's chain. */
function hintFor(
  subject: DiagnosisSubject,
  staff: DiagnosisNetwork | null,
  explorer: boolean,
  shared: DiagnosisNetwork | null,
  wallet: WalletFacts,
): NetworkHint | null {
  if (subject.kind === "solana")
    return { network: "solana", source: staff ? "staff" : "member-context" };
  if (staff)
    return { network: staff, source: explorer ? "explorer-link" : "staff" };
  if (shared) return { network: shared, source: "member-context" };
  const chain = wallet.signed?.network ?? wallet.claimed?.network ?? null;
  return chain && chain !== "solana"
    ? { network: chain, source: "wallet-chain" }
    : null;
}

export type PlanInput = {
  storage: Storage;
  facts: DiagnosisThreadFacts;
  trigger: DiagnosisTrigger;
  actor: string | null;
  clientId: string | null;
  subject: DiagnosisSubject;
  staffNetwork: DiagnosisNetwork | null;
  fromExplorer: boolean;
  /** Networks the edge says are on, probe order. */
  enabled: DiagnosisNetwork[];
  coverage: DiagnosisCoverage;
  force: boolean;
  now: number;
  deadlineMs: number;
};
export type PlanOutcome =
  | { kind: "plan"; plan: DiagnosisRunPlan; lease: DiagnosisLease }
  | { kind: "cached"; record: StoredDiagnosisRecord }
  | { kind: "running"; lease: DiagnosisLease };

/** Plans one run and writes its lease and counters, in the caller's
 * transaction. Throws HttpError with the route's reason on a refusal. */
export async function planDiagnosis(input: PlanInput): Promise<PlanOutcome> {
  const { storage, facts, subject, now } = input;
  const thread = facts.thread;
  const guardOnly = input.trigger === "key-guard";
  if (!input.enabled.length)
    throw new HttpError(
      503,
      "Transaction checks aren't available yet.",
      undefined,
      "diagnosis-unavailable",
    );
  if (!input.coverage.enabled)
    throw new HttpError(
      403,
      "Support is paused until the workspace's balance is topped up.",
      undefined,
      "support-paused",
    );
  // The key guard for a Solana value is local (a keypair has a shape), so
  // it runs while Solana checks are off; an EVM guard reads EVM networks.
  if (
    subject.kind === "solana" &&
    !guardOnly &&
    !input.enabled.includes("solana")
  )
    throw new HttpError(
      409,
      "Templ doesn't check Solana transactions in this workspace yet.",
      undefined,
      "diagnosis-network-off",
    );
  if (
    subject.kind === "evm" &&
    !input.enabled.some((network) => network !== "solana")
  )
    throw new HttpError(
      409,
      "Templ doesn't check EVM transactions in this workspace yet.",
      undefined,
      "diagnosis-network-off",
    );
  if (
    subject.kind === "evm" &&
    input.staffNetwork &&
    input.staffNetwork !== "solana" &&
    !input.enabled.includes(input.staffNetwork)
  )
    throw new HttpError(
      409,
      `Templ doesn't check ${networkName(input.staffNetwork)} yet.`,
      undefined,
      "diagnosis-network-off",
    );
  const listed = await listThreadRecords(storage, thread);
  const readable = listed
    .map((item) => item.record)
    .filter((item): item is StoredDiagnosisRecord => item !== null);
  const ofSubject = readable.filter((item) =>
    sameSubject(item.subject, subject),
  );
  if (input.clientId) {
    const retry = readable.find((item) => item.clientId === input.clientId);
    if (retry) return { kind: "cached", record: retry };
  }
  const current = ofSubject.find((item) => item.case === facts.caseSeq);
  if (
    !guardOnly &&
    current &&
    !input.force &&
    now - current.at <
      diagnosisFreshForMs(current.diagnosis.status, current.diagnosis.finality)
  )
    return { kind: "cached", record: current };
  const leaseKey = `${DIAGNOSIS_LEASE_PREFIX}${thread}`;
  const existing = await storage.get<DiagnosisLease>(leaseKey);
  if (existing && isObject(existing) && existing.expiresAt > now) {
    const leased = checkedSubject(existing.subject);
    if (leased && sameSubject(leased, subject))
      return { kind: "running", lease: existing };
    throw new HttpError(
      409,
      "Another check is running in this chat. Try again in a minute.",
      undefined,
      "diagnosis-busy",
    );
  }
  const newest = ofSubject[0];
  if (!guardOnly && newest && now - newest.at < DIAGNOSIS_MIN_RERUN_MS) {
    const seconds = Math.ceil(
      (newest.at + DIAGNOSIS_MIN_RERUN_MS - now) / 1000,
    );
    throw new HttpError(
      429,
      `This transaction was checked a few seconds ago. Try again in ${seconds} seconds.`,
      seconds,
      "diagnosis-too-soon",
    );
  }
  const room = await roomCounters(storage, now);
  const counters = await threadCounters(storage, thread, now);
  const auto = input.trigger === "member-share" || input.trigger === "ask-ai";
  if (guardOnly) {
    if (room.guards >= FEATURE_LIMITS.keyGuardRunsPerRoomPerDay)
      throw limited("This workspace has used today's key checks.");
  } else {
    const roomLimit = !input.coverage.funded
      ? FEATURE_LIMITS.freeDiagnosisRunsPerRoomPerDay
      : FEATURE_LIMITS.diagnosisRunsPerRoomPerDay;
    if (room.runs >= roomLimit)
      throw limited(
        `This workspace has used today's ${roomLimit} transaction checks. More are available at 00:00 UTC.`,
      );
    if (counters.runs >= FEATURE_LIMITS.diagnosisRunsPerThreadPerDay)
      throw limited(
        `This chat has used today's ${FEATURE_LIMITS.diagnosisRunsPerThreadPerDay} checks.`,
      );
    if (
      auto &&
      counters.auto >= FEATURE_LIMITS.diagnosisAutoRunsPerThreadPerDay
    )
      throw limited("This chat has used today's automatic checks.");
  }
  await assertDiagnosisHeadroom(storage, now);

  const wallet = walletFacts(facts.wallet);
  const shared =
    contextTransactions(facts.context).find((item) =>
      sameSubject(item.subject, subject),
    )?.network ?? null;
  const hint = hintFor(
    subject,
    input.staffNetwork,
    input.fromExplorer,
    shared,
    wallet,
  );
  const evmEnabled = input.enabled.filter(
    (network): network is EvmNetwork => network !== "solana",
  );
  const networks: DiagnosisNetwork[] =
    subject.kind === "solana"
      ? ["solana"]
      : [
          ...(hint && hint.network !== "solana" ? [hint.network] : []),
          ...evmEnabled.filter((network) => network !== hint?.network),
        ].slice(0, 8);
  const guardNetworks: DiagnosisNetwork[] = [
    ...(hint && hint.network !== "solana" ? [hint.network] : []),
    ...[wallet.signed?.network, wallet.claimed?.network].filter(
      (network): network is EvmNetwork => !!network && network !== "solana",
    ),
  ];
  const previousRecord = ofSubject.find((item) => item.sighting);
  const previous =
    subject.kind === "evm" ? (previousRecord?.sighting ?? null) : null;
  const solanaRecord = ofSubject.find((item) => item.solana);
  const lease: DiagnosisLease = {
    v: 1,
    id: randomHex(16),
    conversation: thread,
    case: facts.caseSeq,
    trigger: input.trigger,
    actor: input.actor,
    clientId: input.clientId,
    subject,
    hint,
    networks,
    walletDigest: await sha256(wallet),
    previousDigest: previous ? await sha256(previous) : null,
    // A value that passed the guard in this thread once is not a used key.
    keyGuard:
      guardOnly ||
      readable.every((item) => !sameSubject(item.subject, subject)),
    startedAt: now,
    expiresAt: now + LEASE_MS,
    counted: {
      room: !guardOnly,
      thread: !guardOnly,
      auto: auto && !guardOnly,
      guard: guardOnly,
    },
  };
  await storage.put(leaseKey, lease);
  await storage.put(DIAGNOSIS_QUOTA_KEY, {
    ...room,
    runs: room.runs + (lease.counted.room ? 1 : 0),
    guards: room.guards + (lease.counted.guard ? 1 : 0),
  } satisfies RoomCounters);
  await storage.put(`${DIAGNOSIS_THREAD_PREFIX}${thread}`, {
    ...counters,
    runs: counters.runs + (lease.counted.thread ? 1 : 0),
    auto: counters.auto + (lease.counted.auto ? 1 : 0),
  } satisfies ThreadCounters);
  const checkedAt = iso(now).replace(/\.\d{3}Z$/, "Z");
  const plan: DiagnosisRunPlan = {
    v: 1,
    lease: lease.id,
    conversation: thread,
    case: facts.caseSeq,
    trigger: input.trigger,
    subject,
    hint,
    networks,
    guardNetworks,
    wallet,
    previous,
    solana:
      subject.kind === "solana"
        ? {
            firstCheck: solanaRecord?.solana?.firstCheck ?? null,
            previous: solanaRecord?.solana?.commitment
              ? {
                  seenAt: solanaRecord.solana.seenAt,
                  commitment: solanaRecord.solana.commitment,
                }
              : null,
          }
        : null,
    keyGuard: lease.keyGuard,
    checkedAt,
    deadlineAt: now + input.deadlineMs,
  };
  return { kind: "plan", plan, lease };
}

/* ---------------------------------------------------------------------- */
/* Commit                                                                  */
/* ---------------------------------------------------------------------- */

export type CommitBody = {
  lease: string;
  outcome: "input" | "refused-key" | "guard-clear";
  input?: unknown;
  reads?: Partial<DiagnosisReads>;
  profileRefs?: unknown;
};
export type CommitOutcome =
  | { kind: "stored"; record: StoredDiagnosisRecord }
  | { kind: "refused-key" }
  | { kind: "guard-clear" };

const mismatch = () =>
  new HttpError(
    409,
    "The check couldn't be saved. Try again.",
    undefined,
    "diagnosis-input-mismatch",
  );
const expired = () =>
  new HttpError(
    409,
    "The check took too long. Try again.",
    undefined,
    "diagnosis-lease-expired",
  );

/** Reads the lease a commit names, or throws. */
export async function readLease(
  storage: Storage,
  thread: string,
  id: unknown,
  now: number,
): Promise<DiagnosisLease> {
  const lease = await storage.get<DiagnosisLease>(
    `${DIAGNOSIS_LEASE_PREFIX}${thread}`,
  );
  if (
    !lease ||
    !isObject(lease) ||
    lease.id !== id ||
    lease.conversation !== thread ||
    lease.expiresAt <= now
  )
    throw expired();
  return lease;
}

/** Removes every shared transaction equal to a refused value from the
 * member's context. Returns the new stored context. */
export function withoutSubject(
  context: unknown,
  subject: DiagnosisSubject,
): unknown {
  if (
    !isObject(context) ||
    context.v !== 2 ||
    !Array.isArray(context.transactions)
  )
    return context;
  const value = subjectValue(subject).toLowerCase();
  const transactions = (context.transactions as { hash: string }[]).filter(
    (tx) => String(tx.hash).toLowerCase() !== value,
  );
  const { transactions: _old, ...rest } = context;
  void _old;
  return transactions.length ? { ...rest, transactions } : rest;
}

function evmChecks(input: DiagnosisInput, lease: DiagnosisLease) {
  if (input.kind !== "evm" || lease.subject.kind !== "evm") return false;
  if (input.hash !== lease.subject.hash) return false;
  return input.probes.every((probe) => lease.networks.includes(probe.network));
}

/** Validates the edge's input against the lease, runs the engine and stores
 * the record, in the caller's transaction. */
export async function commitDiagnosis(
  storage: Storage,
  args: {
    thread: string;
    lease: DiagnosisLease;
    body: CommitBody;
    now: number;
    env?: import("./templ-staff").TemplStaffEnv;
    /** The member's context now; a refused value is removed from it. */
    readContext(): Promise<unknown>;
    writeContext(next: unknown): Promise<void>;
  },
): Promise<CommitOutcome> {
  const { thread, lease, body, now } = args;
  const leaseKey = `${DIAGNOSIS_LEASE_PREFIX}${thread}`;
  if (body.outcome === "refused-key") {
    // Templ keeps nothing about the value: only when and that it happened.
    const context = await args.readContext();
    const next = withoutSubject(context, lease.subject);
    if (next !== context) await args.writeContext(next);
    await storage.put(`${DIAGNOSIS_REFUSAL_PREFIX}${thread}`, {
      v: 1,
      at: now,
      trigger: lease.trigger,
    });
    await storage.delete(leaseKey);
    return { kind: "refused-key" };
  }
  if (body.outcome === "guard-clear") {
    if (lease.trigger !== "key-guard") throw mismatch();
    await storage.delete(leaseKey);
    return { kind: "guard-clear" };
  }
  if (body.outcome !== "input" || lease.trigger === "key-guard")
    throw mismatch();
  const text = JSON.stringify(body.input ?? null);
  if (text.length > INPUT_CHARS) throw mismatch();
  const input = body.input as DiagnosisInput;
  if (!isObject(input)) throw mismatch();
  if (
    lease.subject.kind === "evm"
      ? !evmChecks(input, lease)
      : input.kind !== "solana" ||
        (input as { signature?: unknown }).signature !== lease.subject.signature
  )
    throw mismatch();
  if ((await sha256(input.wallet)) !== lease.walletDigest) throw mismatch();
  if (JSON.stringify(input.hint) !== JSON.stringify(lease.hint))
    throw mismatch();
  if (input.kind === "evm") {
    const seed = input.previous
      ? { ...input.previous, confirmedNonceNow: undefined }
      : null;
    if (seed)
      delete (seed as { confirmedNonceNow?: unknown }).confirmedNonceNow;
    const digest = seed ? await sha256(seed) : null;
    if (digest !== lease.previousDigest) throw mismatch();
  }
  const checkedAt = Date.parse(String(input.checkedAt));
  if (
    !Number.isFinite(checkedAt) ||
    checkedAt < lease.startedAt - 5_000 ||
    checkedAt > now + 5_000
  )
    throw mismatch();
  // The engine never throws: bad facts become "Couldn't check".
  const diagnosis = diagnose(input);
  const counters = await threadCounters(storage, thread, now);
  const listed = await listThreadRecords(storage, thread);
  // Keep at most diagnosisStoredPerThread: unreadable ones go first, then
  // the oldest.
  const keep = FEATURE_LIMITS.diagnosisStoredPerThread;
  const order = [
    ...listed.filter((item) => !item.record),
    ...listed
      .filter((item) => item.record)
      .sort((a, b) => a.record!.at - b.record!.at),
  ];
  for (const item of order.slice(0, Math.max(0, listed.length - keep + 1)))
    await storage.delete(item.key);
  const last = counters.lastRun?.case === lease.case ? counters.lastRun.run : 0;
  const run = last >= 99 ? 1 : last + 1;
  const reads = body.reads ?? {};
  const pendingSighting: Sighting | null =
    input.kind === "evm" &&
    input.found &&
    input.found.receipt === null &&
    input.found.txAgreement.kind === "seen"
      ? {
          network: input.found.network,
          from: input.found.tx.from,
          nonce: input.found.tx.nonce,
          seenAt: input.checkedAt,
          seenBy: input.found.txAgreement.by,
        }
      : null;
  const record: StoredDiagnosisRecord = {
    v: 1,
    id: `dx-${randomHex(8)}`,
    case: lease.case,
    run,
    trigger: lease.trigger as Trigger,
    actor: lease.actor,
    clientId: lease.clientId,
    startedAt: lease.startedAt,
    at: now,
    subject: lease.subject,
    hint: lease.hint,
    inputSha256: await sha256(input),
    reads: {
      calls: Number(reads.calls) || 0,
      primaryCu: Number(reads.primaryCu) || 0,
      confirmationAttempts: Number(reads.confirmationAttempts) || 0,
      ms: Number(reads.ms) || 0,
      networks: Array.isArray(reads.networks)
        ? reads.networks.filter((item) => typeof item === "string").slice(0, 16)
        : [],
    },
    sighting: pendingSighting,
    solana:
      input.kind === "solana"
        ? {
            firstCheck: input.heights.firstCheck,
            seenAt: input.checkedAt,
            commitment:
              input.status.kind === "seen"
                ? input.status.commitment
                : input.status.found
                  ? input.status.commitment
                  : null,
          }
        : null,
    profileRefs: Array.isArray(body.profileRefs)
      ? body.profileRefs
          .filter(
            (item): item is string =>
              typeof item === "string" && item.length <= 120,
          )
          .slice(0, 20)
      : [],
    rating: null,
    diagnosis,
  };
  await storage.put(recordKey(thread, lease.case, run), record);
  if (["confirmed", "failed", "pending"].includes(diagnosis.status))
    await recordCaseContribution(
      storage,
      thread,
      lease.case,
      "transactionCheckAt",
      now,
      args.env,
    );
  await recordDefiniteUsageTransaction(
    storage as never,
    await chargeRef(storage, thread, lease.case),
    diagnosis.status,
    now,
    args.env,
  );
  // The case's quality record keeps the rules this check found, so a
  // manager can sample reviews by rule.
  for (const rule of new Set(diagnosis.staff.findings.map((item) => item.rule)))
    await recordCaseFacet(
      storage as never,
      thread,
      lease.case,
      { diagnosisRule: rule },
      now,
    );
  await storage.put(`${DIAGNOSIS_THREAD_PREFIX}${thread}`, {
    ...counters,
    lastRun: { case: lease.case, run },
  } satisfies ThreadCounters);
  await storage.delete(leaseKey);
  console.log(
    "TEMPL_DIAGNOSIS_RUN",
    JSON.stringify({
      trigger: lease.trigger,
      outcome: "stored",
      status: diagnosis.status,
      networks: record.reads.networks.length,
      calls: record.reads.calls,
      primaryCu: record.reads.primaryCu,
      ms: record.reads.ms,
      budgetLimited: Boolean(reads.budgetLimited),
      subrequests: Number(reads.subrequests) || 0,
    }),
  );
  return { kind: "stored", record };
}

/** An abandoned run: the lease goes, and counters are refunded only when no
 * provider call was made. */
export async function abortDiagnosis(
  storage: Storage,
  thread: string,
  leaseId: unknown,
  calls: number,
  now: number,
) {
  const lease = await storage.get<DiagnosisLease>(
    `${DIAGNOSIS_LEASE_PREFIX}${thread}`,
  );
  if (!lease || !isObject(lease) || lease.id !== leaseId) return;
  await storage.delete(`${DIAGNOSIS_LEASE_PREFIX}${thread}`);
  if (calls > 0) return;
  const room = await roomCounters(storage, now);
  const counters = await threadCounters(storage, thread, now);
  await storage.put(DIAGNOSIS_QUOTA_KEY, {
    ...room,
    runs: Math.max(0, room.runs - (lease.counted.room ? 1 : 0)),
    guards: Math.max(0, room.guards - (lease.counted.guard ? 1 : 0)),
  } satisfies RoomCounters);
  await storage.put(`${DIAGNOSIS_THREAD_PREFIX}${thread}`, {
    ...counters,
    runs: Math.max(0, counters.runs - (lease.counted.thread ? 1 : 0)),
    auto: Math.max(0, counters.auto - (lease.counted.auto ? 1 : 0)),
  } satisfies ThreadCounters);
}

/* ---------------------------------------------------------------------- */
/* Rating and the list                                                     */
/* ---------------------------------------------------------------------- */

/** "Was this check right?" People only. */
export async function rateDiagnosis(
  storage: Storage,
  thread: string,
  body: Record<string, unknown>,
  actor: string,
  now: number,
) {
  if (
    !SUPPORT_DIAGNOSIS_RATINGS.includes(body.rating as SupportDiagnosisRating)
  )
    throw new HttpError(
      400,
      "Choose correct, incomplete or wrong.",
      undefined,
      "invalid-rating",
    );
  const listed = await listThreadRecords(storage, thread);
  const item = listed.find((entry) => entry.record?.id === body.diagnosis);
  if (!item?.record)
    throw new HttpError(
      404,
      "That check isn't in this chat.",
      undefined,
      "diagnosis-not-found",
    );
  const rating = {
    rating: body.rating as SupportDiagnosisRating,
    by: actor,
    at: now,
  };
  await storage.put(item.key, { ...item.record, rating });
  await recordCaseFacet(
    storage as never,
    thread,
    item.seq,
    { diagnosisRating: { diagnosis: item.record.id, rating: rating.rating } },
    now,
  );
  return { diagnosis: item.record.id, rating: rating.rating, at: iso(now) };
}

export async function diagnosisList(
  storage: Storage,
  thread: string,
  input: {
    enabled: DiagnosisNetwork[];
    reader: { isBot: boolean };
    coverage: DiagnosisCoverage;
    now: number;
  },
): Promise<SupportDiagnosisList> {
  const listed = await listThreadRecords(storage, thread);
  const lease = await storage.get<DiagnosisLease>(
    `${DIAGNOSIS_LEASE_PREFIX}${thread}`,
  );
  const refusal = await storage.get<{ at: number }>(
    `${DIAGNOSIS_REFUSAL_PREFIX}${thread}`,
  );
  let roomLeft = 0;
  let threadLeft = 0;
  try {
    const room = await roomCounters(storage, input.now);
    const counters = await threadCounters(storage, thread, input.now);
    roomLeft = Math.max(
      0,
      (!input.coverage.funded
        ? FEATURE_LIMITS.freeDiagnosisRunsPerRoomPerDay
        : FEATURE_LIMITS.diagnosisRunsPerRoomPerDay) - room.runs,
    );
    threadLeft = Math.max(
      0,
      FEATURE_LIMITS.diagnosisRunsPerThreadPerDay - counters.runs,
    );
  } catch {
    // Unreadable counters: nothing can run today, and the list still reads.
  }
  let running =
    lease &&
    isObject(lease) &&
    lease.expiresAt > input.now &&
    lease.trigger !== "key-guard" &&
    (!input.reader.isBot ||
      (input.coverage.enabled &&
        (lease.subject.kind === "solana"
          ? input.enabled.includes("solana")
          : lease.networks.some((network) => input.enabled.includes(network)))))
      ? {
          subject: subjectValue(lease.subject),
          trigger: lease.trigger,
          startedAt: iso(lease.startedAt),
        }
      : null;
  if (!running && input.coverage.enabled && input.enabled.length) {
    const data = await storage.get<{ context?: unknown; caseSeq?: number }>(
      `support-workflow-v1:${thread}`,
    );
    const record = await storage.get<{ member?: string }>(
      `conversation-v1:${thread}`,
    );
    const facts = {
      thread,
      member: record?.member,
      caseSeq: data?.caseSeq ?? 0,
      context: data?.context,
      wallet: { signed: null, claimed: null },
    };
    if (await diagnosisPending(storage, facts, input.enabled, input.now)) {
      const next = await autoSubject(storage, facts, input.enabled, input.now);
      if (next)
        running = {
          subject: subjectValue(next),
          trigger: "member-share",
          startedAt: iso(input.now),
        };
    }
  }
  return {
    schemaVersion: 1,
    enabled: input.enabled.length > 0 && input.coverage.enabled,
    networks: input.enabled.map((network) => ({
      id: network,
      name: networkName(network),
    })),
    diagnoses: listed
      .filter((item) => item.record)
      .filter(
        (item) =>
          !input.reader.isBot ||
          (input.coverage.enabled &&
            diagnosisNetworkEnabled(item.record!.diagnosis, input.enabled)),
      )
      .slice(0, FEATURE_LIMITS.diagnosisStoredPerThread)
      .map((item) => diagnosisView(item.record!, input.reader, input.now)),
    unreadable: listed.filter((item) => !item.record).length,
    running,
    refusal:
      refusal && Number.isSafeInteger(refusal.at)
        ? { at: iso(refusal.at) }
        : null,
    limits: { roomLeftToday: roomLeft, threadLeftToday: threadLeft },
  };
}

/* ---------------------------------------------------------------------- */
/* Request parsing                                                         */
/* ---------------------------------------------------------------------- */

/** The subject of a run request: `{hash, network?}` or `{link}`. */
export function parseRunSubject(value: unknown): {
  subject: DiagnosisSubject;
  network: DiagnosisNetwork | null;
  fromExplorer: boolean;
} {
  const invalid = () =>
    new HttpError(
      400,
      "This doesn't look like a transaction ID. Paste the hash, signature or explorer link.",
      undefined,
      "invalid-transaction",
    );
  if (!isObject(value)) throw invalid();
  let network: DiagnosisNetwork | null = null;
  if (value.network !== undefined && value.network !== null) {
    const parsed = parseSupportNetwork(value.network);
    if (!parsed)
      throw new HttpError(
        400,
        "Choose a network Templ knows, such as Ethereum or Solana.",
        undefined,
        "invalid-network",
      );
    network = parsed;
  }
  const hasHash = typeof value.hash === "string";
  const hasLink = typeof value.link === "string";
  if (hasHash === hasLink) throw invalid();
  const reference = parseTransactionReference(
    (hasHash ? value.hash : value.link) as string,
    network ?? undefined,
  );
  if (!reference) throw invalid();
  if (hasLink && !/^https:/i.test(String(value.link))) throw invalid();
  if (reference.network === "solana")
    return {
      subject: { kind: "solana", signature: reference.hash },
      network: "solana",
      fromExplorer: hasLink,
    };
  const fromLink =
    hasLink && reference.network ? parseNetwork(reference.network) : null;
  if (network === "solana") throw invalid();
  return {
    subject: { kind: "evm", hash: reference.hash.toLowerCase() as Hex },
    network: fromLink ?? network,
    fromExplorer: hasLink,
  };
}

export function parseClientId(value: unknown): string {
  if (typeof value !== "string" || !DIAGNOSIS_CLIENT_ID.test(value))
    throw new HttpError(
      400,
      "Send a request id of 8 to 64 letters, digits, - or _.",
      undefined,
      "invalid-client-id",
    );
  return value;
}

/** The networks the edge says are on: "eip155:1,eip155:8453,solana". */
export function enabledFromHeader(value: string | null): DiagnosisNetwork[] {
  if (!value) return [];
  const out: DiagnosisNetwork[] = [];
  for (const part of value.split(",")) {
    const network = parseNetwork(part.trim());
    if (network && !out.includes(network)) out.push(network);
  }
  return out.slice(0, 16);
}

/* ---------------------------------------------------------------------- */
/* Automatic runs                                                          */
/* ---------------------------------------------------------------------- */

export type DiagnosisJob = {
  v: 1;
  id: string;
  kind: "member-share" | "ask-ai";
  /** The thread, or the member whose thread an ask opens. */
  thread: string | null;
  member: string | null;
  actor: string | null;
  at: number;
};

type PendingDiagnosisJobs = { v: 1; jobs: Record<string, number> };
const pendingJobKey = (job: Pick<DiagnosisJob, "thread" | "member">) =>
  job.thread
    ? `${DIAGNOSIS_PENDING_THREAD_PREFIX}${job.thread}`
    : job.member
      ? `${DIAGNOSIS_PENDING_MEMBER_PREFIX}${job.member}`
      : null;
function livePendingJobs(raw: unknown, now: number): Record<string, number> {
  if (!isObject(raw) || raw.v !== 1 || !isObject(raw.jobs)) return {};
  return Object.fromEntries(
    Object.entries(raw.jobs).filter(
      ([id, expiry]) =>
        /^[0-9a-f]{16}$/.test(id) &&
        Number.isSafeInteger(expiry) &&
        Number(expiry) > now,
    ),
  ) as Record<string, number>;
}

/** Removes a finished, failed or dropped job from its pending marker.
 * The caller keeps this update in the job's storage transaction. */
export async function finishDiagnosisJob(
  storage: Storage,
  job: DiagnosisJob,
  now: number,
): Promise<void> {
  const key = pendingJobKey(job);
  if (!key) return;
  const jobs = livePendingJobs(await storage.get(key), now);
  delete jobs[job.id];
  if (Object.keys(jobs).length)
    await storage.put(key, { v: 1, jobs } satisfies PendingDiagnosisJobs);
  else await storage.delete(key);
}

/** Queues an automatic run after this transaction commits: a member's
 * consented share, or an Ask AI request. The room alarm runs it. If the
 * request fails, the transaction drops the job with everything else. */
export async function queueDiagnosisJob(
  storage: Storage,
  job: Omit<DiagnosisJob, "v" | "id">,
): Promise<number> {
  const id = randomHex(8);
  await storage.put(`${DIAGNOSIS_JOB_PREFIX}${pad(job.at, 15)}:${id}`, {
    v: 1,
    id,
    ...job,
  } satisfies DiagnosisJob);
  const key = pendingJobKey(job);
  if (key) {
    const jobs = livePendingJobs(await storage.get(key), job.at);
    jobs[id] = job.at + DIAGNOSIS_PENDING_MS;
    await storage.put(key, { v: 1, jobs } satisfies PendingDiagnosisJobs);
  }
  return job.at;
}

export async function nextDiagnosisJobs(
  storage: ReadStorage,
  limit: number,
): Promise<{ key: string; job: DiagnosisJob | null }[]> {
  const rows = await storage.list<unknown>({
    prefix: DIAGNOSIS_JOB_PREFIX,
    limit,
  });
  return [...rows].map(([key, raw]) => {
    const job =
      isObject(raw) &&
      raw.v === 1 &&
      (raw.kind === "member-share" || raw.kind === "ask-ai") &&
      Number.isSafeInteger(raw.at)
        ? (raw as unknown as DiagnosisJob)
        : null;
    return { key, job };
  });
}

/** Whether a current shared transaction has a queued or running check.
 * The caller authorizes the thread. Only enabled networks count. */
export async function diagnosisPending(
  storage: Pick<ReadStorage, "get">,
  facts: DiagnosisThreadFacts,
  enabled: DiagnosisNetwork[],
  now: number,
): Promise<boolean> {
  const shared = contextTransactions(facts.context).filter(
    ({ subject, network }) =>
      subject.kind === "solana"
        ? enabled.includes("solana")
        : network
          ? enabled.includes(network)
          : enabled.some((item) => item !== "solana"),
  );
  if (!shared.length) return false;
  const leaseKey = `${DIAGNOSIS_LEASE_PREFIX}${facts.thread}`;
  const threadKey = `${DIAGNOSIS_PENDING_THREAD_PREFIX}${facts.thread}`;
  const memberKey = facts.member
    ? `${DIAGNOSIS_PENDING_MEMBER_PREFIX}${facts.member}`
    : null;
  const rows = await storage.get<unknown>([
    leaseKey,
    threadKey,
    ...(memberKey ? [memberKey] : []),
  ]);
  const lease = rows.get(leaseKey) as DiagnosisLease | undefined;
  if (
    lease?.case === facts.caseSeq &&
    lease.expiresAt > now &&
    shared.some(({ subject }) => sameSubject(subject, lease.subject))
  )
    return true;
  return [threadKey, ...(memberKey ? [memberKey] : [])].some(
    (key) => Object.keys(livePendingJobs(rows.get(key), now)).length > 0,
  );
}

/** Which shared transaction an automatic run checks: the newest one of the
 * current context that has no fresh check or lease in this case. */
export async function autoSubject(
  storage: Storage,
  facts: DiagnosisThreadFacts,
  enabled: DiagnosisNetwork[],
  now: number,
): Promise<DiagnosisSubject | null> {
  const listed = await listThreadRecords(storage, facts.thread);
  const lease = await storage.get<DiagnosisLease>(
    `${DIAGNOSIS_LEASE_PREFIX}${facts.thread}`,
  );
  for (const { subject, network } of contextTransactions(facts.context)) {
    if (subject.kind === "solana" && !enabled.includes("solana")) continue;
    if (
      subject.kind === "evm" &&
      (network
        ? !enabled.includes(network)
        : !enabled.some((item) => item !== "solana"))
    )
      continue;
    const fresh = listed.some(
      (item) =>
        item.record &&
        item.record.case === facts.caseSeq &&
        sameSubject(item.record.subject, subject) &&
        now - item.record.at <
          diagnosisFreshForMs(
            item.record.diagnosis.status,
            item.record.diagnosis.finality,
          ),
    );
    const leased =
      lease &&
      isObject(lease) &&
      lease.expiresAt > now &&
      sameSubject(lease.subject, subject);
    if (!fresh && !leased) return subject;
    return null;
  }
  return null;
}

/** The route's response shapes. */
export const diagnosisResponses = {
  cached: (
    record: StoredDiagnosisRecord,
    reader: { isBot: boolean },
    now: number,
  ) => json({ diagnosis: diagnosisView(record, reader, now), cached: true }),
  running: (lease: DiagnosisLease) =>
    json(
      {
        running: {
          subject: subjectValue(lease.subject),
          trigger: lease.trigger,
          startedAt: iso(lease.startedAt),
        },
      },
      202,
    ),
};

export type { StoredDiagnosisRecord };
