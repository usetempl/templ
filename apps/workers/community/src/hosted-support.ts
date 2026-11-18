import {
  featureOn,
  workspaceFeatureEnvFromFlags,
  type WorkspaceFlagEnv,
} from "./workspace-flags";
/** Public descriptors for a workspace whose manager enabled its hosted page. */
import type { WorkspaceFlag } from "@templ/chat/workspace-flags";
import { SUPPORT_LIMITS } from "@templ/chat/support";
import { siteOrigins, HttpError, json, readJson, type Env } from "./common";
import {
  isDomainName,
  coversOrigin,
  checkedDomainRows,
  domainVerifyOffered,
  recheckDomain,
  DOMAIN_LIMITS,
} from "./domain-verify";
import { nativeRecord, NATIVE_UUID } from "./native-rooms";
import { widgetConfig } from "./support-widget";

export const hostedPageOffered = (env: WorkspaceFlagEnv & {
  SUPPORT_HOSTED_PAGE_ENABLED?: string;
},
) => featureOn(env, undefined, "hostedSupportPage");
export const hostedPageHref = (origin: string, workspace: string) =>
  `${origin}/help/${workspace}`;
export type HostedSupportDescriptor = {
  workspace: string;
  name: string;
  href: string;
  frameRequired: boolean;
  verifiedSites: string[];
};

export async function hostedSupportDescriptor(
  env: Env,
  workspace: string,
  fetcher: typeof fetch = fetch,
): Promise<HostedSupportDescriptor | null> {
  if (!NATIVE_UUID.test(workspace)) return null;
  const response = await widgetConfig(env, workspace, {
    op: "read",
    origin: env.APP_ORIGIN,
  });
  if (!response.ok)
    throw new HttpError(503, "Support settings are unavailable.");
  let settings = await response.json<{
    hostedPage?: boolean;
    closed?: boolean;
    frameRequired?: boolean;
    origins: string[];
    workspaceFlags?: WorkspaceFlag[];
  }>();
  env = workspaceFeatureEnvFromFlags(env, settings.workspaceFlags ?? [], workspace);
  if (!hostedPageOffered(env)) return null;
  if (!settings.hostedPage || settings.closed) return null;
  const listed = checkedDomainRows(
    settings as unknown as Record<string, unknown>,
  ).verifiedDomains;
  if (
    domainVerifyOffered(env) &&
    listed.some(
      (row) => Date.now() - row.lastCheckedAt >= DOMAIN_LIMITS.recheckAfterMs,
    )
  ) {
    await Promise.all(
      listed.map((row) =>
        recheckDomain(row, {
          fetcher,
          config: (body) =>
            widgetConfig(
              env,
              workspace,
              body as Parameters<typeof widgetConfig>[2],
            ),
        }),
      ),
    );
    const refreshed = await widgetConfig(env, workspace, {
      op: "read",
      origin: env.APP_ORIGIN,
    });
    if (!refreshed.ok)
      throw new HttpError(503, "Support settings are unavailable.");
    settings = await refreshed.json<typeof settings>();
    if (!settings.hostedPage || settings.closed) return null;
  }
  const { record } = await nativeRecord(env, workspace);
  const domains = checkedDomainRows(
    settings as unknown as Record<string, unknown>,
  ).verifiedDomains;
  return {
    workspace,
    name: record.room.name,
    href: hostedPageHref(env.APP_ORIGIN, workspace),
    frameRequired: settings.frameRequired === true,
    verifiedSites: domainVerifyOffered(env)
      ? settings.origins.filter((origin) =>
          domains.some((row) => coversOrigin(row.domain, origin)),
        )
      : [],
  };
}

type DirectoryEnv = Pick<Env, "AUTH_RECORDS" | "APP_ORIGIN">;
function directory(env: DirectoryEnv, domain: string) {
  return env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(
      `${siteOrigins(env).origin.hostname}:support-entry:${domain}`,
    ),
  );
}
export async function indexSupportDomain(
  env: DirectoryEnv,
  domain: string,
  workspace: string,
  remove = false,
) {
  const response = await directory(env, domain).fetch(
    new Request("https://internal/support-entry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, remove }),
    }),
  );
  if (!response.ok)
    throw new HttpError(
      503,
      "The support page link is unavailable. Try again.",
    );
}
/** One domain's bounded candidate index. A lookup rechecks each candidate. */
export async function supportEntryRecord(
  request: Request,
  storage: DurableObjectStorage,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/support-entry") return null;
  if (request.method === "GET")
    return json((await storage.get<string[]>("workspaces")) ?? []);
  if (request.method !== "POST") throw new HttpError(404, "Not found.");
  const body = await readJson(request);
  if (
    typeof body.workspace !== "string" ||
    !NATIVE_UUID.test(body.workspace) ||
    typeof body.remove !== "boolean"
  )
    throw new HttpError(400, "Invalid workspace.");
  return storage.transaction(async (local) => {
    const rows = ((await local.get<string[]>("workspaces")) ?? []).filter(
      (id) => id !== body.workspace,
    );
    if (!body.remove) rows.push(body.workspace as string);
    if (rows.length > SUPPORT_LIMITS.hostedDomainCandidates)
      throw new HttpError(429, "This domain has too many support entries.");
    await local.put("workspaces", rows);
    return json({ ok: true });
  });
}

/** A domain has a link only while exactly one verified workspace publishes it. */
export async function supportEntryRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const match = /^\/support-entry\/([^/]+)$/.exec(
    new URL(request.url).pathname,
  );
  if (!match) return null;
  const domain = match[1];
  if (
    request.method !== "GET" ||
    request.headers.get("Origin") !== env.APP_ORIGIN ||
    !isDomainName(domain)
  )
    throw new HttpError(404, "Support page not found.");
  const response = await directory(env, domain).fetch(
    new Request("https://internal/support-entry"),
  );
  if (!response.ok)
    throw new HttpError(503, "Support settings are unavailable.");
  const candidates = await response.json<string[]>();
  const found: HostedSupportDescriptor[] = [];
  for (const workspace of candidates.slice(
    0,
    SUPPORT_LIMITS.hostedDomainCandidates,
  )) {
    const settings = await widgetConfig(env, workspace, {
      op: "read",
      origin: env.APP_ORIGIN,
    });
    if (!settings.ok)
      throw new HttpError(503, "Support settings are unavailable.");
    const current = await settings.json<Record<string, unknown>>();
    if (
      !checkedDomainRows(current).verifiedDomains.some(
        (row) => row.domain === domain,
      )
    )
      continue;
    const descriptor = await hostedSupportDescriptor(env, workspace);
    if (
      descriptor?.verifiedSites.some((origin) => coversOrigin(domain, origin))
    )
      found.push(descriptor);
  }
  if (found.length !== 1) throw new HttpError(404, "Support page not found.");
  return json(found[0]);
}
