/** Public-key-only control plane for Own's independent endpoint authority. */
import {
  OWN_SUPPORT_ENDPOINT,
  EncryptionProtocolError,
  object,
  opaqueId,
  ownAuthorityCheckpointBytes,
  ownNativeDeviceRevocationBytes,
} from "@templ/e2ee/protocol";
import { verifySignature } from "@templ/e2ee/verify";

type Storage = Pick<DurableObjectTransaction, "get" | "put">;
export const OWN_DEVICE_REVOKED = "support-encryption-own-device-revoked-v1:";
export const OWN_AUTHORITY_CHECKPOINT =
  "support-encryption-own-authority-checkpoint-v1";
export type OwnAuthorityCheckpoint = { revision: number; digest: string };
export async function revokeOwnDevice(
  storage: Storage,
  root: string,
  value: unknown,
  now = Date.now(),
) {
  const body = object(value, ["device", "at", "signature"]);
  const device = opaqueId(body.device);
  if (
    typeof body.at !== "number" ||
    !Number.isSafeInteger(body.at) ||
    body.at < 0 ||
    !(await verifySignature(
      root,
      String(body.signature),
      ownNativeDeviceRevocationBytes(
        { ...OWN_SUPPORT_ENDPOINT, rootKey: root },
        device,
        body.at,
      ),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const key = OWN_DEVICE_REVOKED + device;
  if (!(await storage.get(key))) {
    if (Math.abs(now - body.at) > 5 * 60_000)
      throw new EncryptionProtocolError("encryption-scope-changed");
    await storage.put(key, true);
  }
  return { revoked: true as const };
}
export async function advanceOwnAuthority(
  storage: Storage,
  root: string,
  value: unknown,
) {
  const body = object(value, ["revision", "digest", "signature"]);
  const revision = body.revision as number,
    digest = body.digest as string;
  if (
    !(await verifySignature(
      root,
      String(body.signature),
      ownAuthorityCheckpointBytes(root, revision, digest),
    ))
  )
    throw new EncryptionProtocolError("encryption-integrity");
  const current = await storage.get<OwnAuthorityCheckpoint>(
    OWN_AUTHORITY_CHECKPOINT,
  );
  if (
    (!current && revision !== 0) ||
    (current &&
      !(
        (revision === current.revision && digest === current.digest) ||
        revision === current.revision + 1
      ))
  )
    throw new EncryptionProtocolError("encryption-scope-changed");
  await storage.put(OWN_AUTHORITY_CHECKPOINT, { revision, digest });
  return { revision, digest };
}
