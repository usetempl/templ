import { SITE } from "./site-environment";
import { PRINCIPAL_HINT_HEADER, principalHint } from "./principal-hint";

export const COMMUNITY_API = SITE.community;

export class CommunityApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: unknown,
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export function chatRetryAfter(response: Response): number | null {
  const value = response.headers.get("Retry-After");
  if (!value || !/^\d+$/.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0
    ? Math.min(seconds, 86_400)
    : null;
}

export async function communityFetch<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  onReceipt?: () => void,
): Promise<T> {
  // POSTs are preflighted already for their JSON body, so the hint adds no
  // round trip. GETs stay simple requests without it.
  const hint = body === undefined ? undefined : principalHint();
  const response = await fetch(`${COMMUNITY_API}${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    cache: "no-store",
    signal,
    ...(body === undefined
      ? {}
      : {
          headers: {
            "Content-Type": "application/json",
            ...(hint ? { [PRINCIPAL_HINT_HEADER]: hint } : {}),
          },
          body: JSON.stringify(body),
        }),
  });
  // This response starts only after the service accepts the question. Its body
  // stays open while the AI prepares the answer.
  const accepted =
    response.ok &&
    !!onReceipt &&
    response.headers.get("Content-Type")?.split(";")[0] ===
      "application/vnd.templ.received+json";
  if (accepted) onReceipt();
  const data = await response.json();
  if (accepted && typeof data.error === "string") {
    throw new CommunityApiError(data.error, data.status, data);
  }
  if (!response.ok) {
    if (data.reason === "strong-auth-required" && typeof window !== "undefined")
      window.dispatchEvent(new Event("templ:strong-auth-required"));
    throw new CommunityApiError(
      data.error ?? "The chat service is unavailable.",
      response.status,
      data,
      chatRetryAfter(response),
    );
  }
  return data as T;
}

export const roomPath = (
  room: import("@templ/chat/index").ChatRoomId,
  suffix: string,
) => `/rooms/${room.slice(5)}/${suffix}`;
