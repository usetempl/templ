import { featureOn, workspaceFeatureEnvFromFlags } from "./workspace-flags";
import type { WorkspaceFlag } from "@templ/chat/workspace-flags";
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import {
  INSTALL_CHECK_IDS,
  type InstallCheckRecord,
  type InstallCheckResult,
} from "@templ/chat/support-install-check";
import {
  HttpError,
  json,
  randomToken,
  sha256Hex,
  recordByHash,
  type Env,
} from "./common";
import { bitcoinSessionAuthorized } from "./bitcoin-account-auth";
import { nativeRecord } from "./native-rooms";
import { sessionPrincipals } from "./service-principals";
import type { AuthData } from "./auth-record";
import { sessionIdentity, walletSignsIn } from "./linked-wallets";
import { verifySessionAuthority } from "./chain";
import { decodeSolanaSignature, verifySolanaSignature } from "./solana";
import type { Address } from "viem";
import { requireSafetyAccess } from "./safety";
import {
  installFixtureWorkspace,
  readInstallFixtureScope,
  readServingReleaseIdentity,
  type InstallFixtureScope,
} from "@templ/chat/support-install-fixture";
import { releaseIdentity } from "./release-identity";
import { widgetWebsiteOrigin } from "./widget-origin";
import { loopbackOffered } from "./widget-session-config";

type Store = Pick<DurableObjectStorage, "get" | "put" | "delete">;
type Permit = {
  hash: string;
  workspace: string;
  origin: string;
  managerSession: string;
  expiresAt: number;
  run?: string;
  member?: string;
  memberSession?: string;
  fixture?: InstallFixtureScope;
};
const KEY = "install-check-v1";
const PERMIT = "install-check-permit-v1";
const invalid = () => new HttpError(404, "Install check not found.");

