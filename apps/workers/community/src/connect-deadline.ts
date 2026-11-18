import { HttpError } from "./common";

/** Request-local approval deadline. No client header or JSON field sets it. */
export const CONNECT_DEADLINE = Symbol("connect-approval-deadline");
export type ConnectDeadlineEnv = { [CONNECT_DEADLINE]?: number };
/** The shared workspace and widget transactions check this immediately before
 * their writes, so an approval that waited past expiry cannot approve a site. */
export function requireConnectDeadline(deadline: unknown) {
  if (deadline === undefined) return;
  if (!Number.isSafeInteger(deadline) || Number(deadline) <= Date.now())
    throw new HttpError(
      410,
      "This install link expired. Start again in your coding tool.",
    );
}
