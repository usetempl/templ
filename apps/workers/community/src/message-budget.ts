import { OPERATIONAL_LIMITS } from "@templ/chat/plans";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { HttpError, json, type Env } from "./common";
import { withSearchBudget } from "./search-budget";
import { timed } from "./request-context";

type BudgetEntry = { id: string; pending: boolean; until: number };
type Storage = Pick<
  DurableObjectStorage,
  "get" | "put" | "delete" | "setAlarm" | "list"
>;
const INTERVAL_MS = OPERATIONAL_LIMITS.messageIntervalSeconds * 1000;
const RESERVATION_MS = 60_000;
export const MESSAGE_PACING_REASON = "account-message-pace";
export const MESSAGE_BUDGET_AVAILABLE_HEADER = "X-Message-Budget-Available";
export const MESSAGE_BUDGET_USED_HEADER = "X-Message-Budget-Used";
export function assertMessageBudgetAvailable(available: boolean) {
  if (!available)
    throw new HttpError(
      429,
      "Your next message will send shortly.",
      1,
      MESSAGE_PACING_REASON,
    );
}

function checkedBudgetEntry(value: BudgetEntry | undefined) {
  if (
    value !== undefined &&
    (typeof value !== "object" ||
      value === null ||
      typeof value.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.id) ||
      typeof value.pending !== "boolean" ||
      !Number.isSafeInteger(value.until))
  )
    throw new HttpError(503, "Chat is temporarily unavailable.");
  return value;
}

// A stable object serializes reservations across rooms, routes and linked
// identities. A fixed time bucket would allow two sends at its boundary.
export async function messageBudgetRequest(
  storage: Storage,
  body: Record<string, unknown>,
) {
  const principal = normalizeChatPrincipal(body.principal);
  const aliases = Array.isArray(body.aliases)
    ? [...new Set(body.aliases.map(normalizeChatPrincipal))]
    : [];
  const id =
    typeof body.id === "string" && /^[a-f0-9]{64}$/.test(body.id)
      ? body.id
      : null;
  if (
    !principal ||
    !aliases.includes(principal) ||
    aliases.some((value) => !value) ||
    aliases.length > 32 ||
    !id
  )
    throw new HttpError(400, "Invalid message budget request.");
  const now = Date.now();
  const key = `message-budget:${principal}`;
  const own = checkedBudgetEntry(await storage.get<BudgetEntry>(key));
  const existing = own?.id === id && own.until > now ? own : undefined;
  if (body.op === "release") {
    if (existing?.pending) await storage.delete(key);
    return json({ ok: true });
  }
  if (body.op === "commit") {
    if (!existing) throw new HttpError(409, "Please retry your message.", 1);
    await storage.put(key, { id, pending: false, until: now + INTERVAL_MS });
    return json({ ok: true });
  }
  if (body.op !== "reserve")
    throw new HttpError(400, "Invalid message budget request.");
  if (existing) {
    if (existing.pending)
      throw new HttpError(
        409,
        "This message is still being sent. Please retry.",
        1,
      );
    return json({ reserved: false });
  }
  const entries = await Promise.all(
    aliases.map(async (alias) =>
      checkedBudgetEntry(
        await storage.get<BudgetEntry>(`message-budget:${alias}`),
      ),
    ),
  );
  const until = Math.max(now, ...entries.map((entry) => entry?.until ?? now));
  if (until > now)
    throw new HttpError(
      429,
      "Your next message will send shortly.",
      Math.max(1, Math.ceil((until - now) / 1000)),
      MESSAGE_PACING_REASON,
    );
  await storage.put(key, { id, pending: true, until: now + RESERVATION_MS });
  // Only set the first alarm. Constant activity must not postpone cleanup.
  if (!(await storage.get<number>("message-budget-expiry"))) {
    await storage.put("message-budget-expiry", now + RESERVATION_MS);
    await storage.setAlarm(now + RESERVATION_MS);
  }
  return json({ reserved: true });
}

export async function expireMessageBudget(storage: DurableObjectStorage) {
  const expiry = await storage.get<number>("message-budget-expiry");
  if (expiry === undefined) return false;
  await storage.transaction(async (transaction) => {
    const now = Date.now();
    const cursor = await transaction.get<string>("message-budget-cursor");
    const rows = await transaction.list<BudgetEntry>({
      prefix: "message-budget:",
      ...(cursor ? { startAfter: cursor } : {}),
      limit: 500,
    });
    for (const [key, entry] of rows)
      if (Array.isArray(entry) || entry.until <= now)
        await transaction.delete(key);
    // Continue bounded pages promptly, then revisit live rows next minute.
    if (rows.size === 500)
      await transaction.put("message-budget-cursor", [...rows.keys()].at(-1)!);
    else await transaction.delete("message-budget-cursor");
    const next = now + (rows.size === 500 ? 1000 : RESERVATION_MS);
    if (rows.size || cursor) {
      await transaction.put("message-budget-expiry", next);
      await transaction.setAlarm(next);
    } else await transaction.delete("message-budget-expiry");
  });
  return true;
}

