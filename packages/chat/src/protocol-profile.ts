/** The protocol profile and the workspace's knowledge sources: contract
 * entries with their lifecycle, metric definitions, the `templ-profile/1`
 * file format with its JSON and CSV parsers, and knowledge source views.
 *
 * Browser-safe: pure types and parsers, no SDK, storage, RPC or signing.
 * Entries use generic labels a manager writes; nothing here names a
 * protocol. Solana programs, mints and accounts are entries like EVM
 * contracts, keyed by their base58 address. */
import { base58Decode } from "./solana";
import type { SupportNetwork } from "./support";

export const PROFILE_KINDS = [
  "vault",
  "strategy",
  "receipt-token",
  "router",
  "bridge",
  "token",
  "staking",
  "program",
  "other",
] as const;
export const PROFILE_STATUSES = [
  "live",
  "deprecated",
  "withdraw-only",
  "migrated",
] as const;
export const PROFILE_VISIBILITY = ["member-safe", "staff-only"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];
export type ProfileVisibility = (typeof PROFILE_VISIBILITY)[number];
export const PROFILE_CONVERSIONS = [
  "erc4626",
  "price-per-share",
  "one-to-one",
] as const;
export type ProfileConversion = (typeof PROFILE_CONVERSIONS)[number];
export type ProfileRef = { network: SupportNetwork; address: string };

export const PROFILE_KIND_TEXT: Record<ProfileKind, string> = {
  vault: "Vault",
  strategy: "Strategy",
  "receipt-token": "Receipt token",
  router: "Router",
  bridge: "Bridge",
  token: "Token",
  staking: "Staking",
  program: "Program",
  other: "Other",
};
export const PROFILE_STATUS_TEXT: Record<ProfileStatus, string> = {
  live: "Live",
  deprecated: "Deprecated",
  "withdraw-only": "Withdraw only",
  migrated: "Migrated",
};
export const PROFILE_VISIBILITY_TEXT: Record<ProfileVisibility, string> = {
  "member-safe": "Members can see it",
  "staff-only": "Team only",
};

export type ProfileContract = {
  network: SupportNetwork;
  /** EVM lowercase hex; Solana base58 that decodes to 32 bytes. */
  address: string;
  label: string;
  kind: ProfileKind;
  status: ProfileStatus;
  generation: string | null;
  /** Product family id. */
  product: string | null;
  symbol: string | null;
  decimals: number | null;
  successor: ProfileRef | null;
  /** Receipt token or vault → the asset it holds. */
  underlying: ProfileRef | null;
  conversion: ProfileConversion | null;
  /** https only. */
  migrationDocUrl: string | null;
  /** YYYY-MM-DD. */
  lastSupportedOn: string | null;
  /** "abi-<16 hex>". */
  abi: string | null;
  /** Team only; never sent to AI agents or members. */
  staffNote: string | null;
  visibility: ProfileVisibility;
  source: "manual" | "import" | "registry";
  registryMissingSince: string | null;
  updatedAt: string;
};
/** What a file or form supplies for one entry. */
export type ProfileContractInput = Omit<
  ProfileContract,
  "source" | "registryMissingSince" | "updatedAt" | "abi"
