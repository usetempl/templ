import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError } from "./common";
import { principal } from "./principal";

/** A verified login link can retain one original raw-wallet service identity.
 * This set never authorizes token balances, purchases or contract management. */
export function servicePrincipals(
  id: ChatPrincipalId | null,
  input?: unknown,
): ChatPrincipalId[] {
  if (!id) {
    if (
      input !== undefined &&
      input !== null &&
      !(Array.isArray(input) && input.length === 0)
    )
      throw new HttpError(400, "Invalid account identity.");
    return [];
  }
  const values = input;
  if (!Array.isArray(values) || values.length < 1 || values.length > 2)
    throw new HttpError(400, "Invalid account identity.");
  const result = values.map(principal);
  if (
    new Set(result).size !== result.length ||
    !result.includes(id) ||
    (result.length === 2 &&
      (!id.startsWith("account:") ||
        result.filter((value) => value.startsWith("account:")).length !== 1))
  )
    throw new HttpError(400, "Invalid account identity.");
  return [id, ...result.filter((value) => value !== id)];
}
export type ServiceSession = {
  principalId: ChatPrincipalId;
  servicePrincipals: ChatPrincipalId[];
};
export const sessionPrincipals = (session?: ServiceSession | null) =>
  servicePrincipals(session?.principalId ?? null, session?.servicePrincipals);
export function servicePrincipalHeaders(
  session?: ServiceSession | null,
): Record<string, string> {
  return session
    ? { "X-Service-Principals": JSON.stringify(sessionPrincipals(session)) }
    : {};
}
export function principalsFromHeaders(
  headers: Headers,
  id: ChatPrincipalId | null,
  target = false,
) {
  const value = headers.get(
    target ? "X-Target-Service-Principals" : "X-Service-Principals",
  );
  if (value === null) return servicePrincipals(id, null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new HttpError(400, "Invalid account identity.");
  }
  if (target && Array.isArray(parsed) && parsed.length && id) {
    const values = servicePrincipals(principal(parsed[0]), parsed);
    if (!values.includes(id))
      throw new HttpError(400, "Invalid target account.");
    return values;
  }
  return servicePrincipals(id, parsed);
}
export const actsAs = (
  values: readonly ChatPrincipalId[],
  other: string | null | undefined,
) => typeof other === "string" && values.includes(other as ChatPrincipalId);
export async function aliasValues<T>(
  storage: Pick<DurableObjectTransaction, "get">,
  prefix: string,
  values: readonly ChatPrincipalId[],
) {
  return Promise.all(values.map((id) => storage.get<T>(`${prefix}${id}`)));
}
