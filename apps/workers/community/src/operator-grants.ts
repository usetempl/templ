/** `GET /operator/grants`: what each reviewed grant did, for Templ operators
 * and the product-grants release gate (verify-product-grants.mjs).
 *
 * The route reads the worker's own `PRODUCT_GRANTS` policy var, asks each
 * listed workspace's room object to apply the list, and returns fixed fields
 * per grant: id, kind, status (pending, credited, deferred or revoked), its
 * cases and when they end. No workspace name, usage, member or payment detail.
 * Asking a room applies the list there first, so a grant for a workspace
 * nobody opened since the deploy still credits. */
import { HttpError, json, type Env } from "./common";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  initializeProducts,
  PRODUCT_STATE_KEY,
  type ProductStorage,
} from "./product-entitlements";
import {
  applyProductGrants,
  grantStatuses,
  type FoundingRegistry,
  productGrants,
  type GrantStatus,
  type ProductGrantsEnv,
} from "./product-grants";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import type { NativeRoomRecord } from "./native-rooms";

export const OPERATOR_GRANTS_PATH = "/operator/grants";
export const ROOM_GRANT_STATUS_PATH = "/private/product/grant-status";
const ROOM_TIMEOUT_MS = 10_000;

export type OperatorGrantRow = {
  id: string;
  kind: string;
  status: GrantStatus;
  cases: number;
  endsAt: string | null;
};
export type OperatorGrants = {
  schemaVersion: 1;
  checkedAt: string;
  /** SHA-256 of the PRODUCT_GRANTS text this worker read, so a saved
   * record binds the exact reviewed list. */
  listSha256: string;
  grants: OperatorGrantRow[];
};

type GrantsRouteEnv = OperatorAdminEnv & ProductGrantsEnv & Pick<Env, "ROOMS">;

export async function operatorGrantsRoute<S extends ServiceSession>(
  request: Request,
  env: GrantsRouteEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== OPERATOR_GRANTS_PATH) return null;
  const session = await auth.session();
  if (!isOperatorAdmin(env, session.principalId, sessionPrincipals(session)))
    throw new HttpError(403, "This page is for Templ operators.");
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  const list = productGrants(env);
  if (!list.ok) throw new HttpError(503, "The grant list could not be read.");
  const workspaces = [
    ...new Set(list.grants.map((grant) => grant.room.slice("room:".length))),
  ];
  const found = new Map<string, OperatorGrantRow>();
  for (const workspace of workspaces)
    for (const row of await roomGrantStatus(env, workspace))
      found.set(row.id, row);
  const grants = list.grants.map(
    (grant) =>
      found.get(grant.id) ?? {
        id: grant.id,
        kind: grant.kind,
        status: list.revoked.has(grant.id)
          ? ("revoked" as const)
          : ("pending" as const),
        cases: grant.cases,
        endsAt: null,
      },
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(env.PRODUCT_GRANTS ?? ""),
  );
  return json({
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    listSha256: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(""),
    grants,
  } satisfies OperatorGrants);
}

/** One workspace's rows. A room that cannot answer leaves its grants
 * pending; the gate then refuses. */
async function roomGrantStatus(
  env: Pick<Env, "ROOMS">,
  workspace: string,
): Promise<OperatorGrantRow[]> {
  try {
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(`native-room:${workspace}`),
    ).fetch(
      new Request(`https://internal${ROOM_GRANT_STATUS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(ROOM_TIMEOUT_MS),
      }),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return [];
    }
    const body = (await response.json().catch(() => null)) as {
      grants?: unknown;
    } | null;
    return Array.isArray(body?.grants)
      ? (body.grants as OperatorGrantRow[])
      : [];
  } catch {
    return [];
  }
}

/** The room side, inside one storage transaction: apply the list, then
 * report this room's grants. A room without a workspace answers 404. */
export async function roomGrantStatusRequest(
  storage: ProductStorage & Pick<DurableObjectTransaction, "get">,
  env: ProductGrantsEnv,
  nowMs: number,
  founding?: FoundingRegistry,
): Promise<Response> {
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native) throw new HttpError(404, "Workspace not found.");
  const room = `room:${native.room.id}`;
  await initializeProducts(storage, {
    creator: native.room.creator,
    room,
    nowMs,
  });
  if (await storage.get(PRODUCT_STATE_KEY))
    await applyProductGrants(storage, env, room, nowMs, founding);
  return json({ grants: await grantStatuses(storage, env, room) });
}
