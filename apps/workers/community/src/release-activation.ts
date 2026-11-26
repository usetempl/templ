import {
  inactiveReleaseAvailability,
  readReleaseActivation,
  readReleaseAvailability as readAvailability,
  releaseActivationCanonical,
  RELEASE_ACTIVATION_MAX_BYTES,
  RELEASE_ACTIVATION_PATH,
  RELEASE_ACTIVATION_SIGNING_SCOPE,
  RELEASE_ACTIVATION_WINDOW_MS,
  RELEASE_AVAILABILITY_PATH,
  type ReleaseActivation,
  type ReleaseAvailability,
  type ReleaseActivationMetadata,
} from "@templ/chat/release-activation";
import { readServingReleaseIdentity } from "@templ/chat/support-install-fixture";
import { ACCESS_AUDIT_RETENTION } from "@templ/chat/audit";
import {parseOwnSetupRelease, type OwnSetupRelease} from "@templ/e2ee/own-setup";
import { HttpError, json, sha256Hex, type Env } from "./common";

export type ReleaseActivationEnv = Partial<
  Pick<
    Env,
    | "APP_ORIGIN"
    | "AUTH_RECORDS"
    | "RELEASE_IDENTITY"
    | "CF_VERSION_METADATA"
    | "RELEASE_ACTIVATION_KEY"
    | "RELEASE_ACTIVATION_ENABLED"
    | "MEDIA_BUCKET"
  >
>;
export const RELEASE_ACTIVATION_OBJECT = "production-release-activation-v1";
export const RELEASE_ACTIVATION_APPLY_PRIVATE =
  "/private/release-activation/apply";
export const RELEASE_ACTIVATION_READ_PRIVATE =
  "/private/release-activation/read";
export const RELEASE_ACTIVATION_METADATA_PRIVATE =
  "/private/release-activation/metadata";
export const RELEASE_ACTIVATION_SIGNATURE = "X-Templ-Release-Signature";
const KEY = "release-activation-v1";
const NONCES = "release-activation-nonces-v1";
const AUDIT_PREFIX = "release-activation-audit-v1:";
const AUDIT_SEQUENCE = "release-activation-audit-sequence-v1";
const SERVING_IDENTITY_MAX_BYTES = 65_536;
const ACTIVE_RELEASE = Symbol("verified-production-release");
const ACTIVATION_READ_UNKNOWN = Symbol("activation-read-unknown");
export const RELEASE_PAIR_REGISTRY_KEY = "release-control/active-pairs-v1.json";
export const RELEASE_WEB_VERSION_HEADER = "X-Templ-Web-Version";
const VERSION = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const REGISTRY_MAX_BYTES = 262_144;
type PairRegistry = {
  schemaVersion: 1;
  headDigest: string;
  pairs: StoredActivation[];
  nonces: Nonce[];
};
type StoredActivation = {
  canonical: string;
  signature: string;
  digest: string;
};
type Nonce = { nonce: string; until: number };
function storedNonces(value: unknown): Nonce[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) throw refusal();
  const seen = new Set<string>();
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).sort().join(",") !== "nonce,until" ||
      typeof entry.nonce !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.nonce) ||
      !Number.isSafeInteger(entry.until) ||
      entry.until <= 0 ||
      seen.has(entry.nonce)
    )
      throw refusal();
    seen.add(entry.nonce);
  }
  return value;
}
function storedSequence(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value >= Number.MAX_SAFE_INTEGER
  )
    throw refusal();
  return value;
}
type Audit = {
  at: number;
  digest: string;
  previousDigest: string | null;
  mainCommit: string;
  mainCiRunId: ReleaseActivation["mainCiRunId"];
  workerVersion: string;
  webVersion: string;
};
type ScopedEnv = ReleaseActivationEnv & {
  [ACTIVE_RELEASE]?: ReleaseAvailability;
  [ACTIVATION_READ_UNKNOWN]?: boolean;
};
const refusal = () => new HttpError(403, "Release activation was refused.");
const readUnavailable = () =>
  new HttpError(503, "Release activation is unavailable.");
const confirmedRefusal = (error: unknown) =>
  error instanceof HttpError && error.status === 403;
