/** Structured request context: the network, transaction hashes and explorer
 * links a member shares with the team. Pure functions with no I/O, so the
 * worker, the widget and the inbox apply the same rules. Nothing here signs,
 * reads a chain or decides access. */
import {
  SUPPORT_WALLET_CHAINS,
  isEip155ChainId,
  supportWalletChain,
} from "./chains";
import {
  SOLANA_EXPLORER,
  SOLANA_NAME,
  base58Decode,
  isSolanaAddress,
} from "./solana";
import { SUPPORT_FAILURE_SNAPSHOT_LIMIT } from "./support";
import type {
  SupportContext,
  SupportFailureSnapshot,
  SupportNetwork,
  SupportTransaction,
} from "./support";
import {
  AppContextError,
  SUPPORT_APP_FIELDS,
  parseAppContext,
  type SupportAppContext,
  type SupportAppField,
} from "./support-app-context";

export {
  SUPPORT_APP_ACTIONS,
  SUPPORT_APP_FIELDS,
  SUPPORT_APP_LIMITS,
  appContextTexts,
  type SupportAppAction,
  type SupportAppContext,
  type SupportAppContextInput,
  type SupportAppField,
} from "./support-app-context";

export const SUPPORT_CONTEXT_LIMITS = {
  descriptionBytes: 2000,
  /** Longest network name, hash or explorer link accepted as input. */
  inputChars: 300,
  transactions: 5,
  snapshots: SUPPORT_FAILURE_SNAPSHOT_LIMIT,
} as const;
export type SupportContextReason =
  | "invalid-context"
  | "invalid-network"
  | "invalid-transaction"
  | "invalid-app-context"
  | "invalid-context-target";
const MESSAGES: Readonly<Record<SupportContextReason, string>> = {
  "invalid-transaction":
    "This doesn't look like a transaction ID. Paste the hash, signature or explorer link.",
  "invalid-network":
    'Use a network like "eip155:8453" or "solana", or a name such as Base.',
  "invalid-context":
    "Share up to 5 transactions, with a description of at most 2,000 bytes.",
  "invalid-app-context": "Share details from the app in the documented shape.",
  "invalid-context-target":
    "Choose a detail you shared: the network, a transaction, the note or one detail from the app.",
};
/** A refused context write. `reason` is the code the service returns. */
export class SupportContextError extends Error {
  readonly reason: SupportContextReason;
  constructor(reason: SupportContextReason, message = MESSAGES[reason]) {
    super(message);
    this.name = "SupportContextError";
    this.reason = reason;
  }
}
/** The stored form in `support-workflow-v1:<tc>`. `chainId` is never stored;
 * it is derived on read so it cannot disagree with `network`. */
export type StoredSupportContext = {
  v: 2;
  snapshots?: SupportFailureSnapshot[];
  description?: string;
  network?: SupportNetwork;
  transactions?: SupportTransaction[];
  /** Typed details from the protocol's app, one per field. */
  app?: SupportAppContext;
};
/** One accepted input, before it is merged with what the thread holds. */
export type ParsedSupportContext = {
  snapshots?: SupportFailureSnapshot[];
  description?: string;
  network?: SupportNetwork;
  /** Newest first, no duplicate hash. */
  transactions: SupportTransaction[];
  app?: SupportAppContext;
};

/** Checks `context.app` with the service's network rules. Throws
 * SupportContextError with `invalid-app-context` and the failing field's
 * message. */
export function parseAppContextInput(
  value: unknown,
): SupportAppContext | undefined {
  try {
    return parseAppContext(value, { parseSupportNetwork, isSolanaAddress });
  } catch (error) {
    if (error instanceof AppContextError)
      throw new SupportContextError("invalid-app-context", error.message);
    throw error;
  }
}

/* ---------------------------------------------------------------------- */
/* A member removes one shared detail (CONTEXT-MEMBER-REMOVAL)             */
/* ---------------------------------------------------------------------- */

/** One shared detail: the note, the network, one transaction by hash, or
 * one typed field. */
export type SupportContextTarget =
  | { field: "description" | "network" | SupportAppField }
  | { transaction: string };
/** What the activity log keeps for a removal: the field, never its value. */
export function contextTargetLabel(target: SupportContextTarget): string {
  return "transaction" in target
    ? "transaction"
    : target.field === "description" || target.field === "network"
      ? target.field
      : `app.${target.field}`;
}
/** `{ field }` or `{ transaction }`, nothing else. Throws
 * `invalid-context-target`. */
