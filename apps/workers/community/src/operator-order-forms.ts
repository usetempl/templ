import { MANAGED_QUALIFICATION_TRIAL, managedQualificationTrial, assertManagedQualificationWorkspace, assertManagedQualificationForm, revokeManagedQualification } from "./managed-agent-trial-access";
import {
  isProductUsageTerms,
  usageResolutionTable,
} from "@templ/chat/usage-billing";
import type { AuthMethod } from "@templ/chat/principal";
import { normalizeChatPrincipal } from "@templ/chat/principal";
import { PRODUCT_PILOT_DEFAULTS } from "@templ/chat/plans";
import { resolutionPriceTable } from "@templ/chat/resolution-pricing";
import { HttpError, json, readJson, type Env } from "./common";
import {
  approvedManualBillingTrial,
  assertManualBillingTrialWorkspace,
  assertManualBillingTrialForm,
} from "./manual-billing-trial-access";
import { isOperatorAdmin, type OperatorAdminEnv } from "./operator-admin";
import {
  BILLING_INDEX_OBJECT,
  BILLING_INDEX_PATH,
  registerBillingWorkspace,
} from "./operator-billing";
import { requireWalletAuth } from "./privileged-auth";
import { principalList } from "./principal";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import { appendAuditToStream } from "./room-audit";
import {
  initializeProducts,
  readProductState,
  recordProductEvent,
  PRODUCT_STATE_KEY,
} from "./product-entitlements";
import {
  activeOrderForm,
  activeProductOrderForm,
  isProductOrderForm,
  processProductOrderForms,
  PRODUCT_ORDER_FORM_KEY,
  readProductOrderForms,
  reconcilePilotOrderFormActivations,
  type ProductOrderForm,
} from "./product-order-forms";
import { templStaffCount } from "./templ-staff";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";

export const ROOM_ORDER_FORMS_PATH = "/private/product/order-forms";
type OrderFormEnv = OperatorAdminEnv &
  Pick<Env, "ROOMS" | "FOUNDER_PRINCIPALS" | "APP_ORIGIN">;
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASON_MAX = 280;

