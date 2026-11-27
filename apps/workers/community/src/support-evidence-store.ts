/** Case frames and evidence rows in the room object: team-only facts a
 * person or the registered AI agent records on one member request.
 *
 * Every key is room-local and keyed by the case (`<tc>:<seq pad 8>`), so
 * the ledger's prune and the thread's deletion remove them with the case.
 * Rows are never edited or deleted by anyone: a row is withdrawn (kept and
 * marked) or replaced by a newer row. Nothing here reaches the member, the
 * message budget, usage or the case ledger's counts.
 *
 * The caller checks the viewer's current access to the thread and writes
 * inside the room transaction; this module grants nothing. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { CitationRow } from "@templ/chat/support-citations";
import {
  INVALID_EVIDENCE_MESSAGE,
  INVALID_FRAME_MESSAGE,
  SUPPORT_EVIDENCE_LIMITS,
  SupportEvidenceError,
  checkedEvidence,
  checkedFrame,
  parseEvidenceInput,
  parseFrameInput,
  withSupersededBy,
  type SupportCaseFrame,
  type SupportEvidence,
  type SupportEvidenceInput,
  type SupportFieldSource,
  type SupportFrameValues,
} from "@templ/chat/support-evidence";
import { HttpError } from "./common";
import { agentPositionEvidence } from "./support-positions";
import { refusePhrase } from "./secret-guard";

type Storage = DurableObjectTransaction;
type ReadStorage = Pick<Storage, "get" | "list">;

export const FRAME_PREFIX = "support-frame-v1:";
export const EVIDENCE_PREFIX = "support-evidence-v1:";
export const EVIDENCE_SEQ_PREFIX = "support-evidence-seq-v1:";
export const EVIDENCE_CLIENT_PREFIX = "support-evidence-client-v1:";
/** Every thread-scoped prefix this store writes. */
export const EVIDENCE_THREAD_PREFIXES = [
  FRAME_PREFIX,
  EVIDENCE_PREFIX,
  EVIDENCE_SEQ_PREFIX,
  EVIDENCE_CLIENT_PREFIX,
] as const;

const pad4 = (value: number) => String(value).padStart(4, "0");
const pad8 = (value: number) => String(value).padStart(8, "0");
export const frameKey = (thread: string, seq: number) =>
  `${FRAME_PREFIX}${thread}:${pad8(seq)}`;
export const evidenceKey = (thread: string, seq: number, n: number) =>
  `${EVIDENCE_PREFIX}${thread}:${pad8(seq)}:${pad4(n)}`;
const evidenceSeqKey = (thread: string, seq: number) =>
  `${EVIDENCE_SEQ_PREFIX}${thread}:${pad8(seq)}`;
const clientKey = (thread: string, clientId: string) =>
  `${EVIDENCE_CLIENT_PREFIX}${thread}:${clientId}`;
const iso = (at: number) => new Date(at).toISOString();
const CLIENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Who writes: a person on the team or the registered AI agent. */
export type EvidenceWriter = {
  by: "person" | "agent";
  author: ChatPrincipalId;
};
type EvidenceClientMarker = {
  seq: number;
  from: number;
  count: number;
  digest: string;
};