>;
export type ProfileMetric = {
  /** e.g. "apy-7d-net". */
  id: string;
  label: string;
  formula: string;
  source: "frontend" | "indexer" | "chain" | "other";
  window: "instant" | "1d" | "7d" | "30d" | "90d" | "custom";
  fees: "net" | "gross" | "n/a";
  appliesTo: { products: string[]; kinds: ProfileKind[] };
  visibility: ProfileVisibility;
};
export type RegistryResult = {
  at: string;
  trigger: "manual" | "schedule";
  result:
    | "applied"
    | "unchanged"
    | "paused"
    | "registry-unreachable"
    | "registry-timeout"
    | "registry-too-large"
    | "registry-format";
  added: number;
  changed: number;
  missing: number;
  conflicts: number;
  /** Paused syncs list up to 50 changed keys for the manager to check. */
  pending?: string[];
};
export type ProfileSettingsView = {
  expectedNetworks: SupportNetwork[];
  officialUrls: string[];
  registry: null | {
    url: string;
    schedule: "daily" | "manual";
    lastSyncAt: string | null;
    lastResult: RegistryResult | null;
  };
  counts: {
    contracts: number;
    byNetwork: Record<string, number>;
    byStatus: Record<ProfileStatus, number>;
    metrics: number;
    abis: number;
  };
  revision: number;
  invalidRows: number;
};
export type ProfileMatch = Omit<
  ProfileContract,
  "staffNote" | "source" | "registryMissingSince" | "updatedAt"
> & {
  successorLabel: string | null;
  /** People only. */
  staffNote?: string;
};
export const LEGACY_TRIGGERS = [
  "transaction",
  "diagnosis",
  "frame",
  "context",
  "agent-evidence",
  "address-check",
  /** The member's proven wallet
   * holds an older receipt token from the profile. Append-only. */
  "wallet",
] as const;
export type LegacyTrigger = (typeof LEGACY_TRIGGERS)[number];
export type LegacyFact = ProfileMatch & {
  status: Exclude<ProfileStatus, "live">;
  trigger: LegacyTrigger;
};
export const PROFILE_LIMITS = {
  contracts: 10_000,
  metrics: 100,
  abis: 500,
  abiBytes: 262_144,
  importBytes: 2_097_152,
  importRows: 10_000,
  /** Rows per import call: the room's request cap is 24 KB. */
  importRowsPerCall: 60,
  registryBytes: 5_242_880,
  officialUrls: 20,
  expectedNetworks: 16,
  lookupRefs: 20,
  listPage: 100,
  slicePerNetwork: 50,
  sliceAddresses: 64,
  legacyFacts: 3,
  matches: 5,
  syncLog: 30,
  staffNoteChars: 280,
  importsPerHour: 5,
} as const;
export const PROFILE_ROW_ERRORS = [
  "network",
  "address",
  "label",
  "kind",
  "status",
  "generation",
  "product",
  "symbol",
  "decimals",
  "successor",
  "underlying",
  "conversion",
  "url",
  "date",
  "visibility",
  "note",
  "duplicate",
  "columns",
] as const;
export type ProfileRowError = (typeof PROFILE_ROW_ERRORS)[number];
export const PROFILE_SCHEMA = "templ-profile/1";

