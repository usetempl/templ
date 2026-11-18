import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError, errorBody, json, readJson, sha256Hex } from "./common";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import { requireWalletAuth } from "./privileged-auth";
import { sessionPrincipals, type ServiceSession } from "./service-principals";

/** Notices about Templ's own service, posted by Templ
 * operators. A notice has one of five fixed kinds and an optional short note.
 * Customer widgets show only the kind's fixed line, never the note, so a
 * stolen operator session can't put a sentence of its choosing on every
 * protocol's site. Notices carry no workspace, member, wallet or message
 * data. */
export const INCIDENT_KINDS = [
  "slow-replies",
  "sign-in",
  "alerts",
  "agents",
  "maintenance",
] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];
export type IncidentState = "open" | "resolved";

const H = 3_600_000;
const DAY = 24 * H;
export const INCIDENT_POLICY = Object.freeze({
  maxOpen: 3,
  noteMaxChars: 280,
  bodyMaxBytes: 2_048,
  /** Fixed notices stay on the public list this long. */
  publicDays: 14,
  publicMax: 20,
  /** Operator view and storage. */
  keepDays: 90,
  logDays: 365,
  /** Widgets and the staff banner hide an open notice with no update for
   * this long; the status page says "No update since". */
  staleMs: 6 * H,
  memoMs: 30_000,
  staleMemoMs: 5 * 60_000,
  pruneBatch: 50,
  readTimeoutMs: 2_000,
});

/** The Durable Object instance in the COST_METRICS namespace. */
export const INCIDENTS_INSTANCE = "ops-incidents-v1";

const RECORD_PREFIX = "incident-v1:";
const ID_PREFIX = "incident-id-v1:";
const LOG_PREFIX = "incident-log-v1:";
const OPEN_KEY = "incident-open-v1";
const UUIDV7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type StoredIncident = {
  schemaVersion: 1;
  id: string;
  kind: IncidentKind;
  state: IncidentState;
  startedAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  note: string | null;
  revision: number;
};
/** What `GET /status/incidents` serves: no author, no revision. */
export type PublicIncident = {
  id: string;
  kind: IncidentKind;
  state: IncidentState;
  startedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  note: string | null;
};
export type IncidentLogEntry = {
  at: number;
  actor: ChatPrincipalId;
  authenticatedAt: number;
  action: "open" | "note" | "resolve";
  noteLength: number;
};
export type OperatorIncident = PublicIncident & {
  revision: number;
  log: IncidentLogEntry[];
};
export type PublicIncidents = {
  schemaVersion: 1;
  incidents: PublicIncident[];
  stale?: true;
};

const isKind = (value: unknown): value is IncidentKind =>
  typeof value === "string" &&
  (INCIDENT_KINDS as readonly string[]).includes(value);
const pad = (value: number, width: number) =>
  String(value).padStart(width, "0");
const recordKey = (startedAt: number, id: string) =>
  `${RECORD_PREFIX}${pad(startedAt, 16)}:${id}`;
const iso = (value: number) => new Date(value).toISOString();

/** Notes are plain text for the status page and the staff banner: no links,
 * domains, emails or wallet addresses, no control characters. Returns the
 * trimmed note, or null for an absent or empty one. */
export function incidentNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw noteRefused();
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value))
    throw noteRefused();
  const note = value.normalize("NFC").trim();
  if (!note) return null;
  if ([...note].length > INCIDENT_POLICY.noteMaxChars)
    throw new HttpError(
      400,
      `Notes can be at most ${INCIDENT_POLICY.noteMaxChars} characters.`,
      undefined,
      "note-too-long",
    );
  if (
    /https?|:\/\/|www\./i.test(note) ||
    /[^\s@]+@[^\s@]+/.test(note) ||
    // A bare domain: a label, a dot and a letter-only ending.
    /(?:^|[^\p{L}\p{N}_-])[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.[a-z]{2,}(?![\p{L}\p{N}_-])/iu.test(
      note,
    ) ||
    /0x[0-9a-f]{40}/i.test(note) ||
    /(?:^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/.test(
      note,
    )
  )
    throw noteRefused();
  return note;
}
function noteRefused() {
  return new HttpError(
    400,
    "Notes can't contain links, emails or wallets.",
    undefined,
    "note-refused",
  );
}

function publicView(record: StoredIncident): PublicIncident {
  return {
    id: record.id,
    kind: record.kind,
    state: record.state,
    startedAt: iso(record.startedAt),
    updatedAt: iso(record.updatedAt),
    resolvedAt: record.resolvedAt === null ? null : iso(record.resolvedAt),
    note: record.note,
  };
}

function refuseUnknownKeys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    throw new HttpError(400, "This notice has fields Templ doesn't accept.");
}