export function parseContextTarget(value: unknown): SupportContextTarget {
  if (isRecord(value) && Object.keys(value).length === 1) {
    const { field, transaction } = value;
    if (
      field === "description" ||
      field === "network" ||
      SUPPORT_APP_FIELDS.includes(field as SupportAppField)
    )
      return { field: field as SupportAppField };
    const tx =
      typeof transaction === "string"
        ? parseTransactionReference(transaction)
        : null;
    if (tx) return { transaction: tx.hash };
  }
  throw new SupportContextError("invalid-context-target");
}
/** What the thread holds without that one detail, or null when the thread
 * doesn't hold it. */
export function removeSupportContext(
  previous: SupportContext | null,
  target: SupportContextTarget,
): StoredSupportContext | null {
  if (!previous) return null;
  const stored: StoredSupportContext = {
    v: 2,
    ...(previous.snapshots ? { snapshots: previous.snapshots } : {}),
    ...(previous.description ? { description: previous.description } : {}),
    ...(previous.network ? { network: previous.network } : {}),
    ...(previous.transactions?.length
      ? { transactions: previous.transactions }
      : {}),
    ...(previous.app ? { app: { ...previous.app } } : {}),
  };
  if ("transaction" in target) {
    const kept = (stored.transactions ?? []).filter(
      (tx) => tx.hash !== target.transaction,
    );
    if (kept.length === (stored.transactions?.length ?? 0)) return null;
    if (kept.length) stored.transactions = kept;
    else delete stored.transactions;
    return stored;
  }
  const { field } = target;
  if (field === "description" || field === "network") {
    if (!stored[field]) return null;
    delete stored[field];
    return stored;
  }
  if (stored.app?.[field] === undefined) return null;
  delete stored.app[field];
  if (!Object.keys(stored.app).length) delete stored.app;
  return stored;
}

const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
/** Base58 of 64 bytes is usually 87 or 88 characters, 86 for about 0.3% of
 * signatures, and shorter with leading zero bytes; the decode decides. */
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SOLANA: SupportNetwork = "solana";

const NETWORK_NAMES = new Map<string, SupportNetwork>([
  ...SUPPORT_WALLET_CHAINS.map(
    (chain) =>
      [chain.name.toLowerCase(), `eip155:${chain.id}`] as [
        string,
        SupportNetwork,
      ],
  ),
  ["eth", "eip155:1"],
  ["ethereum mainnet", "eip155:1"],
  ["mainnet", "eip155:1"],
  ["optimism", "eip155:10"],
  ["op", "eip155:10"],
  ["bnb", "eip155:56"],
  ["bsc", "eip155:56"],
  ["binance smart chain", "eip155:56"],
  ["matic", "eip155:137"],
  ["polygon pos", "eip155:137"],
  ["zksync", "eip155:324"],
  ["arbitrum", "eip155:42161"],
  ["arb", "eip155:42161"],
  ["avax", "eip155:43114"],
  ["avalanche c-chain", "eip155:43114"],
  ["robinhood", "eip155:4663"],
  ["solana", SOLANA],
  ["sol", SOLANA],
]);
/** Explorer hosts whose `/tx/<hash>` links name a transaction, each also
 * accepted with a `www.` prefix. */
