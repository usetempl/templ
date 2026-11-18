/** The encrypted current authority lives outside the native room's backup.
 * A retained native digest prevents an old authority backup from granting
 * devices that were subsequently revoked. There is no empty-state fallback. */
import {
  base64url,
  decoded,
  EncryptionProtocolError,
  integer,
  object,
  OWN_SUPPORT_ENDPOINT,
  ownAuthorityCheckpointBytes,
  ownNativeDeviceRevocationBytes,
  utf8,
  type OwnSupportEncryptionProfile,
} from "@templ/e2ee/protocol";
import { sha256, verifyEncryptionProfile } from "@templ/e2ee/verify";
import type { OwnAuthorityStorage } from "@templ/e2ee/own-authority";
import {
  restoreCustomerKeyVault,
  type CustomerKeyBackup,
} from "@templ/e2ee/backup";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 16_384;
const ORDINARY_ENTRIES = 8_192;
const ORDINARY_BYTES = 768 * 1024;
export const AUTHORITY_OBJECT = "own-authority/current-v1";
export type NativeCheckpoint = {
  permissionRevision: number;
  deletionRevision: number;
  authority: { revision: number; digest: string } | null;
  at: number;
};
export interface NativeAuthorityControl {
  read(): Promise<NativeCheckpoint>;
  advance(value: {
    revision: number;
    digest: string;
    signature: string;
  }): Promise<unknown>;
  revokeDevice(value: {
    device: string;
    at: number;
    signature: string;
  }): Promise<unknown>;
}
export interface AuthorityObjectStore {
  read(): Promise<{ etag: string; bytes: Uint8Array } | null>;
  /** Return null when another writer changed the current object. */
  replace(bytes: Uint8Array, etag: string | null): Promise<string | null>;
}
export function r2AuthorityStore(
  bucket: R2Bucket,
  timing = {
    now: () => Date.now(),
    wait: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
): AuthorityObjectStore {
  let nextWriteAt = 0;
  return {
    async read() {
      const result = await bucket.get(AUTHORITY_OBJECT);
      if (!result) return null;
      if (result.size > MAX_BYTES) throw new EncryptionProtocolError();
      nextWriteAt = Math.max(nextWriteAt, result.uploaded.getTime() + 1_100);
      return {
        etag: result.etag,
        bytes: new Uint8Array(await result.arrayBuffer()),
      };
    },
    async replace(bytes, etag) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const delay = nextWriteAt - timing.now();
        if (delay > 2_500) refuse();
        if (delay > 0) await timing.wait(delay);
        nextWriteAt = timing.now() + 1_100;
        try {
          const result = await bucket.put(AUTHORITY_OBJECT, bytes, {
            onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
            httpMetadata: {
              contentType: "application/octet-stream",
              cacheControl: "no-store",
            },
          });
          return result?.etag ?? null;
        } catch (error) {
          // The provider documents 429/TooManyRequests for per-key write
          // pacing. Retry only that transient condition, with the same CAS.
          const failure = error as {
            status?: number;
            code?: string;
            message?: string;
          };
          if (
            attempt === 3 ||
            !(
              failure.status === 429 ||
              failure.code === "TooManyRequests" ||
              /(?:\b429\b|\bTooManyRequests\b)/.test(failure.message ?? "")
            )
          )
            throw error;
        }
      }
      return null;
    },
  };
}
type AuthorityState = { v: 1; revision: number; entries: [string, unknown][] };
type SealedState = {
  v: 1;
  revision: number;
  nonce: string;
  ciphertext: string;
};
export type AuthoritySnapshot = {
  etag: string;
  digest: string;
  revision: number;
  entries: Map<string, unknown>;
  native: NativeCheckpoint;
};
function refuse(): never {
  throw new EncryptionProtocolError("encryption-scope-changed");
}
function aad(profile: OwnSupportEncryptionProfile, revision: number) {
  return utf8(
    JSON.stringify([
      "templ:own-support:authority-v1",
      profile.environment,
      profile.workspace,
      profile.serviceOrigin,
      profile.rootKey,
      revision,
    ]),
  );
}
function checkKey(key: CryptoKey) {
  if (
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256
  )
    refuse();
}
async function seal(
  profile: OwnSupportEncryptionProfile,
  key: CryptoKey,
  state: AuthorityState,
  control = false,
) {
  checkKey(key);
  if (state.entries.length > MAX_ENTRIES) refuse();
  const bytes = utf8(JSON.stringify(state));
  try {
    // Leave space for base64 and the envelope; never retain a partial object.
    if (bytes.length > MAX_BYTES * 0.7) refuse();
    if (
      !control &&
      (state.entries.length > ORDINARY_ENTRIES || bytes.length > ORDINARY_BYTES)
    )
      refuse();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: aad(profile, state.revision),
      },
      key,
      bytes,
    );
    return utf8(
      JSON.stringify({
        v: 1,
        revision: state.revision,
        nonce: base64url(nonce),
        ciphertext: base64url(new Uint8Array(ciphertext)),
      }),
    );
  } finally {
    bytes.fill(0);
  }
}
async function unseal(
  profile: OwnSupportEncryptionProfile,
  key: CryptoKey,
  bytes: Uint8Array,
) {
  checkKey(key);
  if (bytes.length > MAX_BYTES) refuse();
  const envelope = object(JSON.parse(new TextDecoder().decode(bytes)), [
    "v",
    "revision",
    "nonce",
    "ciphertext",
  ]) as SealedState;
  if (envelope.v !== 1) refuse();
  const revision = integer(envelope.revision, 0);
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decoded(envelope.nonce, 12),
          additionalData: aad(profile, revision),
        },
        key,
        decoded(envelope.ciphertext, 17, MAX_BYTES),
      ),
    );
    const state = object(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)),
      ["v", "revision", "entries"],
    ) as AuthorityState;
    if (
      state.v !== 1 ||
      state.revision !== revision ||
      !Array.isArray(state.entries) ||
      state.entries.length > MAX_ENTRIES ||
      state.entries.some(
        (entry) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          entry[0].length > 256 ||
          !entry[0],
      )
    )
      refuse();
    const entries = new Map(state.entries);
    if (entries.size !== state.entries.length) refuse();
    return { revision, entries };
  } catch {
    return refuse();
  } finally {
    plaintext?.fill(0);
  }
}
function checkpoint(value: NativeCheckpoint, now: number): NativeCheckpoint {
  const raw = object(value, [
    "permissionRevision",
    "deletionRevision",
    "authority",
    "at",
  ]);
  integer(raw.permissionRevision, 0);
  integer(raw.deletionRevision, 0);
  const at = integer(raw.at, 0);
  if (at > now || now - at > 60_000) refuse();
  if (raw.authority !== null) {
    const anchor = object(raw.authority, ["revision", "digest"]);
    integer(anchor.revision, 0);
    if (
      typeof anchor.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(anchor.digest)
    )
      refuse();
  }
  return value;
}

