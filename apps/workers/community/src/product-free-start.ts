/** The owner registry: which workspace holds a billing owner's free start,
 * which holds an app domain's, and which holds an owner's founding credit.
 * It lives outside the room, in one object per owner principal and per
 * registrable domain, so creating another workspace, or signing in with a
 * new wallet for the same app, never gets a second free start.
 * Reservations are idempotent for the workspace that made them. */
import { getDomain } from "tldts";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError, json, type Env } from "./common";
import { identityRequest } from "./account-identity";

export const FREE_START_REGISTRY_PATH = "/private/product-free-start";
const ROOM = /^room:[a-f0-9-]{36}$/i;
const DOMAIN = /^[a-z0-9.-]{3,253}$/;
/** What one registry object records, by kind. */
const KEYS = {
  "free-start": "product-free-start-room-v1",
  founding: "product-founding-room-v1",
} as const;
type RegistryKind = keyof typeof KEYS;

const unavailable = () =>
  new HttpError(503, "The free start could not be verified.");

/** The registrable domain (public suffix list, private suffixes included)
 * of a widget origin, or null for an IP address, localhost or anything
 * else without one. */
export function registrableDomain(origin: string | null): string | null {
  if (!origin) return null;
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  const domain = getDomain(host, { allowPrivateDomains: true });
  return domain && DOMAIN.test(domain) ? domain : null;
}

/** One registry object's answer: `allowed` when nothing is recorded yet, or
 * when this workspace recorded it. `check` reads without recording. */
export async function freeStartRegistryRequest(
  storage: Pick<DurableObjectTransaction, "get" | "put">,
  body: Record<string, unknown>,
) {
  const kind = body.kind as RegistryKind;
  const holder =
    typeof body.domain === "string"
      ? DOMAIN.test(body.domain)
        ? `domain:${body.domain}`
        : null
      : normalizeChatPrincipal(body.owner);
  if (
    !Object.hasOwn(KEYS, kind) ||
    (kind === "founding" && typeof body.domain === "string") ||
    !holder ||
    typeof body.room !== "string" ||
    !ROOM.test(body.room) ||
    (body.op !== "check" && body.op !== "reserve")
  )
    throw new HttpError(400, "Invalid free start request.");
  const key = KEYS[kind];
  const existing = await storage.get<{
    holder: string;
    room: string;
    reservedAt: number;
  }>(key);
  if (existing && (existing.holder !== holder || typeof existing.room !== "string"))
    throw unavailable();
  if (!existing && body.op === "reserve")
    await storage.put(key, { holder, room: body.room, reservedAt: Date.now() });
  return json({ allowed: !existing || existing.room === body.room });
}

/** Checks, then reserves, `kind` for `room` in every registry object that
 * applies: each service principal of the owner and, for the free start, the
 * app domain. False when any holds it for another workspace. */
export async function reserveOwnerRegistry(
  env: Partial<Env>,
  input: {
    kind: RegistryKind;
    owner: ChatPrincipalId;
    room: string;
    domain: string | null;
  },
) {
  if (!env.ROOMS || !env.AUTH_RECORDS || !env.APP_ORIGIN) throw unavailable();
  const identity = await identityRequest(env as Env, {
    op: "read",
    principalId: input.owner,
  });
  const holders: { name: string; body: Record<string, unknown> }[] =
    identity.servicePrincipals.map((id) => ({
      name: `product-free-start:${id}`,
      body: { owner: id },
    }));
  if (input.kind === "free-start" && input.domain)
    holders.push({
      name: `product-free-start:domain:${input.domain}`,
      body: { domain: input.domain },
    });
  for (const op of ["check", "reserve"])
    for (const holder of holders) {
      const response = await env.ROOMS.get(env.ROOMS.idFromName(holder.name)).fetch(
        new Request(`https://internal${FREE_START_REGISTRY_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            op,
            kind: input.kind,
            room: input.room,
            ...holder.body,
          }),
        }),
      );
      if (!response.ok) throw unavailable();
      if ((await response.json<{ allowed: boolean }>()).allowed !== true)
        return false;
    }
  return true;
}

export type FreeStartReservation = {
  owner: boolean;
  domain: boolean | null;
};

/** The owner and every supplied app domain must each allow the free start. */
export async function reserveFreeStartRegistry(
  env: Partial<Env>,
  input: { owner: ChatPrincipalId; room: string; origins: readonly string[] },
): Promise<FreeStartReservation> {
  const owner = await reserveOwnerRegistry(env, {
    kind: "free-start",
    owner: input.owner,
    room: input.room,
    domain: null,
  });
  if (!owner) return { owner: false, domain: null };
  const domains = [...new Set(input.origins.map(registrableDomain))]
    .filter((domain): domain is string => domain !== null);
  if (!domains.length) return { owner: true, domain: null };
  for (const domain of domains) {
    if (!(await reserveOwnerRegistry(env, {
      kind: "free-start",
      owner: input.owner,
      room: input.room,
      domain,
    }))) return { owner: true, domain: false };
  }
  return { owner: true, domain: true };
}