const LINK_HOSTS = new Map<string, SupportNetwork>([
  ...SUPPORT_WALLET_CHAINS.map(
    (chain) =>
      [
        new URL(chain.tx.replace("{hash}", "0")).hostname,
        `eip155:${chain.id}`,
      ] as [string, SupportNetwork],
  ),
  ["solscan.io", SOLANA],
  ["explorer.solana.com", SOLANA],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Empty strings and null are "not provided". */
function provided(value: unknown) {
  return value !== undefined && value !== null && value !== "";
}
function chainIdOf(network: SupportNetwork | undefined): number | null {
  if (!network || network === SOLANA) return null;
  const id = Number(network.slice("eip155:".length));
  return isEip155ChainId(id) ? id : null;
}
/** The canonical form only: "eip155:<positive safe integer>" or "solana". */
function isSupportNetwork(value: unknown): value is SupportNetwork {
  if (value === SOLANA) return true;
  return (
    typeof value === "string" &&
    /^eip155:[1-9][0-9]*$/.test(value) &&
    `eip155:${chainIdOf(value as SupportNetwork)}` === value
  );
}
function sameFamily(hash: string, network: SupportNetwork) {
  return network === SOLANA
    ? isSolanaSignature(hash)
    : isEvmTransactionHash(hash);
}

export function isEvmTransactionHash(value: unknown): value is string {
  return typeof value === "string" && EVM_HASH.test(value);
}
/** A Solana transaction signature: base58 that decodes to exactly 64 bytes. */
export function isSolanaSignature(value: unknown): value is string {
  if (typeof value !== "string" || !SOLANA_SIGNATURE.test(value)) return false;
  try {
    return base58Decode(value).length === 64;
  } catch {
    return false;
  }
}
/** "eip155:<n>", "solana", or a known name ("Base", "Arbitrum", "BSC"),
 * trimmed and case-insensitive. Anything else is null. */
export function parseSupportNetwork(value: unknown): SupportNetwork | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  if (!name || name.length > SUPPORT_CONTEXT_LIMITS.inputChars) return null;
  const canonical = /^eip155:([1-9][0-9]*)$/.exec(name);
  if (canonical) {
    const id = Number(canonical[1]);
    return isEip155ChainId(id) ? `eip155:${id}` : null;
  }
  return NETWORK_NAMES.get(name) ?? null;
}
/** undefined: not a link. null: a link Templ does not read. */
function explorerLink(value: string): SupportTransaction | null | undefined {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  const network = LINK_HOSTS.get(
    url.hostname.toLowerCase().replace(/^www\./, ""),
  );
  const path = /^\/tx\/([^/]+)\/?$/.exec(url.pathname);
  if (!network || !path) return null;
  let hash: string;
  try {
    hash = decodeURIComponent(path[1]);
  } catch {
    return null;
  }
  if (network === SOLANA) {
    // Templ reads Solana mainnet only; a devnet or testnet link is refused.
    const cluster = url.searchParams.get("cluster");
    if (cluster !== null && cluster !== "mainnet" && cluster !== "mainnet-beta")
      return null;
    return isSolanaSignature(hash) ? { hash, network } : null;
  }
  return isEvmTransactionHash(hash)
    ? { hash: hash.toLowerCase(), network }
    : null;
}
/** One hash or explorer link. EVM hashes are stored lowercase, signatures as
 * sent. A link names its own network; otherwise `hint` applies when the hash
 * family matches, an EVM hash without one has no network, and a signature is
 * Solana. Links must be `https:` on a listed explorer with a `/tx/` path. */
export function parseTransactionReference(
  input: string,
  hint?: SupportNetwork,
): SupportTransaction | null {
  if (typeof input !== "string") return null;
  const value = input.trim();
  if (!value || value.length > SUPPORT_CONTEXT_LIMITS.inputChars) return null;
  const link = explorerLink(value);
  if (link !== undefined) return link;
  if (isEvmTransactionHash(value)) {
    const hash = value.toLowerCase();
    return hint && isSupportNetwork(hint) && hint !== SOLANA
      ? { hash, network: hint }
      : { hash };
  }
  if (isSolanaSignature(value)) return { hash: value, network: SOLANA };
  return null;
}
/** Newest first; the first entry for a hash keeps its place, and a network
 * from a later duplicate fills one it lacks. */
function dedupe(list: readonly SupportTransaction[]): SupportTransaction[] {
  const out: SupportTransaction[] = [];
  const index = new Map<string, number>();
  for (const tx of list) {
    const at = index.get(tx.hash);
    if (at === undefined) {
      index.set(tx.hash, out.length);
      out.push(
        tx.network ? { hash: tx.hash, network: tx.network } : { hash: tx.hash },
      );
    } else if (!out[at].network && tx.network)
      out[at] = { hash: out[at].hash, network: tx.network };
  }
  return out;
}
/** The description rule: at most 2,000 UTF-8 bytes, no control characters
 * except newlines and tabs. Returns the trimmed text, "" when blank, or null
 * when invalid. */
function descriptionText(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length >
      SUPPORT_CONTEXT_LIMITS.descriptionBytes ||
    CONTROL.test(value)
  )
    return null;
  return value.trim();
}
/** Network and chainId from one object; both present and different, or
 * either invalid, is `invalid-network`. */
