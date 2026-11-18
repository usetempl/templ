import type { AuthMethod } from "@templ/chat/principal";
import { BRAIN_STORAGE_PRICE } from "@templ/chat/brain-storage";
import { HttpError, json, readJson, type Env } from "./common";
import { principalList } from "./principal";
import { isOperatorAdmin, isTrialOperatorAdmin } from "./operator-admin";
import {
  storageTrialOperatorScope,
  assertStorageTrialWorkspace,
  assertStorageTrialAction,
} from "./brain-storage-trial-access";
import { requireWalletAuth } from "./privileged-auth";
import { appendAuditToStream } from "./room-audit";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import {
  creditStorageReceipt,
  endStorageAgreement,
  recordStorageAgreement,
  storageBillingView,
  storageRows,
  type StorageAgreement,
  type StorageBillingEnv,
} from "./brain-storage-billing";
import type { ProductStorage } from "./product-entitlements";
export const STORAGE_OPERATOR_PATH = "/private/brain-storage/operator";
type Storage = ProductStorage &
  Pick<DurableObjectTransaction, "list" | "delete">;
type Environment = Env & StorageBillingEnv;
const WORKSPACE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export async function storageOperatorRoute<
  S extends ServiceSession & {
    authenticatedAt?: number;
    authMethod?: AuthMethod;
  },
>(request: Request, env: Environment, auth: { session: () => Promise<S> }) {
  const url = new URL(request.url);
  if (url.pathname !== "/operator/brain-storage") return null;
  const session = await auth.session();
  const founder =
    isOperatorAdmin(env, session.principalId, sessionPrincipals(session)) &&
    principalList(env.FOUNDER_PRINCIPALS).includes(session.principalId);
  if (
    !founder &&
    !isTrialOperatorAdmin(env, session.principalId, [session.principalId])
  )
    throw new HttpError(404, "Not found.");
  if (!["GET", "POST"].includes(request.method))
    throw new HttpError(404, "Not found.");
  const body = request.method === "POST" ? await readJson(request, 65_536) : {};
  const workspace =
    request.method === "GET"
      ? url.searchParams.get("workspace")
      : body.workspace;
  if (typeof workspace !== "string" || !WORKSPACE.test(workspace))
    throw new HttpError(400, "Choose a workspace.");
  if (
    !founder &&
    !storageTrialOperatorScope(env, session.principalId, workspace, Date.now())
  )
    throw new HttpError(404, "Not found.");
  if (request.method === "POST")
    requireWalletAuth(session, body.confirmed, Date.now());
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${workspace}`),
  ).fetch(
    new Request(`https://internal${STORAGE_OPERATOR_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        ...body,
        workspace,
        action: request.method === "GET" ? "read" : body.action,
        operator: session.principalId,
        servicePrincipals: sessionPrincipals(session),
        authenticatedAt: session.authenticatedAt,
        authMethod: session.authMethod,
      }),
    }),
  );
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
export async function storageOperatorRequest(
  storage: Storage,
  env: Environment,
  body: Record<string, unknown>,
  now: number,
) {
  const founder =
    typeof body.operator === "string" &&
    isOperatorAdmin(env, body.operator as never, body.servicePrincipals) &&
    principalList(env.FOUNDER_PRINCIPALS).includes(body.operator as never);
  const trial = founder
    ? undefined
    : await assertStorageTrialWorkspace(
        storage,
        env,
        body.operator,
        body.workspace,
        now,
      );
  if (trial) await assertStorageTrialAction(storage, trial, body);
  const native = await storage.get<{ room: { id: string } }>("native-room");
  if (!native || body.workspace !== native.room.id)
    throw new HttpError(404, "Not found.");
  if (body.action === "read")
    return json({
      billing: await storageBillingView(storage, env, now),
      rows: await storageRows(storage),
    });
  requireWalletAuth(
    {
      authenticatedAt: body.authenticatedAt as number,
      authMethod: body.authMethod as AuthMethod,
    },
    body.confirmed,
    now,
  );
  if (
    typeof body.reason !== "string" ||
    body.reason.trim().length < 3 ||
    body.reason.length > 280
  )
    throw new HttpError(400, "Write the reason for this action.");
  if (body.action === "record") {
    const candidate: StorageAgreement = {
      schema: 1,
      id: String(body.id),
      revision: Number(body.revision),
      workspace: native.room.id,
      documentText: String(body.documentText),
      documentSha256: String(body.documentSha256),
      termsSha256: String(body.termsSha256),
      approvedBy: String(body.operator),
      signedBy: String(body.signedBy),
      recordedAt: now,
      startsAt: Number(body.startsAt),
      endsAt: Number(body.endsAt),
      price: { ...BRAIN_STORAGE_PRICE },
    };
    if (body.priceVersion !== BRAIN_STORAGE_PRICE.version)
      throw new HttpError(409, "Review the current storage rate again.");
    await recordStorageAgreement(storage, candidate);
  } else if (body.action === "end") {
    await endStorageAgreement(
      storage,
      env,
      String(body.id),
      Number(body.revision),
      now,
    );
  } else if (
    body.action === "payment" ||
    body.action === "credit" ||
    (trial && body.action === "forgive")
  ) {
    await creditStorageReceipt(
      storage,
      {
        id: String(body.receiptId),
        cents: Number(body.cents),
        referenceSha256: String(body.referenceSha256),
        operator: String(body.operator),
        at: now,
        kind: body.action === "payment" ? "payment" : "credit",
        reason: body.reason.trim(),
      },
      env,
    );
  } else throw new HttpError(400, "Choose a storage billing action.");
  await appendAuditToStream(
    storage as never,
    "access",
    {
      actor: body.operator as never,
      action: "support.settings",
      target: "brain-storage",
      after: {
        op: body.action,
        agreementId: body.id ?? null,
        revision: body.revision ?? null,
        ...(["payment", "credit", "forgive"].includes(String(body.action))
          ? {
              cents: Number(body.cents),
              referenceSha256: String(body.referenceSha256),
              reason: body.reason.trim(),
            }
          : {}),
      },
      authenticatedAt: new Date(Number(body.authenticatedAt)).toISOString(),
    },
    now,
  );
  return json({
    billing: await storageBillingView(storage, env, now),
    rows: await storageRows(storage),
  });
}
