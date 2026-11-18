/** Customer-only bootstrap/restore. The wrapping key is supplied by the
 * customer's independent backup system and is never sent to Templ. */
import {
  base64url,
  decoded,
  EncryptionProtocolError,
  integer,
  object,
  opaqueId,
  utf8,
  type E2eeEnvironment,
} from "./protocol";
import { exportPublic } from "./endpoint-crypto";
import { sha256 } from "./verify";

export type CustomerKeyVault = {
  root: CryptoKeyPair;
  validation: CryptoKeyPair;
  recovery: CryptoKeyPair;
};
export type RecoveryCheckpoint = {
  permissionRevision: number;
  deletionRevision: number;
  customerRevocationRevision: number;
  at: number;
};
export type CustomerKeyBackup = {
  v: 1;
  workspace: string;
  environment: E2eeEnvironment;
  checkpoint: RecoveryCheckpoint;
  publicKeys: { rootKey: string; validationKey: string; recoveryKey: string };
  nonce: string;
  ciphertext: string;
};
function checkpoint(value: unknown): RecoveryCheckpoint {
  const raw = object(value, [
    "permissionRevision",
    "deletionRevision",
    "customerRevocationRevision",
    "at",
  ]);
  return {
    permissionRevision: integer(raw.permissionRevision, 0),
    deletionRevision: integer(raw.deletionRevision, 0),
    customerRevocationRevision: integer(raw.customerRevocationRevision, 0),
    at: integer(raw.at, 0),
  };
}
function backupAad(backup: Omit<CustomerKeyBackup, "nonce" | "ciphertext">) {
  return utf8(
    JSON.stringify([
      "templ:e2ee:customer-backup:v1",
      backup.v,
      backup.workspace,
      backup.environment,
      backup.checkpoint.permissionRevision,
      backup.checkpoint.deletionRevision,
      backup.checkpoint.customerRevocationRevision,
      backup.checkpoint.at,
      backup.publicKeys.rootKey,
      backup.publicKeys.validationKey,
      backup.publicKeys.recoveryKey,
    ]),
  );
}
function assertWrappingKey(key: CryptoKey) {
  if (
    key.type !== "secret" ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256
  )
    throw new EncryptionProtocolError("customer-custody-required");
}
async function runtimePair(
  pkcs8: Uint8Array,
  rawPublic: string,
  encryption: boolean,
): Promise<CryptoKeyPair> {
  const algorithm = {
    name: encryption ? "ECDH" : "ECDSA",
    namedCurve: "P-256",
  };
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    algorithm,
    false,
    encryption ? ["deriveBits"] : ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    decoded(rawPublic, 65),
    algorithm,
    true,
    encryption ? [] : ["verify"],
  );
  return { privateKey, publicKey };
}

export async function createCustomerKeyVault(input: {
  workspace: string;
  environment: E2eeEnvironment;
  wrappingKey: CryptoKey;
  checkpoint: RecoveryCheckpoint;
}): Promise<{ keys: CustomerKeyVault; backup: CustomerKeyBackup }> {
  opaqueId(input.workspace);
  assertWrappingKey(input.wrappingKey);
  if (!["production", "staging", "local"].includes(input.environment))
    throw new EncryptionProtocolError();
  const state = checkpoint(input.checkpoint);
  const [root, validation, recovery] = await Promise.all([
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]),
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]),
    crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]),
  ]);
  const publicKeys = {
    rootKey: await exportPublic(root.publicKey),
    validationKey: await exportPublic(validation.publicKey),
    recoveryKey: await exportPublic(recovery.publicKey),
  };
  const privateBytes = await Promise.all(
    [root, validation, recovery].map(
      async (pair) =>
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    ),
  );
  let plaintext: Uint8Array | undefined;
  try {
    plaintext = utf8(
      JSON.stringify([
        "templ:e2ee:customer-private-keys:v1",
        ...privateBytes.map(base64url),
      ]),
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const meta = {
      v: 1 as const,
      workspace: input.workspace,
      environment: input.environment,
      checkpoint: state,
      publicKeys,
    };
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: nonce,
          additionalData: backupAad(meta),
          tagLength: 128,
        },
        input.wrappingKey,
        plaintext,
      ),
    );
    const keys = {
      root: await runtimePair(privateBytes[0], publicKeys.rootKey, false),
      validation: await runtimePair(
        privateBytes[1],
        publicKeys.validationKey,
        false,
      ),
      recovery: await runtimePair(
        privateBytes[2],
        publicKeys.recoveryKey,
        true,
      ),
    };
    return {
      keys,
      backup: {
        ...meta,
        nonce: base64url(nonce),
        ciphertext: base64url(ciphertext),
      },
    };
  } finally {
    plaintext?.fill(0);
    for (const bytes of privateBytes) bytes.fill(0);
  }
}

