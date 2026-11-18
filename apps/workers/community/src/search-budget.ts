import { PRODUCT_LIMITS } from "@templ/chat/plans";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { HttpError, json, type Env } from "./common";

type Storage = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "list" | "setAlarm"
>;
const WINDOW_MS = 60_000;
const PREFIX = "search-budget:";
const EXPIRY = "search-budget-expiry";
const CURSOR = "search-budget-cursor";
const unavailable = () =>
  json({ error: "Search is unavailable right now." }, 503, {
    "Retry-After": "30",
  });

function liveSearches(value: unknown, now: number): number[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > PRODUCT_LIMITS.searchesPerMinutePerAccount ||
    value.some((at) => !Number.isSafeInteger(at) || at < 0)
  )
    throw new HttpError(503, "Search is unavailable right now.", 30);
  return value.filter((at) => at > now - WINDOW_MS);
}

/** Called inside one AuthRecord transaction. Trusted canonical identity and
 * linked aliases share a rolling minute across every room and search scope. */
export async function searchBudgetRequest(
  storage: Storage,
  body: Record<string, unknown>,
) {
  const principal = normalizeChatPrincipal(body.principal);
  const aliases = Array.isArray(body.aliases)
    ? [...new Set(body.aliases.map(normalizeChatPrincipal))]
    : [];
  if (
    !principal ||
    !aliases.includes(principal) ||
    aliases.some((alias) => !alias) ||
    aliases.length > 32
  )
    throw new HttpError(400, "Invalid search budget request.");
  const now = Date.now();
  const rows = await Promise.all(
    aliases.map(async (alias) => ({
      alias,
      times: liveSearches(await storage.get(`${PREFIX}${alias}`), now),
    })),
  );
  const times = rows.flatMap((row) => row.times).sort((a, b) => a - b);
  const limit = PRODUCT_LIMITS.searchesPerMinutePerAccount;
  if (times.length >= limit)
    throw new HttpError(
      429,
      "Search is busy. Try again in a moment.",
      Math.max(
        1,
        Math.ceil((times[times.length - limit] + WINDOW_MS - now) / 1000),
      ),
    );
  await storage.put(`${PREFIX}${principal}`, [
    ...rows.find((row) => row.alias === principal)!.times,
    now,
  ]);
  // Activity must not keep pushing expiry cleanup into the future.
  if (!(await storage.get(EXPIRY))) {
    await storage.put(EXPIRY, now + WINDOW_MS);
    await storage.setAlarm(now + WINDOW_MS);
  }
  return json({ ok: true });
}

export async function expireSearchBudget(storage: DurableObjectStorage) {
  if ((await storage.get(EXPIRY)) === undefined) return false;
  await storage.transaction(async (transaction) => {
    const now = Date.now();
    const cursor = await transaction.get<string>(CURSOR);
    const rows = await transaction.list<unknown>({
      prefix: PREFIX,
      ...(cursor ? { startAfter: cursor } : {}),
      limit: 500,
    });
    for (const [key, row] of rows) {
      // Corrupt counters stay closed for operator repair; never reset them
      // automatically into a fresh allowance.
      let live: number[];
      try {
        live = liveSearches(row, now);
      } catch {
        continue;
      }
      if (!live.length) await transaction.delete(key);
      else if (Array.isArray(row) && live.length !== row.length)
        await transaction.put(key, live);
    }
    if (rows.size === 500)
      await transaction.put(CURSOR, [...rows.keys()].at(-1)!);
    else await transaction.delete(CURSOR);
    if (rows.size || cursor) {
      const next = now + (rows.size === 500 ? 1000 : WINDOW_MS);
      await transaction.put(EXPIRY, next);
      await transaction.setAlarm(next);
    } else await transaction.delete(EXPIRY);
  });
  return true;
}

export async function withSearchBudget(
  env: Env,
  input: { principal: string | null; aliases: string[] },
  forward: () => Promise<Response>,
) {
  // The room still supplies the normal sign-in/permission response.
  if (!input.principal) return forward();
  let response: Response;
  try {
    const stub = env.AUTH_RECORDS.get(
      env.AUTH_RECORDS.idFromName(`search-pacing:${env.APP_ORIGIN}`),
    );
    response = await stub.fetch(
      new Request("https://internal/search-budget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          principal: input.principal,
          aliases: [...new Set([input.principal, ...input.aliases])],
        }),
      }),
    );
    if (response.status === 429) return response;
    if (!response.ok || (await response.json<{ ok?: unknown }>()).ok !== true)
      return unavailable();
  } catch {
    return unavailable();
  }
  return forward();
}