/** Called inside the settings object's transaction. One active check per workspace. */
export async function installCheckOperation(
  storage: Store,
  body: Record<string, unknown>,
  now = Date.now(),
): Promise<Response | null> {
  if (typeof body.op !== "string" || !body.op.startsWith("install-check-"))
    return null;
  if (body.op === "install-check-read")
    return json({
      check: (await storage.get<InstallCheckRecord>(KEY)) ?? null,
    });
  if (body.op === "install-check-create") {
    if (
      !widgetWebsiteOrigin(body.origin, body.loopback === true) ||
      typeof body.workspace !== "string" ||
      typeof body.managerSession !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.managerSession)
    )
      throw invalid();
    const token = randomToken();
    const expiresAt = now + FEATURE_LIMITS.installCheckTokenMinutes * 60_000;
    let fixture: InstallFixtureScope | undefined;
    if (body.fixture !== undefined) {
      try {
        fixture = readInstallFixtureScope(body.fixture);
      } catch {
        throw invalid();
      }
      if (
        installFixtureWorkspace(fixture) !== body.workspace ||
        fixture.appOrigin !== body.origin
      )
        throw invalid();
    }
    await storage.put(PERMIT, {
      hash: await sha256Hex(token),
      workspace: body.workspace,
      origin: body.origin,
      managerSession: body.managerSession,
      expiresAt,
      ...(fixture ? { fixture } : {}),
    } satisfies Permit);
    return json({ token, expiresAt });
  }
  const permit = await storage.get<Permit>(PERMIT);
  if (
    !permit ||
    !widgetWebsiteOrigin(body.origin, true) ||
    permit.expiresAt <= now ||
    permit.workspace !== body.workspace ||
    permit.origin !== body.origin
  )
    throw invalid();
  if (body.op === "install-check-authority")
    return json({
      managerSession: permit.managerSession,
      ...(permit.fixture ? { fixture: permit.fixture } : {}),
    });
  if (body.op === "install-check-resolve") {
    if (
      body.managerSession !== permit.managerSession ||
      permit.run ||
      !permit.fixture ||
      typeof body.token !== "string" ||
      (await sha256Hex(body.token)) !== permit.hash ||
      JSON.stringify(body.fixture) !== JSON.stringify(permit.fixture)
    )
      throw invalid();
    return json({ workspace: permit.workspace, fixture: permit.fixture });
  }
  if (
    body.managerSession !== permit.managerSession ||
    typeof body.member !== "string" ||
    typeof body.memberSession !== "string"
  )
    throw invalid();
  if (body.op === "install-check-start") {
    if (
      permit.run ||
      typeof body.token !== "string" ||
      (await sha256Hex(body.token)) !== permit.hash
    )
      throw invalid();
    permit.run = randomToken();
    permit.member = body.member;
    permit.memberSession = body.memberSession;
    permit.hash = "";
    await storage.put(PERMIT, permit);
    const check: InstallCheckRecord = {
      id: permit.run,
      startedAt: now,
      results: [],
    };
    await storage.put(KEY, check);
    return json({ check });
  }
  if (
    !permit.run ||
    body.run !== permit.run ||
    body.member !== permit.member ||
    body.memberSession !== permit.memberSession
  )
    throw invalid();
  if (body.op === "install-check-preview") return json({ preview: true });
  if (body.op !== "install-check-result") throw invalid();
  const row = body.result as InstallCheckResult | undefined;
  if (
    !row ||
    !INSTALL_CHECK_IDS.includes(row.id) ||
    typeof row.pass !== "boolean" ||
    !Number.isSafeInteger(row.at) ||
    row.at > now ||
    row.at < now - FEATURE_LIMITS.installCheckRunMinutes * 60_000 ||
    Object.keys(row).some((key) => !["id", "pass", "at"].includes(key))
  )
    throw new HttpError(400, "Invalid install check result.");
  const check = await storage.get<InstallCheckRecord>(KEY);
  if (!check || check.id !== permit.run) throw invalid();
  if (row.at < check.startedAt)
    throw new HttpError(400, "Invalid install check result.");
  check.results = [
    ...check.results.filter((item) => item.id !== row.id),
    { id: row.id, pass: row.pass, at: row.at },
  ];
  await storage.put(KEY, check);
  return json({ check });
}