/** A stable digest of what a create asks for; the same client id with the
 * same body is a replay, a different body is a conflict. */
async function createDigest(kind: IncidentKind, note: string | null) {
  return sha256Hex(JSON.stringify({ kind, note }));
}

// ---------------------------------------------------------------------------
// Durable Object side (`COST_METRICS` instance `ops-incidents-v1`)

type IncidentStorage = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "list" | "transaction" | "getAlarm" | "setAlarm"
>;

async function listRecords(
  storage: Pick<DurableObjectStorage, "list">,
  options: { limit: number; reverse?: boolean; start?: string },
) {
  return [
    ...(
      await storage.list<StoredIncident>({ prefix: RECORD_PREFIX, ...options })
    ).values(),
  ];
}

/** Open notices and those fixed in the last 14 days, newest first. */
export function publicIncidentList(
  records: StoredIncident[],
  now: number,
): PublicIncident[] {
  const since = now - INCIDENT_POLICY.publicDays * DAY;
  return records
    .filter(
      (record) =>
        record.state === "open" ||
        (record.resolvedAt !== null && record.resolvedAt >= since),
    )
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1))
    .slice(0, INCIDENT_POLICY.publicMax)
    .map(publicView);
}

async function ensureAlarm(storage: IncidentStorage, now: number) {
  if ((await storage.getAlarm()) === null) await storage.setAlarm(now + DAY);
}

type CreateInput = {
  id: string;
  kind: IncidentKind;
  note: string | null;
  actor: ChatPrincipalId;
  authenticatedAt: number;
};
type UpdateInput = {
  id: string;
  expectedRevision: number;
  note?: string | null;
  resolve: boolean;
  actor: ChatPrincipalId;
  authenticatedAt: number;
};

async function appendLog(
  storage: Pick<DurableObjectStorage, "list" | "put">,
  id: string,
  entry: IncidentLogEntry,
) {
  const existing = await storage.list({
    prefix: `${LOG_PREFIX}${id}:`,
    reverse: true,
    limit: 1,
  });
  const last = [...existing.keys()][0];
  const seq = last ? Number(last.slice(-4)) + 1 : 0;
  await storage.put(`${LOG_PREFIX}${id}:${pad(seq, 4)}`, entry);
}

export async function createIncident(
  storage: IncidentStorage,
  input: CreateInput,
  now = Date.now(),
): Promise<{ incident: PublicIncident; created: boolean }> {
  const digest = await createDigest(input.kind, input.note);
  const result = await storage.transaction(async (txn) => {
    const prior = await txn.get<{ key: string; digest: string }>(
      ID_PREFIX + input.id,
    );
    if (prior) {
      if (prior.digest !== digest)
        throw new HttpError(
          409,
          "This notice changed. Reload and try again.",
          undefined,
          "incident-conflict",
        );
      const stored = await txn.get<StoredIncident>(prior.key);
      if (!stored)
        throw new HttpError(
          409,
          "This notice changed. Reload and try again.",
          undefined,
          "incident-conflict",
        );
      return { incident: publicView(stored), created: false };
    }
    const open = (await txn.get<string[]>(OPEN_KEY)) ?? [];
    if (open.length >= INCIDENT_POLICY.maxOpen)
      throw new HttpError(
        409,
        "Three notices are already open. Mark one fixed first.",
        undefined,
        "incidents-full",
      );
    const record: StoredIncident = {
      schemaVersion: 1,
      id: input.id,
      kind: input.kind,
      state: "open",
      startedAt: now,
      updatedAt: now,
      resolvedAt: null,
      note: input.note,
      revision: 1,
    };
    const key = recordKey(now, input.id);
    await txn.put(key, record);
    await txn.put(ID_PREFIX + input.id, { key, digest });
    await txn.put(OPEN_KEY, [...open, input.id]);
    await appendLog(txn, input.id, {
      at: now,
      actor: input.actor,
      authenticatedAt: input.authenticatedAt,
      action: "open",
      noteLength: input.note?.length ?? 0,
    });
    return { incident: publicView(record), created: true };
  });
  await ensureAlarm(storage, now);
  return result;
}

