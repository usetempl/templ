import { emailSignInAvailable } from "./email-alerts";
import { readReleaseAvailability } from "./release-activation";
import type { Env } from "./common";

/** Runtime configuration can qualify a candidate. Public sign-in needs its
 * signed activation for the exact serving Worker. */
export async function publicEmailSignInEnv(env: Env): Promise<Env> {
  if (!emailSignInAvailable(env)) return env;
  const release = await readReleaseAvailability(env);
  return release.active && release.publicRelease?.emailSignInVerified === true
    ? env
    : { ...env, EMAIL_SIGN_IN_ENABLED: "false" };
}