async function roomRequest(
  env: OrderFormEnv,
  workspace: string,
  body: Record<string, unknown>,
) {
  const response = await env.ROOMS.get(
    env.ROOMS.idFromName(`native-room:${workspace}`),
  ).fetch(
    new Request(`https://internal${ROOM_ORDER_FORMS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }),
  );
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new HttpError(
      response.status,
      typeof payload.error === "string"
        ? payload.error
        : "The order form could not be changed.",
    );
  return payload;
}
export async function operatorOrderFormsRoute<
  S extends ServiceSession & {
    authenticatedAt?: number;
    authMethod?: AuthMethod;
  },
>(
  request: Request,
  env: OrderFormEnv,
  auth: { session: () => Promise<S> },
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/operator/order-forms") return null;
  const session = await auth.session();
  const body = request.method === "POST" ? await readJson(request, 4_096) : {};
  const trialWorkspace =
    request.method === "GET"
      ? new URL(request.url).searchParams.get("workspace")
      : body.workspace;
  const manualTrial = approvedManualBillingTrial(
    env,
    session.principalId,
    trialWorkspace,
  );
  const managedTrial = managedQualificationTrial(env, session.principalId, trialWorkspace);
  if (
    !isOperatorAdmin(env, session.principalId, sessionPrincipals(session)) &&
    !manualTrial && !managedTrial
  )
    throw new HttpError(404, "Not found.");
  if (
    manualTrial &&
    (request.method === "GET"
      ? [...new URL(request.url).searchParams.keys()].join() !== "workspace"
      : body.action !== "create")
  )
    throw new HttpError(404, "Not found.");
  if (managedTrial && (request.method === "GET" ? [...new URL(request.url).searchParams.keys()].join() !== "workspace" : !["create", "end"].includes(String(body.action)))) throw new HttpError(404, "Not found.");
  try {
    requireWalletAuth(session, true);
  } catch (error) {
    if (error instanceof HttpError && error.reason === "strong-auth-required")
      throw new HttpError(401, "Sign in with your wallet again.");
    throw error;
  }
  if (request.method === "POST")
    requireWalletAuth(session, body.confirmed);
  if (request.method === "GET") {
    const url = new URL(request.url),
      after = url.searchParams.get("after");
    const workspace = url.searchParams.get("workspace");
    if (workspace) {
      if (!WORKSPACE.test(workspace))
        throw new HttpError(400, "Choose a workspace.");
      return json({
        workspace,
        ...(await roomRequest(env, workspace, {
          op: "list",
          manualTrialPrincipal: manualTrial ? session.principalId : null,
      managedTrialPrincipal: managedTrial ? session.principalId : null,
        })),
      });
    }
    if (after && !WORKSPACE.test(after))
      throw new HttpError(400, "Invalid cursor.");
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(BILLING_INDEX_OBJECT),
    ).fetch(
      new Request(
        `https://internal${BILLING_INDEX_PATH}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      ),
    );
    if (!response.ok)
      throw new HttpError(503, "The workspace list could not be read.");
    const page = (await response.json()) as {
      workspaces: string[];
      next: string | null;
    };
    const rows = [];
    for (const workspace of page.workspaces)
      rows.push({
        workspace,
        ...(await roomRequest(env, workspace, { op: "list" })),
      });
    return json({ workspaces: rows, next: page.next });
  }
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  if (body.expectedPrincipalId !== session.principalId)
    throw new HttpError(401, "Your sign-in changed. Try again.");
  if (typeof body.workspace !== "string" || !WORKSPACE.test(body.workspace))
    throw new HttpError(400, "Choose a workspace.");
  if (
    typeof body.reason !== "string" ||
    !body.reason.trim() ||
    body.reason.length > REASON_MAX
  )
    throw new HttpError(400, "Write the reason for this action.");
  if (!["create", "amend", "end"].includes(String(body.action)))
    throw new HttpError(400, "Choose an order form action.");
  let id = body.id;
  if (body.action === "create") {
    const validated = await roomRequest(env, body.workspace, {
      ...body,
      op: "validate-create",
      manualTrialPrincipal: manualTrial ? session.principalId : null,
      managedTrialPrincipal: managedTrial ? session.principalId : null,
      operator: session.principalId,
      authenticatedAt: session.authenticatedAt,
      authMethod: session.authMethod,
    });
    if (validated.replay === true) {
      await registerBillingWorkspace(env, body.workspace);
      return json(validated);
    }
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(BILLING_INDEX_OBJECT),
    ).fetch(
      new Request(`https://internal${BILLING_INDEX_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          op: "orderform-id",
          workspace: body.workspace,
          requestKey: validated.requestKey,
        }),
      }),
    );
    if (!response.ok)
      throw new HttpError(503, "An order form ID could not be created.");
    id = ((await response.json()) as { id: string }).id;
  }
  const result = await roomRequest(env, body.workspace, {
    ...body,
    id,
    op: "action",
    manualTrialPrincipal: manualTrial ? session.principalId : null,
      managedTrialPrincipal: managedTrial ? session.principalId : null,
    operator: session.principalId,
    authenticatedAt: session.authenticatedAt,
    authMethod: session.authMethod,
  });
  await registerBillingWorkspace(env, body.workspace);
  return json(result);
}

/** The caller commits the record, product event and access audit in one transaction. */
export async function roomOrderFormsRequest(
  storage: DurableObjectTransaction,
  env: Pick<OrderFormEnv, "FOUNDER_PRINCIPALS" | "APP_ORIGIN"> & {
    TEMPL_STAFF_PRINCIPALS?: string;
  } & WorkspaceFlagEnv,
  body: Record<string, unknown>,
  now: number,
): Promise<Response> {
  const native = await storage.get<{
    room: {
      id: string;
      creator: import("@templ/chat/principal").ChatPrincipalId;
    };
  }>("native-room");
  if (!native) throw new HttpError(404, "Workspace not found.");
  if (native.room.id === MANAGED_QUALIFICATION_TRIAL.workspace && body.managedTrialPrincipal !== MANAGED_QUALIFICATION_TRIAL.operator) throw new HttpError(404, "Not found.");
  if (body.manualTrialPrincipal)
    await assertManualBillingTrialWorkspace(
      storage,
      env,
      body.manualTrialPrincipal,
      now,
    );
  if (body.managedTrialPrincipal) await assertManagedQualificationWorkspace(storage, env, body.managedTrialPrincipal, now, body.action === "end" || body.op === "list");
  if (body.op === "list") {
    const record = await readProductOrderForms(storage);
    if (body.manualTrialPrincipal)
      for (const form of record.history) assertManualBillingTrialForm(form);
    if (body.managedTrialPrincipal)
      for (const form of record.history) await assertManagedQualificationForm(storage, form, now, true);
    return json({
      orderForm: await activeProductOrderForm(storage, now),
      history: record.history,
      ended: record.ended,
      templStaffCount: await templStaffCount(storage),
      pilotEnabled: await featureOn(env, storage, "pilotOrderForms"),
    });
  }
  if (body.op !== "action" && body.op !== "validate-create")
    throw new HttpError(400, "Unknown request.");
  const operator = normalizeChatPrincipal(body.operator);
  if (!operator) throw new HttpError(401, "Sign in as a Templ operator.");
  if (
    typeof body.reason !== "string" ||
    !body.reason.trim() ||
    body.reason.length > REASON_MAX
  )
    throw new HttpError(400, "Write the reason for this action.");
  try {
    requireWalletAuth(
      {
        authenticatedAt: body.authenticatedAt as number,
        authMethod: body.authMethod as AuthMethod,
      },
      body.confirmed,
      now,
    );
  } catch (error) {
    if (error instanceof HttpError && error.reason === "strong-auth-required")
      throw new HttpError(401, "Sign in with your wallet again.");
    throw error;
  }
  const record = await readProductOrderForms(storage);
  const action = body.action;
  const current = record.history.at(-1);
  const active = activeOrderForm(record, now);
  const latestForms = new Map(record.history.map((form) => [form.id, form]));
  const hasCurrentOrScheduledForm =
    active !== null ||
    [...latestForms.values()].some(
      (form) => form.endsAt > now && record.ended[form.id] === undefined,
    );
  const approvedBy = normalizeChatPrincipal(body.approvedBy);
  if (
    (action === "create" || action === "amend" || action === "end") &&
    (!approvedBy || !principalList(env.FOUNDER_PRINCIPALS).includes(approvedBy))
  )
    throw new HttpError(400, "A listed founder must approve this form.");
  let candidate: ProductOrderForm | undefined;
  if (action === "create" || action === "amend") {
    const pilot =
      body.pilot !== undefined &&
      typeof body.pilot === "object" &&
      body.pilot !== null &&
      !Array.isArray(body.pilot)
        ? {
            title: "Pilot",
            durationDays: PRODUCT_PILOT_DEFAULTS.durationDays,
            monthlyCapCents: PRODUCT_PILOT_DEFAULTS.monthlyCapCents,
            totalCapCents: PRODUCT_PILOT_DEFAULTS.totalCapCents,
            upfrontCents: PRODUCT_PILOT_DEFAULTS.upfrontCents,
            ...body.pilot,
          }
        : body.pilot;
    const first = current
      ? record.history.find((form) => form.id === current.id)
      : undefined;
    const startsAt =
      pilot && action === "amend" && first?.pilot
        ? first.startsAt
        : (body.startsAt as number);
    candidate = {
      id:
        body.op === "validate-create"
          ? `OF-${new Date(now).getUTCFullYear()}-001`
          : String(body.id),
      revision: action === "create" ? 1 : (current?.revision ?? 0) + 1,
      workspace: `room:${native.room.id}`,
      table: (isProductUsageTerms(body.usage)
        ? usageResolutionTable(body.usage)
        : (body.table ??
          (pilot
            ? resolutionPriceTable()
            : undefined))) as ProductOrderForm["table"],
      service: body.service as ProductOrderForm["service"],
      startsAt,
      endsAt: (body.endsAt ??
        (pilot && typeof pilot === "object"
          ? startsAt +
            Number((pilot as { durationDays?: unknown }).durationDays) *
              86_400_000
          : undefined)) as number,
      documentSha256: body.documentSha256 as string,
      approvedBy: approvedBy!,
      createdBy: operator,
      ...(pilot !== undefined
        ? { pilot: pilot as ProductOrderForm["pilot"] }
        : {}),
      ...(body.usage !== undefined
        ? { usage: body.usage as ProductOrderForm["usage"] }
        : {}),
    };
    if (body.manualTrialPrincipal) assertManualBillingTrialForm(candidate);
    if (body.managedTrialPrincipal) await assertManagedQualificationForm(storage, candidate, now);
    if (!isProductOrderForm(candidate))
      throw new HttpError(400, "Check the order form fields and dates.");
    if (
      Boolean(current?.pilot) !== Boolean(candidate.pilot) &&
      action === "amend"
    )
      throw new HttpError(400, "Keep this order form kind.");
    if (candidate.usage) {
      if (action === "amend" && !current?.usage)
        throw new HttpError(
          400,
          "End the earlier agreement before starting usage billing.",
        );
      if (
        action === "amend" &&
        current?.usage &&
        (
          [
            "walletVerificationUsdCents",
            "transactionCheckUsdCents",
            "aiDraftUsdCents",
            "templAiResolutionUsdCents",
          ] as const
        ).some((key) => candidate!.usage![key] > current.usage![key])
      )
        throw new HttpError(
          409,
          "A usage price increase needs a delivered 30-day notice.",
        );
      if (
        action === "amend" &&
        current?.usage &&
        candidate.documentSha256 === current.documentSha256 &&
        JSON.stringify(candidate.usage) !== JSON.stringify(current.usage)
      )
        throw new HttpError(
          400,
          "Use the new signed document for this revision.",
        );
    } else if (action === "amend" && current?.usage)
      throw new HttpError(400, "Keep this agreement kind.");
    if (candidate.pilot) {
      if (candidate.endsAt <= now)
        throw new HttpError(400, "Choose a pilot end date in the future.");
      if (!(await featureOn(env, storage, "pilotOrderForms")))
        throw new HttpError(409, "Pilot order forms are unavailable.");
      const table = resolutionPriceTable();
      const same = (
        left: ProductOrderForm["table"],
        right: ProductOrderForm["table"] | undefined,
      ) =>
        right &&
        left.usdCents === right.usdCents &&
        left.aiOnlyUsdCents === right.aiOnlyUsdCents &&
        left.stepOneAfterCases === right.stepOneAfterCases &&
        left.stepOneUsdCents === right.stepOneUsdCents;
      if (
        !same(candidate.table, table) &&
        (action !== "amend" || !same(candidate.table, current?.table))
      )
        throw new HttpError(400, "Use the normal case prices for a pilot.");
      const candidatePilot = candidate.pilot;
      const currentPilot = current?.pilot;
      if (
        action === "amend" &&
        currentPilot &&
        candidate.documentSha256 === current.documentSha256 &&
        (candidate.endsAt !== current.endsAt ||
          !same(candidate.table, current.table) ||
          Object.keys(candidatePilot).some(
            (key) =>
              candidatePilot[key as keyof typeof candidatePilot] !==
              currentPilot[key as keyof typeof currentPilot],
          ))
      )
        throw new HttpError(
          400,
          "Use the new signed document for this revision.",
        );
    }
    if (
      candidate.service === "managed-ai" &&
      !(await featureOn(env, storage, "managedAgent"))
    )
      throw new HttpError(409, "Managed AI is unavailable.");
    const fields = (form: ProductOrderForm) =>
      JSON.stringify({
        workspace: form.workspace,
        table: {
          aiOnlyUsdCents: form.table.aiOnlyUsdCents,
          usdCents: form.table.usdCents,
          stepOneAfterCases: form.table.stepOneAfterCases,
          stepOneUsdCents: form.table.stepOneUsdCents,
        },
        service: form.service,
        startsAt: form.startsAt,
        endsAt: form.endsAt,
        documentSha256: form.documentSha256,
        approvedBy: form.approvedBy,
        createdBy: form.createdBy,
        ...(form.pilot ? { pilot: form.pilot } : {}),
        ...(form.usage ? { usage: form.usage } : {}),
      });
    if (
      action === "create" &&
      record.history.some(
        (form) => form.revision === 1 && fields(form) === fields(candidate!),
      )
    )
      return json({
        replay: true,
        orderForm: await activeProductOrderForm(storage, now),
        history: record.history,
        ended: record.ended,
      });
    if (candidate.startsAt < now && !(action === "amend" && candidate.pilot))
      throw new HttpError(400, "Check the order form fields and dates.");
    if (record.history.length >= 256)
      throw new HttpError(409, "Order form history needs an operator review.");
    if (body.op === "validate-create") {
      if (action !== "create")
        throw new HttpError(400, "Choose an order form action.");
      if (hasCurrentOrScheduledForm)
        throw new HttpError(409, "This workspace already has an order form.");
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fields(candidate)),
      );
      return json({
        requestKey: [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join(""),
      });
    }
  }
  if (body.managedTrialPrincipal && action !== "create" && action !== "end") throw new HttpError(404, "Not found.");
  if (body.op === "validate-create")
    throw new HttpError(400, "Choose an order form action.");
  if (action === "create") {
    if (record.history.some((form) => form.id === body.id))
      throw new HttpError(409, "Use a new order form ID.");
    if (hasCurrentOrScheduledForm)
      throw new HttpError(409, "This workspace already has an order form.");
  } else if (action === "amend" || action === "end") {
    if (
      !current ||
      body.id !== current.id ||
      body.expectedRevision !== current.revision ||
      record.ended[current.id] !== undefined ||
      (current.endsAt <= now &&
        !(action === "end" && active?.id === current.id))
    )
      throw new HttpError(409, "Read the current order form and try again.");
  } else throw new HttpError(400, "Choose an order form action.");
  let form: ProductOrderForm;
  if (action === "end") {
    if (body.managedTrialPrincipal) {
      await assertManagedQualificationForm(storage, current!, now, true);
      await revokeManagedQualification(storage, now);
    }
    form = current!;
    record.ended[form.id] = now;
  } else {
    form = candidate!;
    record.history.push(form);
  }
  await initializeProducts(storage, {
    creator: native.room.creator,
    room: form.workspace,
    nowMs: now,
  });
  await storage.put(
    PRODUCT_STATE_KEY,
    await readProductState(storage, now, env),
  );
  await storage.put(PRODUCT_ORDER_FORM_KEY, record);
  await reconcilePilotOrderFormActivations(storage, now, env);
  await processProductOrderForms(storage, env, now);
  await storage.put(
    PRODUCT_STATE_KEY,
    await readProductState(storage, now, env),
  );
  await recordProductEvent(
    storage,
    `orderform:${form.id}:${form.revision}:${action}`,
    {
      action: `orderform.${action}`,
      at: now,
      reason: body.reason.trim(),
      operator,
      authenticatedAt: body.authenticatedAt as number,
      approvedBy: approvedBy!,
    },
  );
  await appendAuditToStream(
    storage,
    "access",
    {
      actor: operator,
      action: `orderform.${action}`,
      target: form.id,
      after: {
        revision: form.revision,
        service: form.service,
        reason: body.reason.trim(),
        approvedBy: approvedBy!,
      },
    },
    now,
  );
  return json({
    orderForm: await activeProductOrderForm(storage, now),
    history: record.history,
    ended: record.ended,
  });
}
