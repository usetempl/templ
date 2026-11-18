/** Only non-secret routing identifiers cross this navigation boundary. */
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
export function customerSupportUrl(
  origin: string,
  workspace: string,
  conversation?: string,
  caseSeq?: number,
  custody: "customer" | "templ-own-support" = "customer",
): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== origin ||
    (custody === "templ-own-support"
      ? origin !== OWN_SUPPORT_ENDPOINT.clientOrigin || workspace !== OWN_SUPPORT_ENDPOINT.workspace
      : custody !== "customer" || /(^|\.)(usetempl\.com|templ\.fun|templ\.vip)$/.test(url.hostname)) ||
    !/^[a-f0-9-]{36}$/.test(workspace) ||
    (conversation !== undefined && !/^tc-[a-f0-9]{32}$/.test(conversation)) ||
    (caseSeq !== undefined && (!Number.isSafeInteger(caseSeq) || caseSeq < 1))
  )
    return null;
  const route = new URLSearchParams({ workspace });
  if (conversation) route.set("conversation", conversation);
  if (caseSeq) route.set("case", String(caseSeq));
  url.hash = route.toString();
  return url.href;
}
