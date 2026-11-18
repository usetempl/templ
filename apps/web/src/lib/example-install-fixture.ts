import {
  installFixtureWorkspace,
  readInstallFixtureScope,
  readServingReleaseIdentity,
  type InstallFixtureScope,
  type ServingReleaseIdentity,
} from "@templ/chat/support-install-fixture";
import { APP_ENVIRONMENT, SITE } from "./site-environment";

const invalid = () => new Error("This install preview could not be checked.");
const sameIdentity = (
  actual: ServingReleaseIdentity,
  expected: ServingReleaseIdentity,
) =>
  Object.entries(expected).every(
    ([key, value]) => actual[key as keyof ServingReleaseIdentity] === value,
  );
const sameScope = (
  actual: InstallFixtureScope,
  expected: InstallFixtureScope,
) =>
  actual.schemaVersion === expected.schemaVersion &&
  actual.environment === expected.environment &&
  actual.namespace === expected.namespace &&
  actual.attempt === expected.attempt &&
  actual.appOrigin === expected.appOrigin &&
  actual.communityOrigin === expected.communityOrigin &&
  sameIdentity(actual.worker, expected.worker) &&
  sameIdentity(actual.web, expected.web);

/** Explicit previews resolve their permit before the page mounts support. */
export async function exampleInstallWorkspace(input: {
  workspace: string;
  hash: string;
  pageIdentity?: ServingReleaseIdentity;
  signal?: AbortSignal;
}): Promise<string> {
  const params = new URLSearchParams(input.hash.replace(/^#/, ""));
  if (!params.has("templ-fixture")) return input.workspace;
  const tokens = params.getAll("templ-check");
  const attempts = params.getAll("templ-attempt");
  if (
    params.getAll("templ-fixture").length !== 1 ||
    params.get("templ-fixture") !== "1" ||
    [...params.keys()].some(
      (key) => !["templ-check", "templ-fixture", "templ-attempt"].includes(key),
    ) ||
    tokens.length !== 1 ||
    attempts.length !== 1 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      attempts[0],
    ) ||
    !/^[0-9a-f]{64}$/.test(tokens[0]) ||
    APP_ENVIRONMENT !== "production" ||
    SITE.origin !== "https://usetempl.com" ||
    SITE.community !== "https://community.usetempl.com"
  )
    throw invalid();
  const pageIdentity = readServingReleaseIdentity(input.pageIdentity, "web");
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
    : AbortSignal.timeout(20_000);
  const options = {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal,
  } as const;
  const [workerResponse, webResponse] = await Promise.all([
    fetch(`${SITE.community}/release`, options),
    fetch(`${SITE.origin}/api/release`, options),
  ]);
  if (workerResponse.status !== 200 || webResponse.status !== 200)
    throw invalid();
  const fixture = readInstallFixtureScope({
    schemaVersion: 2,
    environment: "production",
    namespace: input.workspace,
    attempt: attempts[0],
    appOrigin: SITE.origin,
    communityOrigin: SITE.community,
    worker: await workerResponse.json(),
    web: await webResponse.json(),
  });
  if (!sameIdentity(fixture.web, pageIdentity)) throw invalid();
  const workspace = await installFixtureWorkspace(fixture);
  const response = await fetch(
    `${SITE.community}/widget/${workspace}/install-check/fixture`,
    {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokens[0], fixture }),
    },
  );
  if (response.status !== 200) throw invalid();
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join(",") !== "fixture,workspace" ||
    (result as { workspace?: unknown }).workspace !== workspace ||
    !sameScope(
      readInstallFixtureScope((result as { fixture?: unknown }).fixture),
      fixture,
    )
  )
    throw invalid();
  return workspace;
}
