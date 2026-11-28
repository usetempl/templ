import { createHash, createHmac } from "node:crypto";
import { vi } from "vitest";
import {
  projectedReleasedFeatures,
  readReleaseActivation,
  releaseActivationCanonical,
  RELEASE_ACTIVATION_SIGNING_SCOPE,
  RELEASE_ACTIVATION_WINDOW_MS,
  type ReleaseActivation,
  type ReleasePublicProjection,
} from "@templ/chat/release-activation";
import { AuthRecord } from "../src/auth-record";
import { RELEASE_ACTIVATION_OBJECT } from "../src/release-activation";
import { Memory } from "./case-memory";
import type { Env } from "../src/common";
import type { ServingReleaseIdentity } from "@templ/chat/support-install-fixture";

const TEST_KEY = "0a".repeat(32);
const worker = {
  schemaVersion: 1 as const,
  environment: "production" as const,
  service: "community" as const,
  versionId: "11111111-1111-4111-8111-111111111111",
  commit: "a".repeat(40),
  sourceDigest: "b".repeat(64),
  lockfileSha256: "c".repeat(64),
};
const web = {
  ...worker,
  service: "web" as const,
  versionId: "22222222-2222-4222-8222-222222222222",
};
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
/** Signed, local-only receipts exercise the normal production reader. */
export function releaseActivationFixture(
  env: Env,
  projection: ReleasePublicProjection,
  pair: { worker: ServingReleaseIdentity; web: ServingReleaseIdentity } = {
    worker,
    web,
  },
) {
  const { worker: servingWorker, web: servingWeb } = pair;
  const storage = new Memory();
  const namespace = env.AUTH_RECORDS;
  Object.assign(env, {
    RELEASE_ACTIVATION_ENABLED: "true",
    RELEASE_ACTIVATION_KEY: TEST_KEY,
    RELEASE_IDENTITY: JSON.stringify({
      schemaVersion: 1,
      environment: servingWorker.environment,
      commit: servingWorker.commit,
      sourceDigest: servingWorker.sourceDigest,
      lockfileSha256: servingWorker.lockfileSha256,
    }),
    CF_VERSION_METADATA: { id: servingWorker.versionId },
    RELEASED_FEATURES: "[]",
  });
  const object = new AuthRecord(
    { storage } as unknown as DurableObjectState,
    env,
  );
  env.AUTH_RECORDS = {
    idFromName: (name: string) => namespace?.idFromName(name) ?? name,
    get: (id: DurableObjectId) =>
      String(id) === RELEASE_ACTIVATION_OBJECT
        ? { fetch: (request: Request) => object.fetch(request) }
        : namespace.get(id),
  } as DurableObjectNamespace;
  vi.spyOn(globalThis, "fetch").mockImplementation(((
    input: RequestInfo | URL,
  ) =>
    (input instanceof Request ? input.url : String(input)) ===
    "https://usetempl.com/api/release"
      ? Promise.resolve(Response.json(servingWeb))
      : Promise.reject(
          new Error("Unexpected activation fixture request."),
        )) as typeof fetch);
  let generation = 0;
  const setProjection = (publicRelease: ReleasePublicProjection) => {
    const previous = storage.data.get("release-activation-v1") as
      | { digest: string }
      | undefined;
    const now = Date.now();
    const activation = readReleaseActivation({
      schemaVersion: 1,
      environment: "production",
      appOrigin: "https://usetempl.com",
      communityOrigin: "https://community.usetempl.com",
      worker: servingWorker,
      web: servingWeb,
      artifacts: Object.fromEntries(
        [
          "workerArtifactSha256",
          "webArtifactSha256",
          "workerArtifactDigest",
          "webArtifactDigest",
          "workerModuleSha256",
          "workerAssetSha256",
          "webModuleSha256",
          "webAssetSha256",
          "widgetAssetSha256",
        ].map((key) => [key, "f".repeat(64)]),
      ),
      mainCommit: "1".repeat(40),
      mainCiRunId: "123456789",
      evidenceIndexSha256: "2".repeat(64),
      projectionSha256: hash(releaseActivationCanonical(publicRelease)),
      publicRelease,
      releasedFeatures: projectedReleasedFeatures(publicRelease),
      previousDigest: previous?.digest ?? null,
      issuedAt: now,
      expiresAt: now + RELEASE_ACTIVATION_WINDOW_MS,
      nonce: (++generation).toString(16).padStart(64, "0"),
    } satisfies ReleaseActivation);
    const canonical = releaseActivationCanonical(activation);
    storage.data.set("release-activation-v1", {
      canonical,
      digest: hash(canonical),
      signature: createHmac("sha256", Buffer.from(TEST_KEY, "hex"))
        .update(RELEASE_ACTIVATION_SIGNING_SCOPE + canonical)
        .digest("hex"),
    });
  };
  setProjection(projection);
  return { storage, setProjection, worker: servingWorker, web: servingWeb };
}
