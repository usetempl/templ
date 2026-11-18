import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError } from "./common";

export function principal(value: unknown) {
  const result = normalizeChatPrincipal(value);
  if (!result) throw new HttpError(400, "Invalid user ID.");
  return result;
}
/** An operator allowlist var: comma-separated canonical principals, at most
 * 20. A malformed entry or an empty list leaves no operator. */
export function principalList(value: string | undefined): ChatPrincipalId[] {
  try {
    const values = (value ?? "").split(",").filter(Boolean);
    if (!values.length || values.length > 20) return [];
    return [...new Set(values.map((entry) => principal(entry.trim())))];
  } catch {
    return [];
  }
}
