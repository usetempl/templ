import {
  browserOnboardingEvent,
  JOURNEY_ID,
  ONBOARDING_POLICY,
  onboardingReport,
  ONBOARDING_AUDIENCES,
  ONBOARDING_TRAFFIC,
  validOnboardingEvent,
  type OnboardingEvent,
  type OnboardingJourney,
  type OnboardingTraffic,
  type OnboardingAudience,
} from "@templ/chat/onboarding";
import type { AnalyticsEvent } from "@templ/chat/analytics-events";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError, json, readJson } from "./common";
import {
  isOperatorAdmin,
  isTrialOperatorAdmin,
  type OperatorAdminEnv,
} from "./operator-admin";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import type { FunnelEnv } from "./funnel-metrics";
import { currentHumanAdmin } from "./workspace-admin";
import { principalList } from "./principal";

const INSTANCE = "onboarding-journeys-v1";
const PREFIX = "journey:";
const DAY = 86_400_000;
export const WORKSPACE_ONBOARDING = "onboarding-journey-v1";
export type WorkspaceOnboarding = {
  journey: string;
  traffic: OnboardingTraffic;
  expiresAt: number;
  widgetSynced?: boolean;
};
/** Validate requests from older workers during rollout, then discard the reference. */
export async function receiveWidgetOnboardingScope(
  _storage: DurableObjectStorage,
  body: Record<string, unknown>,
) {
  if (
    Object.keys(body).length !== 3 ||
    typeof body.journey !== "string" ||
    !JOURNEY_ID.test(body.journey) ||
    typeof body.traffic !== "string" ||
    !Object.hasOwn(ONBOARDING_TRAFFIC, body.traffic) ||
    !Number.isSafeInteger(body.expiresAt) ||
    Number(body.expiresAt) <= Date.now() ||
    Number(body.expiresAt) > Date.now() + ONBOARDING_POLICY.retentionDays * DAY
  )
    throw new HttpError(400, "Invalid onboarding reference.");
  return json({ ok: true });
}
export function onboardingTraffic(
  env: OperatorAdminEnv,
  session: ServiceSession | null,
  trial = false,
): OnboardingTraffic {
  if (
    trial ||
    (session &&
      isTrialOperatorAdmin(
        env,
        session.principalId,
        sessionPrincipals(session),
      ))
  )
    return "test";
  const internal = principalList(
    [env.FOUNDER_PRINCIPALS, env.TEMPL_STAFF_PRINCIPALS]
      .filter(Boolean)
      .join(","),
  );
  if (
    session &&
    (isOperatorAdmin(env, session.principalId, sessionPrincipals(session)) ||
      sessionPrincipals(session).some((principal) =>
        internal.includes(principal),
      ))
  )
    return "operator";
  return session ? "customer" : "unclassified";
}
export const onboardingOptOut = (request: Request) =>
  ["1", "yes"].includes(request.headers.get("DNT") ?? "") ||
  request.headers.get("Sec-GPC") === "1";
/** First-party app route, after the origin check and request limiter. */
export async function browserOnboardingRoute(
  request: Request,
  _env: FunnelEnv & OperatorAdminEnv,
  _session: () => Promise<ServiceSession | null>,
) {
  if (new URL(request.url).pathname !== "/funnel/journey") return null;
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const value = browserOnboardingEvent(await readJson(request, 512));
  if (!value) throw new HttpError(400, "Invalid onboarding event.");
  return json({ recorded: false });
}
export async function operatorOnboardingRoute(
  request: Request,
  env: FunnelEnv & OperatorAdminEnv,
  session: () => Promise<ServiceSession>,
) {
  const url = new URL(request.url);
  if (url.pathname !== "/operator/onboarding") return null;
  const actor = await session();
  if (!isOperatorAdmin(env, actor.principalId, sessionPrincipals(actor)))
    throw new HttpError(403, "This page is for Templ operators.");
  if (request.method !== "GET") throw new HttpError(404, "Not found.");
  const days = Number(url.searchParams.get("days") ?? "30");
  const traffic = url.searchParams.get("traffic") ?? "public";
  if (
    ![7, 30, 90].includes(days) ||
    !Object.hasOwn(ONBOARDING_AUDIENCES, traffic)
  )
    throw new HttpError(400, "Choose a valid period and traffic group.");
  if (!env.COST_METRICS)
    throw new HttpError(503, "Onboarding counts are unavailable.");
  const response = await env.COST_METRICS.get(
    env.COST_METRICS.idFromName(INSTANCE),
  ).fetch(
    new Request(
      `https://internal/onboarding/report?days=${days}&traffic=${traffic}`,
      { signal: AbortSignal.timeout(5000) },
    ),
  );
  if (!response.ok)
    throw new HttpError(503, "Onboarding counts are unavailable.");
  return response;
}