function explicitNetwork(
  input: Record<string, unknown>,
): SupportNetwork | undefined {
  let network: SupportNetwork | undefined;
  if (provided(input.network)) {
    const parsed = parseSupportNetwork(input.network);
    if (!parsed) throw new SupportContextError("invalid-network");
    network = parsed;
  }
  if (provided(input.chainId)) {
    if (!isEip155ChainId(input.chainId))
      throw new SupportContextError("invalid-network");
    const fromId: SupportNetwork = `eip155:${input.chainId}`;
    if (network && network !== fromId)
      throw new SupportContextError("invalid-network");
    network = fromId;
  }
  return network;
}
/** Checks frozen failure rows, with exact keys and the same typed text rules. */
export function parseFailureSnapshots(
  value: unknown,
): SupportFailureSnapshot[] {
  if (!Array.isArray(value) || value.length > SUPPORT_CONTEXT_LIMITS.snapshots)
    throw new SupportContextError("invalid-context");
  const keys = [
    "id",
    "capturedAt",
    "wallet",
    "network",
    "app",
    "failure",
    "sdk",
    "transactions",
  ];
  const result = value.map((raw): SupportFailureSnapshot => {
    if (
      !isRecord(raw) ||
      Object.keys(raw).some((key) => !keys.includes(key)) ||
      typeof raw.id !== "string" ||
      !/^[0-9a-f-]{36}$/.test(raw.id) ||
      typeof raw.capturedAt !== "string" ||
      raw.capturedAt.length > 40 ||
      !/^\d{4}-\d{2}-\d{2}T/.test(raw.capturedAt) ||
      !Number.isFinite(Date.parse(raw.capturedAt)) ||
      !isRecord(raw.wallet) ||
      Object.keys(raw.wallet).some(
        (key) => !["level", "address"].includes(key),
      ) ||
      !["guest", "attached", "verified"].includes(String(raw.wallet.level))
    )
      throw new SupportContextError("invalid-context");
    const network =
      raw.network === undefined ? undefined : parseSupportNetwork(raw.network);
    if (raw.network !== undefined && !network)
      throw new SupportContextError("invalid-network");
    const address = raw.wallet.address;
    if (
      address !== undefined &&
      (typeof address !== "string" ||
        (network === "solana"
          ? !isSolanaAddress(address)
          : network
            ? !/^0x[0-9a-fA-F]{40}$/.test(address)
            : !isSolanaAddress(address) &&
              !/^0x[0-9a-fA-F]{40}$/.test(address)))
    )
      throw new SupportContextError("invalid-context");
    if (
      raw.app !== undefined &&
      (!isRecord(raw.app) ||
        Object.keys(raw.app).some(
          (key) =>
            !SUPPORT_APP_FIELDS.includes(key as SupportAppField) ||
            key === "failure" ||
            key === "sdk",
        ))
    )
      throw new SupportContextError("invalid-app-context");
    if (isRecord(raw.app)) {
      const nested: Record<string, readonly string[]> = {
        product: ["key", "label", "address", "network"],
        shown: ["value", "metric", "period", "asOf"],
        error: ["code", "message"],
      };
      for (const [field, keys] of Object.entries(nested)) {
        const value = raw.app[field];
        if (
          value !== undefined &&
          (!isRecord(value) ||
            Object.keys(value).some((key) => !keys.includes(key)))
        )
          throw new SupportContextError("invalid-app-context");
      }
      const metric = isRecord(raw.app.shown) ? raw.app.shown.metric : undefined;
      if (
        metric !== undefined &&
        (!isRecord(metric) ||
          Object.keys(metric).some((key) => !["key", "label"].includes(key)))
      )
        throw new SupportContextError("invalid-app-context");
    }
    const app =
      raw.app === undefined ? undefined : parseAppContextInput(raw.app);
    if (
      raw.transactions !== undefined &&
      (!Array.isArray(raw.transactions) ||
        raw.transactions.some(
          (tx) =>
            !isRecord(tx) ||
            Object.keys(tx).some((key) => !["hash", "network"].includes(key)),
        ))
    )
      throw new SupportContextError("invalid-context");
    const transactions =
      raw.transactions === undefined
        ? undefined
        : parseSupportContextInput({ network, transactions: raw.transactions })
            .transactions;
    const details = parseAppContextInput({
      ...(raw.failure === undefined ? {} : { failure: raw.failure }),
      ...(raw.sdk === undefined ? {} : { sdk: raw.sdk }),
    });
    return {
      ...(transactions?.length ? { transactions } : {}),
      id: raw.id,
      capturedAt: new Date(raw.capturedAt).toISOString(),
      wallet: {
        level: raw.wallet.level as SupportFailureSnapshot["wallet"]["level"],
        ...(address ? { address: address as string } : {}),
      },
      ...(network ? { network } : {}),
      ...(app ? { app } : {}),
      ...(details?.failure ? { failure: details.failure } : {}),
      ...(details?.sdk ? { sdk: details.sdk } : {}),
    };
  });
  if (new Set(result.map((row) => row.id)).size !== result.length)
    throw new SupportContextError("invalid-context");
  return result;
}
/** Checks member-approved context before any thread write. */
export function parseSupportContextInput(value: unknown): ParsedSupportContext {
  if (!isRecord(value)) throw new SupportContextError("invalid-context");
  const result: ParsedSupportContext = { transactions: [] };
  if (value.snapshots !== undefined)
    result.snapshots = parseFailureSnapshots(value.snapshots);
  if (provided(value.description)) {
    const description = descriptionText(value.description);
    if (description === null) throw new SupportContextError("invalid-context");
    if (description) result.description = description;
  }
  const network = explicitNetwork(value);
  if (network) result.network = network;
  const entries: SupportTransaction[] = [];
  if (provided(value.transactionHash)) {
    const tx =
      typeof value.transactionHash === "string"
        ? parseTransactionReference(value.transactionHash, network)
        : null;
    if (!tx) throw new SupportContextError("invalid-transaction");
    entries.push(tx);
  }
  if (provided(value.transactions)) {
    if (
      !Array.isArray(value.transactions) ||
      value.transactions.length > SUPPORT_CONTEXT_LIMITS.transactions
    )
      throw new SupportContextError("invalid-context");
    for (const entry of value.transactions as unknown[]) {
      if (!isRecord(entry)) throw new SupportContextError("invalid-context");
      if (!provided(entry.hash)) continue;
      if (typeof entry.hash !== "string")
        throw new SupportContextError("invalid-transaction");
      const own = explicitNetwork(entry);
      const tx = parseTransactionReference(entry.hash, own ?? network);
      if (!tx || (own && tx.network !== own))
        throw new SupportContextError("invalid-transaction");
      entries.push(tx);
    }
  }
  result.transactions = dedupe([
    ...entries,
    ...(result.snapshots ?? []).flatMap(
      (snapshot) => snapshot.transactions ?? [],
    ),
  ]);
  if (result.transactions.length > SUPPORT_CONTEXT_LIMITS.transactions)
    throw new SupportContextError("invalid-context");
  if (provided(value.app)) {
    const app = parseAppContextInput(value.app);
    if (app) result.app = app;
  }
  return result;
}
/** Description and network replace when provided; transactions accumulate,
 * newest first, keeping the newest 5; each typed app field replaces the one
 * the thread holds. Values shared before Templ checked them are dropped. */
