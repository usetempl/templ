/** `/operator/corpus`: Templ's corpus readers read de-identified rows.
 *
 * - Readers are the accounts in `CORPUS_READER_PRINCIPALS`, at most
 *   `CORPUS_LIMITS.readers`; a longer list turns reading off. Being a Templ
 *   operator for incidents or deletions does not make someone a reader.
 *   Anyone else, and everyone while the copy is off, gets 404.
 * - Every read needs a valid wallet session and names a
 *   purpose (`CORPUS_PURPOSES`). It counts toward the reader's daily rows
 *   and is logged in the corpus directory: reader, time, purpose,
 *   workspace pseudonym and row count. A leak sample logs one entry per
 *   workspace it read from, so each workspace's monthly count includes it.
 * - The route takes a workspace pseudonym, a build time, a ref a dispute
 *   record carries, or a sample size. It refuses a thread, room, case or
 *   message id, reads only the workspace's SupportKnowledge object (never
 *   the room), and returns rows without refs and no link into the app.
 *
 * Routes:
 * - `GET /operator/corpus?workspace=ws_…&purpose=…[&since=<ms or next>]`:
 *   up to 100 rows built at or after `since`, oldest first, and `next`,
 *   the value to pass as `since` for the following page.
 * - `GET /operator/corpus?workspace=ws_…&ref=<hex>&purpose=resolution-audit`:
 *   the one row a dispute names.
 * - `GET /operator/corpus/sample?n=…&purpose=leak-sample`: random rows
 *   across workspaces.
 * - `POST /operator/corpus/leak {sampled, leaked, confirmed,
 *   expectedPrincipalId}`: a leak sample's result. Two results in a row over
 *   the limit pause every workspace's builds. */
import { CORPUS_LIMITS } from "@templ/chat/plans";
import type { AuthMethod } from "@templ/chat/principal";
import {
  isCorpusPurpose,
  type CorpusCase,
  type CorpusPurpose,
} from "@templ/chat/support-corpus";
import { HttpError, json, readJson } from "./common";
import { corpusDirectory, type CorpusDirectoryEnv } from "./corpus-directory";
import { principalList } from "./principal";
import { requireWalletAuth } from "./privileged-auth";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import { knowledgeCorpusRead, type KnowledgeEnv } from "./support-knowledge-client";

export type CorpusOperatorEnv = CorpusDirectoryEnv & KnowledgeEnv & {
  SUPPORT_CORPUS_ENABLED?: string;
  /** Comma-separated principals, at most three. */
  CORPUS_READER_PRINCIPALS?: string;
};
type OperatorSession = ServiceSession & {
  authMethod?: AuthMethod;
  authenticatedAt?: number;
};
const PATH = /^\/operator\/corpus(?:\/(sample|leak))?$/;
const WS = /^ws_[0-9a-f]{16}$/;
const REF = /^[0-9a-f]{64}$/;
/** Names a reader may not pass: nothing here reads a thread or a room. */
const REFUSED_KEYS = ["thread", "room", "tc", "seq", "case", "conversation", "message", "member"];
const ALLOWED_KEYS = ["workspace", "since", "purpose", "ref", "n"];
const notFound = () => new HttpError(404, "Not found.");

function readers(env: CorpusOperatorEnv) {
  const list = principalList(env.CORPUS_READER_PRINCIPALS);
  return list.length <= CORPUS_LIMITS.readers ? list : [];
}
export function isCorpusReader(env: CorpusOperatorEnv, session: ServiceSession) {
  const list = readers(env);
  return (
    list.length > 0 &&
    sessionPrincipals(session).some((id) => list.includes(id))
  );
}

const knowledgeRead = (
  env: CorpusOperatorEnv,
  room: string,
  body: Record<string, unknown>,
) => knowledgeCorpusRead<{ rows: CorpusCase[]; next: string | null }>(env, room, body);
/** A build time in milliseconds, or the `next` cursor of a previous page. */
const SINCE = /^\d{1,16}(?:-\d{1,6})?$/;

