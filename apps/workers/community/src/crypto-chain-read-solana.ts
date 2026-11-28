import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  knownSolanaMint,
  SOLANA_MINTS,
  SOLANA_PROGRAMS,
} from "@templ/chat/diagnosis/known-addresses";
import { isSolanaSignature } from "@templ/chat/diagnosis/subject";
import { isSolanaAddress } from "@templ/chat/solana";
import { formatUnits } from "viem";
import {
  agree,
  checkIdentity,
  CryptoEgressRefused,
  fail,
  invalid,
  isoSeconds,
  isRecord,
  rpc,
  sameFacts,
  sourceReports,
  type CryptoProviderId,
  type Observed,
  type ReadContext,
  type SolanaRpcProvider,
} from "./crypto-chain-read-egress";
import {
  addressReadNotes,
  txReadNotes,
  type ActivityAgreement,
  type AddressReadBody,
  type TxReadBody,
  type TxResult,
} from "./crypto-chain-read-notes";
import { isSolanaKeypair } from "./tx-diagnosis/key-guard";

/** Solana mainnet through two public RPC operators, at confirmed
 * commitment. Amounts are lamports or a token's raw units; token decimals
 * come from the chain. */

const PROVIDERS: readonly SolanaRpcProvider[] = ["solana-foundation", "publicnode-solana"];
/** Balance changes listed per transaction; the rest are counted. */
const LISTED = 20;
/** History items that also get this address's own change. */
const DETAILED = 3;
/** Reviewed mints whose associated token accounts are read with a wallet.
 * Both use the original SPL Token program. */
const READ_MINTS = SOLANA_MINTS.filter((mint) => mint.label === "USDC" || mint.label === "USDT");

type Commitment = "processed" | "confirmed" | "finalized";
const RANK: Record<Commitment, number> = { processed: 0, confirmed: 1, finalized: 2 };
const lower = (a: Commitment, b: Commitment) => (RANK[a] <= RANK[b] ? a : b);

/** The error's type names, never its free text. */
export type SolanaTxError = {
  kind: string;
  instruction?: number;
  detail?: string;
  /** A program's own error number (a Custom error). */
  code?: number;
};

export type SolanaTokenChange = {
  mint: string;
  /** From Templ's reviewed list, never from token metadata. */
  label: string | null;
  decimals: number;
  changeRaw: string;
  change: string;
};

export type SolanaTxFacts = {
  chain: "solana";
  signature: string;
  /** "processing": seen at processed commitment, not yet confirmed. */
  state: "succeeded" | "failed" | "processing";
  commitment: Commitment;
  slot: number;
  blockTime: string | null;
  /** Paid even when the transaction failed; null while processing. */
  feeLamports: string | null;
  feeSol: string | null;
  feePayer: string | null;
  error: SolanaTxError | null;
  /** Per account, signed, the fee included for the payer. A failed
   * transaction shows only the fee. */
  solChanges: { account: string; changeLamports: string; changeSol: string }[];
  /** Per token account, signed. */
  tokenChanges: (SolanaTokenChange & { account: string; owner: string | null })[];
  accountCount: number;
  /** Changes not listed: past 20, or a balance too large to read exactly. */
  omittedChanges: number;
};

export type SolanaAddressChange = {
  /** Signed; includes the fee when this address paid it. */
  solChangeLamports: string;
  solChange: string;
  feePaid: boolean;
  feeLamports: string;
  /** Tokens this address owns, summed per mint, signed. */
  tokens: SolanaTokenChange[];
  seenBy: CryptoProviderId[];
};
export type SolanaActivityItem = {
  signature: string;
  slot: number;
  blockTime: string | null;
  state: "succeeded" | "failed";
  commitment: Commitment;
  seenBy: CryptoProviderId[];
  agreement: ActivityAgreement;
  /** Only on conflict: each provider's view. */
  observations?: {
    provider: CryptoProviderId;
    state: "succeeded" | "failed";
    slot: number;
    commitment: Commitment;
  }[];
  /** Read for the newest three; null otherwise or when no provider agreed. */
  change: SolanaAddressChange | null;
};
export type SolanaActivity = {
  chain: "solana";
  items: SolanaActivityItem[];
  /** The wallet and its reviewed token accounts, in that order. */
  accounts: string[];
  history: { shown: number; complete: boolean };
};