const LABEL = /^[\p{L}\p{N}][\p{L}\p{N} .+&()/-]{0,59}$/u;
const GENERATION = /^[A-Za-z0-9.+-]{1,16}$/;
const PRODUCT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SYMBOL = /^[A-Za-z0-9.+-]{1,12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const METRIC_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const NAMES: Record<string, SupportNetwork> = {
  ethereum: "eip155:1",
  mainnet: "eip155:1",
  base: "eip155:8453",
  optimism: "eip155:10",
  arbitrum: "eip155:42161",
  polygon: "eip155:137",
  bsc: "eip155:56",
  "bnb chain": "eip155:56",
  gnosis: "eip155:100",
  fantom: "eip155:250",
  sonic: "eip155:146",
  katana: "eip155:747474",
  solana: "solana",
};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const isPlain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** "eip155:<id>", "solana" or a known chain name; null otherwise. */
export function profileNetwork(value: unknown): SupportNetwork | null {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  const canonical = /^eip155:([1-9][0-9]{0,15})$/.exec(name);
  if (canonical && Number.isSafeInteger(Number(canonical[1])))
    return `eip155:${Number(canonical[1])}`;
  return NAMES[name] ?? null;
}
/** The stored form of an address on a network, or null. */
export function profileAddress(
  network: SupportNetwork,
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  if (network === "solana") {
    if (!B58.test(address)) return null;
    try {
      return base58Decode(address).length === 32 ? address : null;
    } catch {
      return null;
    }
  }
  return EVM.test(address) && !/^0x0{40}$/.test(address)
    ? address.toLowerCase()
    : null;
}
export const profileKey = (ref: ProfileRef) => `${ref.network}:${ref.address}`;
/** The one citation id of an entry: `profile:<network>:<address>`. */
export const profileSourceId = (ref: ProfileRef) => `profile:${profileKey(ref)}`;

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
function ref(
  network: unknown,
  address: unknown,
): ProfileRef | null | undefined {
  const empty = (value: unknown) =>
    value === undefined || value === null || value === "";
  if (empty(network) && empty(address)) return null;
  const net = profileNetwork(network);
  if (!net) return undefined;
  const addr = profileAddress(net, address);
  return addr ? { network: net, address: addr } : undefined;
}
const opt = (value: unknown) =>
  value === undefined || value === null || value === "" ? null : value;

/** One entry from a file row or a form, or the first field that failed. */
export function parseProfileContract(
  raw: Record<string, unknown>,
): { contract: ProfileContractInput } | { error: ProfileRowError } {
  const network = profileNetwork(raw.network);
  if (!network) return { error: "network" };
  const address = profileAddress(network, raw.address);
  if (!address) return { error: "address" };
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  if (!LABEL.test(label)) return { error: "label" };
  if (!PROFILE_KINDS.includes(raw.kind as ProfileKind)) return { error: "kind" };
  const kind = raw.kind as ProfileKind;
  const status = (opt(raw.status) ?? "live") as ProfileStatus;
  if (!PROFILE_STATUSES.includes(status)) return { error: "status" };
  const generation = opt(raw.generation);
  if (generation !== null && !GENERATION.test(String(generation)))
    return { error: "generation" };
  const product = opt(raw.product);
  if (product !== null && !PRODUCT.test(String(product)))
    return { error: "product" };
  const symbol = opt(raw.symbol);
  if (symbol !== null && !SYMBOL.test(String(symbol))) return { error: "symbol" };
  const decimalsRaw = opt(raw.decimals);
  const decimals = decimalsRaw === null ? null : Number(decimalsRaw);
  if (
    decimals !== null &&
    (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 77)
  )
    return { error: "decimals" };
  const successor = isPlain(raw.successor)
    ? ref(raw.successor.network, raw.successor.address)
    : ref(raw.successor_network, raw.successor_address);
  if (successor === undefined) return { error: "successor" };
  const underlying = isPlain(raw.underlying)
    ? ref(raw.underlying.network, raw.underlying.address)
    : ref(raw.underlying_network, raw.underlying_address);
  if (underlying === undefined) return { error: "underlying" };
  const conversion = opt(raw.conversion);
  if (
    conversion !== null &&
    !PROFILE_CONVERSIONS.includes(conversion as ProfileConversion)
  )
    return { error: "conversion" };
  const docRaw = opt(raw.migrationDocUrl ?? raw.migration_doc_url);
  const migrationDocUrl = docRaw === null ? null : httpsUrl(docRaw);
  if (docRaw !== null && !migrationDocUrl) return { error: "url" };
  const lastSupported = opt(raw.lastSupportedOn ?? raw.last_supported_on);
  if (lastSupported !== null) {
    const text = String(lastSupported);
    if (!DATE.test(text) || !Number.isFinite(Date.parse(`${text}T00:00:00Z`)))
      return { error: "date" };
  }
  const visibility = (opt(raw.visibility) ??
    (kind === "strategy" ? "staff-only" : "member-safe")) as ProfileVisibility;
  if (!PROFILE_VISIBILITY.includes(visibility)) return { error: "visibility" };
  const noteRaw = opt(raw.staffNote ?? raw.staff_note);
  if (
    noteRaw !== null &&
    (typeof noteRaw !== "string" ||
      noteRaw.length > PROFILE_LIMITS.staffNoteChars ||
      CONTROL.test(noteRaw))
  )
    return { error: "note" };
  return {
    contract: {
      network,
      address,
      label,
      kind,
      status,
      generation: generation === null ? null : String(generation),
      product: product === null ? null : String(product),
      symbol: symbol === null ? null : String(symbol),
      decimals,
      successor,
      underlying,
      conversion: conversion as ProfileConversion | null,
      migrationDocUrl,
      lastSupportedOn: lastSupported === null ? null : String(lastSupported),
      staffNote: noteRaw === null ? null : (noteRaw as string).trim() || null,
      visibility,
    },
  };
}
/** A stored entry, checked in full. */
export function checkedProfileContract(raw: unknown): ProfileContract | null {
  if (!isPlain(raw)) return null;
  const parsed = parseProfileContract(raw);
  if (!("contract" in parsed)) return null;
  if (!["manual", "import", "registry"].includes(raw.source as string))
    return null;
  if (
    raw.abi !== null &&
    (typeof raw.abi !== "string" || !/^abi-[0-9a-f]{16}$/.test(raw.abi))
  )
    return null;
  if (
    raw.registryMissingSince !== null &&
    (typeof raw.registryMissingSince !== "string" ||
      !Number.isFinite(Date.parse(raw.registryMissingSince)))
  )
    return null;
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt)))
    return null;
  return {
    ...parsed.contract,
    abi: (raw.abi as string | null) ?? null,
    source: raw.source as ProfileContract["source"],
    registryMissingSince: (raw.registryMissingSince as string | null) ?? null,
    updatedAt: raw.updatedAt,
  };
}
export function checkedProfileMetric(raw: unknown): ProfileMetric | null {
  if (!isPlain(raw)) return null;
  if (typeof raw.id !== "string" || !METRIC_ID.test(raw.id)) return null;
  if (typeof raw.label !== "string" || !LABEL.test(raw.label.trim())) return null;
  if (
    typeof raw.formula !== "string" ||
    raw.formula.length < 1 ||
    raw.formula.length > 280 ||
    CONTROL.test(raw.formula)
  )
    return null;
  if (!["frontend", "indexer", "chain", "other"].includes(raw.source as string))
    return null;
  if (!["instant", "1d", "7d", "30d", "90d", "custom"].includes(raw.window as string))
    return null;
  if (!["net", "gross", "n/a"].includes(raw.fees as string)) return null;
  const applies = isPlain(raw.appliesTo) ? raw.appliesTo : { products: [], kinds: [] };
  if (
    !Array.isArray(applies.products) ||
    applies.products.length > 20 ||
    !applies.products.every((p) => typeof p === "string" && PRODUCT.test(p)) ||
    !Array.isArray(applies.kinds) ||
    !applies.kinds.every((k) => PROFILE_KINDS.includes(k as ProfileKind))
  )
    return null;
  const visibility = (raw.visibility ?? "member-safe") as ProfileVisibility;
  if (!PROFILE_VISIBILITY.includes(visibility)) return null;
  return {
    id: raw.id,
    label: raw.label.trim(),
    formula: raw.formula,
    source: raw.source as ProfileMetric["source"],
    window: raw.window as ProfileMetric["window"],
    fees: raw.fees as ProfileMetric["fees"],
    appliesTo: {
      products: [...(applies.products as string[])],
      kinds: [...(applies.kinds as ProfileKind[])],
    },
    visibility,
  };
}

