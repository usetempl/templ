import type { ChatPrincipalId } from "@templ/chat/principal";
import {
  COMMUNITY_API,
  CommunityApiError,
  communityFetch,
  chatRetryAfter,
} from "./community-client";
import { peekCommunitySession, readCommunitySession } from "./community-auth";

/** Anonymous reads deliberately omit cookies, including a disconnected wallet's old cookie. */
export async function anonymousChatFetch<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${COMMUNITY_API}${path}`, {
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  const body = await response.json();
  if (!response.ok)
    throw new CommunityApiError(
      body.error ?? "Chat couldn’t load.",
      response.status,
      body,
      chatRetryAfter(response),
    );
  return body as T;
}
/** A remembered, unexpired session for this account is enough to send: the
 * worker checks the cookie on every write and refuses another account through
 * expectedPrincipalId. The network check runs only when nothing is remembered. */
export async function requireChatSession(account?: ChatPrincipalId) {
  if (!account) throw new Error("Sign in to continue.");
  const session =
    peekCommunitySession(account) ??
    (await readCommunitySession(false, account));
  if (session?.principalId?.toLowerCase() !== account.toLowerCase())
    throw new CommunityApiError("Sign in to continue.", 401);
}
export async function chatMutation<T>(
  account: ChatPrincipalId | undefined,
  path: string,
  body: unknown,
  assertCurrent?: () => void,
  signal?: AbortSignal,
) {
  await requireChatSession(account);
  assertCurrent?.();
  signal?.throwIfAborted();
  const payload = { ...(body as Record<string, unknown>) };
  if (Object.hasOwn(payload, "expectedWallet"))
    throw new Error("expectedWallet is not supported.");
  try {
    return await communityFetch<T>(
      path,
      {
        ...payload,
        expectedPrincipalId: account,
      },
      signal,
    );
  } catch (reason) {
    // The cookie no longer matches the remembered session. Check it again:
    // an ended session is forgotten, and another account's is remembered.
    if (reason instanceof CommunityApiError && reason.status === 401)
      await readCommunitySession(true).catch(() => {});
    throw reason;
  }
}