export async function updateIncident(
  storage: IncidentStorage,
  input: UpdateInput,
  now = Date.now(),
): Promise<PublicIncident & { revision: number }> {
  return storage.transaction(async (txn) => {
    const index = await txn.get<{ key: string }>(ID_PREFIX + input.id);
    const record = index && (await txn.get<StoredIncident>(index.key));
    if (!index || !record) throw new HttpError(404, "Notice not found.");
    if (record.revision !== input.expectedRevision)
      throw new HttpError(
        409,
        "This notice changed. Reload and try again.",
        undefined,
        "incident-revision",
      );
    if (record.state === "resolved")
      throw new HttpError(
        409,
        "This notice is already fixed. Post a new one instead.",
        undefined,
        "incident-resolved",
      );
    if (input.note === undefined && !input.resolve)
      throw new HttpError(400, "Change the note or mark the notice fixed.");
    const next: StoredIncident = {
      ...record,
      ...(input.note === undefined ? {} : { note: input.note }),
      updatedAt: now,
      revision: record.revision + 1,
      ...(input.resolve ? { state: "resolved" as const, resolvedAt: now } : {}),
    };
    await txn.put(index.key, next);
    if (input.resolve) {
      const open = (await txn.get<string[]>(OPEN_KEY)) ?? [];
      await txn.put(
        OPEN_KEY,
        open.filter((id) => id !== input.id),
      );
    }
    await appendLog(txn, input.id, {
      at: now,
      actor: input.actor,
      authenticatedAt: input.authenticatedAt,
      action: input.resolve ? "resolve" : "note",
      noteLength: next.note?.length ?? 0,
    });
    return { ...publicView(next), revision: next.revision };
  });
}

export async function operatorIncidentList(
  storage: Pick<DurableObjectStorage, "list">,
  now = Date.now(),
): Promise<OperatorIncident[]> {
  const since = now - INCIDENT_POLICY.keepDays * DAY;
  const records = (await listRecords(storage, { limit: 500, reverse: true }))
    .filter(
      (record) =>
        record.state === "open" ||
        (record.resolvedAt !== null && record.resolvedAt >= since),
    )
    .slice(0, 200);
  return Promise.all(
    records.map(async (record) => ({
      ...publicView(record),
      revision: record.revision,
      log: [
        ...(
          await storage.list<IncidentLogEntry>({
            prefix: `${LOG_PREFIX}${record.id}:`,
            limit: 100,
          })
        ).values(),
      ],
    })),
  );
}

/** Deletes notices 90 days after their fix and change logs after 365 days,
 * at most 50 keys per call. True while there may be more to prune or open
 * notices to keep an alarm for. */
export async function pruneIncidents(
  storage: Pick<DurableObjectStorage, "list" | "delete" | "get">,
  now: number,
): Promise<boolean> {
  const budget = INCIDENT_POLICY.pruneBatch;
  const doomed: string[] = [];
  const recordCutoff = now - INCIDENT_POLICY.keepDays * DAY;
  const records = await listRecords(storage, { limit: 200 });
  for (const record of records) {
    if (doomed.length + 2 > budget) break;
    if (record.resolvedAt !== null && record.resolvedAt < recordCutoff)
      doomed.push(
        recordKey(record.startedAt, record.id),
        ID_PREFIX + record.id,
      );
  }
  const logCutoff = now - INCIDENT_POLICY.logDays * DAY;
  if (doomed.length < budget) {
    const logs = await storage.list<IncidentLogEntry>({
      prefix: LOG_PREFIX,
      limit: 500,
    });
    for (const [key, entry] of logs) {
      if (doomed.length >= budget) break;
      if (entry.at < logCutoff) doomed.push(key);
    }
  }
  if (doomed.length) await storage.delete(doomed);
  if (doomed.length >= budget) return true;
  const left = await storage.list({ prefix: "incident-", limit: 1 });
  return left.size > 0;
}

/** Private binding API of the instance. Null for other paths, so
 * `CostMetrics.fetch` tries the next instance's handler. Refusals keep their
 * reason code for the worker to pass on. */