export function mergeSupportContext(
  previous: SupportContext | null,
  next: ParsedSupportContext,
): StoredSupportContext {
  const description = next.description ?? previous?.description;
  const network = next.network ?? previous?.network;
  const transactions = dedupe([
    ...next.transactions,
    ...(previous?.transactions ?? []),
  ]).slice(0, SUPPORT_CONTEXT_LIMITS.transactions);
  const app = mergeApp(previous?.app, next.app);
  const snapshots = [...(previous?.snapshots ?? [])];
  for (const snapshot of next.snapshots ?? []) {
    const index = snapshots.findIndex((row) => row.id === snapshot.id);
    if (index < 0) snapshots.push(snapshot);
    else {
      const held = snapshots[index];
      if (
        held.capturedAt !== snapshot.capturedAt ||
        held.wallet.level !== snapshot.wallet.level
      )
        throw new SupportContextError("invalid-context");
      const conflict = (a: unknown, b: unknown): boolean => {
        if (a === undefined || b === undefined) return false;
        if (isRecord(a) && isRecord(b))
          return Object.keys(a).some((key) => conflict(a[key], b[key]));
        return sortedJson(a) !== sortedJson(b);
      };
      const { transactions: heldTransactions, ...heldFields } = held;
      const { transactions: newTransactions, ...nextFields } = snapshot;
      if (conflict(heldFields, nextFields))
        throw new SupportContextError("invalid-context");
      snapshots[index] = {
        ...held,
        ...snapshot,
        wallet: { ...held.wallet, ...snapshot.wallet },
        ...(heldTransactions || newTransactions
          ? {
              transactions: [
                ...new Map(
                  [...(heldTransactions ?? []), ...(newTransactions ?? [])].map(
                    (row) => [`${row.network ?? ""}:${row.hash}`, row],
                  ),
                ).values(),
              ].slice(0, SUPPORT_CONTEXT_LIMITS.transactions),
            }
          : {}),
        ...(held.app || snapshot.app
          ? { app: mergeApp(held.app, snapshot.app) }
          : {}),
        ...(held.failure || snapshot.failure
          ? { failure: { ...held.failure!, ...snapshot.failure! } }
          : {}),
      };
    }
  }
  const kept = snapshots.slice(-SUPPORT_CONTEXT_LIMITS.snapshots);
  return {
    v: 2,
    ...(kept.length ? { snapshots: kept } : {}),
    ...(description ? { description } : {}),
    ...(network ? { network } : {}),
    ...(transactions.length ? { transactions } : {}),
    ...(app ? { app } : {}),
  };
}
/** Each typed field from `next` replaces the one in `previous`; the result
 * keeps the order of `SUPPORT_APP_FIELDS`, the order a check gives back. */