/** The issuing app session must still be valid when a widget uses its permit. */
async function installManager(env: Env, hash: string) {
  const response = await recordByHash(env, "session", hash).fetch(
    new Request("https://internal/read", { method: "POST" }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw invalid();
  }
  const data = await response.json<AuthData>();
  const now = Date.now();
  if (
    data.widgetScope ||
    data.contractChain !== undefined ||
    !data.principalId ||
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= now ||
    !Number.isSafeInteger(data.authorizationExpiresAt) ||
    data.authorizationExpiresAt! < data.expiresAt ||
    !Number.isSafeInteger(data.authenticatedAt) ||
    data.authenticatedAt! <= 0 ||
    data.authenticatedAt! > now ||
    !Number.isSafeInteger(data.walletRevision) ||
    data.walletRevision! < 0 ||
    data.nonce ||
    data.message ||
    !["wallet", "solana", "bitcoin"].includes(data.authMethod ?? "")
  )
    throw invalid();
  const read = await sessionIdentity(env, data.principalId);
  if (data.authMethod === "wallet") {
    if (
      !data.address ||
      !(await verifySessionAuthority(
        env,
        data.address as Address,
        data.authorization,
      )) ||
      (read.identity.principalId.startsWith("account:") &&
        !walletSignsIn(read.linked, data.address as Address))
    )
      throw invalid();
  } else if (data.authMethod === "bitcoin") {
    if (!bitcoinSessionAuthorized(data, read.identity, env.APP_ORIGIN)) throw invalid();
  } else {
    const proof = data.solanaAuthorization,
      signature = decodeSolanaSignature(proof?.signature);
    if (
      !proof ||
      !signature ||
      !data.solanaAddress ||
      !read.identity.solana?.some(
        (wallet) => wallet.address === data.solanaAddress,
      ) ||
      !(await verifySolanaSignature(
        proof.message,
        signature,
        data.solanaAddress,
      ))
    )
      throw invalid();
  }
  return read.identity;
}

/** "Check my install" answers only while its release switch is on. */
export function requireInstallCheck(
  env: Pick<Env, "SUPPORT_INSTALL_CHECK_ENABLED">,
) {
  if (!featureOn(env, undefined, "installCheck")) throw invalid();
}
export const INSTALL_PREVIEW = Symbol("install-preview");
/** A fixture names the actual production serving pair, never the public Demo workspace. */
export async function currentInstallFixture(
  env: Env,
  value: unknown,
  origin: string,
): Promise<InstallFixtureScope> {
  requireInstallCheck(env);
  try {
    const claimed = readInstallFixtureScope(value);
    if (
      env.APP_ORIGIN !== claimed.appOrigin ||
      origin !== claimed.appOrigin ||
      env.EXAMPLE_VAULT_WORKSPACE !== claimed.namespace
    )
      throw invalid();
    const response = releaseIdentity(env);
    if (!response.ok) throw invalid();
    const worker = readServingReleaseIdentity(
      await response.json(),
      "community",
    );
    const served = await fetch(`${claimed.appOrigin}/api/release`, {
      redirect: "manual",
      headers: {
        "Cache-Control": "no-store",
        "Cloudflare-Workers-Version-Overrides": `templ-web-production="${claimed.web.versionId}"`,
      },
      cf: { cacheTtl: 0 },
      signal: AbortSignal.timeout(20_000),
    });
    if (served.status !== 200) {
      await served.body?.cancel();
      throw invalid();
    }
    const web = readServingReleaseIdentity(await served.json(), "web");
    const actual = readInstallFixtureScope({ ...claimed, worker, web });
    if (JSON.stringify(actual) !== JSON.stringify(claimed)) throw invalid();
    return actual;
  } catch {
    throw invalid();
  }
}
async function installAuthority(
  env: Env,
  scope: { workspace: string; origin: string },
  config: (body: Record<string, unknown>) => Promise<Response>,
) {
  const authority = await config({ op: "install-check-authority", ...scope });
  if (!authority.ok) return { refused: authority };
  const { managerSession, fixture } = await authority.json<{
    managerSession: string;
    fixture?: InstallFixtureScope;
  }>();
  await checkInstallIssuer(env, scope, managerSession);
  return { managerSession, fixture };
}
async function checkInstallIssuer(
  env: Env,
  scope: { workspace: string; origin: string },
  managerSession: string,
) {
  const current = await installManager(env, managerSession);
  const workspace = await nativeRecord(env, scope.workspace);
  if (!sessionPrincipals(current).includes(workspace.record.room.manager))
    throw invalid();
  await requireSafetyAccess(
    env,
    `room:${scope.workspace}`,
    current.principalId,
    sessionPrincipals(current),
  );
}
async function currentFixtureFlags(
  env: Env,
  scope: { workspace: string; origin: string },
  config: (body: Record<string, unknown>) => Promise<Response>,
) {
  const settings = await config({ op: "read", origin: scope.origin });
  if (!settings.ok) {
    await settings.body?.cancel();
    throw invalid();
  }
  const current = await settings.json<{
    closed?: boolean;
    workspaceFlags?: WorkspaceFlag[];
  }>();
  const scoped = workspaceFeatureEnvFromFlags(
    env,
    current.workspaceFlags ?? [],
    scope.workspace,
  );
  if (
    current.closed ||
    !widgetWebsiteOrigin(scope.origin, loopbackOffered(scoped))
  )
    throw invalid();
  requireInstallCheck(scoped);
}
/** Issuance checks the current manager after reading the exact serving pair. */
export async function prepareInstallFixture(
  env: Env,
  input: {
    workspace: string;
    origin: string;
    managerSession: string;
    fixture: unknown;
  },
  config: (body: Record<string, unknown>) => Promise<Response>,
): Promise<InstallFixtureScope> {
  const fixture = await currentInstallFixture(env, input.fixture, input.origin);
  if (installFixtureWorkspace(fixture) !== input.workspace) throw invalid();
  const scope = { workspace: input.workspace, origin: input.origin };
  await checkInstallIssuer(env, scope, input.managerSession);
  await currentFixtureFlags(env, scope, config);
  return fixture;
}
/** Resolving a permit returns only its public fixture scope and grants no session authority. */
export async function resolveInstallFixture(
  env: Env,
  input: { workspace: string; origin: string; body: Record<string, unknown> },
  config: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  if (
    Object.keys(input.body).sort().join(",") !== "fixture,token" ||
    typeof input.body.token !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.body.token)
  )
    throw invalid();
  requireInstallCheck(env);
  let fixture: InstallFixtureScope;
  try {
    fixture = readInstallFixtureScope(input.body.fixture);
  } catch {
    throw invalid();
  }
  if (
    env.APP_ORIGIN !== fixture.appOrigin ||
    input.origin !== fixture.appOrigin ||
    env.EXAMPLE_VAULT_WORKSPACE !== fixture.namespace
  )
    throw invalid();
  if (installFixtureWorkspace(fixture) !== input.workspace) throw invalid();
  const scope = { workspace: input.workspace, origin: input.origin };
  const permit = await config({ op: "install-check-authority", ...scope });
  if (!permit.ok) return permit;
  const stored = await permit.json<{
    managerSession: string;
    fixture?: InstallFixtureScope;
  }>();
  if (
    !stored.fixture ||
    JSON.stringify(stored.fixture) !== JSON.stringify(fixture)
  )
    throw invalid();
  const checked = await config({
    op: "install-check-resolve",
    ...scope,
    managerSession: stored.managerSession,
    token: input.body.token,
    fixture,
  });
  if (!checked.ok) return checked;
  await checked.body?.cancel();
  await currentInstallFixture(env, fixture, input.origin);
  const authority = await installAuthority(env, scope, config);
  if (authority.refused) return authority.refused;
  if (
    !authority.fixture ||
    JSON.stringify(authority.fixture) !== JSON.stringify(fixture)
  )
    throw invalid();
  await currentFixtureFlags(env, scope, config);
  return config({
    op: "install-check-resolve",
    ...scope,
    managerSession: authority.managerSession,
    token: input.body.token,
    fixture,
  });
}
export async function widgetInstallCheck(
  env: Env,
  input: {
    workspace: string;
    origin: string;
    member: string;
    session: string;
    body: Record<string, unknown>;
    preview?: boolean;
  },
  config: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  const scope = { workspace: input.workspace, origin: input.origin };
  let authority = await installAuthority(env, scope, config);
  if (authority.refused) return authority.refused;
  if (input.body.token && authority.fixture) {
    const fixture = await currentInstallFixture(
      env,
      authority.fixture,
      input.origin,
    );
    if (installFixtureWorkspace(fixture) !== input.workspace) throw invalid();
    authority = await installAuthority(env, scope, config);
    if (authority.refused) return authority.refused;
    if (
      !authority.fixture ||
      JSON.stringify(authority.fixture) !== JSON.stringify(fixture)
    )
      throw invalid();
    await currentFixtureFlags(env, scope, config);
  }
  const { managerSession } = authority;
  return config({
    op: input.preview
      ? "install-check-preview"
      : input.body.token
        ? "install-check-start"
        : "install-check-result",
    ...scope,
    managerSession,
    member: input.member,
    memberSession: await sha256Hex(input.session),
    token: input.body.token,
    run: input.body.run,
    result: input.body.result,
  });
}