/** A 32-byte address. A 64-byte keypair reads "keypair"; nothing is sent. */
export async function parseSolanaAddress(
  value: string,
): Promise<{ ok: true; address: string } | { ok: false; reason: "invalid-address" | "keypair" }> {
  const text = typeof value === "string" ? value.trim() : "";
  if (isSolanaAddress(text)) return { ok: true, address: text };
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(text) && (await isSolanaKeypair(text)))
    return { ok: false, reason: "keypair" };
  return { ok: false, reason: "invalid-address" };
}

/** A signature, or "keypair" for a 64-byte secret key. */
export async function parseSolanaSignature(
  value: string,
): Promise<{ ok: true; signature: string } | { ok: false; reason: "invalid-id" | "keypair" }> {
  const text = typeof value === "string" ? value.trim() : "";
  if (!isSolanaSignature(text)) return { ok: false, reason: "invalid-id" };
  return (await isSolanaKeypair(text))
    ? { ok: false, reason: "keypair" }
    : { ok: true, signature: text };
}

const integer = (value: unknown, min = 0) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min
    ? value
    : invalid("integer");
const absent = (raw: unknown) => raw === null || raw === undefined;
const sol = (lamports: bigint) => formatUnits(lamports, 9);
const account = (raw: unknown) =>
  typeof raw === "string" && isSolanaAddress(raw) ? raw : invalid("account");

const NAME = /^[A-Za-z]{1,64}$/;
function errorOf(raw: unknown): SolanaTxError | null {
  if (absent(raw)) return null;
  if (typeof raw === "string") return { kind: NAME.test(raw) ? raw : "Unknown" };
  if (!isRecord(raw)) return { kind: "Unknown" };
  const [kind] = Object.keys(raw);
  if (!kind || !NAME.test(kind)) return { kind: "Unknown" };
  const value = raw[kind];
  if (kind !== "InstructionError" || !Array.isArray(value) || value.length !== 2) return { kind };
  const [instruction, inner] = value;
  if (!Number.isSafeInteger(instruction) || instruction < 0) return { kind };
  if (typeof inner === "string") return NAME.test(inner) ? { kind, instruction, detail: inner } : { kind, instruction };
  if (!isRecord(inner)) return { kind, instruction };
  const [detail] = Object.keys(inner);
  if (!detail || !NAME.test(detail)) return { kind, instruction };
  return detail === "Custom" && Number.isSafeInteger(inner.Custom)
    ? { kind, instruction, detail, code: inner.Custom as number }
    : { kind, instruction, detail };
}

type TokenBalance = {
  index: number;
  mint: string;
  owner: string | null;
  amount: bigint;
  decimals: number;
};
type Parsed = {
  signatures: string[];
  slot: number;
  blockTime: number | null;
  error: SolanaTxError | null;
  fee: number;
  accounts: string[];
  /** Lamports; an unsafe number cannot be read exactly. */
  pre: number[];
  post: number[];
  preTokens: TokenBalance[];
  postTokens: TokenBalance[];
};