/** Read current complete denial state before restoring keys or approving
 * anything. One unacknowledged durable write can be reconciled; an older
 * object, missing object, bad digest or skipped generation cannot. */
export async function readAuthoritySnapshot(input: {
  profile: OwnSupportEncryptionProfile;
  wrappingKey: CryptoKey;
  store: AuthorityObjectStore;
  native: NativeAuthorityControl;
  now?: number;
}): Promise<AuthoritySnapshot> {
  await verifyEncryptionProfile(input.profile, input.profile.rootKey);
  if (
    input.profile.custody !== "templ-own-support" ||
    input.profile.workspace !== OWN_SUPPORT_ENDPOINT.workspace
  )
    refuse();
  const stored = await input.store.read();
  if (!stored) return refuse();
  const state = await unseal(input.profile, input.wrappingKey, stored.bytes);
  const native = checkpoint(await input.native.read(), input.now ?? Date.now());
  const digest = await sha256(stored.bytes),
    anchor = native.authority;
  if (
    (!anchor && state.revision !== 0) ||
    (anchor &&
      (state.revision < anchor.revision ||
        state.revision > anchor.revision + 1 ||
        (state.revision === anchor.revision && digest !== anchor.digest)))
  )
    refuse();
  return { ...state, etag: stored.etag, digest, native };
}

/** The backup restores keys only. Its old device permissions are never used:
 * the complete current authority and native deletion/access checkpoints must
 * be readable before the private keys are returned to this endpoint. */