export async function incidentsRequest(
  request: Request,
  storage: IncidentStorage,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/incidents/")) return null;
  try {
    return await incidentsInstanceRoute(
      request,
      storage,
      url.pathname.slice("/incidents/".length),
    );
  } catch (error) {
    return json(
      errorBody(error, "Notices are unavailable."),
      error instanceof HttpError ? error.status : 503,
    );
  }
}
async function incidentsInstanceRoute(
  request: Request,
  storage: IncidentStorage,
  route: string,
): Promise<Response> {
  const now = Date.now();
  if (route === "public" && request.method === "GET")
    return json({
      schemaVersion: 1,
      incidents: publicIncidentList(
        await listRecords(storage, { limit: 200, reverse: true }),
        now,
      ),
    } satisfies PublicIncidents);
  if (route === "operator" && request.method === "GET")
    return json({
      schemaVersion: 1,
      incidents: await operatorIncidentList(storage, now),
    });
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const body = await readJson(request, 4_096);
  const actor = body.actor as ChatPrincipalId;
  const authenticatedAt = body.authenticatedAt;
  if (
    typeof actor !== "string" ||
    !actor ||
    !Number.isSafeInteger(authenticatedAt)
  )
    throw new HttpError(400, "Invalid notice change.");
  if (route === "create") {
    refuseUnknownKeys(body, ["id", "kind", "note", "actor", "authenticatedAt"]);
    if (
      typeof body.id !== "string" ||
      !UUIDV7.test(body.id) ||
      !isKind(body.kind)
    )
      throw new HttpError(400, "Invalid notice.");
    const created = await createIncident(
      storage,
      {
        id: body.id,
        kind: body.kind,
        note: incidentNote(body.note),
        actor,
        authenticatedAt: authenticatedAt as number,
      },
      now,
    );
    return json(created, created.created ? 201 : 200);
  }
  if (route === "update") {
    refuseUnknownKeys(body, [
      "id",
      "expectedRevision",
      "note",
      "resolve",
      "actor",
      "authenticatedAt",
    ]);
    if (
      typeof body.id !== "string" ||
      !UUIDV7.test(body.id) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      typeof body.resolve !== "boolean"
    )
      throw new HttpError(400, "Invalid notice change.");
    return json({
      incident: await updateIncident(
        storage,
        {
          id: body.id,
          expectedRevision: body.expectedRevision as number,
          ...("note" in body ? { note: incidentNote(body.note) } : {}),
          resolve: body.resolve,
          actor,
          authenticatedAt: authenticatedAt as number,
        },
        now,
      ),
    });
  }
  throw new HttpError(404, "Not found.");
}

// ---------------------------------------------------------------------------
// Worker side

export type IncidentsEnv = OperatorAdminEnv & {
  COST_METRICS?: DurableObjectNamespace;
  CHAT_READ_RATE_LIMITER?: RateLimit;
  SUPPORT_INCIDENTS_ENABLED?: string;
};
export const incidentsEnabled = (env: IncidentsEnv) =>
  env.SUPPORT_INCIDENTS_ENABLED === "true";

async function instanceCall<T>(
  env: IncidentsEnv,
  path: string,
  body?: object,
): Promise<
  { ok: true; value: T } | { ok: false; status: number; body: unknown }
> {
  if (!env.COST_METRICS) return { ok: false, status: 503, body: null };
  const response = await env.COST_METRICS.get(
    env.COST_METRICS.idFromName(INCIDENTS_INSTANCE),
  ).fetch(
    new Request(`https://internal/incidents/${path}`, {
      method: body === undefined ? "GET" : "POST",
      signal: AbortSignal.timeout(INCIDENT_POLICY.readTimeoutMs),
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    }),
  );
  const parsed = await response.json().catch(() => null);
  return response.ok
    ? { ok: true, value: parsed as T }
    : { ok: false, status: response.status, body: parsed };
}

export type IncidentsMemo = {
  current: { at: number; body: PublicIncidents } | null;
};
export const createIncidentsMemo = (): IncidentsMemo => ({ current: null });

function publicResponse(body: PublicIncidents) {
  const response = json(body);
  response.headers.set(
    "Cache-Control",
    `public, max-age=${INCIDENT_POLICY.memoMs / 1000}`,
  );
  // Readable from any protocol site without credentials. `responseHeaders`
  // replaces this with the credentialed app headers for the app's own origin.
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Vary", "Origin");
  return response;
}

/** `GET /status/incidents`: public, no Origin or credentials needed, fixed
 * fields only. Handled before the Origin gate, like `/health/support`. */