/** A jsonParsed getTransaction answer, checked field by field. */
function solanaTx(raw: unknown): Parsed {
  if (!isRecord(raw) || !isRecord(raw.meta) || !isRecord(raw.transaction))
    return invalid("transaction");
  const meta = raw.meta;
  const transaction = raw.transaction;
  const signatures = transaction.signatures;
  if (!Array.isArray(signatures) || !signatures.length || !signatures.every(isSolanaSignature))
    return invalid("signatures");
  const message = transaction.message;
  if (!isRecord(message) || !Array.isArray(message.accountKeys) || !message.accountKeys.length)
    return invalid("accounts");
  // jsonParsed lists lookup-table accounts here too, in balance order.
  const accounts = message.accountKeys.map((key: unknown) =>
    account(isRecord(key) ? key.pubkey : key),
  );
  const balances = (list: unknown) => {
    if (!Array.isArray(list) || list.length !== accounts.length) return invalid("balances");
    return list.map((value: unknown) =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : invalid("lamports"),
    );
  };
  const tokens = (list: unknown): TokenBalance[] => {
    if (absent(list)) return [];
    if (!Array.isArray(list)) return invalid("token balances");
    return list.map((entry: unknown) => {
      if (!isRecord(entry) || !isRecord(entry.uiTokenAmount)) return invalid("token balance");
      const index = integer(entry.accountIndex);
      if (index >= accounts.length) invalid("token account");
      const { amount, decimals } = entry.uiTokenAmount;
      if (typeof amount !== "string" || !/^\d{1,40}$/.test(amount)) return invalid("token amount");
      return {
        index,
        mint: account(entry.mint),
        owner: absent(entry.owner) ? null : account(entry.owner),
        amount: BigInt(amount),
        decimals: integer(decimals) <= 255 ? (decimals as number) : invalid("decimals"),
      };
    });
  };
  return {
    signatures,
    slot: integer(raw.slot),
    blockTime: absent(raw.blockTime) ? null : integer(raw.blockTime, 1),
    error: errorOf(meta.err),
    fee: integer(meta.fee),
    accounts,
    pre: balances(meta.preBalances),
    post: balances(meta.postBalances),
    preTokens: tokens(meta.preTokenBalances),
    postTokens: tokens(meta.postTokenBalances),
  };
}

function tokenChange(mint: string, decimals: number, change: bigint): SolanaTokenChange {
  const known = knownSolanaMint(mint);
  return {
    mint,
    label: known?.label ?? null,
    decimals,
    changeRaw: change.toString(),
    change: formatUnits(change, decimals),
  };
}

function txFacts(parsed: Parsed, signature: string, commitment: Commitment): SolanaTxFacts {
  let omitted = 0;
  const solChanges: SolanaTxFacts["solChanges"] = [];
  parsed.accounts.forEach((key, index) => {
    const before = parsed.pre[index];
    const after = parsed.post[index];
    if (before === after) return;
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || solChanges.length >= LISTED) {
      omitted++;
      return;
    }
    const change = BigInt(after) - BigInt(before);
    solChanges.push({ account: key, changeLamports: change.toString(), changeSol: sol(change) });
  });
  const byAccount = new Map<number, { pre?: TokenBalance; post?: TokenBalance }>();
  for (const entry of parsed.preTokens) byAccount.set(entry.index, { ...byAccount.get(entry.index), pre: entry });
  for (const entry of parsed.postTokens) byAccount.set(entry.index, { ...byAccount.get(entry.index), post: entry });
  const tokenChanges: SolanaTxFacts["tokenChanges"] = [];
  for (const [index, { pre, post }] of [...byAccount].sort(([a], [b]) => a - b)) {
    const entry = (post ?? pre)!;
    if (pre && post && (pre.mint !== post.mint || pre.decimals !== post.decimals)) invalid("token account");
    const change = (post?.amount ?? 0n) - (pre?.amount ?? 0n);
    if (change === 0n) continue;
    if (tokenChanges.length >= LISTED) {
      omitted++;
      continue;
    }
    tokenChanges.push({
      account: parsed.accounts[index],
      owner: entry.owner,
      ...tokenChange(entry.mint, entry.decimals, change),
    });
  }
  return {
    chain: "solana",
    signature,
    state: parsed.error ? "failed" : "succeeded",
    commitment,
    slot: parsed.slot,
    blockTime: parsed.blockTime === null ? null : isoSeconds(parsed.blockTime),
    feeLamports: String(parsed.fee),
    feeSol: sol(BigInt(parsed.fee)),
    feePayer: parsed.accounts[0],
    error: parsed.error,
    solChanges,
    tokenChanges,
    accountCount: parsed.accounts.length,
    omittedChanges: omitted,
  };
}

const COMMITMENTS = new Set(["processed", "confirmed", "finalized"]);
/** Validates a status and a history entry's commitment. Without a status,
 * no confirmations count means the slot is rooted. */
