import {
  BOT_LIMITS,
  normalizeBotDisplayName,
  type ChatBots,
} from "@templ/chat/bots";
import {
  normalizeChatPrincipal,
  type AuthMethod,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { isSolanaAddress } from "@templ/chat/solana";
import { HttpError, readJson } from "./common";
import { requireWalletAuth } from "./privileged-auth";

/** Registering a support bot by the Solana wallet its account signed in with.
 *
 * `POST /rooms/:id/bots` names a bot by its account ID or EVM address. A
 * manager may name it by a Solana wallet instead: the worker looks the wallet
 * up in the `identity-solana:` index, which only a checked Sign In With Solana
 * proof writes, and sends the room the ordinary registration for that
 * account. The wallet never becomes an alias and is never stored as the bot.
 *
 * The lookup is not an API. It runs only for the workspace's manager, after
 * a valid wallet session and an explicit confirmation, once the room agreed
 * it can take another bot, and under the per-manager lookup limit the
 * Solana staff grant uses. An unknown wallet and a wallet whose proof is gone
 * get the same answer. A wallet that is found always ends in the room's own
 * registration, with its permission checks and audit entry. */

/** The one answer for a Solana wallet no account proved, however it came to
 * be unknown. The staff grant by Solana wallet gives the same text. */
export const SOLANA_BOT_UNKNOWN =
  "No Templ account has signed in with this Solana wallet. Ask them to sign in to Templ with it first, or use their account ID.";
const NOT_ALLOWED = "You do not have permission to do that.";
const PATH = /^\/rooms\/([0-9a-f-]{36})\/bots$/;

type Session = {
  principalId: ChatPrincipalId;
  authMethod: AuthMethod;
  authenticatedAt?: number;
};
export type SolanaBotDependencies<S extends Session> = {
  /** The caller's current session; throws 401 when there is none. */
  session(request: Request): Promise<S>;
  /** Every principal the session acts as. */
  principals(session: S): readonly ChatPrincipalId[];
  /** The workspace manager's principal. */
  manager(roomId: string): Promise<ChatPrincipalId>;
  /** The account a proven Solana wallet signs in to, or null. */
  owner(wallet: string): Promise<ChatPrincipalId | null>;
  /** The per-manager lookup limit; false when it is used up. */
  limit(key: string): Promise<boolean>;
  /** The worker's own router, for the registration the room makes. */
  route(request: Request): Promise<Response>;
  /** True inside a support widget, whose sessions never reach bot routes. */
  widget: boolean;
};

/** Returns null for anything but a bot registration that names a Solana
 * wallet, leaving that request untouched for the ordinary route. */
export async function solanaBotRoute<S extends Session>(
  request: Request,
  deps: SolanaBotDependencies<S>,
): Promise<Response | null> {
  if (request.method !== "POST" || deps.widget) return null;
  const url = new URL(request.url);
  const match = PATH.exec(url.pathname);
  if (!match) return null;
  // The body is read first, from a copy, so the ordinary route still reads
  // the original. A body that fails to parse is the ordinary route's error.
  let body: Record<string, unknown>;
  try {
    body = await readJson(request.clone(), 24_000);
  } catch {
    return null;
  }
  const wallet = body.principalId;
  if (normalizeChatPrincipal(wallet) || !isSolanaAddress(wallet)) return null;
  const session = await deps.session(request);
  if (
    "expectedWallet" in body ||
    body.expectedPrincipalId !== session.principalId
  )
    throw new HttpError(401, "Your sign-in changed. Try again.");
  if (!deps.principals(session).includes(await deps.manager(match[1])))
    throw new HttpError(403, NOT_ALLOWED);
  requireWalletAuth(session, body.confirmed);
  // The name is checked before the lookup, with the room's own message, so
  // a request the room would refuse can't tell a known wallet from an
  // unknown one.
  try {
    normalizeBotDisplayName(body.displayName);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Use 2 to 32 characters.",
    );
  }
  // The room answers for its own bot list: set up, and room for one more.
  const headers = new Headers(request.headers);
  headers.delete("Content-Type");
  headers.delete("Content-Length");
  const listed = await deps.route(
    new Request(request.url, { method: "GET", headers }),
  );
  if (!listed.ok) return listed;
  const { bots } = await listed.json<ChatBots>();
  if (!Array.isArray(bots) || bots.length >= BOT_LIMITS.botsPerRoom)
    throw new HttpError(
      409,
      `This room has reached its limit of ${BOT_LIMITS.botsPerRoom} bots.`,
    );
  // Shared with the staff grant by Solana wallet: one lookup budget per
  // manager account.
  if (!(await deps.limit(`solana-grant:${session.principalId}`)))
    throw new HttpError(429, "Too many requests. Please try again shortly.");
  const account = await deps.owner(wallet);
  if (!account || !account.startsWith("account:"))
    throw new HttpError(
      404,
      SOLANA_BOT_UNKNOWN,
      undefined,
      "unknown-solana-wallet",
    );
  const { confirmed: _confirmed, ...rest } = body;
  const forward = new Headers(request.headers);
  forward.delete("Content-Length");
  return deps.route(
    new Request(request.url, {
      method: "POST",
      headers: forward,
      body: JSON.stringify({ ...rest, principalId: account }),
    }),
  );
}
