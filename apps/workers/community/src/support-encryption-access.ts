/** Native access checkpoints are public authority metadata, never key material.
 * Rotate them in the same transaction that removes access. A failed encrypted
 * request cannot roll back a committed removal or make a later grant reuse it. */
import type { ChatPrincipalId } from "@templ/chat/principal";

type Storage = Pick<DurableObjectTransaction, "get" | "put">;
export const ENCRYPTION_ACCESS_PREFIX = "support-encryption-access-v1:";
export const ENCRYPTION_ACCESS_REVISION = "support-encryption-access-revision-v1";
async function changed(storage: Storage) {
  const prior = await storage.get<number>(ENCRYPTION_ACCESS_REVISION) ?? 0;
  if (!Number.isSafeInteger(prior) || prior < 0 || prior >= Number.MAX_SAFE_INTEGER)
    throw new Error("Invalid encryption access revision");
  await storage.put(ENCRYPTION_ACCESS_REVISION, prior + 1);
}

async function generation(storage: Storage, key: string) {
  const saved = await storage.get<string>(key);
  if (saved !== undefined) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(saved))
      throw new Error("Invalid encryption access checkpoint");
    return saved;
  }
  const value = crypto.randomUUID();
  await storage.put(key, value);
  return value;
}

export async function revokeEncryptionPrincipal(
  storage: Storage,
  principal: string,
) {
  await changed(storage);
  await storage.put(
    `${ENCRYPTION_ACCESS_PREFIX}principal:${principal}`,
    crypto.randomUUID(),
  );
}
export async function revokeEncryptionRole(storage: Storage, role: string) {
  await changed(storage);
  await storage.put(
    `${ENCRYPTION_ACCESS_PREFIX}role:${role}`,
    crypto.randomUUID(),
  );
}
export async function revokeEncryptionForRestore(storage: Storage) {
  await changed(storage);
  await storage.put(`${ENCRYPTION_ACCESS_PREFIX}restore`, crypto.randomUUID());
}

export async function nativeEncryptionGrant(
  storage: Storage,
  input: {
    environment: string;
    workspace: string;
    principal: string;
    aliases: readonly ChatPrincipalId[];
    /** Native case member for member devices; never supplied by the client. */
    member?: string;
    /** Present only for a device whose staff authority comes from ownership. */
    manager?: string;
  },
): Promise<string> {
  const identities = [...new Set([input.principal, ...input.aliases])].sort();
  const principals = [];
  for (const principal of identities)
    principals.push([
      principal,
      await generation(
        storage,
        `${ENCRYPTION_ACCESS_PREFIX}principal:${principal}`,
      ),
    ]);
  const roles = new Set<string>();
  if (!input.member && !input.manager)
    for (const principal of identities)
      for (const role of (await storage.get<string[]>(`roles:${principal}`)) ??
        [])
        roles.add(role);
  const grants = [];
  for (const role of [...roles].sort())
    grants.push([
      role,
      await generation(storage, `${ENCRYPTION_ACCESS_PREFIX}role:${role}`),
    ]);
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "templ:e2ee:native-authorization:v1",
      input.environment,
      input.workspace,
      input.principal,
      input.member ?? null,
      input.manager ?? null,
      principals,
      grants,
      await generation(storage, `${ENCRYPTION_ACCESS_PREFIX}restore`),
    ]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