function commitmentOf(entry: Record<string, unknown>): Commitment {
  const status = entry.confirmationStatus;
  if (typeof status === "string" && COMMITMENTS.has(status)) return status as Commitment;
  if (!absent(status)) return invalid("commitment");
  return entry.confirmations === null ? "finalized" : "processed";
}

function statusOf(result: unknown): { slot: number; commitment: Commitment } | null {
  if (!isRecord(result) || !Array.isArray(result.value) || result.value.length !== 1)
    return invalid("status");
  const entry = result.value[0];
  if (entry === null) return null;
  if (!isRecord(entry)) return invalid("status entry");
  return { slot: integer(entry.slot), commitment: commitmentOf(entry) };
}

const voided = <T>(ctx: ReadContext, provider: SolanaRpcProvider): Observed<T> => ({
  provider,
  ok: false,
  failure: fail(ctx, provider, { outcome: "invalid-response" }).failure,
});

async function observeTx(
  ctx: ReadContext,
  provider: SolanaRpcProvider,
  signature: string,
): Promise<Observed<TxResult<SolanaTxFacts>>> {
  const [identity, statusReply, txReply] = await Promise.all([
    checkIdentity(ctx, provider),
    rpc(ctx, provider, { method: "getSignatureStatuses", signature }),
    rpc(ctx, provider, { method: "getTransaction", signature }),
  ]);
  if (identity || !statusReply.ok || !txReply.ok) return voided(ctx, provider);
  try {
    const status = statusOf(statusReply.result);
    if (txReply.result === null) {
      if (!status) return { provider, ok: true, value: { found: false } };
      // A confirmed transaction this provider cannot return is no answer.
      if (status.commitment !== "processed") invalid("confirmed without transaction");
      return {
        provider,
        ok: true,
        value: {
          found: true,
          tx: {
            chain: "solana",
            signature,
            state: "processing",
            commitment: "processed",
            slot: status.slot,
            blockTime: null,
            feeLamports: null,
            feeSol: null,
            feePayer: null,
            error: null,
            solChanges: [],
            tokenChanges: [],
            accountCount: 0,
            omittedChanges: 0,
          },
        },
      };
    }
    const parsed = solanaTx(txReply.result);
    if (!parsed.signatures.includes(signature)) invalid("signature");
    if (status && status.slot !== parsed.slot) invalid("slot");
    const commitment = status?.commitment === "finalized" ? "finalized" : "confirmed";
    return { provider, ok: true, value: { found: true, tx: txFacts(parsed, signature, commitment) } };
  } catch (error) {
    if (error instanceof CryptoEgressRefused) throw error;
    return voided(ctx, provider);
  }
}

const withoutCommitment = (result: TxResult<SolanaTxFacts>) =>
  result.found ? { ...result.tx, commitment: null } : result;

export async function readSolanaTransaction(
  ctx: ReadContext,
  signature: string,
): Promise<TxReadBody<SolanaTxFacts>> {
  const observed = await Promise.all(
    PROVIDERS.map((provider) => observeTx(ctx, provider, signature)),
  );
  const { agreement, value, observations } = agree(
    observed,
    (a, b) => sameFacts(withoutCommitment(a), withoutCommitment(b)),
    (a, b) =>
      a.found && b.found
        ? { found: true, tx: { ...a.tx, commitment: lower(a.tx.commitment, b.tx.commitment) } }
        : a,
  );
  const sources = sourceReports(ctx, observed, (result) => result.found);
  const notes = txReadNotes(agreement, sources, value);
  if (value?.found) {
    if (value.tx.state === "failed") notes.add("failed-fee-charged");
    if (value.tx.tokenChanges.some((change) => change.label === null)) notes.add("unreviewed-token");
    if (value.tx.omittedChanges > 0) notes.add("items-capped");
  }
  return {
    agreement,
    result: value,
    observations: observations.map(({ provider, value }) => ({ provider, result: value })),
    sources,
    notes: [...notes],
  };
}

/** The wallet's associated token accounts for the reviewed mints. An
 * off-curve owner (a program-derived wallet such as a multisig vault) has
 * them too. */