export async function restoreOwnVault(input: {
  profile: OwnSupportEncryptionProfile;
  backup: CustomerKeyBackup;
  backupWrappingKey: CryptoKey;
  authorityWrappingKey: CryptoKey;
  store: AuthorityObjectStore;
  native: NativeAuthorityControl;
}) {
  if (
    input.backup.publicKeys.rootKey !== input.profile.rootKey ||
    input.backup.publicKeys.validationKey !== input.profile.validationKey ||
    input.backup.publicKeys.recoveryKey !== input.profile.recoveryKey
  )
    refuse();
  const current = await readAuthoritySnapshot({
    ...input,
    wrappingKey: input.authorityWrappingKey,
  });
  const anchored = current.native.authority?.digest === current.digest &&
    current.native.authority.revision === current.revision;
  const matches = (checked: AuthoritySnapshot, expected: {
    customerRevocationRevision: number;
    permissionRevision: number;
    deletionRevision: number;
  }) =>
    checked.digest === current.digest &&
    checked.revision === expected.customerRevocationRevision &&
    checked.native.permissionRevision === expected.permissionRevision &&
    checked.native.deletionRevision === expected.deletionRevision;
  const expected = {
    permissionRevision: current.native.permissionRevision,
    deletionRevision: current.native.deletionRevision,
    customerRevocationRevision: current.revision,
    at: current.native.at,
  };
  const keys = await restoreCustomerKeyVault({
    backup: input.backup,
    ...OWN_SUPPORT_ENDPOINT,
    wrappingKey: input.backupWrappingKey,
    currentCheckpoint: async () => expected,
    reconcile: async (_from, to) => {
      // The authenticated R2 journal already agrees with a fresh independent
      // native anchor. Re-read a pending generation before repairing its anchor.
      const checked = anchored ? current : await readAuthoritySnapshot({
        ...input,
        wrappingKey: input.authorityWrappingKey,
      });
      return matches(checked, to);
    },
  });
  const journal = new OwnAuthorityJournal({
    profile: input.profile,
    wrappingKey: input.authorityWrappingKey,
    rootSigningKey: keys.root.privateKey,
    store: input.store,
    native: input.native,
  });
  const snapshot = await journal.read();
  // Keep the second independent check after unwrapping. No private keys
  // leave this boundary if any authority revision changes during the restore.
  if (!matches(snapshot, expected)) refuse();
  return { keys, journal, snapshot };
}