export async function statusIncidentsRoute(
  request: Request,
  env: IncidentsEnv,
  memo: IncidentsMemo,
  now = Date.now(),
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/status/incidents") return null;
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  if (
    !env.CHAT_READ_RATE_LIMITER ||
    !(
      await env.CHAT_READ_RATE_LIMITER.limit({
        key: `status:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
      })
    ).success
  )
    throw new HttpError(429, "Too many requests. Please try again shortly.");
  if (!incidentsEnabled(env))
    return publicResponse({ schemaVersion: 1, incidents: [] });
  const cached = memo.current;
  if (cached && cached.at <= now && now - cached.at < INCIDENT_POLICY.memoMs)
    return publicResponse(cached.body);
  let read: Awaited<ReturnType<typeof instanceCall<PublicIncidents>>> | null;
  try {
    read = await instanceCall<PublicIncidents>(env, "public");
  } catch {
    read = null;
  }
  if (read?.ok) {
    const body: PublicIncidents = {
      schemaVersion: 1,
      incidents: read.value.incidents,
    };
    memo.current = { at: now, body };
    return publicResponse(body);
  }
  if (
    cached &&
    cached.at <= now &&
    now - cached.at < INCIDENT_POLICY.staleMemoMs
  )
    return publicResponse({ ...cached.body, stale: true });
  throw new HttpError(
    503,
    "Status can't load right now. Try again in a minute.",
  );
}

type OperatorSession = ServiceSession & {
  authMethod?: import("@templ/chat/principal").AuthMethod;
  authenticatedAt?: number;
};

/** `/operator/incidents[/<id>]`: Templ operators only. Writes need a wallet
 * or Solana sign-in and `confirmed: true`. */
export async function operatorIncidentsRoute<S extends OperatorSession>(
  request: Request,
  env: IncidentsEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/operator\/incidents(?:\/([0-9a-f-]{36}))?$/.exec(
    url.pathname,
  );
  if (!match) return null;
  if (
    !["GET", "POST"].includes(request.method) ||
    (match[1] && request.method !== "POST")
  )
    throw new HttpError(404, "Not found.");
  // The body is read before the session, as every other write route does.
  const body =
    request.method === "POST"
      ? await readJson(request, INCIDENT_POLICY.bodyMaxBytes)
      : null;
  const session = await auth.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(
      403,
      "Only Templ operators can post notices.",
      undefined,
      "operator-only",
    );
  let authenticatedAt = 0;
  if (body) {
    if (
      "expectedWallet" in body ||
      body.expectedPrincipalId !== session.principalId
    )
      throw new HttpError(401, "Your sign-in changed. Try again.");
    authenticatedAt = requireWalletAuth(session, body.confirmed);
  }
  if (!incidentsEnabled(env)) throw new HttpError(404, "Not found.");
  const unavailable = () =>
    new HttpError(503, "Notices are unavailable. Try again in a minute.");
  const forward = async (path: string, payload?: object) => {
    let result;
    try {
      result = await instanceCall<Record<string, unknown>>(env, path, payload);
    } catch {
      throw unavailable();
    }
    if (result.ok) return result.value;
    const error = result.body as { error?: unknown; reason?: unknown } | null;
    if (
      [400, 404, 409].includes(result.status) &&
      typeof error?.error === "string"
    )
      throw new HttpError(
        result.status,
        error.error,
        undefined,
        typeof error.reason === "string" ? error.reason : undefined,
      );
    throw unavailable();
  };
  if (!body) return json(await forward("operator"));
  const { confirmed: _c, expectedPrincipalId: _p, ...fields } = body;
  if (!match[1]) {
    refuseUnknownKeys(fields, ["id", "kind", "note"]);
    if (typeof fields.id !== "string" || !UUIDV7.test(fields.id))
      throw new HttpError(400, "Invalid notice.");
    if (!isKind(fields.kind))
      throw new HttpError(400, "Choose what kind of problem this is.");
    const note = incidentNote(fields.note);
    const created = (await forward("create", {
      id: fields.id,
      kind: fields.kind,
      note,
      actor: session.principalId,
      authenticatedAt,
    })) as { incident: PublicIncident; created: boolean };
    return json({ incident: created.incident }, created.created ? 201 : 200);
  }
  refuseUnknownKeys(fields, ["expectedRevision", "note", "state"]);
  if (!Number.isSafeInteger(fields.expectedRevision))
    throw new HttpError(400, "Reload the notice and try again.");
  if (fields.state !== undefined && fields.state !== "resolved")
    throw new HttpError(
      400,
      "A fixed notice can't reopen. Post a new one instead.",
    );
  const note = "note" in fields ? incidentNote(fields.note) : undefined;
  return json(
    await forward("update", {
      id: match[1],
      expectedRevision: fields.expectedRevision,
      ...(note === undefined ? {} : { note }),
      resolve: fields.state === "resolved",
      actor: session.principalId,
      authenticatedAt,
    }),
  );
}
