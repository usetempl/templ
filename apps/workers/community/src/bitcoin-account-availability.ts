import type { Env } from "./common";
import { readReleaseAvailability } from "./release-activation";

/** The process switch can open only the scoped qualification route. Ordinary
 * Bitcoin sign-in additionally requires this serving Worker's signed evidence. */
export async function bitcoinAccountAvailable(env: Env) {
  if (env.BITCOIN_ACCOUNT_SIGN_IN_ENABLED !== "true") return false;
  const release = await readReleaseAvailability(env, undefined, true);
  return (
    release.active &&
    release.publicRelease?.bitcoinAccountSignInVerified === true
  );
}