async function signature(key: CryptoKey, bytes: Uint8Array) {
  return base64url(
    new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, bytes),
    ),
  );
}
export class OwnAuthorityJournal {
  constructor(
    private options: {
      profile: OwnSupportEncryptionProfile;
      wrappingKey: CryptoKey;
      rootSigningKey: CryptoKey;
      store: AuthorityObjectStore;
      native: NativeAuthorityControl;
    },
  ) {}
  /** Explicit provisioning only; the request handler never calls this. */
  async initialize() {
    const profile = await verifyEncryptionProfile(
      this.options.profile,
      this.options.profile.rootKey,
    );
    if (profile.custody !== "templ-own-support") refuse();
    const current = checkpoint(await this.options.native.read(), Date.now());
    if (current.authority || (await this.options.store.read())) refuse();
    const bytes = await seal(this.options.profile, this.options.wrappingKey, {
      v: 1,
      revision: 0,
      entries: [],
    });
    if (!(await this.options.store.replace(bytes, null))) refuse();
    await this.anchor({ revision: 0, digest: await sha256(bytes) });
  }
  private async anchor(state: { revision: number; digest: string }) {
    const { profile, rootSigningKey, native } = this.options;
    const signatureValue = await signature(
      rootSigningKey,
      ownAuthorityCheckpointBytes(
        profile.rootKey,
        state.revision,
        state.digest,
      ),
    );
    const result = object(
      await native.advance({
        revision: state.revision,
        digest: state.digest,
        signature: signatureValue,
      }),
      ["revision", "digest"],
    );
    if (result.revision !== state.revision || result.digest !== state.digest)
      refuse();
  }
  async read() {
    const current = await readAuthoritySnapshot(this.options);
    if (current.native.authority?.revision === current.revision) return current;
    await this.anchor(current);
    const anchored = await readAuthoritySnapshot(this.options);
    if (anchored.digest !== current.digest || anchored.native.authority?.revision !== anchored.revision) refuse();
    return anchored;
  }
  async transact<T>(
    action: (storage: OwnAuthorityStorage) => Promise<T>,
    control: boolean | ((storage: Pick<OwnAuthorityStorage, "get">) => Promise<boolean>) = false,
    readOnly = false,
    /** Only the checked starting state from this same request. The commit
     * still compares the ETag and the final fence always reads fresh state. */
    startingSnapshot?: AuthoritySnapshot,
  ): Promise<T> {
    const current = startingSnapshot ?? await this.read(),
      entries = structuredClone(current.entries);
    let changed = false,
      actionChanged = false;
    const now = Date.now();
    checkpoint(current.native, now);
    // Read-only operations never create expiry-maintenance writers.
    // Mutating operations still compact before applying their capacity limits.
    for (const [key, raw] of readOnly ? [] : entries) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      const expiredChallenge =
        /^challenge:[a-f0-9]{64}$/.test(key) &&
        value.v === 1 &&
        Number.isSafeInteger(value.expiresAt) &&
        Number(value.expiresAt) <= now;
      const expiredRate =
        /^enroll-rate:[a-f0-9]{64}$/.test(key) &&
        Number.isSafeInteger(value.bucket) &&
        Number(value.bucket) < Math.floor(now / 60_000);
      const expiredCertificate =
        /^certificate:[a-f0-9]{64}:tc-[a-f0-9]{32}:[1-9][0-9]{0,7}$/.test(key) &&
        value.v === 1 && Number.isSafeInteger(value.expiresAt) && Number(value.expiresAt) <= now;
      if (expiredChallenge || expiredRate || expiredCertificate) {
        entries.delete(key);
        changed = true;
      }
    }
    const storage: OwnAuthorityStorage = {
      async get<T>(key: string) {
        return structuredClone(entries.get(key)) as T | undefined;
      },
      async put(key, value) {
        if (readOnly) refuse();
        entries.set(key, structuredClone(value));
        changed = actionChanged = true;
      },
      async delete(key) {
        if (readOnly) refuse();
        const removed = entries.delete(key);
        changed ||= removed;
        actionChanged ||= removed;
        return removed;
      },
    };
    // Classify headroom against the same checked journal generation that the
    // operation will use and conditionally commit.
    const controlCapacity = typeof control === "function" ? await control(storage) : control;
    const result = await action(storage);
    if (!changed) {
      // A concurrent durable denial also invalidates a read-only key grant.
      const latest = await this.read();
      if (
        latest.digest !== current.digest ||
        latest.native.permissionRevision !==
          current.native.permissionRevision ||
        latest.native.deletionRevision !== current.native.deletionRevision
      )
        refuse();
      return result;
    }
    const revision = integer(current.revision + 1, 0);
    // Pure expiry collection only shrinks authenticated metadata. It retains
    // hard-cap eligibility, even when a readonly operation triggered cleanup.
    const bytes = await seal(
      this.options.profile,
      this.options.wrappingKey,
      { v: 1, revision, entries: [...entries] },
      controlCapacity || !actionChanged,
    );
    // A failed compare-and-swap discards the result, including certificates.
    if (!(await this.options.store.replace(bytes, current.etag))) refuse();
    // A lost acknowledgment leaves durable state for the next read to finish.
    // It must never cause the committed denial to be rolled back locally.
    await this.anchor({ revision, digest: await sha256(bytes) });
    const latest = await this.read();
    if (
      latest.revision !== revision ||
      latest.digest !== (await sha256(bytes)) ||
      latest.native.permissionRevision !== current.native.permissionRevision ||
      latest.native.deletionRevision !== current.native.deletionRevision
    )
      refuse();
    return result;
  }
  async flushRevocations(checked?: AuthoritySnapshot): Promise<AuthoritySnapshot> {
    const snapshot = checked ?? await this.read();
    const pendingEntries = [...snapshot.entries].filter(([key]) =>
      key.startsWith("revocation-pending:"),
    );
    const delivered: string[] = [];
    for (const [key, raw] of pendingEntries.slice(0, 4)) {
      const pending = object(raw, ["v", "device", "requestedAt"]);
      if (
        pending.v !== 1 ||
        typeof pending.device !== "string" ||
        key !== `revocation-pending:${pending.device}`
      )
        refuse();
      integer(pending.requestedAt, 0);
      const device = pending.device,
        at = Date.now();
      const signed = await signature(
        this.options.rootSigningKey,
        ownNativeDeviceRevocationBytes(this.options.profile, device, at),
      );
      const result = object(
        await this.options.native.revokeDevice({
          device,
          at,
          signature: signed,
        }),
        ["revoked"],
      );
      if (result.revoked !== true) refuse();
      // Native replay is idempotent when its acknowledgment was lost.
      delivered.push(key);
    }
    if (delivered.length)
      await this.transact(async (storage) => {
        for (const key of delivered) await storage.delete(key);
      }, true);
    // A bounded request drains four entries. Remaining denials stay durable
    // and prevent approval until a later request finishes publication.
    if (pendingEntries.length > delivered.length) refuse();
    if (!delivered.length) return snapshot;
    const latest = await this.read();
    if ([...latest.entries.keys()].some(key => key.startsWith("revocation-pending:"))) refuse();
    return latest;
  }
}
