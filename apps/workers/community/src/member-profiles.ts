import {
  profileMediaHash,
  profileUpdate,
  type ProfileUpdate,
} from "@templ/chat/profiles";
import { identityStore, MAX_PROFILE_LOOKUP } from "./account-identity";
import { HttpError, json, readJson, siteOrigins, type Env } from "./common";
import {
  mediaOwnedBy,
  restoreMediaReference,
  setMediaReference,
} from "./media";
import { safetyRequest, type SafetyEnv } from "./safety";
import type { ServiceSession } from "./service-principals";

/** Member profiles. Names and avatars are public by content, so
 * `GET /profiles` needs no session; the identity object only ever returns the
 * public projection. Writes belong to the signed-in account and are capped at
 * three changes per sliding day. Private-room icon upload stays gated as before. */
/** The worker's own session type carries more than the principal; this
 * module only needs the principal and its verified aliases. */
export type ProfileRouteAuth<S extends ServiceSession = ServiceSession> = {
  /** Resolves the current session or throws 401/503 like every other route. */
  session: () => Promise<S>;
  /** The shared `expectedPrincipalId` consistency guard. */
  guard: (body: Record<string, unknown>, session: S) => void;
};
const clientIp = (request: Request) =>
  request.headers.get("CF-Connecting-IP") ?? "unknown";
/** Forwards an identity op and returns its response as is, so 400 and 429
 * (with Retry-After) reach the person unchanged. */
async function identityProfileOp(env: Env, body: Record<string, unknown>) {
  let response: Response;
  try {
    response = await identityStore(env).fetch(
      new Request("https://internal/identity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    throw new HttpError(503, "Profiles are temporarily unavailable.");
  }
  if (response.status >= 500)
    throw new HttpError(503, "Profiles are temporarily unavailable.");
  return response;
}
/** Comma-separated `ids` query: at most 50 non-empty entries. */
export function profileIds(url: URL): string[] {
  const raw = url.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length > MAX_PROFILE_LOOKUP)
    throw new HttpError(
      400,
      `Request up to ${MAX_PROFILE_LOOKUP} profiles at a time.`,
    );
  return ids;
}
/** An avatar must be an image staged by this account. The successful profile
 * write pins it for public reads; a blocked image cannot become an avatar. */
async function requireAvatar(env: Env, update: ProfileUpdate, owner: string) {
  if (typeof update.avatar !== "string") return null;
  const hash = profileMediaHash(
    update.avatar,
    siteOrigins(env).communityOrigin,
  );
  if (!hash) throw new HttpError(400, "Upload an avatar image first.");
  if ((env as SafetyEnv).SAFETY_ENABLED === "true") {
    const status = await safetyRequest(env as SafetyEnv, {
      op: "status",
      roomKeys: [],
      mediaKeys: [hash],
    });
    if (!status.ok)
      throw new HttpError(503, "Profiles are temporarily unavailable.");
    const result = await status.json<{ blockedMedia: string[] }>();
    if (result.blockedMedia.length)
      throw new HttpError(400, "Upload an avatar image first.");
  }
  if (!(await mediaOwnedBy(env, owner, hash)))
    throw new HttpError(400, "Upload an avatar image first.");
  return hash;
}
/** Worker handlers for `GET|POST /auth/profile` and `GET /profiles?ids=`.
 * Returns null for any other path so the caller keeps routing. */
export async function memberProfileRoute<S extends ServiceSession>(
  request: Request,
  env: Env,
  auth: ProfileRouteAuth<S>,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/profiles" && request.method === "GET") {
    if (
      !env.CHAT_READ_RATE_LIMITER ||
      !(
        await env.CHAT_READ_RATE_LIMITER.limit({
          key: `profiles:${clientIp(request)}`,
        })
      ).success
    )
      throw new HttpError(429, "Too many requests. Please try again shortly.");
    const ids = profileIds(url);
    if (!ids.length) return json({ profiles: [] });
    return identityProfileOp(env, { op: "profiles", principalIds: ids });
  }
  if (url.pathname !== "/auth/profile") return null;
  if (request.method === "GET") {
    const session = await auth.session();
    auth.guard(
      { expectedPrincipalId: url.searchParams.get("expectedPrincipalId") },
      session,
    );
    return identityProfileOp(env, {
      op: "profile-read",
      principalId: session.principalId,
    });
  }
  if (request.method !== "POST") return null;
  const session = await auth.session();
  const body = await readJson(request, 2048);
  auth.guard(body, session);
  const { expectedPrincipalId: _expected, ...draft } = body;
  let update: ProfileUpdate;
  try {
    update = profileUpdate(draft, siteOrigins(env).communityOrigin);
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
  const avatarId = await requireAvatar(env, update, session.principalId);
  const changesAvatar = Object.hasOwn(update, "avatar");
  const referenceChange = changesAvatar
    ? await setMediaReference(
        env,
        session.principalId,
        "profile",
        update.avatar === null ? null : avatarId,
      )
    : null;
  try {
    const response = await identityProfileOp(env, {
      op: "profile-write",
      principalId: session.principalId,
      update,
    });
    if (!response.ok && changesAvatar)
      await restoreMediaReference(
        env,
        session.principalId,
        "profile",
        update.avatar === null ? null : avatarId,
        referenceChange!.previous,
        referenceChange!.revision,
      );
    return response;
  } catch (error) {
    if (changesAvatar)
      await restoreMediaReference(
        env,
        session.principalId,
        "profile",
        update.avatar === null ? null : avatarId,
        referenceChange!.previous,
        referenceChange!.revision,
      ).catch(() => undefined);
    throw error;
  }
}