type ActivationStep =
  | "current-worker"
  | "current-web"
  | "proposal-store"
  | "registry-store";
class ActivationStepFailure extends HttpError {
  constructor(
    readonly step: ActivationStep,
    error: unknown,
  ) {
    super(
      error instanceof HttpError ? error.status : 403,
      "Release activation was refused.",
    );
  }
}
async function activationStep<T>(
  step: ActivationStep,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new ActivationStepFailure(step, error);
  }
}
function enabled(env: ReleaseActivationEnv) {
  return (
    env.APP_ORIGIN === "https://usetempl.com" &&
    env.RELEASE_ACTIVATION_ENABLED === "true" &&
    typeof env.RELEASE_ACTIVATION_KEY === "string" &&
    /^[0-9a-f]{64}$/.test(env.RELEASE_ACTIVATION_KEY)
  );
}
function workerIdentity(env: ReleaseActivationEnv) {
  const source = JSON.parse(env.RELEASE_IDENTITY ?? "null");
  return readServingReleaseIdentity(
    {
      schemaVersion: source?.schemaVersion,
      environment: source?.environment,
      commit: source?.commit,
      sourceDigest: source?.sourceDigest,
      lockfileSha256: source?.lockfileSha256,
      service: "community",
      versionId: env.CF_VERSION_METADATA?.id,
    },
    "community",
  );
}
function sameIdentity(a: unknown, b: unknown) {
  return releaseActivationCanonical(a) === releaseActivationCanonical(b);
}
async function key(env: ReleaseActivationEnv) {
  if (!enabled(env)) throw refusal();
  return crypto.subtle.importKey(
    "raw",
    Uint8Array.from(env.RELEASE_ACTIVATION_KEY!.match(/../g)!, (byte) =>
      parseInt(byte, 16),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}
function admission(activation: ReleaseActivation) {
  const now = Date.now();
  if (
    activation.issuedAt > now + 30_000 ||
    activation.issuedAt <= now - RELEASE_ACTIVATION_WINDOW_MS ||
    activation.expiresAt <= now
  )
    throw refusal();
}
async function signedActivation(
  canonical: string,
  signature: string,
  env: ReleaseActivationEnv,
) {
  if (
    new TextEncoder().encode(canonical).byteLength >
      RELEASE_ACTIVATION_MAX_BYTES ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    throw refusal();
  let activation: ReleaseActivation;
  try {
    activation = readReleaseActivation(JSON.parse(canonical));
  } catch {
    throw refusal();
  }
  if (
    releaseActivationCanonical(activation) !== canonical ||
    !(await crypto.subtle.verify(
      "HMAC",
      await key(env),
      Uint8Array.from(signature.match(/../g)!, (byte) => parseInt(byte, 16)),
      new TextEncoder().encode(RELEASE_ACTIVATION_SIGNING_SCOPE + canonical),
    )) ||
    (await sha256Hex(releaseActivationCanonical(activation.publicRelease))) !==
      activation.projectionSha256
  )
    throw refusal();
  return activation;
}
async function servingWeb(response: Response) {
  const body = await boundedBody(response, SERVING_IDENTITY_MAX_BYTES);
  try {
    return readServingReleaseIdentity(JSON.parse(body), "web");
  } catch {
    throw refusal();
  }
}
/** Fixed production URLs cannot be replaced by a request header or manifest field. */
async function servingPair(
  env: ReleaseActivationEnv,
  activation: ReleaseActivation,
  verifyWorker = true,
  reading = false,
) {
  if (
    !enabled(env) ||
    (verifyWorker && !sameIdentity(workerIdentity(env), activation.worker))
  )
    throw refusal();
  const response = await fetch("https://usetempl.com/api/release", {
    redirect: "manual",
    cf: { cacheTtl: 0 },
    headers: {
      Accept: "application/json",
      "Cache-Control": "no-store",
      "Cloudflare-Workers-Version-Overrides": `templ-web-production="${activation.web.versionId}"`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (reading && (response.status === 429 || response.status >= 500))
    throw readUnavailable();
  if (
    response.status !== 200 ||
    (response.url && response.url !== "https://usetempl.com/api/release")
  )
    throw refusal();
  const web = await servingWeb(response);
  if (
    !sameIdentity(web, activation.web) ||
    !enabled(env) ||
    (verifyWorker && !sameIdentity(workerIdentity(env), activation.worker))
  )
    throw refusal();
}
async function registry(env: ReleaseActivationEnv) {
  if (!env.MEDIA_BUCKET) return null;
  const object = await env.MEDIA_BUCKET.get(RELEASE_PAIR_REGISTRY_KEY);
  if (!object) return null;
  if (object.size > REGISTRY_MAX_BYTES) throw refusal();
  const bytes = await object.text();
  if (new TextEncoder().encode(bytes).byteLength > REGISTRY_MAX_BYTES)
    throw refusal();
  let value: PairRegistry;
  try {
    value = JSON.parse(bytes) as PairRegistry;
  } catch {
    throw refusal();
  }
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "headDigest,nonces,pairs,schemaVersion" ||
    value.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(value.headDigest) ||
    !Array.isArray(value.pairs) ||
    value.pairs.length < 1 ||
    value.pairs.length > 4
  )
    throw refusal();
  storedNonces(value.nonces);
  const seen = new Set<string>();
  for (const pair of value.pairs) {
    if (
      !pair ||
      Object.keys(pair).sort().join(",") !== "canonical,digest,signature" ||
      typeof pair.canonical !== "string" ||
      (await sha256Hex(pair.canonical)) !== pair.digest
    )
      throw refusal();
    const activation = await signedActivation(
      pair.canonical,
      pair.signature,
      env,
    );
    const name = `${activation.worker.versionId}:${activation.web.versionId}`;
    if (seen.has(name)) throw refusal();
    seen.add(name);
  }
  if (!value.pairs.some((pair) => pair.digest === value.headDigest))
    throw refusal();
  return { value, etag: object.etag };
}

/** Setup and first-message admission require both independently qualified
 * generations to remain in the signed registry. This grants no release flag. */
export async function requireOwnEncryptionReleasePair(env: ReleaseActivationEnv, input: OwnSetupRelease) {
  const expected = parseOwnSetupRelease(input), stored = await registry(env);
  const identity = workerIdentity(env);
  if (!stored || ![expected.currentWorkerVersion, expected.previousWorkerVersion].includes(identity.versionId)) throw refusal();
  const find = async (digest: string, version: string) => {
    const pair = stored.value.pairs.find(item => item.digest === digest);
    if (!pair) throw refusal();
    const activation = await signedActivation(pair.canonical, pair.signature, env);
    if (activation.worker.versionId !== version || activation.web.versionId !== expected.webVersion) throw refusal();
    return activation;
  };
  const current = await find(expected.currentActivationDigest, expected.currentWorkerVersion);
  const previous = await find(expected.previousActivationDigest, expected.previousWorkerVersion);
  const actual = identity.versionId === expected.currentWorkerVersion ? current : previous;
  if (!sameIdentity(identity, actual.worker) || current.projectionSha256 !== previous.projectionSha256) throw refusal();
}

async function pairAvailability(
  env: ReleaseActivationEnv,
  webVersion?: string,
  checkWeb = false,
) {
  const stored = await registry(env);
  if (!stored) return null;
  const identity = workerIdentity(env);
  const matches = [];
  for (const pair of stored.value.pairs) {
    const activation = await signedActivation(
      pair.canonical,
      pair.signature,
      env,
    );
    if (
      sameIdentity(identity, activation.worker) &&
      (!webVersion || activation.web.versionId === webVersion)
    )
      matches.push({ pair, activation });
  }
  if (checkWeb && !webVersion && matches.length > 1) {
    const response = await fetch("https://usetempl.com/api/release", {
      redirect: "manual",
      cf: { cacheTtl: 0 },
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 429 || response.status >= 500)
      throw readUnavailable();
    if (
      response.status !== 200 ||
      (response.url && response.url !== "https://usetempl.com/api/release")
    )
      throw refusal();
    const currentWeb = await servingWeb(response);
    for (let i = matches.length - 1; i >= 0; i--)
      if (!sameIdentity(matches[i].activation.web, currentWeb))
        matches.splice(i, 1);
  }
  if (!checkWeb && !webVersion && matches.length > 1)
    matches.splice(0, matches.length - 1);
  if (matches.length !== 1) return inactiveReleaseAvailability();
  const { pair, activation } = matches[0];
  // The API uses proof for its own actual version. A landing outage must not
  // close an existing chat. Web projections also check the selected web runtime.
  if (checkWeb) await servingPair(env, activation, true, true);
  const current = await env.MEDIA_BUCKET!.head(RELEASE_PAIR_REGISTRY_KEY);
  if (current?.etag !== stored.etag) throw readUnavailable();
  if (!sameIdentity(workerIdentity(env), activation.worker)) throw refusal();
  return {
    schemaVersion: 1,
    environment: "production",
    active: true,
    activationDigest: pair.digest,
    publicRelease: activation.publicRelease,
    releasedFeatures: activation.releasedFeatures,
    worker: activation.worker,
    web: activation.web,
  } satisfies ReleaseAvailability;
}

async function applyPair(
  env: ReleaseActivationEnv,
  canonical: string,
  signature: string,
  activation: ReleaseActivation,
) {
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) throw refusal();
  const current = await registry(env);
  if ((current?.value.headDigest ?? null) !== activation.previousDigest)
    return json({ error: "Release activation changed." }, 409);
  const now = Date.now();
  const nonces = (current?.value.nonces ?? []).filter(
    (entry) => entry.until > now,
  );
  if (nonces.some((entry) => entry.nonce === activation.nonce))
    return json({ error: "Release activation was refused." }, 409);
  if (nonces.length >= 128)
    return json({ error: "Release activation was refused." }, 429);
  const digest = await sha256Hex(canonical);
  // Keep the current public versions and the proved incoming versions. Older
  // signed proposals remain in the immutable journal, not the live registry.
  const currentIdentity = async (url: string, service: "community" | "web") => {
    const response = await fetch(url, {
      redirect: "manual",
      cf: { cacheTtl: 0 },
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 200 || (response.url && response.url !== url))
      throw refusal();
    return readServingReleaseIdentity(
      JSON.parse(await boundedBody(response, SERVING_IDENTITY_MAX_BYTES)),
      service,
    );
  };
  const [currentWorker, currentWeb] = await Promise.all([
    activationStep("current-worker", () =>
      currentIdentity("https://community.usetempl.com/release", "community"),
    ),
    activationStep("current-web", () =>
      currentIdentity("https://usetempl.com/api/release", "web"),
    ),
  ]);
  const workers = new Set([
    currentWorker.versionId,
    activation.worker.versionId,
  ]);
  const webs = new Set([currentWeb.versionId, activation.web.versionId]);
  const pairs = [];
  let predecessor: PairRegistry["pairs"][number] | undefined;
  let predecessorIssuedAt = 0;
  for (const stored of current?.value.pairs ?? []) {
    const previous = await signedActivation(
      stored.canonical,
      stored.signature,
      env,
    );
    if (
      workers.has(previous.worker.versionId) &&
      webs.has(previous.web.versionId) &&
      (previous.worker.versionId !== activation.worker.versionId ||
        previous.web.versionId !== activation.web.versionId)
    )
      pairs.push(stored);
    else if (
      workers.size === 1 &&
      previous.worker.versionId !== activation.worker.versionId &&
      previous.projectionSha256 === activation.projectionSha256 &&
      releaseActivationCanonical(previous.releasedFeatures) ===
        releaseActivationCanonical(activation.releasedFeatures) &&
      previous.issuedAt >= predecessorIssuedAt
    ) {
      predecessor = stored;
      predecessorIssuedAt = previous.issuedAt;
    }
  }
  // A Web update must not retire the signed pair of a Room still on the
  // preceding Worker. Keep one pair with the same public feature authority.
  // A later distinct Core activation replaces this retained generation.
  if (predecessor) pairs.push(predecessor);
  if (pairs.length >= 4)
    return json({ error: "Release pair capacity is full." }, 409);
  const value: PairRegistry = {
    schemaVersion: 1,
    headDigest: digest,
    pairs: [...pairs, { canonical, signature, digest }],
    nonces: [
      ...nonces,
      { nonce: activation.nonce, until: activation.expiresAt },
    ],
  };
  admission(activation);
  // Keep each signed proposal immutable, including a proposal refused by CAS.
  // The registry and public readback determine whether it was applied.
  const audit = await activationStep("proposal-store", () =>
    bucket.put(
      `release-control/proposals/${digest}.json`,
      JSON.stringify({ canonical, signature, digest }),
      {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: "application/json" },
      },
    ),
  );
  if (!audit) return json({ error: "Release activation was refused." }, 409);
  admission(activation);
  const written = await activationStep("registry-store", () =>
    bucket.put(RELEASE_PAIR_REGISTRY_KEY, JSON.stringify(value), {
      onlyIf: current
        ? { etagMatches: current.etag }
        : { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    }),
  );
  if (!written) return json({ error: "Release activation changed." }, 409);
  return json({ ok: true, activationDigest: digest }, 201);
}
function stub(env: ReleaseActivationEnv) {
  if (!env.AUTH_RECORDS) throw refusal();
  return env.AUTH_RECORDS.get(
    env.AUTH_RECORDS.idFromName(RELEASE_ACTIVATION_OBJECT),
  );
}
async function boundedBody(
  request: Request | Response,
  maxBytes = RELEASE_ACTIVATION_MAX_BYTES,
) {
  if (
    Number(request.headers.get("Content-Length") ?? 0) > maxBytes ||
    !request.body
  )
    throw refusal();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw refusal();
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}
export async function releaseActivationRoute(
  request: Request,
  env: ReleaseActivationEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (
    ![RELEASE_ACTIVATION_PATH, RELEASE_AVAILABILITY_PATH].includes(url.pathname)
  )
    return null;
  if (
    url.search ||
    env.APP_ORIGIN !== "https://usetempl.com" ||
    url.origin !== "https://community.usetempl.com"
  )
    return json({ error: "Not found." }, 404);
  if (url.pathname === RELEASE_AVAILABILITY_PATH) {
    if (request.method !== "GET")
      return json({ error: "Method not allowed." }, 405);
    const version =
      request.headers.get(RELEASE_WEB_VERSION_HEADER) ?? undefined;
    if (version && !VERSION.test(version))
      return json(inactiveReleaseAvailability());
    try {
      return json(await releaseAvailability(env, version, true));
    } catch (error) {
      return confirmedRefusal(error)
        ? json(inactiveReleaseAvailability())
        : json({ error: "Release activation is unavailable." }, 503);
    }
  }
  if (request.method === "GET") {
    try {
      if (env.MEDIA_BUCKET)
        return json({
          schemaVersion: 1,
          environment: "production",
          activationDigest: (await registry(env))?.value.headDigest ?? null,
        });
      return await stub(env).fetch(
        new Request(`https://internal${RELEASE_ACTIVATION_METADATA_PRIVATE}`, {
          method: "POST",
          body: "{}",
        }),
      );
    } catch {
      return json(
        { error: "Release activation metadata is unavailable." },
        503,
      );
    }
  }
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405);
  try {
    if (
      request.headers.get("Content-Type") !== "application/json" ||
      !enabled(env)
    )
      throw refusal();
    const canonical = await boundedBody(request);
    const signature = request.headers.get(RELEASE_ACTIVATION_SIGNATURE) ?? "";
    const activation = await signedActivation(canonical, signature, env);
    admission(activation);
    await servingPair(env, activation);
    admission(activation);
    if (env.MEDIA_BUCKET)
      return await applyPair(env, canonical, signature, activation);
    return await stub(env).fetch(
      new Request(`https://internal${RELEASE_ACTIVATION_APPLY_PRIVATE}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [RELEASE_ACTIVATION_SIGNATURE]: signature,
        },
        body: canonical,
      }),
    );
  } catch (error) {
    const response = json(
      { error: "Release activation was refused." },
      error instanceof HttpError ? error.status : 403,
    );
    if (error instanceof ActivationStepFailure)
      response.headers.set("X-Templ-Release-Stage", error.step);
    return response;
  }
}
export async function releaseActivationRecordRequest(
  request: Request,
  state: Pick<DurableObjectState, "storage">,
  env: ReleaseActivationEnv,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (
    ![
      RELEASE_ACTIVATION_APPLY_PRIVATE,
      RELEASE_ACTIVATION_READ_PRIVATE,
      RELEASE_ACTIVATION_METADATA_PRIVATE,
    ].includes(path)
  )
    return null;
  if (request.method !== "POST")
    return json({ error: "Method not allowed." }, 405);
  if (path === RELEASE_ACTIVATION_METADATA_PRIVATE) {
    try {
      const stored = await state.storage.get<StoredActivation>(KEY);
      if (
        stored &&
        (!/^[0-9a-f]{64}$/.test(stored.digest) ||
          typeof stored.canonical !== "string" ||
          (await sha256Hex(stored.canonical)) !== stored.digest)
      )
        throw refusal();
      return json({
        schemaVersion: 1,
        environment: "production",
        activationDigest: stored?.digest ?? null,
      } satisfies ReleaseActivationMetadata);
    } catch {
      return json(
        { error: "Release activation metadata is unavailable." },
        503,
      );
    }
  }
  if (path === RELEASE_ACTIVATION_READ_PRIVATE) {
    try {
      if (!enabled(env)) return json(inactiveReleaseAvailability());
      const stored = await state.storage.get<StoredActivation>(KEY);
      if (!stored) return json(inactiveReleaseAvailability());
      const activation = await signedActivation(
        stored.canonical,
        stored.signature,
        env,
      );
      if ((await sha256Hex(stored.canonical)) !== stored.digest)
        throw refusal();
      // Older entry Workers still validate their own exact identity after this
      // private read. The storage object may already run the next version.
      await servingPair(env, activation, false, true);
      const current = await state.storage.get<StoredActivation>(KEY);
      if (current?.digest !== stored.digest) throw readUnavailable();
      if (!enabled(env)) return json(inactiveReleaseAvailability());
      return json({
        schemaVersion: 1,
        environment: "production",
        active: true,
        activationDigest: stored.digest,
        publicRelease: activation.publicRelease,
        releasedFeatures: activation.releasedFeatures,
        worker: activation.worker,
        web: activation.web,
      } satisfies ReleaseAvailability);
    } catch (error) {
      return confirmedRefusal(error)
        ? json(inactiveReleaseAvailability())
        : json({ error: "Release activation is unavailable." }, 503);
    }
  }
  try {
    const canonical = await boundedBody(request);
    const signature = request.headers.get(RELEASE_ACTIVATION_SIGNATURE) ?? "";
    const activation = await signedActivation(canonical, signature, env);
    admission(activation);
    await servingPair(env, activation);
    const digest = await sha256Hex(canonical);
    return await state.storage.transaction(async (storage) => {
      admission(activation);
      if (
        !enabled(env) ||
        !sameIdentity(workerIdentity(env), activation.worker)
      )
        throw refusal();
      const current = await storage.get<StoredActivation>(KEY);
      if ((current?.digest ?? null) !== activation.previousDigest)
        return json({ error: "Release activation changed." }, 409);
      const now = Date.now();
      const nonces = storedNonces(await storage.get(NONCES)).filter(
        (entry) => entry.until > now,
      );
      if (nonces.some((entry) => entry.nonce === activation.nonce))
        return json({ error: "Release activation was refused." }, 409);
      if (nonces.length >= 128)
        return json({ error: "Release activation was refused." }, 429);
      const sequence = storedSequence(await storage.get(AUDIT_SEQUENCE)) + 1;
      const audit: Audit = {
        at: now,
        digest,
        previousDigest: activation.previousDigest,
        mainCommit: activation.mainCommit,
        mainCiRunId: activation.mainCiRunId,
        workerVersion: activation.worker.versionId,
        webVersion: activation.web.versionId,
      };
      const page = await storage.list<Audit>({
        prefix: AUDIT_PREFIX,
        limit: 50,
      });
      for (const [name, entry] of page)
        if (
          entry.at <= now - ACCESS_AUDIT_RETENTION.ms ||
          Number(name.slice(AUDIT_PREFIX.length)) <=
            sequence - ACCESS_AUDIT_RETENTION.count
        )
          await storage.delete(name);
      admission(activation);
      if (
        !enabled(env) ||
        !sameIdentity(workerIdentity(env), activation.worker)
      )
        throw refusal();
      await storage.put({
        [KEY]: { canonical, signature, digest } satisfies StoredActivation,
        [NONCES]: [
          ...nonces,
          { nonce: activation.nonce, until: activation.expiresAt },
        ],
        [AUDIT_SEQUENCE]: sequence,
        [`${AUDIT_PREFIX}${String(sequence).padStart(16, "0")}`]: audit,
      });
      return json({ ok: true, activationDigest: digest }, 201);
    });
  } catch (error) {
    return json(
      { error: "Release activation was refused." },
      error instanceof HttpError ? error.status : 403,
    );
  }
}
async function releaseAvailability(
  env: ReleaseActivationEnv,
  webVersion?: string,
  checkWeb = false,
): Promise<ReleaseAvailability> {
  if (!enabled(env)) return inactiveReleaseAvailability();
  if (webVersion && !VERSION.test(webVersion))
    return inactiveReleaseAvailability();
  const pair = await pairAvailability(env, webVersion, checkWeb);
  if (pair) return pair;
  const response = await stub(env).fetch(
    new Request(`https://internal${RELEASE_ACTIVATION_READ_PRIVATE}`, {
      method: "POST",
      body: "{}",
    }),
  );
  if (response.status === 429 || response.status >= 500)
    throw readUnavailable();
  if (!response.ok) return inactiveReleaseAvailability();
  const value = readAvailability(await response.json());
  if (
    value.active &&
    value.worker &&
    !sameIdentity(
      workerIdentity(env),
      readServingReleaseIdentity(value.worker, "community"),
    )
  )
    return inactiveReleaseAvailability();
  return value;
}
export async function readReleaseAvailability(
  env: ReleaseActivationEnv,
  webVersion?: string,
  checkWeb = false,
): Promise<ReleaseAvailability> {
  try {
    return await releaseAvailability(env, webVersion, checkWeb);
  } catch {
    return inactiveReleaseAvailability();
  }
}
/** A request owns this value. It never changes shared Worker or room bindings. */
export async function releaseActivationEnv<T extends ReleaseActivationEnv>(
  env: T,
): Promise<T> {
  if (
    env.APP_ORIGIN !== "https://usetempl.com" ||
    (env as ScopedEnv)[ACTIVE_RELEASE]
  )
    return env;
  try {
    return Object.assign({}, env, {
      [ACTIVE_RELEASE]: await releaseAvailability(env),
    });
  } catch (error) {
    return Object.assign({}, env, {
      [ACTIVE_RELEASE]: inactiveReleaseAvailability(),
      [ACTIVATION_READ_UNKNOWN]: !confirmedRefusal(error),
    });
  }
}
export function releaseActivationReadUnknown(env: ReleaseActivationEnv): boolean {
  return (env as ScopedEnv)[ACTIVATION_READ_UNKNOWN] === true;
}
function activatedAvailability(
  env: ReleaseActivationEnv,
): ReleaseAvailability | undefined {
  try {
    const value = (env as ScopedEnv)[ACTIVE_RELEASE];
    return value?.active &&
      enabled(env) &&
      value.worker &&
      sameIdentity(workerIdentity(env), value.worker)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
export function activatedReleasedFeatures(
  env: ReleaseActivationEnv,
): readonly string[] {
  return activatedAvailability(env)?.releasedFeatures ?? [];
}
/** Standard team links share the proved workflow and its serving identity. */
export function activatedReleaseFlag(
  env: ReleaseActivationEnv,
  flag: "supportWorkflowVerified" | "selfServeSupportOnboardingVerified" | "trialAiPracticeVerified",
): boolean {
  return activatedAvailability(env)?.publicRelease?.[flag] === true;
}
