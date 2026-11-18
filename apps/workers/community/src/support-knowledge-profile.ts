/** The protocol profile inside SupportKnowledge: contract entries with
 * their lifecycle, metric definitions, uploaded ABIs, bulk imports and the
 * registry sync's apply rules. Only the room calls these operations, after
 * it checked the caller's current role; writes are the manager's. */
import type { SupportNetwork } from "@templ/chat/support";
import {
  PROFILE_KINDS,
  PROFILE_LIMITS,
  PROFILE_STATUSES,
  PROFILE_VISIBILITY,
  checkedProfileContract,
  checkedProfileMetric,
  parseProfileContract,
  parseProfileCsv,
  parseProfileJson,
  profileAddress,
  profileKey,
  profileNetwork,
  sameProfileEntry,
  type ProfileContract,
  type ProfileContractInput,
  type ProfileMatch,
  type ProfileMetric,
  type ProfileRef,
  type ProfileSettingsView,
  type ProfileStatus,
  type RegistryResult,
} from "@templ/chat/protocol-profile";
import {
  HOUR_MS,
  KnowledgeError,
  RowSkips,
  iso,
  randomHex,
  readMeta,
  readMetaJson,
  sha256Hex,
  writeMeta,
  type KnowledgeDb,
} from "./support-knowledge-schema";

type Row = Record<string, unknown>;
const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const refOf = (network: unknown, address: unknown): ProfileRef | null =>
  network && address
    ? { network: String(network) as SupportNetwork, address: String(address) }
    : null;

export function rowContract(row: Row, skips: RowSkips): ProfileContract | null {
  const contract = checkedProfileContract({
    network: row.network,
    address: row.address,
    label: row.label,
    kind: row.kind,
    status: row.status,
    generation: str(row.generation),
    product: str(row.product),
    symbol: str(row.symbol),
    decimals: row.decimals === null ? null : Number(row.decimals),
    successor: refOf(row.successor_network, row.successor_address),
    underlying: refOf(row.underlying_network, row.underlying_address),
    conversion: str(row.conversion),
    migrationDocUrl: str(row.migration_doc_url),
    lastSupportedOn: str(row.last_supported_on),
    abi: str(row.abi_id),
    staffNote: str(row.staff_note),
    visibility: row.visibility,
    source: row.source,
    registryMissingSince:
      row.registry_missing_since === null ? null : iso(Number(row.registry_missing_since)),
    updatedAt: iso(Number(row.updated_at)),
  });
  if (!contract) skips.skip("profile_contracts", `${row.network}:${row.address}`);
  return contract;
}

function writeContract(
  db: KnowledgeDb,
  entry: ProfileContractInput,
  source: ProfileContract["source"],
  by: string,
  now: number,
  keep: { abi?: string | null; missingSince?: number | null } = {},
) {
  db.sql.exec(
    `INSERT INTO profile_contracts (network, address, label, kind, status, generation, product, symbol, decimals,
       successor_network, successor_address, underlying_network, underlying_address, conversion,
       migration_doc_url, last_supported_on, abi_id, staff_note, visibility, source, registry_missing_since, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (network, address) DO UPDATE SET
       label = excluded.label, kind = excluded.kind, status = excluded.status, generation = excluded.generation,
       product = excluded.product, symbol = excluded.symbol, decimals = excluded.decimals,
       successor_network = excluded.successor_network, successor_address = excluded.successor_address,
       underlying_network = excluded.underlying_network, underlying_address = excluded.underlying_address,
       conversion = excluded.conversion, migration_doc_url = excluded.migration_doc_url,
       last_supported_on = excluded.last_supported_on, abi_id = COALESCE(excluded.abi_id, profile_contracts.abi_id),
       staff_note = excluded.staff_note, visibility = excluded.visibility, source = excluded.source,
       registry_missing_since = excluded.registry_missing_since, updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`,
    entry.network,
    entry.address,
    entry.label,
    entry.kind,
    entry.status,
    entry.generation,
    entry.product,
    entry.symbol,
    entry.decimals,
    entry.successor?.network ?? null,
    entry.successor?.address ?? null,
    entry.underlying?.network ?? null,
    entry.underlying?.address ?? null,
    entry.conversion,
    entry.migrationDocUrl,
    entry.lastSupportedOn,
    keep.abi ?? null,
    entry.staffNote,
    entry.visibility,
    source,
    keep.missingSince ?? null,
    now,
    by,
  );
}
const contractCount = (db: KnowledgeDb) =>
  Number(db.sql.exec("SELECT COUNT(*) AS n FROM profile_contracts").toArray()[0]?.n ?? 0);
const bumpRevision = (db: KnowledgeDb) =>
  writeMeta(db, "profile.revision", String((Number(readMeta(db, "profile.revision")) || 0) + 1));
const profileLimit = () =>
  new KnowledgeError(409, "profile-limit", "The profile holds up to 10,000 contracts.");

/* ---------------------------------------------------------------------- */
/* Settings                                                                */
/* ---------------------------------------------------------------------- */

