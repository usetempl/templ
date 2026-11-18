import type { ChatPrincipalId } from "@templ/chat/principal";
import { siteOrigins, type AppOrigin } from "./common";
import type { OpsHealthEnv } from "./ops-health";

/** The app origin the canary signs in to: the Worker's own. It throws for an
 * unknown origin (through `siteOrigins`), so a misconfigured Worker never
 * runs the canary. Whether an environment runs it at all is the release
 * manifest's `supportCanary` declaration and the cron it allows. */
export function canaryOrigin(env: Pick<OpsHealthEnv, "APP_ORIGIN">): AppOrigin {
  return siteOrigins(env).appOrigin;
}
const ACCOUNT = /^0x[0-9a-f]{40}$/;
const WORKSPACE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The canary's principal, and only inside Templ's own workspace. Its threads are checks, not requests: callers leave them out
 * of counts, notifications and the default inbox views. */
export function canaryPrincipal(
  env: Pick<
    OpsHealthEnv,
    "APP_ORIGIN" | "TEMPL_SUPPORT_WORKSPACE" | "SUPPORT_CANARY_ACCOUNT"
  >,
  room: string,
): ChatPrincipalId | null {
  const workspace = env.TEMPL_SUPPORT_WORKSPACE;
  const account = env.SUPPORT_CANARY_ACCOUNT;
  try {
    canaryOrigin(env);
  } catch {
    return null;
  }
  if (
    !workspace ||
    !account ||
    !WORKSPACE.test(workspace) ||
    !ACCOUNT.test(account)
  )
    return null;
  return room === `room:${workspace}` ? (account as ChatPrincipalId) : null;
}
