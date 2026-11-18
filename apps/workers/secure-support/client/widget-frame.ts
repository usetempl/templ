/** No message, credential, draft or key crosses this bridge. */
const parents = new Set(["https://usetempl.com", "https://docs.usetempl.com", "https://blog.usetempl.com"]);
const intents = new Set(["support", "privacy", "legal", "security", "feedback", "quote", "app-approval", "app-services"]);
export function widgetNavigation(url: URL) {
  if (url.pathname !== "/widget") return undefined;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 2 || new Set(keys).size !== 2 || !keys.includes("theme") || !keys.includes("intent") ||
      !["light", "dark"].includes(url.searchParams.get("theme") ?? "") || !intents.has(url.searchParams.get("intent") ?? ""))
    throw new Error("Open support from Templ’s website.");
  if (url.hash && !/^#workspace=[a-f0-9-]+&conversation=tc-[a-f0-9]{32}&case=[1-9][0-9]*$/.test(url.hash))
    throw new Error("Open this support link in its own tab.");
  return {theme: url.searchParams.get("theme")!, intent: url.searchParams.get("intent")!};
}
export async function connectWidgetFrame() {
  if (window.parent === window) throw new Error("Open support from Templ’s website.");
  const parentOrigin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {window.removeEventListener("message", receive); reject(new Error("The support page could not be verified."));}, 10_000);
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || !parents.has(event.origin) || !event.data ||
          Object.keys(event.data).length !== 1 || event.data.type !== "templ-own-init") return;
      clearTimeout(timeout); window.removeEventListener("message", receive); resolve(event.origin);
    };
    window.addEventListener("message", receive);
  });
  return {
    ready: () => window.parent.postMessage({type: "templ-own-ready"}, parentOrigin),
    close: () => window.parent.postMessage({type: "templ-own-close"}, parentOrigin),
  };
}