export function reviewedTokenAccounts(owner: string): string[] {
  const key = new PublicKey(owner);
  const program = new PublicKey(SOLANA_PROGRAMS.splToken);
  return READ_MINTS.map((mint) =>
    getAssociatedTokenAddressSync(new PublicKey(mint.mint), key, true, program).toBase58(),
  );
}

type Entry = {
  signature: string;
  slot: number;
  blockTime: string | null;
  state: "succeeded" | "failed";
  commitment: Commitment;
};

function historyEntry(raw: unknown): Entry {
  if (!isRecord(raw)) return invalid("history entry");
  const signature =
    typeof raw.signature === "string" && isSolanaSignature(raw.signature)
      ? raw.signature
      : invalid("history signature");
  const blockTime = absent(raw.blockTime) ? null : integer(raw.blockTime, 1);
  return {
    signature,
    slot: integer(raw.slot),
    blockTime: blockTime === null ? null : isoSeconds(blockTime),
    state: absent(raw.err) ? "succeeded" : "failed",
    commitment: commitmentOf(raw),
  };
}

async function observeHistory(
  ctx: ReadContext,
  provider: SolanaRpcProvider,
  accounts: readonly string[],
  limit: number,
): Promise<Observed<{ entries: Entry[]; complete: boolean }>> {
  const [identity, lists] = await Promise.all([
    checkIdentity(ctx, provider),
    Promise.all(
      accounts.map((address) =>
        rpc(ctx, provider, { method: "getSignaturesForAddress", address, limit }),
      ),
    ),
  ]);
  if (identity || lists.some((reply) => !reply.ok)) return voided(ctx, provider);
  try {
    const bySignature = new Map<string, Entry>();
    let complete = true;
    for (const reply of lists) {
      const result = reply.ok ? reply.result : null;
      if (!Array.isArray(result) || result.length > limit) return invalid("history");
      if (result.length === limit) complete = false;
      for (const raw of result) {
        const entry = historyEntry(raw);
        const seen = bySignature.get(entry.signature);
        // The same transaction can touch the wallet and its token accounts.
        if (seen && !sameFacts({ ...seen, commitment: null }, { ...entry, commitment: null }))
          invalid("history entry differs");
        bySignature.set(
          entry.signature,
          seen ? { ...entry, commitment: lower(seen.commitment, entry.commitment) } : entry,
        );
      }
    }
    return { provider, ok: true, value: { entries: [...bySignature.values()], complete } };
  } catch (error) {
    if (error instanceof CryptoEgressRefused) throw error;
    return voided(ctx, provider);
  }
}

function addressChange(parsed: Parsed, self: string): Omit<SolanaAddressChange, "seenBy"> {
  const index = parsed.accounts.indexOf(self);
  let lamports = 0n;
  if (index >= 0) {
    const before = parsed.pre[index];
    const after = parsed.post[index];
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) invalid("lamports");
    lamports = BigInt(after) - BigInt(before);
  }
  const feePaid = parsed.accounts[0] === self;
  const sums = new Map<string, { decimals: number; change: bigint }>();
  const add = (entry: TokenBalance, sign: 1n | -1n) => {
    if (entry.owner !== self) return;
    const sum = sums.get(entry.mint) ?? { decimals: entry.decimals, change: 0n };
    if (sum.decimals !== entry.decimals) invalid("decimals");
    sums.set(entry.mint, { decimals: sum.decimals, change: sum.change + sign * entry.amount });
  };
  for (const entry of parsed.preTokens) add(entry, -1n);
  for (const entry of parsed.postTokens) add(entry, 1n);
  return {
    solChangeLamports: lamports.toString(),
    solChange: sol(lamports),
    feePaid,
    feeLamports: feePaid ? String(parsed.fee) : "0",
    tokens: [...sums]
      .filter(([, sum]) => sum.change !== 0n)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([mint, sum]) => tokenChange(mint, sum.decimals, sum.change)),
  };
}

