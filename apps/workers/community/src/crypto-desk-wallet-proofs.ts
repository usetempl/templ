import { CRYPTO_SUPPORT_WORKSPACE } from "./crypto-support";
import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";

export function cryptoDeskWalletProofsOn(env: WorkspaceFlagEnv, room: string, origin: string) {
  return Boolean(CRYPTO_SUPPORT_WORKSPACE) && room === CRYPTO_SUPPORT_WORKSPACE && origin.startsWith("https://") &&
    env.APP_ORIGIN === origin && featureOn(env, undefined, "cryptoDeskWalletProofs");
}