export async function restoreCustomerKeyVault(input: {
  backup: CustomerKeyBackup;
  workspace: string;
  environment: E2eeEnvironment;
  wrappingKey: CryptoKey;
  /** Reads authoritative current native access/deletions AND the customer's
   * own revocations. An unavailable source must refuse recovery. */
  currentCheckpoint: () => Promise<RecoveryCheckpoint>;
  /** Replays every change since the backup before any key can be issued. */
  reconcile: (
    from: RecoveryCheckpoint,
    to: RecoveryCheckpoint,
  ) => Promise<boolean>;
  now?: number;
}): Promise<CustomerKeyVault> {
  assertWrappingKey(input.wrappingKey);
  const backup = object(input.backup, [
    "v",
    "workspace",
    "environment",
    "checkpoint",
    "publicKeys",
    "nonce",
    "ciphertext",
  ]) as CustomerKeyBackup;
  if (
    backup.v !== 1 ||
    backup.workspace !== input.workspace ||
    backup.environment !== input.environment
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const from = checkpoint(backup.checkpoint),
    to = checkpoint(await input.currentCheckpoint()),
    now = input.now ?? Date.now();
  if (
    to.at > now ||
    now - to.at > 60_000 ||
    to.at < from.at ||
    to.permissionRevision < from.permissionRevision ||
    to.deletionRevision < from.deletionRevision ||
    to.customerRevocationRevision < from.customerRevocationRevision ||
    !(await input.reconcile(from, to))
  )
    throw new EncryptionProtocolError("encryption-scope-changed");
  const publicKeys = object(backup.publicKeys, [
    "rootKey",
    "validationKey",
    "recoveryKey",
  ]);
  for (const key of Object.values(publicKeys)) decoded(key, 65);
  let plaintext: Uint8Array | undefined;
  const bytes: Uint8Array[] = [];
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decoded(backup.nonce, 12),
          additionalData: backupAad(backup),
          tagLength: 128,
        },
        input.wrappingKey,
        decoded(backup.ciphertext, 17, 4096),
      ),
    );
    const content = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
    );
    if (
      !Array.isArray(content) ||
      content.length !== 4 ||
      content[0] !== "templ:e2ee:customer-private-keys:v1"
    )
      throw new Error();
    bytes.push(
      ...content.slice(1).map((value: unknown) => decoded(value, 100, 256)),
    );
    const keys = {
      root: await runtimePair(bytes[0], backup.publicKeys.rootKey, false),
      validation: await runtimePair(
        bytes[1],
        backup.publicKeys.validationKey,
        false,
      ),
      recovery: await runtimePair(
        bytes[2],
        backup.publicKeys.recoveryKey,
        true,
      ),
    };
    // Each restored private/public pair must match, not just parse.
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    for (const pair of [keys.root, keys.validation]) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        challenge,
      );
      if (
        !(await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          pair.publicKey,
          signature,
          challenge,
        ))
      )
        throw new Error();
    }
    const probe = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      false,
      ["deriveBits"],
    );
    const a = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: probe.publicKey },
        keys.recovery.privateKey,
        256,
      ),
    );
    const b = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: keys.recovery.publicKey },
        probe.privateKey,
        256,
      ),
    );
    try {
      if ((await sha256(a)) !== (await sha256(b))) throw new Error();
    } finally {
      a.fill(0);
      b.fill(0);
    }
    return keys;
  } catch {
    throw new EncryptionProtocolError("encryption-integrity");
  } finally {
    plaintext?.fill(0);
    for (const value of bytes) value.fill(0);
  }
}