export async function corpusOperatorRoute<S extends OperatorSession>(
  request: Request,
  env: CorpusOperatorEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  const leak = match[1] === "leak";
  if (request.method !== (leak ? "POST" : "GET")) throw notFound();
  const body = leak ? await readJson(request, 2_048) : null;
  const session = await auth.session();
  if (env.SUPPORT_CORPUS_ENABLED !== "true" || !isCorpusReader(env, session)) throw notFound();
  if (body && body.expectedPrincipalId !== session.principalId)
    throw new HttpError(401, "Your sign-in changed. Try again.");
  // A read's purpose is its confirmation; the leak result confirms itself.
  requireWalletAuth(session, body ? body.confirmed : true);
  const directory = corpusDirectory(env);
  if (!directory) throw new HttpError(503, "The copy is unavailable. Try again in a minute.");
  const reader = session.principalId;
  if (body) {
    const sampled = Number(body.sampled);
    const leaked = Number(body.leaked);
    return json(await directory.leak(reader, sampled, leaked));
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => REFUSED_KEYS.includes(key.toLowerCase())))
    throw new HttpError(400, "Corpus reads take no thread or room.", undefined, "corpus-no-thread");
  if (keys.some((key) => !ALLOWED_KEYS.includes(key)) || new Set(keys).size !== keys.length)
    throw new HttpError(400, "Read with a workspace, a time or a ref.", undefined, "corpus-query");
  const purpose = url.searchParams.get("purpose");
  if (!isCorpusPurpose(purpose))
    throw new HttpError(400, "Name the purpose of this read.", undefined, "corpus-purpose");
  if (match[1] === "sample") {
    if (purpose !== "leak-sample")
      throw new HttpError(400, "A sample is read to check for leaks.", undefined, "corpus-purpose");
    return sample(env, directory, reader, url, purpose);
  }
  const workspace = url.searchParams.get("workspace") ?? "";
  if (!WS.test(workspace))
    throw new HttpError(400, "Name a workspace pseudonym.", undefined, "corpus-query");
  const ref = url.searchParams.get("ref");
  if (ref !== null && (!REF.test(ref) || purpose !== "resolution-audit"))
    throw new HttpError(400, "A ref is read only to review a disputed charge.", undefined, "corpus-query");
  const since = url.searchParams.get("since") ?? "0";
  if (!SINCE.test(since))
    throw new HttpError(400, "Read from a build time in milliseconds or a page's next value.", undefined, "corpus-query");
  const room = await directory.resolve(workspace).catch((error) => {
    if (error instanceof HttpError && error.status === 404) throw notFound();
    throw error;
  });
  const limit = ref ? 1 : CORPUS_LIMITS.rowsPerRead;
  await directory.take(reader, limit);
  const page = await knowledgeRead(env, room.room, ref ? { ref } : { since, limit });
  await directory.log({ reader, purpose, workspace, rows: page.rows.length });
  return json({ schemaVersion: 1, workspace, purpose, rows: page.rows, next: page.next });
}

async function sample(
  env: CorpusOperatorEnv,
  directory: NonNullable<ReturnType<typeof corpusDirectory>>,
  reader: string,
  url: URL,
  purpose: CorpusPurpose,
) {
  if (url.searchParams.has("workspace") || url.searchParams.has("ref") || url.searchParams.has("since"))
    throw new HttpError(400, "A sample takes a size only.", undefined, "corpus-query");
  const n = Number(url.searchParams.get("n") ?? CORPUS_LIMITS.leakSampleRows);
  if (!Number.isSafeInteger(n) || n < 1 || n > CORPUS_LIMITS.leakSampleRows)
    throw new HttpError(400, `Sample 1 to ${CORPUS_LIMITS.leakSampleRows} rows.`, undefined, "corpus-query");
  await directory.take(reader, n);
  const { workspaces } = await directory.workspaces();
  const order = [...workspaces].sort(() => Math.random() - 0.5);
  const rows: CorpusCase[] = [];
  const read = new Map<string, number>();
  for (const workspace of order) {
    if (rows.length >= n) break;
    const { room } = await directory.resolve(workspace);
    const page = await knowledgeRead(env, room, { sample: true, limit: Math.max(1, Math.ceil(n / Math.max(1, order.length))) });
    const taken = page.rows.slice(0, n - rows.length);
    rows.push(...taken);
    if (taken.length) read.set(workspace, taken.length);
  }
  for (const [workspace, count] of read) await directory.log({ reader, purpose, workspace, rows: count });
  return json({ schemaVersion: 1, purpose, rows });
}