type BudgetInput = {
  scope: string;
  path: string;
  method: string;
  body?: Record<string, unknown>;
  principal: string | null;
  aliases: string[];
};
/** A pace reservation for one message write. `applies` is false for
 * requests the pace does not cover. `failure` is a refusal to return as is,
 * with nothing reserved. `reserved` says whether this request holds the
 * account's next slot; while paced it is false and the room decides. */
export type PacingReservation =
  | { applies: false; reserved?: undefined; failure?: undefined }
  | {
      applies: true;
      reserved: boolean;
      failure?: Response;
      retryAfter: string | null;
      command: (op: string) => Promise<Response>;
    };
function writesMessage(input: BudgetInput) {
  const body = input.body;
  return (
    /^\/channels\/[^/]+\/messages(?:\/[0-9]+\/edit)?$/.test(input.path) ||
    /^\/conversations\/(?:ask|start|tc-[a-f0-9]{32}\/messages(?:\/[0-9]+\/edit)?)$/.test(
      input.path,
    ) ||
    ((body?.action === "note" || body?.encryptedRecord !== undefined) &&
      /^\/conversations\/tc-[a-f0-9]{32}\/workflow$/.test(input.path))
  );
}
/** Reserves the account's next message slot before a message write. */
export async function reservePacing(
  env: Env,
  input: BudgetInput,
): Promise<PacingReservation> {
  const body = input.body;
  if (
    input.method !== "POST" ||
    !input.principal ||
    !body ||
    (typeof body.text !== "string" && body.encryptedRecord === undefined) ||
    !writesMessage(input)
  )
    return { applies: false };
  // Only the existing idempotent write routes reuse a reservation. An edit
  // can legitimately restore old text and must take another slot.
  const retry = input.path.endsWith("/edit")
    ? crypto.randomUUID()
    : (body.clientId ?? (body.encryptedRecord as { id?: unknown } | undefined)?.id ?? crypto.randomUUID());
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        input.scope,
        input.path,
        input.principal,
        retry,
        body.encryptedRecord ?? body.text,
        body.replyTo ?? null,
      ]),
    ),
  );
  const id = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const stub = env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(`message-pacing:${env.APP_ORIGIN}`),
  );
  const command = (op: string) =>
    timed(
      env,
      op === "reserve" ? "pace" : "settle",
      stub.fetch(
        new Request("https://internal/message-budget", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op,
            id,
            principal: input.principal,
            aliases: [...new Set([input.principal, ...input.aliases])],
          }),
        }),
      ),
    );
  let reservation = await command("reserve");
  // Let an identical request already in flight commit its room write. The
  // reservation remains occupied throughout; an unknown outcome stays closed.
  for (let attempt = 0; reservation.status === 409 && attempt < 4; attempt++) {
    await reservation.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, 25));
    reservation = await command("reserve");
  }
  // While paced, the room may still answer a deduplicated retry or unchanged
  // edit. It enforces this internal flag immediately before message writes.
  if (!reservation.ok && reservation.status !== 429)
    return {
      applies: true,
      reserved: false,
      failure: reservation,
      retryAfter: null,
      command,
    };
  const retryAfter = reservation.headers.get("Retry-After");
  const reserved = reservation.ok
    ? (await reservation.json<{ reserved: boolean }>()).reserved
    : false;
  if (!reservation.ok) await reservation.body?.cancel().catch(() => {});
  return { applies: true, reserved, retryAfter, command };
}
/** Gives back a slot reserved for a write that was never sent. */
export async function releasePacing(reservation: PacingReservation) {
  if (reservation.applies && reservation.reserved)
    await reservation.command("release").catch(() => undefined);
}
/** Commits the slot a sent write used, or releases it. A failed commit after
 * the room accepted the write answers 503 so the client retries the same
 * message rather than assuming it was lost. */
export async function settlePacing(
  reservation: PacingReservation,
  response: Response,
): Promise<Response> {
  if (!reservation.applies) return response;
  // A transport failure has an unknown outcome. Keep its reservation until
  // its lease ends rather than granting extra sends after a lost response.
  if (reservation.reserved) {
    const spent =
      response.ok &&
      response.headers.get(MESSAGE_BUDGET_USED_HEADER) !== "false";
    const outcome = await reservation.command(spent ? "commit" : "release");
    if (!outcome.ok && response.ok && outcome.status !== 409)
      return json(
        { error: "Your message may have been sent. Retry the same message." },
        503,
      );
  }
  const clean = new Response(response.body, response);
  clean.headers.delete(MESSAGE_BUDGET_USED_HEADER);
  if (response.status === 429 && reservation.retryAfter) {
    const details = await clean
      .clone()
      .json<{ reason?: string }>()
      .catch(() => null);
    if (details?.reason === MESSAGE_PACING_REASON)
      clean.headers.set("Retry-After", reservation.retryAfter);
  }
  return clean;
}
export async function withMessageBudget(
  env: Env,
  input: BudgetInput,
  forward: (available?: boolean) => Promise<Response>,
): Promise<Response> {
  if (input.method === "GET" && input.path === "/search")
    return withSearchBudget(env, input, forward);
  const reservation = await reservePacing(env, input);
  if (!reservation.applies) return forward();
  if (reservation.failure) return reservation.failure;
  return settlePacing(reservation, await forward(reservation.reserved));
}