export type ProfileParse = {
  contracts: ProfileContractInput[];
  metrics: ProfileMetric[];
  errors: { row: number; reason: ProfileRowError }[];
};
function collect(rows: Record<string, unknown>[], out: ProfileParse) {
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (out.contracts.length >= PROFILE_LIMITS.importRows) return;
    const parsed = parseProfileContract(row);
    if ("error" in parsed) {
      out.errors.push({ row: index + 1, reason: parsed.error });
      return;
    }
    const key = profileKey(parsed.contract);
    if (seen.has(key)) {
      out.errors.push({ row: index + 1, reason: "duplicate" });
      return;
    }
    seen.add(key);
    out.contracts.push(parsed.contract);
  });
}
/** A `templ-profile/1` JSON file. */
export function parseProfileJson(text: string): ProfileParse {
  const out: ProfileParse = { contracts: [], metrics: [], errors: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    out.errors.push({ row: 0, reason: "columns" });
    return out;
  }
  if (!isPlain(data) || data.schema !== PROFILE_SCHEMA || !Array.isArray(data.contracts)) {
    out.errors.push({ row: 0, reason: "columns" });
    return out;
  }
  collect(
    data.contracts.map((row) => (isPlain(row) ? row : {})),
    out,
  );
  if (Array.isArray(data.metrics))
    for (const raw of data.metrics.slice(0, PROFILE_LIMITS.metrics)) {
      const metric = checkedProfileMetric(raw);
      if (metric) out.metrics.push(metric);
    }
  return out;
}
export const PROFILE_CSV_COLUMNS = [
  "network",
  "address",
  "label",
  "kind",
  "status",
  "generation",
  "product",
  "symbol",
  "decimals",
  "underlying_network",
  "underlying_address",
  "conversion",
  "successor_network",
  "successor_address",
  "migration_doc_url",
  "last_supported_on",
  "visibility",
  "staff_note",
] as const;
/** RFC 4180 subset: comma, double-quote quoting with "" escapes, LF or
 * CRLF, a header row, no unknown columns. */
