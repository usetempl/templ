import { SITE } from "./site-environment";

/* A hosted page starts its widget's public policy read while the HTML
 * parses, before React and the widget module load. The inline script sends
 * the request createSupportClient sends: GET with credentials "omit", cache
 * "no-store" and no headers, from the same document, so the service sees the
 * same origin and referrer. The page's first hosted chat takes the read. Its
 * widget's first request for that URL receives the response, once, unless
 * the request differs or comes after FRESH_FOR; then it goes to the network
 * and the early read is dropped. Frame pages read their policy inside
 * Templ's frame and start none. A link preload cannot serve this request: no
 * crossorigin value gives credentials "omit", so the browser would send it
 * twice. */
const SLOT = "templHostedPolicy";
/** A slow or suspended opening falls back to the ordinary current read. */
const FRESH_FOR = 3_000;
const SETTLED_FOR = 1_000;

type EarlyRead = {
  url: string;
  at: number;
  path: string;
  settled?: number;
  stopped?: boolean;
  response: Promise<Response>;
  abort(reason?: unknown): void;
};

const policyUrl = (workspace: string) =>
  `${SITE.community}/widget/${workspace}/auth/policy`;

/** The page's nonced inline script. The URL holds only the API origin and a
 * checked workspace ID. */
export function hostedPolicyScript(workspace: string) {
  const url = JSON.stringify(policyUrl(workspace)).replace(/</g, "\\u003c");
  return `if (!location.search && !location.hash && !document.hidden) {
    try {
      const controller = new AbortController();
      const entry = {
        url: ${url}, path: location.pathname, at: performance.now(),
        abort: (reason) => controller.abort(reason),
        response: fetch(${url}, {method:"GET",credentials:"omit",cache:"no-store",signal:controller.signal})
      };
      const stop = () => {
        entry.stopped = true;
        if (window.${SLOT} === entry) delete window.${SLOT};
        controller.abort();
      };
      entry.response.then(() => { entry.settled = performance.now(); }, () => {});
      setTimeout(() => {
        if (window.${SLOT} === entry) stop();
        removeEventListener("pagehide", stop);
      }, ${FRESH_FOR});
      addEventListener("pagehide", stop, {once:true});
      window.${SLOT} = entry;
    } catch {}
  }`;
}

/** The widget's anonymous policy read, exactly as createSupportClient sends it. */
const samePolicyRead = (init?: RequestInit): init is RequestInit =>
  !!init &&
  init.method === "GET" &&
  init.credentials === "omit" &&
  init.cache === "no-store" &&
  !init.signal?.aborted &&
  !Array.from(new Headers(init.headers)).length &&
  Object.keys(init).every((key) =>
    ["method", "credentials", "cache", "signal", "headers"].includes(key),
  );

/** Takes this document's early read for the workspace. A hosted chat calls
 * this once; later chats, including after client-side navigation, find none.
 * The returned transport passes every other request to `fetch`. */
export function claimHostedPolicyRead(workspace: string): typeof fetch | undefined {
  const page = window as Window & { [SLOT]?: EarlyRead };
  let early = page[SLOT];
  delete page[SLOT];
  if (early?.url !== policyUrl(workspace) || location.search || location.hash || early.path !== location.pathname) {
    early?.abort();
    return;
  }
  return (input, init) => {
    const read = early;
    if (!read || input !== read.url) return fetch(input, init);
    early = undefined;
    const now = performance.now();
    if (!samePolicyRead(init) || read.stopped || location.search || location.hash || read.path !== location.pathname ||
      now - read.at > FRESH_FOR || (read.settled !== undefined && now - read.settled > SETTLED_FOR)) {
      read.abort();
      return fetch(input, init);
    }
    // The widget's own abort, timeout or wallet change cancels this read too.
    const { signal } = init;
    if (signal)
      signal.addEventListener("abort", () => read.abort(signal.reason), { once: true });
    return read.response.catch((error) => {
      if (signal?.aborted) throw error;
      return fetch(input, init);
    });
  };
}