type RegistrySettings = {
  url: string;
  schedule: "daily" | "manual";
  etag: string | null;
  lastSyncAt: number | null;
  lastResult: RegistryResult | null;
  nextSyncAt: number | null;
};
export const readRegistry = (db: KnowledgeDb) =>
  readMetaJson<RegistrySettings>(db, "profile.registry");
export const writeRegistry = (db: KnowledgeDb, value: RegistrySettings | null) =>
  value === null
    ? db.sql.exec("DELETE FROM meta WHERE key = 'profile.registry'")
    : writeMeta(db, "profile.registry", JSON.stringify(value));

export function profileSettings(db: KnowledgeDb, people = true): ProfileSettingsView {
  const visible = people ? "" : " WHERE visibility = 'member-safe'";
  const byNetwork: Record<string, number> = {};
  for (const row of db.sql
    .exec(`SELECT network, COUNT(*) AS n FROM profile_contracts${visible} GROUP BY network`)
    .toArray())
    byNetwork[String(row.network)] = Number(row.n);
  const byStatus = Object.fromEntries(PROFILE_STATUSES.map((s) => [s, 0])) as Record<
    ProfileStatus,
    number
  >;
  for (const row of db.sql
    .exec(`SELECT status, COUNT(*) AS n FROM profile_contracts${visible} GROUP BY status`)
    .toArray())
    if (PROFILE_STATUSES.includes(row.status as ProfileStatus))
      byStatus[row.status as ProfileStatus] = Number(row.n);
  const registry = readRegistry(db);
  const skips = new RowSkips();
  for (const row of db.sql.exec(`SELECT * FROM profile_contracts${visible}`).toArray())
    rowContract(row, skips);
  return {
    expectedNetworks: readMetaJson<SupportNetwork[]>(db, "profile.expectedNetworks") ?? [],
    officialUrls: readMetaJson<string[]>(db, "profile.officialUrls") ?? [],
    registry: people && registry
      ? {
          url: registry.url,
          schedule: registry.schedule,
          lastSyncAt: registry.lastSyncAt === null ? null : iso(registry.lastSyncAt),
          lastResult: registry.lastResult,
        }
      : null,
    counts: {
      contracts: Object.values(byNetwork).reduce((a, b) => a + b, 0),
      byNetwork,
      byStatus,
      metrics: people ? Number(db.sql.exec("SELECT COUNT(*) AS n FROM profile_metrics").toArray()[0]?.n ?? 0) : listMetrics(db, false).metrics.length,
      abis: Number(db.sql.exec(people ? "SELECT COUNT(*) AS n FROM profile_abis" : "SELECT COUNT(DISTINCT abi_id) AS n FROM profile_contracts WHERE visibility = 'member-safe'").toArray()[0]?.n ?? 0),
    },
    revision: Number(readMeta(db, "profile.revision")) || 0,
    invalidRows: skips.count,
  };
}
export function setProfileSettings(
  db: KnowledgeDb,
  args: { expectedNetworks?: unknown; officialUrls?: unknown },
) {
  if (args.expectedNetworks !== undefined) {
    if (!Array.isArray(args.expectedNetworks) || args.expectedNetworks.length > PROFILE_LIMITS.expectedNetworks)
      throw new KnowledgeError(400, "profile-settings", "Choose at most 16 networks.");
    const networks = args.expectedNetworks.map(profileNetwork);
    if (networks.some((n) => !n))
      throw new KnowledgeError(400, "profile-settings", "Choose networks Templ knows.");
    writeMeta(db, "profile.expectedNetworks", JSON.stringify([...new Set(networks)]));
  }
  if (args.officialUrls !== undefined) {
    if (!Array.isArray(args.officialUrls) || args.officialUrls.length > PROFILE_LIMITS.officialUrls)
      throw new KnowledgeError(400, "profile-settings", "List at most 20 official sites.");
    const origins: string[] = [];
    for (const raw of args.officialUrls) {
      let url: URL;
      try {
        url = new URL(String(raw));
      } catch {
        throw new KnowledgeError(422, "profile-url", "Use an https link on one of your official sites.");
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new KnowledgeError(422, "profile-url", "Use an https link on one of your official sites.");
      origins.push(url.origin);
    }
    writeMeta(db, "profile.officialUrls", JSON.stringify([...new Set(origins)]));
  }
  bumpRevision(db);
  return profileSettings(db);
}
/** Hosts a migration guide may use: the official sites. */
function officialHosts(db: KnowledgeDb): Set<string> {
  return new Set(
    (readMetaJson<string[]>(db, "profile.officialUrls") ?? []).map((origin) =>
      new URL(origin).hostname.toLowerCase(),
    ),
  );
}
function checkDocHost(db: KnowledgeDb, entry: ProfileContractInput) {
  if (!entry.migrationDocUrl) return;
  if (!officialHosts(db).has(new URL(entry.migrationDocUrl).hostname.toLowerCase()))
    throw new KnowledgeError(422, "profile-url", "Use an https link on one of your official sites.");
}

/* ---------------------------------------------------------------------- */
/* Entries                                                                 */
/* ---------------------------------------------------------------------- */

export function listProfile(
  db: KnowledgeDb,
  args: {
    network?: unknown;
    kind?: unknown;
    status?: unknown;
    visibility?: unknown;
    product?: unknown;
    q?: unknown;
    after?: unknown;
  },
  people: boolean,
) {
  const where: string[] = [];
  const bind: (string | number)[] = [];
  const network = profileNetwork(args.network);
  if (network) {
    where.push("network = ?");
    bind.push(network);
  }
  if (PROFILE_KINDS.includes(args.kind as never)) {
    where.push("kind = ?");
    bind.push(String(args.kind));
  }
  if (PROFILE_STATUSES.includes(args.status as never)) {
    where.push("status = ?");
    bind.push(String(args.status));
  }
  if (!people) {
    where.push("visibility = ?");
    bind.push("member-safe");
  } else if (PROFILE_VISIBILITY.includes(args.visibility as never)) {
    where.push("visibility = ?");
    bind.push(String(args.visibility));
  }
  if (typeof args.product === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(args.product)) {
    where.push("product = ?");
    bind.push(args.product);
  }
  if (typeof args.q === "string" && args.q.trim() && args.q.length <= 60) {
    const q = args.q.trim();
    where.push("(label LIKE ? ESCAPE '\\' OR address LIKE ?)");
    bind.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`, `${q.toLowerCase().startsWith("0x") ? q.toLowerCase() : q}%`);
  }
  if (typeof args.after === "string") {
    const [n, a] = args.after.split("|");
    if (n && a) {
      where.push("(network > ? OR (network = ? AND address > ?))");
      bind.push(n, n, a);
    }
  }
  const rows = db.sql
    .exec(
      `SELECT * FROM profile_contracts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY network, address LIMIT ?`,
      ...bind,
      PROFILE_LIMITS.listPage + 1,
    )
    .toArray();
  const skips = new RowSkips();
  const page = rows.slice(0, PROFILE_LIMITS.listPage);
  const parsed = page
    .map((row) => rowContract(row, skips))
    .filter((c): c is ProfileContract => c !== null);
  const references = people ? new Map<string, ProfileContract | null>() : contractReferences(db, parsed);
  const contracts = parsed.map(c => people ? c : memberProfileContract(c, references));
  const tail = page[page.length - 1];
  return {
    contracts,
    next: rows.length > PROFILE_LIMITS.listPage && tail ? `${tail.network}|${tail.address}` : null,
    invalidRows: skips.count,
  };
}

export function upsertProfileEntry(
  db: KnowledgeDb,
  args: { contract: unknown },
  by: string,
  now: number,
) {
  const parsed =
    args.contract && typeof args.contract === "object"
      ? parseProfileContract(args.contract as Record<string, unknown>)
      : ({ error: "columns" } as const);
  if (!("contract" in parsed))
    throw new KnowledgeError(400, "profile-row", `Row 1: check the ${parsed.error}.`, {
      field: parsed.error,
    });
  checkDocHost(db, parsed.contract);
  const existing = db.sql
    .exec(
      "SELECT abi_id FROM profile_contracts WHERE network = ? AND address = ?",
      parsed.contract.network,
      parsed.contract.address,
    )
    .toArray()[0];
  if (!existing && contractCount(db) >= PROFILE_LIMITS.contracts) throw profileLimit();
  writeContract(db, parsed.contract, "manual", by, now, {
    abi: (existing?.abi_id as string | null) ?? null,
  });
  bumpRevision(db);
  return { contract: parsed.contract, created: !existing };
}
export function deleteProfileEntry(db: KnowledgeDb, args: { network: unknown; address: unknown }) {
  const network = profileNetwork(args.network);
  const address = network ? profileAddress(network, args.address) : null;
  if (!network || !address)
    throw new KnowledgeError(404, "profile-not-found", "Contract not found.");
  db.sql.exec("DELETE FROM profile_contracts WHERE network = ? AND address = ?", network, address);
  bumpRevision(db);
  return { deleted: true };
}

function readRefs(db: KnowledgeDb, refs: ProfileRef[]): Map<string, ProfileContract> {
  const out = new Map<string, ProfileContract>();
  const skips = new RowSkips();
  for (const ref of refs) {
    const row = db.sql
      .exec("SELECT * FROM profile_contracts WHERE network = ? AND address = ?", ref.network, ref.address)
      .toArray()[0];
    if (!row) continue;
    const contract = rowContract(row, skips);
    if (contract) out.set(profileKey(contract), contract);
  }
  return out;
}
function contractReferences(db: KnowledgeDb, contracts: ProfileContract[]) {
  const references = new Map<string, ProfileContract | null>();
  const skips = new RowSkips();
  for (const contract of contracts)
    for (const ref of [contract.successor, contract.underlying]) {
      if (!ref || references.has(profileKey(ref))) continue;
      const row = db.sql.exec("SELECT * FROM profile_contracts WHERE network = ? AND address = ?", ref.network, ref.address).toArray()[0];
      if (row) references.set(profileKey(ref), rowContract(row, skips));
    }
  return references;
}
function memberProfileContract(contract: ProfileContract, references: Map<string, ProfileContract | null>) {
  const visible = (ref: ProfileRef | null) => ref && (!references.has(profileKey(ref)) || references.get(profileKey(ref))?.visibility === "member-safe") ? ref : null;
  return { ...contract, staffNote: null, successor: visible(contract.successor), underlying: visible(contract.underlying) };
}
/** The addresses among `refs` that are entries of this profile, as the
 * de-identifier compares them (EVM lowercase, base58 exact). Unreadable
 * refs are left out, never thrown. */
export function profileAddressesIn(
  db: KnowledgeDb,
  refs: readonly { network?: unknown; address?: unknown }[],
): Set<string> {
  const valid: ProfileRef[] = [];
  for (const item of refs.slice(0, 200)) {
    const network = profileNetwork(item?.network);
    const address = network ? profileAddress(network, item?.address) : null;
    if (network && address) valid.push({ network, address });
  }
  return new Set(
    [...readRefs(db, valid).values()].map((c) =>
      c.network === "solana" ? c.address : c.address.toLowerCase(),
    ),
  );
}
/** AI agents receive member-safe entries and references only. */
export function lookupProfile(
  db: KnowledgeDb,
  args: { refs: unknown },
  people: boolean,
): { matches: ProfileMatch[] } {
  const refs = checkedRefs(args.refs, PROFILE_LIMITS.lookupRefs);
  const found = readRefs(db, refs);
  const references = contractReferences(db, [...found.values()]);
  const matches: ProfileMatch[] = [];
  for (const ref of refs) {
    const c = found.get(profileKey(ref));
    if (!c || (!people && c.visibility !== "member-safe")) continue;
    const shown = people ? c : memberProfileContract(c, references);
    const successor = shown.successor ? references.get(profileKey(shown.successor)) : null;
    const { staffNote, source: _s, registryMissingSince: _r, updatedAt: _u, ...rest } = shown;
    matches.push({
      ...rest,
      successorLabel: successor?.label ?? null,
      ...(people && staffNote ? { staffNote } : {}),
    });
  }
  return { matches };
}
export function checkedRefs(value: unknown, limit: number): ProfileRef[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new KnowledgeError(400, "profile-refs", `Send at most ${limit} addresses.`);
  const out = new Map<string, ProfileRef>();
  for (const raw of value) {
    const item = raw as { network?: unknown; address?: unknown } | null;
    const network = profileNetwork(item?.network);
    const address = network ? profileAddress(network, item?.address) : null;
    if (!network || !address)
      throw new KnowledgeError(400, "profile-refs", "Send networks and addresses Templ can read.");
    out.set(`${network}:${address}`, { network, address });
  }
  return [...out.values()];
}

const ENGINE_KIND: Record<string, "vault" | "router" | "bridge" | "token" | "staking" | "other"> = {
  vault: "vault",
  strategy: "other",
  "receipt-token": "token",
  router: "router",
  bridge: "bridge",
  token: "token",
  staking: "staking",
  program: "other",
  other: "other",
};
/** The diagnosis engine's profile input for one transaction: at most 50
 * entries per network, with the engine's own keys only. */
export function profileSlice(
  db: KnowledgeDb,
  args: { network: unknown; addresses: unknown },
) {
  const network = profileNetwork(args.network);
  if (!network) throw new KnowledgeError(400, "profile-refs", "Choose a network.");
  const addresses = Array.isArray(args.addresses)
    ? [
        ...new Set(
          args.addresses
            .slice(0, PROFILE_LIMITS.sliceAddresses)
            .map((address) => profileAddress(network, address))
            .filter((address): address is string => address !== null),
        ),
      ]
    : [];
  const found = readRefs(
    db,
    addresses.map((address) => ({ network, address })),
  );
  const contracts = [...found.values()].slice(0, PROFILE_LIMITS.slicePerNetwork).map((c) => {
    const kind = ENGINE_KIND[c.kind] ?? "other";
    const token = kind === "token";
    return {
      network: c.network,
      address: c.address,
      label:
        c.label.replace(/[^\p{L}\p{N} .+&()-]/gu, "-").slice(0, 40).trim() || "Contract",
      kind,
      symbol: token ? c.symbol : null,
      decimals: token ? c.decimals : null,
    };
  });
  return {
    expectedNetworks: readMetaJson<string[]>(db, "profile.expectedNetworks") ?? [],
    contracts,
    refs: contracts.map((c) => ({ network: c.network, address: c.address })),
  };
}

/* ---------------------------------------------------------------------- */
/* Imports                                                                 */
/* ---------------------------------------------------------------------- */

const IMPORT_ID = /^imp-[0-9a-f]{16}$/;
export function startImport(db: KnowledgeDb, now: number) {
  const recent = Number(
    db.sql
      .exec("SELECT COUNT(*) AS n FROM profile_imports WHERE created_at > ? AND origin = 'upload'", now - HOUR_MS)
      .toArray()[0]?.n ?? 0,
  );
  if (recent >= PROFILE_LIMITS.importsPerHour)
    throw new KnowledgeError(429, "profile-import-rate", "Try another import in an hour.", {
      retryAfterSeconds: 3600,
    });
  const id = `imp-${randomHex(8)}`;
  db.sql.exec(
    "INSERT INTO profile_imports (id, created_at, origin, status, applied) VALUES (?, ?, 'upload', 'open', 0)",
    id,
    now,
  );
  return { importId: id };
}
function openImport(db: KnowledgeDb, id: unknown, now: number) {
  if (typeof id !== "string" || !IMPORT_ID.test(id))
    throw new KnowledgeError(404, "profile-import-not-found", "This import expired. Upload the file again.");
  const row = db.sql.exec("SELECT * FROM profile_imports WHERE id = ?", id).toArray()[0];
  if (!row || Number(row.applied) === 1 || Number(row.created_at) < now - HOUR_MS)
    throw new KnowledgeError(404, "profile-import-not-found", "This import expired. Upload the file again.");
  return id;
}
/** Adds file rows (and the file's metric definitions) to an open import.
 * The app sends a file in parts: a room request carries at most 24 KB. */
export function addImportRows(
  db: KnowledgeDb,
  args: { importId: unknown; rows?: unknown; metrics?: unknown },
  now: number,
) {
  const id = openImport(db, args.importId, now);
  let start = Number(
    db.sql
      .exec("SELECT COUNT(*) AS n FROM profile_import_rows WHERE import_id = ? AND n > 0", id)
      .toArray()[0]?.n ?? 0,
  );
  const rows = args.rows ?? [];
  const metrics = args.metrics ?? [];
  if (
    !Array.isArray(rows) ||
    !Array.isArray(metrics) ||
    rows.length > PROFILE_LIMITS.importRowsPerCall * 4 ||
    metrics.length > PROFILE_LIMITS.metrics
  )
    throw new KnowledgeError(400, "profile-import", "Send the file in smaller parts.");
  if (start + rows.length > PROFILE_LIMITS.importRows)
    throw new KnowledgeError(409, "profile-limit", "The profile holds up to 10,000 contracts.");
  let metricRows = Number(
    db.sql
      .exec("SELECT COUNT(*) AS n FROM profile_import_rows WHERE import_id = ? AND n < 0", id)
      .toArray()[0]?.n ?? 0,
  );
  const errors: { row: number; reason: string }[] = [];
  db.transaction(() => {
    for (const raw of rows) {
      start++;
      const result =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? parseProfileContract(raw as Record<string, unknown>)
          : ({ error: "columns" } as const);
      if (!("contract" in result)) errors.push({ row: start, reason: result.error });
      db.sql.exec(
        "INSERT INTO profile_import_rows (import_id, n, row, error) VALUES (?, ?, ?, ?)",
        id,
        start,
        "contract" in result ? JSON.stringify(result.contract) : null,
        "contract" in result ? null : `${start}:${result.error}`,
      );
    }
    for (const raw of metrics) {
      const metric = checkedProfileMetric(raw);
      if (!metric) continue;
      metricRows++;
      db.sql.exec(
        "INSERT INTO profile_import_rows (import_id, n, row, error) VALUES (?, ?, ?, 'metric')",
        id,
        -metricRows,
        JSON.stringify(metric),
      );
    }
  });
  return { importId: id, rows: start, errors };
}
function importRows(db: KnowledgeDb, id: string) {
  const contracts: ProfileContractInput[] = [];
  const errors: { row: number; reason: string }[] = [];
  const metrics: ProfileMetric[] = [];
  const seen = new Set<string>();
  for (const row of db.sql
    .exec("SELECT n, row, error FROM profile_import_rows WHERE import_id = ? ORDER BY n", id)
    .toArray()) {
    if (row.error === "metric") {
      const metric = checkedProfileMetric(JSON.parse(String(row.row)));
      if (metric) metrics.push(metric);
      continue;
    }
    if (row.error) {
      const [n, reason] = String(row.error).split(":");
      errors.push({ row: Number(n), reason });
      continue;
    }
    const parsed = parseProfileContract(JSON.parse(String(row.row)));
    if (!("contract" in parsed)) {
      errors.push({ row: Number(row.n), reason: parsed.error });
      continue;
    }
    const key = profileKey(parsed.contract);
    if (seen.has(key)) {
      errors.push({ row: Number(row.n), reason: "duplicate" });
      continue;
    }
    seen.add(key);
    contracts.push(parsed.contract);
  }
  return { contracts, errors, metrics };
}
function currentOf(db: KnowledgeDb, sources: string[]): Map<string, ProfileContract> {
  const skips = new RowSkips();
  const out = new Map<string, ProfileContract>();
  for (const row of db.sql
    .exec(
      `SELECT * FROM profile_contracts WHERE source IN (${sources.map(() => "?").join(",")})`,
      ...sources,
    )
    .toArray()) {
    const c = rowContract(row, skips);
    if (c) out.set(profileKey(c), c);
  }
  return out;
}
const LIST = 200;
export function previewImport(
  db: KnowledgeDb,
  args: { importId: unknown; mode?: unknown },
  now: number,
) {
  const id = openImport(db, args.importId, now);
  const mode = args.mode === "replace" ? "replace" : "merge";
  const { contracts, errors, metrics } = importRows(db, id);
  const current = currentOf(db, ["import", "manual"]);
  const registry = currentOf(db, ["registry"]);
  const added: ProfileContractInput[] = [];
  const changed: ProfileContractInput[] = [];
  let unchanged = 0;
  for (const entry of contracts) {
    const key = profileKey(entry);
    const before = current.get(key) ?? registry.get(key);
    if (!before) added.push(entry);
    else if (sameProfileEntry(before, entry)) unchanged++;
    else changed.push(entry);
  }
  const keys = new Set(contracts.map(profileKey));
  const removed =
    mode === "replace"
      ? [...current.values()]
          .filter((c) => c.source === "import" && !keys.has(profileKey(c)))
          .map((c) => ({ network: c.network, address: c.address }))
      : [];
  return {
    importId: id,
    mode,
    diff: {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      unchanged,
      errors: errors.length,
      metrics: metrics.length,
    },
    lists: {
      added: added.slice(0, LIST).map((c) => ({ network: c.network, address: c.address, label: c.label })),
      changed: changed.slice(0, LIST).map((c) => ({ network: c.network, address: c.address, label: c.label })),
      removed: removed.slice(0, LIST),
      errors: errors.slice(0, LIST),
    },
  };
}
export function applyImport(
  db: KnowledgeDb,
  args: { importId: unknown; mode?: unknown },
  by: string,
  now: number,
) {
  const id = openImport(db, args.importId, now);
  const mode = args.mode === "replace" ? "replace" : "merge";
  const { contracts, errors, metrics } = importRows(db, id);
  const current = currentOf(db, ["import", "manual", "registry"]);
  const keys = new Set(contracts.map(profileKey));
  const removals =
    mode === "replace"
      ? [...current.values()].filter((c) => c.source === "import" && !keys.has(profileKey(c)))
      : [];
  const added = contracts.filter((c) => !current.has(profileKey(c))).length;
  if (contractCount(db) - removals.length + added > PROFILE_LIMITS.contracts) throw profileLimit();
  const hosts = officialHosts(db);
  const dangling: { row: number; reason: string }[] = [];
  let applied = 0;
  db.transaction(() => {
    for (const c of removals)
      db.sql.exec("DELETE FROM profile_contracts WHERE network = ? AND address = ?", c.network, c.address);
    const present = (ref: ProfileRef | null) =>
      ref === null || keys.has(profileKey(ref)) || current.has(profileKey(ref));
    contracts.forEach((entry, index) => {
      const next = { ...entry };
      if (!present(next.successor)) {
        dangling.push({ row: index + 1, reason: "successor" });
        next.successor = null;
      }
      if (!present(next.underlying)) {
        dangling.push({ row: index + 1, reason: "underlying" });
        next.underlying = null;
      }
      if (next.migrationDocUrl && !hosts.has(new URL(next.migrationDocUrl).hostname.toLowerCase())) {
        dangling.push({ row: index + 1, reason: "url" });
        next.migrationDocUrl = null;
      }
      const before = current.get(profileKey(entry));
      writeContract(db, next, "import", by, now, { abi: before?.abi ?? null });
      applied++;
    });
    for (const metric of metrics)
      db.sql.exec(
        "INSERT INTO profile_metrics (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        metric.id,
        JSON.stringify(metric),
        now,
      );
    db.sql.exec("UPDATE profile_imports SET applied = 1, status = 'applied' WHERE id = ?", id);
    db.sql.exec("DELETE FROM profile_import_rows WHERE import_id = ?", id);
    bumpRevision(db);
  });
  return {
    applied,
    removed: removals.length,
    metrics: metrics.length,
    errors: [...errors, ...dangling].slice(0, LIST),
  };
}

/* ---------------------------------------------------------------------- */
/* Registry                                                                */
/* ---------------------------------------------------------------------- */

export const REGISTRY_PAUSE_SHARE = 0.2;
/** Applies a registry file's rows. Registry rows only touch registry
 * entries; a collision with a manual or imported entry is a conflict, a
 * missing entry is flagged and kept. A sync that would change or newly flag
 * more than 20% of registry entries, widen a team-only entry to members, or
 * add a migration guide on a new host pauses for the manager. */
export function applyRegistryRows(
  db: KnowledgeDb,
  input: {
    rows: ProfileContractInput[];
    trigger: "manual" | "schedule";
    force: boolean;
  },
  now: number,
): RegistryResult {
  const registry = currentOf(db, ["registry"]);
  const others = currentOf(db, ["manual", "import"]);
  const conflicts: string[] = [];
  const added: ProfileContractInput[] = [];
  const changed: ProfileContractInput[] = [];
  let widening = false;
  let newHost = false;
  const hosts = new Set(
    [...registry.values()]
      .map((c) => (c.migrationDocUrl ? new URL(c.migrationDocUrl).hostname : null))
      .filter(Boolean),
  );
  const official = officialHosts(db);
  const keys = new Set<string>();
  for (const entry of input.rows) {
    const key = profileKey(entry);
    if (keys.has(key)) continue;
    keys.add(key);
    if (others.has(key)) {
      conflicts.push(key);
      continue;
    }
    const before = registry.get(key);
    if (entry.migrationDocUrl) {
      const host = new URL(entry.migrationDocUrl).hostname;
      if (!hosts.has(host)) newHost = true;
      if (!official.has(host.toLowerCase())) entry.migrationDocUrl = null;
    }
    if (!before) {
      added.push(entry);
      if (entry.visibility === "member-safe" && entry.kind === "strategy") widening = true;
    } else if (!sameProfileEntry(before, entry) || before.registryMissingSince) {
      changed.push(entry);
      if (before.visibility === "staff-only" && entry.visibility === "member-safe") widening = true;
    }
  }
  const missing = [...registry.values()].filter(
    (c) => !keys.has(profileKey(c)) && !c.registryMissingSince,
  );
  const base = Math.max(registry.size, 1);
  const pause =
    !input.force &&
    registry.size > 0 &&
    (changed.length + missing.length > base * REGISTRY_PAUSE_SHARE || widening || newHost);
  const result: RegistryResult = {
    at: iso(now),
    trigger: input.trigger,
    result: "applied",
    added: added.length,
    changed: changed.length,
    missing: missing.length,
    conflicts: conflicts.length,
  };
  if (!added.length && !changed.length && !missing.length) result.result = "unchanged";
  if (pause) {
    result.result = "paused";
    result.pending = [...changed, ...added].slice(0, 50).map(profileKey);
    return result;
  }
  if (contractCount(db) + added.length > PROFILE_LIMITS.contracts) throw profileLimit();
  db.transaction(() => {
    for (const entry of [...added, ...changed]) {
      const before = registry.get(profileKey(entry));
      writeContract(db, entry, "registry", "registry", now, { abi: before?.abi ?? null });
    }
    for (const c of missing)
      db.sql.exec(
        "UPDATE profile_contracts SET registry_missing_since = ? WHERE network = ? AND address = ?",
        now,
        c.network,
        c.address,
      );
    if (added.length || changed.length || missing.length) bumpRevision(db);
  });
  return result;
}
export function logSync(db: KnowledgeDb, result: RegistryResult, now: number) {
  db.sql.exec(
    "INSERT OR REPLACE INTO profile_sync_log (at, trigger, result) VALUES (?, ?, ?)",
    now,
    result.trigger,
    JSON.stringify(result),
  );
  const keep = db.sql
    .exec("SELECT at FROM profile_sync_log ORDER BY at DESC LIMIT 1 OFFSET ?", PROFILE_LIMITS.syncLog - 1)
    .toArray()[0];
  if (keep) db.sql.exec("DELETE FROM profile_sync_log WHERE at < ?", Number(keep.at));
}
export function syncLog(db: KnowledgeDb) {
  return db.sql
    .exec("SELECT result FROM profile_sync_log ORDER BY at DESC LIMIT ?", PROFILE_LIMITS.syncLog)
    .toArray()
    .map((row) => JSON.parse(String(row.result)) as RegistryResult);
}
/** Parses a registry file body into rows, or a format failure. */
export function registryRows(
  text: string,
  contentType: string,
): ProfileContractInput[] | null {
  const csv = /text\/csv/i.test(contentType) || (!text.trimStart().startsWith("{") && /,/.test(text.split("\n")[0] ?? ""));
  const file = csv ? parseProfileCsv(text) : parseProfileJson(text);
  if (file.errors.some((error) => error.row === 0)) return null;
  return file.contracts;
}

/* ---------------------------------------------------------------------- */
/* ABIs and metrics                                                        */
/* ---------------------------------------------------------------------- */

const ABI_ENTRY_MAX_CHARS = 4_096;
const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value as object)
            .sort()
            .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
        )
      : value;
/** Keeps functions, events and errors; drops everything else. */
export async function putProfileAbi(
  db: KnowledgeDb,
  args: { network: unknown; address: unknown; abi: unknown },
  now: number,
) {
  const network = profileNetwork(args.network);
  const address = network ? profileAddress(network, args.address) : null;
  if (!network || !address || network === "solana")
    throw new KnowledgeError(400, "profile-abi", "Choose an EVM contract in the profile.");
  const entry = db.sql
    .exec("SELECT 1 AS one FROM profile_contracts WHERE network = ? AND address = ?", network, address)
    .toArray()[0];
  if (!entry) throw new KnowledgeError(404, "profile-not-found", "Add the contract before its ABI.");
  if (!Array.isArray(args.abi))
    throw new KnowledgeError(400, "profile-abi", "Upload the ABI as a JSON array.");
  const kept = args.abi.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      ["function", "event", "error"].includes((item as { type?: string }).type ?? "") &&
      JSON.stringify(item).length <= ABI_ENTRY_MAX_CHARS,
  );
  const json = JSON.stringify(sortKeys(kept));
  if (new TextEncoder().encode(json).length > PROFILE_LIMITS.abiBytes)
    throw new KnowledgeError(400, "profile-abi", "The ABI is over 256 KB.");
  const counts = { functions: 0, events: 0, errors: 0 };
  for (const item of kept as { type: string }[])
    counts[item.type === "function" ? "functions" : item.type === "event" ? "events" : "errors"]++;
  const sha = await sha256Hex(json);
  const id = `abi-${sha.slice(0, 16)}`;
  const abis = Number(db.sql.exec("SELECT COUNT(*) AS n FROM profile_abis").toArray()[0]?.n ?? 0);
  const exists = db.sql.exec("SELECT 1 AS one FROM profile_abis WHERE id = ?", id).toArray()[0];
  if (!exists && abis >= PROFILE_LIMITS.abis)
    throw new KnowledgeError(409, "profile-abi-limit", "The profile holds up to 500 ABIs.");
  db.transaction(() => {
    if (!exists)
      db.sql.exec(
        "INSERT INTO profile_abis (id, sha256, json, functions, events, errors, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        sha,
        json,
        counts.functions,
        counts.events,
        counts.errors,
        now,
      );
    db.sql.exec(
      "UPDATE profile_contracts SET abi_id = ?, updated_at = ? WHERE network = ? AND address = ?",
      id,
      now,
      network,
      address,
    );
    bumpRevision(db);
  });
  return { abi: id, ...counts };
}
export function getProfileAbi(db: KnowledgeDb, args: { id: unknown }) {
  if (typeof args.id !== "string" || !/^abi-[0-9a-f]{16}$/.test(args.id))
    throw new KnowledgeError(404, "profile-abi", "ABI not found.");
  const row = db.sql.exec("SELECT * FROM profile_abis WHERE id = ?", args.id).toArray()[0];
  if (!row) throw new KnowledgeError(404, "profile-abi", "ABI not found.");
  return { id: row.id, abi: JSON.parse(String(row.json)) };
}
export function listMetrics(db: KnowledgeDb, people: boolean) {
  const metrics: ProfileMetric[] = [];
  const skips = new RowSkips();
  for (const row of db.sql.exec("SELECT id, json FROM profile_metrics ORDER BY id").toArray()) {
    let metric: ProfileMetric | null = null;
    try {
      metric = checkedProfileMetric(JSON.parse(String(row.json)));
    } catch {
      metric = null;
    }
    if (!metric) skips.skip("profile_metrics", String(row.id));
    else if (people || metric.visibility === "member-safe") metrics.push(metric);
  }
  return { metrics, invalidRows: skips.count };
}
export function writeMetric(
  db: KnowledgeDb,
  args: { action: unknown; metric: unknown },
  now: number,
) {
  if (args.action === "delete") {
    const id = (args.metric as { id?: unknown } | null)?.id;
    if (typeof id !== "string") throw new KnowledgeError(400, "profile-metric", "Choose a metric.");
    db.sql.exec("DELETE FROM profile_metrics WHERE id = ?", id);
    bumpRevision(db);
    return { deleted: true };
  }
  const metric = checkedProfileMetric(args.metric);
  if (!metric)
    throw new KnowledgeError(400, "profile-metric", "Check the metric's id, label, formula, source, window and fees.");
  const exists = db.sql.exec("SELECT 1 AS one FROM profile_metrics WHERE id = ?", metric.id).toArray()[0];
  const count = Number(db.sql.exec("SELECT COUNT(*) AS n FROM profile_metrics").toArray()[0]?.n ?? 0);
  if (!exists && count >= PROFILE_LIMITS.metrics)
    throw new KnowledgeError(409, "profile-metric-limit", "The profile holds up to 100 metrics.");
  db.sql.exec(
    "INSERT INTO profile_metrics (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
    metric.id,
    JSON.stringify(metric),
    now,
  );
  bumpRevision(db);
  return { metric };
}
export function profileRetention(db: KnowledgeDb, now: number) {
  // ABI parts that never completed.
  for (const row of db.sql
    .exec("SELECT key, value FROM meta WHERE key >= 'abi-part:' AND key < 'abi-part;'")
    .toArray()) {
    let at = 0;
    try {
      at = Number((JSON.parse(String(row.value)) as { at?: number }).at) || 0;
    } catch {
      at = 0;
    }
    if (at < now - HOUR_MS) db.sql.exec("DELETE FROM meta WHERE key = ?", String(row.key));
  }
  const stale = db.sql
    .exec("SELECT id FROM profile_imports WHERE applied = 0 AND created_at < ?", now - HOUR_MS)
    .toArray()
    .map((row) => String(row.id));
  for (const id of stale) {
    db.sql.exec("DELETE FROM profile_import_rows WHERE import_id = ?", id);
    db.sql.exec("DELETE FROM profile_imports WHERE id = ?", id);
  }
}