export function parseCsv(text: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field.length) return null;
      quoted = true;
      started = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
      started = true;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.length > 1 || row[0] !== "" || started) rows.push(row);
      row = [];
      field = "";
      started = false;
    } else {
      field += char;
      started = true;
    }
  }
  if (quoted) return null;
  if (field.length || row.length || started) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
export function parseProfileCsv(text: string): ProfileParse {
  const out: ProfileParse = { contracts: [], metrics: [], errors: [] };
  const rows = parseCsv(text);
  if (!rows || !rows.length) {
    out.errors.push({ row: 0, reason: "columns" });
    return out;
  }
  const header = rows[0].map((name) => name.trim().toLowerCase());
  if (
    new Set(header).size !== header.length ||
    !header.every((name) =>
      (PROFILE_CSV_COLUMNS as readonly string[]).includes(name),
    ) ||
    !["network", "address", "label", "kind"].every((name) =>
      header.includes(name),
    )
  ) {
    out.errors.push({ row: 0, reason: "columns" });
    return out;
  }
  const objects: Record<string, unknown>[] = [];
  for (const [index, cells] of rows.slice(1).entries()) {
    if (cells.length !== header.length) {
      out.errors.push({ row: index + 1, reason: "columns" });
      objects.push({});
      continue;
    }
    objects.push(Object.fromEntries(header.map((name, i) => [name, cells[i]])));
  }
  const errorsBefore = out.errors.length;
  collect(objects, out);
  // Rows refused for their columns above were parsed as empty objects;
  // keep only the columns reason for them.
  const columnRows = new Set(
    out.errors.slice(0, errorsBefore).map((error) => error.row),
  );
  out.errors = [
    ...out.errors.slice(0, errorsBefore),
    ...out.errors.slice(errorsBefore).filter((e) => !columnRows.has(e.row)),
  ];
  return out;
}

