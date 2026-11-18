import { isLoopbackOrigin } from "@templ/chat/widget-wallet";

/** A canonical HTTPS website, or a local website while its gate is on. */
export function widgetWebsiteOrigin(
  value: unknown,
  loopback = false,
): value is string {
  if (typeof value !== "string") return false;
  if (isLoopbackOrigin(value)) return loopback;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}