function mergeApp(
  previous: SupportAppContext | undefined,
  next: SupportAppContext | undefined,
): SupportAppContext | undefined {
  if (!previous && !next) return undefined;
  const merged: Record<string, unknown> = { ...previous, ...next };
  const app: Record<string, unknown> = {};
  for (const field of SUPPORT_APP_FIELDS)
    if (merged[field] !== undefined) app[field] = merged[field];
  return app as SupportAppContext;
}
/** What the team and the member read: the stored form plus `chainId`. */
export function supportContextView(
  stored: StoredSupportContext,
): SupportContext {
  const chainId = chainIdOf(stored.network);
  return {
    ...(stored.snapshots?.length ? { snapshots: stored.snapshots } : {}),
    ...(stored.description ? { description: stored.description } : {}),
    ...(stored.network ? { network: stored.network } : {}),
    ...(chainId ? { chainId } : {}),
    ...(stored.transactions?.length
      ? {
          transactions: stored.transactions.map((tx) =>
            tx.network
              ? { hash: tx.hash, network: tx.network }
              : { hash: tx.hash },
          ),
        }
      : {}),
    ...(stored.app ? { app: stored.app } : {}),
  };
}
/** JSON with object keys sorted at every level, so two values compare by
 * content and not by key order. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : item,
  );
}
/** A stored `app` reads only when checking it again gives the same value. */
function checkedApp(value: unknown): SupportAppContext | null {
  try {
    const app = parseAppContextInput(value);
    return app && sortedJson(app) === sortedJson(value) ? app : null;
  } catch {
    return null;
  }
}
function checkedStored(
  value: Record<string, unknown>,
): StoredSupportContext | null {
  if (
    value.v !== 2 ||
    Object.keys(value).some(
      (key) =>
        ![
          "v",
          "description",
          "network",
          "transactions",
          "app",
          "snapshots",
        ].includes(key),
    )
  )
    return null;
  const stored: StoredSupportContext = { v: 2 };
  if (value.snapshots !== undefined) {
    try {
      const snapshots = parseFailureSnapshots(value.snapshots);
      if (sortedJson(snapshots) !== sortedJson(value.snapshots)) return null;
      stored.snapshots = snapshots;
    } catch {
      return null;
    }
  }
  if (value.app !== undefined) {
    const app = checkedApp(value.app);
    if (!app) return null;
    stored.app = app;
  }
  if (value.description !== undefined) {
    const description = descriptionText(value.description);
    if (!description || description !== value.description) return null;
    stored.description = description;
  }
  if (value.network !== undefined) {
    if (!isSupportNetwork(value.network)) return null;
    stored.network = value.network;
  }
  if (value.transactions !== undefined) {
    const list = value.transactions;
    if (
      !Array.isArray(list) ||
      list.length < 1 ||
      list.length > SUPPORT_CONTEXT_LIMITS.transactions
    )
      return null;
    const transactions: SupportTransaction[] = [];
    for (const entry of list as unknown[]) {
      if (
        !isRecord(entry) ||
        Object.keys(entry).some((key) => key !== "hash" && key !== "network") ||
        typeof entry.hash !== "string"
      )
        return null;
      const hash = entry.hash;
      if (entry.network === undefined) {
        if (!isEvmTransactionHash(hash) || hash !== hash.toLowerCase())
          return null;
        transactions.push({ hash });
      } else {
        if (
          !isSupportNetwork(entry.network) ||
          !sameFamily(hash, entry.network)
        )
          return null;
        if (entry.network !== SOLANA && hash !== hash.toLowerCase())
          return null;
        transactions.push({ hash, network: entry.network });
      }
    }
    if (new Set(transactions.map((tx) => tx.hash)).size !== transactions.length)
      return null;
    stored.transactions = transactions;
  }
  return stored;
}
const STORED_TEXT_KEYS = [
  "description",
  "network",
  "transactionHash",
  "channelId",
  "ruleId",
  "checkResult",
];
/** Stored free-text context maps known networks and valid hashes. Other
 * bounded values stay in the `legacy` data field. Reads never rewrite storage. */