export type ProfileDiff = {
  added: ProfileContractInput[];
  changed: ProfileContractInput[];
  removed: ProfileRef[];
  unchanged: number;
};
const FIELDS: (keyof ProfileContractInput)[] = [
  "label",
  "kind",
  "status",
  "generation",
  "product",
  "symbol",
  "decimals",
  "successor",
  "underlying",
  "conversion",
  "migrationDocUrl",
  "lastSupportedOn",
  "staffNote",
  "visibility",
];
export function sameProfileEntry(
  a: ProfileContractInput,
  b: ProfileContractInput,
): boolean {
  return FIELDS.every(
    (field) => JSON.stringify(a[field] ?? null) === JSON.stringify(b[field] ?? null),
  );
}
/** `merge` adds and updates; `replace` also removes current entries that
 * the file leaves out. Callers pass only the entries the file may touch. */
export function profileDiff(
  current: ProfileContractInput[],
  next: ProfileContractInput[],
  mode: "merge" | "replace",
): ProfileDiff {
  const now = new Map(current.map((entry) => [profileKey(entry), entry]));
  const diff: ProfileDiff = { added: [], changed: [], removed: [], unchanged: 0 };
  const seen = new Set<string>();
  for (const entry of next) {
    const key = profileKey(entry);
    seen.add(key);
    const before = now.get(key);
    if (!before) diff.added.push(entry);
    else if (sameProfileEntry(before, entry)) diff.unchanged++;
    else diff.changed.push(entry);
  }
  if (mode === "replace")
    for (const [key, entry] of now)
      if (!seen.has(key))
        diff.removed.push({ network: entry.network, address: entry.address });
  return diff;
}
/** Legacy facts first by trigger, then by label. */
export function legacyOrder(a: LegacyFact, b: LegacyFact): number {
  return (
    LEGACY_TRIGGERS.indexOf(a.trigger) - LEGACY_TRIGGERS.indexOf(b.trigger) ||
    a.label.localeCompare(b.label)
  );
}

/* ---------------------------------------------------------------------- */
/* Knowledge sources                                                       */
/* ---------------------------------------------------------------------- */

export const KNOWLEDGE_KINDS = ["doc", "faq", "profile", "saved-reply"] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];
export const KNOWLEDGE_ERAS = ["current", "legacy"] as const;
export type KnowledgeEraTag = (typeof KNOWLEDGE_ERAS)[number];
export const KNOWLEDGE_ERA_TEXT: Record<KnowledgeEraTag, string> = {
  current: "Current",
  legacy: "Older product",
};
export type KnowledgeSourceStatus = "pending" | "ready" | "failed" | "archived";
export type KnowledgeSourceView = {
  /** "kb-<16 hex>". */
  id: string;
  kind: Exclude<KnowledgeKind, "profile">;
  title: string;
  /** Docs pages only. */
  url: string | null;
  era: KnowledgeEraTag;
  visibility: ProfileVisibility;
  /** Legacy sources are read only for a request that names one of these. */
  addresses: string[];
  status: KnowledgeSourceStatus;
  /** Why the last fetch failed, as a fixed code. */
  error: string | null;
  chunks: number;
  lastFetchAt: string | null;
  nextFetchAt: string | null;
  archivedAt: string | null;
  updatedAt: string;
  /** Generated FAQ sources are separate from the team's original resources. */
  learning?: { kind: "collection" | "entry"; reviewRequired: boolean; parentId?: string; pausedAt?: string; reviewReason?: string };
  /** Team-only review hints; original text and retrieval remain unchanged. */
  possiblyOutdated?: { entryId: string; quote: string; reason: string; sourceUpdatedAt: string }[];
};
export type KnowledgeOverview = {
  sources: KnowledgeSourceView[];
  counts: { sources: number; chunks: number; failed: number };
  next: string | null;
};
/** A current source returned to an agent in this workspace. */
export type KnowledgeSearchHit = {
  sourceId: string;
  kind: KnowledgeKind;
  title: string;
  excerpt: string;
  url?: string;
  era: KnowledgeEraTag;
  visibility: ProfileVisibility;
  updatedAt: string;
  archivedAt?: string;
};
export { KNOWLEDGE_LIMITS } from "./knowledge";