function unreadable(kind: string, thread: string, seq: number) {
  console.warn(
    JSON.stringify({
      event: "TEMPL_SUPPORT_CASE_DATA_UNREADABLE",
      kind,
      conversation: thread,
      seq,
    }),
  );
}
/** 400 with the store's reason for a failed parse. */
function badInput(error: unknown): never {
  if (error instanceof SupportEvidenceError)
    throw new HttpError(400, error.message, undefined, error.reason);
  throw error;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/* Reads                                                                   */

/** The case frame, or null when none was saved or it fails its checks
 * (logged with a fixed label and no content). */
export async function readCaseFrame(
  storage: Pick<Storage, "get">,
  thread: string,
  seq: number,
): Promise<SupportCaseFrame | null> {
  const raw = await storage.get<unknown>(frameKey(thread, seq));
  if (raw === undefined) return null;
  const frame = checkedFrame(raw, seq);
  if (!frame) unreadable("frame", thread, seq);
  return frame;
}
/** The case's evidence rows, oldest first, with `supersededBy` filled.
 * Rows that fail their checks are counted and left out. */
export async function readCaseEvidence(
  storage: ReadStorage,
  thread: string,
  seq: number,
  audience: "team" | "agent" = "team",
): Promise<{ rows: SupportEvidence[]; unreadable: number }> {
  const listed = await storage.list<unknown>({
    prefix: `${EVIDENCE_PREFIX}${thread}:${pad8(seq)}:`,
    limit: SUPPORT_EVIDENCE_LIMITS.rowsPerCase + 1,
  });
  const rows: SupportEvidence[] = [];
  let bad = 0;
  for (const [key, raw] of listed) {
    const n = Number(key.slice(key.lastIndexOf(":") + 1));
    const row = checkedEvidence(raw, seq, n);
    if (row) rows.push(row);
    else bad++;
  }
  if (bad) unreadable("evidence", thread, seq);
  const ordered = withSupersededBy(rows);
  return {
    rows:
      audience === "agent"
        ? await agentPositionEvidence(storage, thread, seq, ordered)
        : ordered,
    unreadable: bad,
  };
}
/** What the citation check reads, or "unreadable" when any row of the case
 * fails its checks: a reply is never checked against part of the case. */
export async function citationRows(
  storage: ReadStorage,
  thread: string,
  seq: number,
  audience: "team" | "agent" = "team",
): Promise<CitationRow[] | "unreadable"> {
  const { rows, unreadable: bad } = await readCaseEvidence(
    storage,
    thread,
    seq,
    audience,
  );
  if (bad) return "unreadable";
  return rows.map((row) => ({
    n: row.n,
    product: row.product,
    metric: row.metric,
    window: row.window,
    value: row.value,
    withdrawn: row.withdrawn !== undefined,
    supersededBy: row.supersededBy ?? null,
  }));
}
/** Counts for the case list: rows written and whether a frame exists. */
export async function caseEvidenceSummary(
  storage: Pick<Storage, "get">,
  thread: string,
  seq: number,
): Promise<{ evidence: number; framed: boolean }> {
  const last = await storage.get<unknown>(evidenceSeqKey(thread, seq));
  return {
    evidence: Number.isSafeInteger(last) ? (last as number) : 0,
    framed: (await storage.get(frameKey(thread, seq))) !== undefined,
  };
}

/* Writes                                                                  */

/** Every free-text field of a frame change goes through the phrase check. */
async function screenFrame(set: Partial<SupportFrameValues>) {
  for (const text of [
    set.product?.label,
    set.metric?.label,
    set.window?.label,
    set.reported?.value,
    set.reported?.place,
    set.reported?.unit,
    set.question?.text,
  ])
    await refusePhrase(text, "saved");
}
async function screenRow(row: SupportEvidenceInput) {
  for (const text of [
    row.value.text,
    row.value.unit,
    row.note,
    row.sourceLabel,
    row.product.label,
    row.metric.label,
    row.window.label,
  ])
    await refusePhrase(text, "saved");
}

/** Saves a frame change for case `seq`. With `ifRevision`, a frame that
 * changed since is 409 `frame-stale`; without it the change applies field
 * by field (last writer wins). Returns the stored frame and the field names
 * that changed. */
export async function saveCaseFrame(
  storage: Storage,
  input: {
    thread: string;
    seq: number;
    body: unknown;
    ifRevision?: unknown;
    writer: EvidenceWriter;
    now: number;
  },
): Promise<{ frame: SupportCaseFrame; fields: string[] }> {
  if (
    input.ifRevision !== undefined &&
    (!Number.isSafeInteger(input.ifRevision) ||
      (input.ifRevision as number) < 0)
  )
    throw new HttpError(400, INVALID_FRAME_MESSAGE, undefined, "invalid-frame");
  let change: ReturnType<typeof parseFrameInput>;
  try {
    change = parseFrameInput(input.body, input.now);
  } catch (error) {
    badInput(error);
  }
  await screenFrame(change.set);
  const raw = await storage.get<unknown>(frameKey(input.thread, input.seq));
  const current = raw === undefined ? null : checkedFrame(raw, input.seq);
  if (raw !== undefined && !current)
    unreadable("frame", input.thread, input.seq);
  const revision = current?.revision ?? 0;
  if (input.ifRevision !== undefined && input.ifRevision !== revision)
    throw new HttpError(
      409,
      "The case details changed. Read them again before saving.",
      undefined,
      "frame-stale",
    );
  const source: SupportFieldSource = {
    by: input.writer.by,
    at: iso(input.now),
    author: input.writer.author,
  };
  const next: Record<string, unknown> = {
    ...(current ?? {}),
    case: input.seq,
    revision: revision + 1,
    updatedAt: iso(input.now),
  };
  for (const field of change.clear) delete next[field];
  for (const [field, value] of Object.entries(change.set))
    next[field] = { ...value, ...source };
  if (
    new TextEncoder().encode(JSON.stringify(next)).length >
    SUPPORT_EVIDENCE_LIMITS.frameBytes
  )
    throw new HttpError(400, INVALID_FRAME_MESSAGE, undefined, "invalid-frame");
  const frame = checkedFrame(next, input.seq);
  if (!frame)
    throw new HttpError(400, INVALID_FRAME_MESSAGE, undefined, "invalid-frame");
  await storage.put(frameKey(input.thread, input.seq), frame);
  return {
    frame,
    fields: [...change.clear, ...Object.keys(change.set)].sort(),
  };
}

/** Adds 1 to 10 rows to case `seq`. The same `clientId` with the same rows
 * returns the original rows (`created: false`); other rows under it are 409
 * `evidence-retry-mismatch`. `attachments` lists the thread's screenshot
 * ids a row may name. */
export async function addCaseEvidence(
  storage: Storage,
  input: {
    thread: string;
    seq: number;
    rows: unknown;
    clientId: unknown;
    writer: EvidenceWriter;
    attachments: readonly string[];
    now: number;
  },
): Promise<{ rows: SupportEvidence[]; created: boolean }> {
  if (typeof input.clientId !== "string" || !CLIENT_ID.test(input.clientId))
    throw new HttpError(400, "Send a valid evidence request id.");
  if (
    !Array.isArray(input.rows) ||
    input.rows.length < 1 ||
    input.rows.length > SUPPORT_EVIDENCE_LIMITS.rowsPerWrite
  )
    throw new HttpError(
      400,
      `Send 1 to ${SUPPORT_EVIDENCE_LIMITS.rowsPerWrite} evidence rows at a time.`,
      undefined,
      "invalid-evidence",
    );
  let parsed: SupportEvidenceInput[];
  try {
    parsed = input.rows.map((row) => parseEvidenceInput(row, input.now));
  } catch (error) {
    badInput(error);
  }
  for (const row of parsed) await screenRow(row);
  const rowDigest = await digest(parsed);
  const marker = await storage.get<EvidenceClientMarker>(
    clientKey(input.thread, input.clientId),
  );
  if (marker) {
    if (marker.seq !== input.seq || marker.digest !== rowDigest)
      throw new HttpError(
        409,
        "This evidence retry doesn't match the original.",
        undefined,
        "evidence-retry-mismatch",
      );
    const { rows } = await readCaseEvidence(storage, input.thread, input.seq);
    return {
      rows: rows.filter(
        (row) => row.n >= marker.from && row.n < marker.from + marker.count,
      ),
      created: false,
    };
  }
  const { rows: existing, unreadable: bad } = await readCaseEvidence(
    storage,
    input.thread,
    input.seq,
  );
  const last = await storage.get<unknown>(
    evidenceSeqKey(input.thread, input.seq),
  );
  const from = (Number.isSafeInteger(last) ? (last as number) : 0) + 1;
  if (from - 1 + parsed.length > SUPPORT_EVIDENCE_LIMITS.rowsPerCase)
    throw new HttpError(
      409,
      "This case has 50 evidence rows. Withdraw a row or add one that replaces it.",
      undefined,
      "evidence-limit",
    );
  const byN = new Map(existing.map((row) => [row.n, row]));
  const written: SupportEvidence[] = [];
  parsed.forEach((row, index) => {
    const n = from + index;
    if (row.supersedes !== undefined) {
      // An earlier row of this case that still stands, or one written
      // earlier in this same request.
      const earlier =
        byN.get(row.supersedes) ??
        written.find((entry) => entry.n === row.supersedes);
      if (!earlier || earlier.withdrawn || row.supersedes >= n || bad)
        throw new HttpError(
          400,
          "A replacing row must name an earlier row of this case that wasn't withdrawn.",
          undefined,
          "invalid-evidence",
        );
    }
    if (
      row.attachment !== undefined &&
      !input.attachments.includes(row.attachment)
    )
      throw new HttpError(
        400,
        "A row can only name a screenshot in this case.",
        undefined,
        "invalid-evidence",
      );
    written.push({
      ...row,
      id: `E${n}`,
      n,
      case: input.seq,
      at: iso(input.now),
      by: input.writer.by,
      author: input.writer.author,
    });
  });
  for (const row of written) {
    if (!checkedEvidence(row, input.seq, row.n))
      throw new HttpError(
        400,
        INVALID_EVIDENCE_MESSAGE,
        undefined,
        "invalid-evidence",
      );
    await storage.put(evidenceKey(input.thread, input.seq, row.n), row);
  }
  await storage.put(
    evidenceSeqKey(input.thread, input.seq),
    from - 1 + written.length,
  );
  await storage.put(clientKey(input.thread, input.clientId), {
    seq: input.seq,
    from,
    count: written.length,
    digest: rowDigest,
  } satisfies EvidenceClientMarker);
  const { rows } = await readCaseEvidence(storage, input.thread, input.seq);
  return {
    rows: rows.filter((row) => row.n >= from),
    created: true,
  };
}

/** Marks row `n` withdrawn. It stays readable and marked. A writer may
 * withdraw their own rows; `any` (the manager or a support lead) any row. A
 * row withdrawn already is returned as it is. */
export async function withdrawCaseEvidence(
  storage: Storage,
  input: {
    thread: string;
    seq: number;
    n: unknown;
    actor: ChatPrincipalId;
    any: boolean;
    now: number;
  },
): Promise<SupportEvidence> {
  if (
    !Number.isSafeInteger(input.n) ||
    (input.n as number) < 1 ||
    (input.n as number) > SUPPORT_EVIDENCE_LIMITS.rowsPerCase
  )
    throw new HttpError(
      400,
      "Choose an evidence row.",
      undefined,
      "invalid-evidence",
    );
  const n = input.n as number;
  const key = evidenceKey(input.thread, input.seq, n);
  const row = checkedEvidence(await storage.get(key), input.seq, n);
  if (!row)
    throw new HttpError(
      404,
      "That evidence row isn't in this case.",
      undefined,
      "evidence-not-found",
    );
  if (!row.withdrawn) {
    if (row.author !== input.actor && !input.any)
      throw new HttpError(
        403,
        "Only whoever added this row or a support lead can withdraw it.",
        undefined,
        "evidence-not-yours",
      );
    row.withdrawn = { at: iso(input.now), by: input.actor };
    await storage.put(key, row);
  }
  const { rows } = await readCaseEvidence(storage, input.thread, input.seq);
  return rows.find((entry) => entry.n === n) ?? row;
}

/* Deletion                                                                */

/** Deletes up to `budget` keys of case `seq`: its frame, evidence rows,
 * counter and the retry markers that point at it. Returns the keys
 * deleted; idempotent, so a later call resumes. */
export async function deleteCaseEvidence(
  storage: Storage,
  thread: string,
  seq: number,
  budget: number,
): Promise<number> {
  if (budget <= 0) return 0;
  let deleted = 0;
  const remove = async (key: string) => {
    if (deleted >= budget) return false;
    if (await storage.delete(key)) deleted++;
    return true;
  };
  for (const key of (
    await storage.list({
      prefix: `${EVIDENCE_PREFIX}${thread}:${pad8(seq)}:`,
      limit: budget,
    })
  ).keys())
    if (!(await remove(key))) return deleted;
  for (const [key, marker] of await storage.list<EvidenceClientMarker>({
    prefix: `${EVIDENCE_CLIENT_PREFIX}${thread}:`,
    limit: 1_000,
  }))
    if (marker?.seq === seq && !(await remove(key))) return deleted;
  await remove(frameKey(thread, seq));
  await remove(evidenceSeqKey(thread, seq));
  return deleted;
}
/** Deletes up to `budget` of a deleted thread's frame and evidence keys,
 * every case at once. */
export async function deleteThreadEvidence(
  storage: Storage,
  thread: string,
  budget: number,
): Promise<number> {
  let deleted = 0;
  for (const prefix of EVIDENCE_THREAD_PREFIXES) {
    if (deleted >= budget) break;
    const rows = await storage.list({
      prefix: `${prefix}${thread}:`,
      limit: budget - deleted,
    });
    for (const key of rows.keys()) if (await storage.delete(key)) deleted++;
  }
  return deleted;
}