function storedTextView(
  value: Record<string, unknown>,
): SupportContext | "unreadable" {
  if (Object.keys(value).some((key) => !STORED_TEXT_KEYS.includes(key)))
    return "unreadable";
  for (const key of [
    "description",
    "network",
    "transactionHash",
    "channelId",
    "ruleId",
  ])
    if (value[key] !== undefined && typeof value[key] !== "string")
      return "unreadable";
  const view: SupportContext = {};
  if (typeof value.description === "string") {
    const description = descriptionText(value.description);
    if (description) view.description = description;
  }
  const legacy: NonNullable<SupportContext["legacy"]> = {};
  let network: SupportNetwork | undefined;
  if (typeof value.network === "string" && value.network.trim()) {
    network = parseSupportNetwork(value.network) ?? undefined;
    if (network) {
      view.network = network;
      const chainId = chainIdOf(network);
      if (chainId) view.chainId = chainId;
    } else if (value.network.length <= 160) legacy.network = value.network;
  }
  if (
    typeof value.transactionHash === "string" &&
    value.transactionHash.trim()
  ) {
    const tx = parseTransactionReference(value.transactionHash, network);
    if (tx) view.transactions = [tx];
    else if (value.transactionHash.length <= 160)
      legacy.transactionHash = value.transactionHash;
  }
  if (legacy.network !== undefined || legacy.transactionHash !== undefined)
    view.legacy = legacy;
  return view;
}
/** Reads what a thread holds. Absent is null; a stored v2 value that fails
 * any check, or any other shape, is "unreadable" (the caller shows no
 * context). Reads never write back. */
export function readStoredSupportContext(
  value: unknown,
): SupportContext | null | "unreadable" {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return "unreadable";
  if ("v" in value) {
    const stored = checkedStored(value);
    return stored ? supportContextView(stored) : "unreadable";
  }
  return storedTextView(value);
}
/** The explorer page for a checked transaction, or null when its network is
 * unknown, unlisted or the hash is malformed. Never the member's own URL. */
export function supportTransactionUrl(tx: SupportTransaction): string | null {
  if (!tx || typeof tx.hash !== "string" || !tx.network) return null;
  if (tx.network === SOLANA)
    return isSolanaSignature(tx.hash)
      ? `${SOLANA_EXPLORER}/tx/${tx.hash}`
      : null;
  const id = chainIdOf(tx.network);
  const chain = id === null ? null : supportWalletChain(id);
  if (!chain || !isEvmTransactionHash(tx.hash)) return null;
  return chain.tx.replace("{hash}", tx.hash.toLowerCase());
}
/** "Base", "Chain 7777777" or "Solana". */
export function supportNetworkName(network: SupportNetwork): string {
  if (network === SOLANA) return SOLANA_NAME;
  const id = chainIdOf(network);
  if (id === null) return String(network);
  return supportWalletChain(id)?.name ?? `Chain ${id}`;
}