async function observeChange(
  ctx: ReadContext,
  provider: SolanaRpcProvider,
  signature: string,
  self: string,
): Promise<Observed<Omit<SolanaAddressChange, "seenBy">>> {
  const reply = await rpc(ctx, provider, { method: "getTransaction", signature });
  if (!reply.ok) return { provider, ok: false, failure: reply.failure };
  try {
    const parsed = reply.result === null ? invalid("listed without transaction") : solanaTx(reply.result);
    if (!parsed.signatures.includes(signature)) invalid("signature");
    return { provider, ok: true, value: addressChange(parsed, self) };
  } catch (error) {
    if (error instanceof CryptoEgressRefused) throw error;
    return voided(ctx, provider);
  }
}

export async function readSolanaAddress(
  ctx: ReadContext,
  self: string,
  limit: number,
): Promise<AddressReadBody<SolanaActivity>> {
  const accounts = [self, ...reviewedTokenAccounts(self)];
  const observed = await Promise.all(
    PROVIDERS.map((provider) => observeHistory(ctx, provider, accounts, limit)),
  );
  const answered = observed.filter(
    (item): item is Extract<(typeof observed)[number], { ok: true }> => item.ok,
  );
  if (!answered.length) {
    const sources = sourceReports(ctx, observed, () => true);
    return {
      agreement: "unavailable",
      activity: null,
      sources,
      notes: [...addressReadNotes("unavailable", sources)],
    };
  }
  const views = new Map<string, { provider: SolanaRpcProvider; entry: Entry }[]>();
  for (const { provider, value } of answered)
    for (const entry of value.entries) {
      const seen = views.get(entry.signature);
      if (seen) seen.push({ provider: provider as SolanaRpcProvider, entry });
      else views.set(entry.signature, [{ provider: provider as SolanaRpcProvider, entry }]);
    }
  const merged = [...views.values()]
    .map((seen): SolanaActivityItem => {
      const seenBy = seen.map((view) => view.provider);
      const [first, second] = seen;
      if (!second)
        return { ...first.entry, seenBy, agreement: "single", change: null };
      if (sameFacts({ ...first.entry, commitment: null }, { ...second.entry, commitment: null }))
        return {
          ...first.entry,
          commitment: lower(first.entry.commitment, second.entry.commitment),
          seenBy,
          agreement: "agreed",
          change: null,
        };
      const shown = RANK[second.entry.commitment] < RANK[first.entry.commitment] ? second : first;
      return {
        ...shown.entry,
        seenBy,
        agreement: "conflict",
        observations: seen.map(({ provider, entry }) => ({
          provider,
          state: entry.state,
          slot: entry.slot,
          commitment: entry.commitment,
        })),
        change: null,
      };
    })
    .sort((a, b) => b.slot - a.slot);
  const items = merged.slice(0, limit);
  await Promise.all(
    items.slice(0, DETAILED).map(async (item) => {
      const changes = await Promise.all(
        item.seenBy.map((provider) =>
          observeChange(ctx, provider as SolanaRpcProvider, item.signature, self),
        ),
      );
      const { value } = agree(changes, sameFacts);
      if (value)
        item.change = {
          ...value,
          seenBy: changes.filter((change) => change.ok).map((change) => change.provider),
        };
    }),
  );
  const sources = sourceReports(ctx, observed, (view) => view.entries.length > 0);
  const complete = answered.every(({ value }) => value.complete) && merged.length <= limit;
  const agreement =
    answered.length === 2 && items.every((item) => item.agreement === "agreed")
      ? "agreed"
      : items.some((item) => item.agreement === "conflict")
        ? "conflict"
        : "single";
  const notes = addressReadNotes(agreement, sources);
  if (!complete) notes.add("history-partial");
  if (items.some((item) => item.state === "failed")) notes.add("failed-fee-charged");
  if (items.some((item) => item.change?.tokens.some((token) => token.label === null)))
    notes.add("unreviewed-token");
  notes.add("solana-token-accounts");
  notes.add("free-text-omitted");
  return {
    agreement,
    activity: {
      chain: "solana",
      items,
      accounts,
      history: { shown: items.length, complete },
    },
    sources,
    notes: [...notes],
  };
}
