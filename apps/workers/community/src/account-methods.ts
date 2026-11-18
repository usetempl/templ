import type { AccountMethods } from "@templ/chat/wallets";
import {
  accountIdentity,
  countWallets,
  type AccountIdentity,
} from "./account-identity";
import { json, readJson, type Env } from "./common";
import {
  linkedWalletsCall,
  readLinkedWallets,
  type LinkedSession,
} from "./linked-wallets";
import { principal } from "./principal";

/** The account's wallets as `GET /auth/account` reports them. The identity
 * object answers the `methods-read` op below; the wallet and Solana routes
 * return the same list after a change. */
type Storage = Pick<DurableObjectTransaction, "get" | "put" | "delete">;
const iso = (ms: number) => new Date(ms).toISOString();

/** `current` is the wallet that opened the session, EVM or Solana, if any. */
export async function accountMethods(
  storage: Storage,
  identity: AccountIdentity,
  current: unknown,
): Promise<AccountMethods> {
  const linked = await readLinkedWallets(storage, identity);
  const count = await countWallets(storage, identity);
  // The last wallet of either kind stays: it is the only way in.
  const another = count.wallets + count.solana > 1;
  const currentWallet =
    typeof current === "string" ? current.toLowerCase() : null;
  return {
    wallets: linked.wallets.map((w) => ({
      address: w.address,
      kind: w.kind,
      addedAt: w.provenAt,
      current: w.address === currentWallet,
    })),
    solanaWallets: (identity.solana ?? []).map((entry) => ({
      address: entry.address,
      addedAt: iso(entry.linkedAt),
      current: typeof current === "string" && current === entry.address,
    })),
    canRemove: {
      wallets: count.wallets > 0 && another,
      solanaWallets: count.solana > 0 && another,
    },
  };
}

/** AuthRecord `/identity` dispatch for `methods-read`; other ops fall
 * through. Reads a clone so the next handler can read the body. */
export async function accountMethodsRecordRequest(
  request: Request,
  state: DurableObjectState,
): Promise<Response | null> {
  if (
    new URL(request.url).pathname !== "/identity" ||
    request.method !== "POST"
  )
    return null;
  const body = await readJson(request.clone(), 8192);
  if (body.op !== "methods-read") return null;
  return state.storage.transaction(async (storage) => {
    const identity = await accountIdentity(
      storage,
      principal(body.principalId),
    );
    return json({
      methods: await accountMethods(storage, identity, body.current),
    });
  });
}

/** `GET /auth/account` reads the method list through this. */
export async function accountMethodsView(
  env: Env,
  session: Pick<LinkedSession, "principalId"> & {
    /** The EVM or Solana wallet that opened the session, if any. */
    address: string | null;
  },
): Promise<AccountMethods> {
  const result = await linkedWalletsCall<{ methods: AccountMethods }>(env, {
    op: "methods-read",
    principalId: session.principalId,
    current: session.address,
  });
  return result.methods;
}