/** Private metrics binding. Journey IDs never leave through operator reports or logs. */
export async function onboardingMetricsRequest(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  const url = new URL(request.url),
    now = Date.now();
  if (url.pathname === "/onboarding/report" && request.method === "GET") {
    const days = Number(url.searchParams.get("days"));
    const traffic = url.searchParams.get("traffic") as OnboardingAudience;
    if (
      ![7, 30, 90].includes(days) ||
      !Object.hasOwn(ONBOARDING_AUDIENCES, traffic)
    )
      throw new HttpError(400, "Invalid onboarding report.");
    const from = new Date(now - (days - 1) * DAY).toISOString().slice(0, 10),
      to = new Date(now).toISOString().slice(0, 10);
    const rows = new Map<string, OnboardingJourney>();
    let after: string | undefined;
    while (rows.size <= ONBOARDING_POLICY.maxJourneysPerReport) {
      const page = await storage.list<OnboardingJourney>({
        ...(after ? { startAfter: after } : { start: `${PREFIX}${from}:` }),
        end: `${PREFIX}${to}:~`,
        limit: 1000,
      });
      for (const [key, value] of page) rows.set(key, value);
      if (page.size < 1000) break;
      after = [...page.keys()].at(-1);
    }
    const collectedSince =
      (await storage.get<number>("collected-since")) ?? null;
    return json(
      onboardingReport(
        [...rows.values()].slice(0, ONBOARDING_POLICY.maxJourneysPerReport),
        {
          from,
          to,
          now,
          traffic,
          available: true,
          complete: rows.size <= ONBOARDING_POLICY.maxJourneysPerReport,
          collectedSince,
        },
      ),
    );
  }
  if (url.pathname !== "/onboarding/ingest") return null;
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const body = await readJson(request, 8192);
  if (
    Object.keys(body).length !== 1 ||
    !Array.isArray(body.events) ||
    !body.events.length ||
    body.events.length > ONBOARDING_POLICY.maxEventsPerBatch ||
    !body.events.every(validOnboardingEvent) ||
    body.events.some(
      (event: OnboardingEvent) =>
        event.at > now + 60_000 ||
        event.at < now - ONBOARDING_POLICY.retentionDays * DAY,
    )
  )
    throw new HttpError(400, "Invalid onboarding batch.");
  return json({ recorded: false });
}
export async function pruneOnboarding(
  storage: DurableObjectStorage,
  now: number,
) {
  const old = await storage.list<OnboardingJourney>({
    start: PREFIX,
    end: `${PREFIX}${new Date(now - (ONBOARDING_POLICY.retentionDays - 1) * DAY).toISOString().slice(0, 10)}:`,
    limit: 128,
  });
  if (old.size)
    await storage.delete(
      [...old.keys()].flatMap((key) => [
        key,
        `index:${key.slice(key.lastIndexOf(":") + 1)}`,
      ]),
    );
  return {
    active: (await storage.list({ prefix: PREFIX, limit: 1 })).size > 0,
    backlog: old.size === 128,
  };
}

export async function workspaceOnboarding(
  storage: DurableObjectStorage,
  env: OperatorAdminEnv & FunnelEnv,
  input: {
    name: AnalyticsEvent;
    principalId: ChatPrincipalId;
    servicePrincipals: ChatPrincipalId[];
  },
) {
  const native = await storage.get<{
    room: { manager: ChatPrincipalId };
    trialOperator?: string;
  }>("native-room");
  if (
    !native ||
    (!input.servicePrincipals.includes(native.room.manager) &&
      !(await currentHumanAdmin(
        storage,
        input.principalId,
        input.servicePrincipals,
        env,
      )))
  )
    throw new HttpError(404, "Workspace not found.");
  return json({ recorded: false });
}
