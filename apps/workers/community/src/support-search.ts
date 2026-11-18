import { HttpError } from "./common";
import {
  SUPPORT_SEARCH_MANIFEST,
  type SupportStorage,
} from "./support-storage";

export type SupportSearchCandidate = {
  channel_id: string;
  id: number;
  created_at: number;
  revision: number;
};
export type SupportSearchBoundary = {
  createdAt: number;
  channelId: string;
  id: number;
};
type Cursor = {
  v: 1;
  user: string;
  query: string;
  scope: string;
  limit: number;
  expires: number;
  after: SupportSearchBoundary | null;
  scanned?: string;
  best: SupportSearchCandidate[];
  pending?: { id: string; after: SupportSearchBoundary }[];
};
const encoder = new TextEncoder();
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const bytes = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
const compare = (a: SupportSearchCandidate, b: SupportSearchCandidate) =>
  b.created_at - a.created_at ||
  b.channel_id.localeCompare(a.channel_id) ||
  b.id - a.id;
async function signingKey(store: SupportStorage) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`${store.room}:${store.capability}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function cursorToken(store: SupportStorage, value: Cursor) {
  const payload = encoder.encode(JSON.stringify(value));
  return `sp1.${base64(payload)}.${base64(new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(store), payload)))}`;
}
async function readCursor(
  store: SupportStorage,
  token: string,
  input: {
    user: string;
    query: string;
    scope: string;
    limit: number;
    now: number;
  },
) {
  try {
    if (token.length > 12_000) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "sp1") throw new Error();
    const payload = bytes(parts[1]);
    if (
      !(await crypto.subtle.verify(
        "HMAC",
        await signingKey(store),
        bytes(parts[2]),
        payload,
      ))
    )
      throw new Error();
    const cursor = JSON.parse(new TextDecoder().decode(payload)) as Cursor;
    if (
      cursor.v !== 1 ||
      cursor.user !== input.user ||
      cursor.query !== input.query ||
      cursor.scope !== input.scope ||
      cursor.limit !== input.limit ||
      cursor.expires <= input.now ||
      !Array.isArray(cursor.best) ||
      cursor.best.length > 21 ||
      (cursor.pending &&
        (!Array.isArray(cursor.pending) || cursor.pending.length > 9))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new HttpError(400, "This search expired. Search again.");
  }
}

/** Each request examines at most eight bounded FTS partitions. The signed
 * continuation carries candidate IDs only and is bound to this account/query.
 * Every candidate is re-authorized and re-read, including those in a cursor.
 * Empty pages can have a next cursor while older partitions are examined. */
export async function supportSearchCandidates(
  store: SupportStorage,
  input: {
    token: string | null;
    user: string;
    query: string;
    scope: string;
    now: number;
    match: string;
    channels: string[];
    manifestPrefix?: string;
    limit: number;
    after: SupportSearchBoundary | null;
    local: (after: SupportSearchBoundary | null) => SupportSearchCandidate[];
    valid: (candidate: SupportSearchCandidate) => Promise<boolean>;
  },
) {
  const cursor: Cursor = input.token?.startsWith("sp1.")
    ? await readCursor(store, input.token, input)
    : {
        v: 1,
        user: input.user,
        query: input.query,
        scope: input.scope,
        limit: input.limit,
        expires: input.now + 15 * 60_000,
        after: input.after,
        best: [],
      };
  const candidates = [...cursor.best];
  const manifests = await store.local.list<{
    id: string;
    maxCreatedAt: number;
  }>({
    prefix: input.manifestPrefix ?? SUPPORT_SEARCH_MANIFEST,
    reverse: true,
    ...(cursor.scanned ? { end: cursor.scanned } : {}),
    limit: 9,
  });
  const selected = cursor.pending?.length
    ? []
    : [...manifests.entries()].slice(0, 8);
  const work = cursor.pending?.length
    ? cursor.pending
    : [
        ...(!cursor.scanned ? [{ id: "local", after: cursor.after }] : []),
        ...selected.map(([, partition]) => ({
          id: partition.id,
          after: cursor.after,
        })),
      ];
  const unfinished: {
    id: string;
    after: SupportSearchBoundary;
    last: SupportSearchCandidate;
  }[] = [];
  // Four connections at a time, below the platform's six-connection limit.
  for (let offset = 0; offset < work.length; offset += 4) {
    const batch = work.slice(offset, offset + 4);
    const pages = await Promise.all(
      batch.map((partition) =>
        partition.id === "local"
          ? Promise.resolve({ rows: input.local(partition.after) })
          : store.request<{ rows: SupportSearchCandidate[] }>(
              partition.id,
              "index",
              {
                action: "search",
                match: input.match,
                channels: input.channels,
                cursor: partition.after,
                limit: input.limit + 1,
              },
            ),
      ),
    );
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index];
      candidates.push(...page.rows);
      const last = page.rows.at(-1);
      if (page.rows.length === input.limit + 1 && last)
        unfinished.push({
          id: batch[index].id,
          after: {
            createdAt: last.created_at,
            channelId: last.channel_id,
            id: last.id,
          },
          last,
        });
    }
  }
  const unique = new Map<string, SupportSearchCandidate>();
  for (const candidate of candidates) {
    if (await input.valid(candidate))
      unique.set(`${candidate.channel_id}:${candidate.id}`, candidate);
  }
  const best = [...unique.values()].sort(compare).slice(0, input.limit + 1);
  const pending = unfinished
    .filter(
      (partition) =>
        best.length <= input.limit ||
        compare(partition.last, best[input.limit]) < 0,
    )
    .map(({ id, after }) => ({ id, after }));
  const scanned = selected.at(-1)?.[0] ?? cursor.scanned;
  if (pending.length)
    return {
      candidates: [] as SupportSearchCandidate[],
      nextCursor: await cursorToken(store, {
        ...cursor,
        scanned,
        best,
        pending,
      }),
    };
  const oldestMatch = best[input.limit - 1];
  const nextPartition = [...manifests.values()][selected.length ? 8 : 0];
  const morePartitions = selected.length
    ? manifests.size > 8
    : manifests.size > 0;
  const pageIsComplete =
    best.length > input.limit &&
    oldestMatch &&
    nextPartition &&
    nextPartition.maxCreatedAt < oldestMatch.created_at;
  if (morePartitions && !pageIsComplete)
    return {
      candidates: [] as SupportSearchCandidate[],
      nextCursor: await cursorToken(store, {
        ...cursor,
        scanned,
        best,
        pending: undefined,
      }),
    };
  const page = best.slice(0, input.limit);
  const last = page.at(-1);
  return {
    candidates: page,
    nextCursor:
      best.length > input.limit && last
        ? await cursorToken(store, {
            ...cursor,
            scanned: undefined,
            best: [],
            pending: undefined,
            after: {
              createdAt: last.created_at,
              channelId: last.channel_id,
              id: last.id,
            },
          })
        : null,
  };
}
