import type { ChatPrincipalId } from "@templ/chat/principal";
import { principalList } from "./principal";
import { servicePrincipals } from "./service-principals";

/** Templ operators: the accounts that read the cost, onboarding and
 * community directory pages. */
export interface OperatorAdminEnv {
  /** Comma-separated canonical principals. A plain var: principals are public
   * addresses. When the var is absent, `FEEDBACK_ADMIN_PRINCIPALS` applies;
   * when it is set, only its own entries are operators. */
  CONTACT_ADMIN_PRINCIPALS?: string;
  /** Disposable operators can set only flags for fresh trial workspaces. */
  TRIAL_OPERATOR_PRINCIPALS?: string;
  FOUNDER_PRINCIPALS?: string;
  TEMPL_STAFF_PRINCIPALS?: string;
  /** The operators when `CONTACT_ADMIN_PRINCIPALS` is absent. */
  FEEDBACK_ADMIN_PRINCIPALS?: string;
}
function operatorAdmins(env: OperatorAdminEnv): ChatPrincipalId[] {
  return principalList(
    env.CONTACT_ADMIN_PRINCIPALS ?? env.FEEDBACK_ADMIN_PRINCIPALS,
  );
}
function trialOperators(env: OperatorAdminEnv): ChatPrincipalId[] {
  return principalList(env.TRIAL_OPERATOR_PRINCIPALS).filter((id) =>
    /^0x[0-9a-f]{40}$/.test(id),
  );
}
/** A trial marker delegates to a listed disposable wallet. */
export function trialOperatorPrincipal(env: OperatorAdminEnv, value: unknown) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value))
    return undefined;
  const id = value.toLowerCase() as ChatPrincipalId;
  return trialOperators(env).includes(id) && operatorAdmins(env).includes(id)
    ? id
    : undefined;
}
export function isTrialOperatorAdmin(
  env: OperatorAdminEnv,
  actor: ChatPrincipalId,
  aliases?: unknown,
) {
  return servicePrincipals(actor, aliases).some((id) =>
    Boolean(trialOperatorPrincipal(env, id)),
  );
}
/** Alias-aware like `feedbackIsAdmin`. */
export function isOperatorAdmin(
  env: OperatorAdminEnv,
  actor: ChatPrincipalId,
  aliases?: unknown,
) {
  const principals = servicePrincipals(actor, aliases);
  const trials = trialOperators(env);
  if (principals.some((id) => trials.includes(id))) return false;
  const admins = operatorAdmins(env);
  return principals.some((id) => admins.includes(id));
}
