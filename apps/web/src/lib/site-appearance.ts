/** A visitor's explicit display preference can travel between Templ's public
 * pages. Customer domains and workspaces keep their own appearance settings. */
export const appearanceCookie = "templ_appearance";
export type SiteAppearance = "light" | "dark" | "system";

export function savedSiteAppearance(): SiteAppearance | undefined {
  try {
    return document.cookie.match(/(?:^|;\s*)templ_appearance=(light|dark|system)(?:;|$)/)?.[1] as SiteAppearance | undefined;
  } catch { return undefined; }
}

export function saveSiteAppearance(choice: SiteAppearance) {
  if (!["light", "dark", "system"].includes(choice)) return;
  if (!["usetempl.com", "docs.usetempl.com", "blog.usetempl.com"].includes(location.hostname)) return;
  try {
    document.cookie = `${appearanceCookie}=${choice}; Path=/; Domain=usetempl.com; Max-Age=31536000; Secure; SameSite=Lax`;
  } catch { /* The local preference still works when cookies are disabled. */ }
}

/** Run before the site's own theme initialization to avoid a light first paint.
 * Docusaurus uses an absent storage value for the system preference. */
export function restoreSiteAppearanceScript(storageKey: string) {
  return `try{const p=document.cookie.match(/(?:^|;\\s*)${appearanceCookie}=(light|dark|system)(?:;|$)/)?.[1];if(p){if(p==="system")localStorage.removeItem(${JSON.stringify(storageKey)});else localStorage.setItem(${JSON.stringify(storageKey)},p)}}catch{}`;
}
