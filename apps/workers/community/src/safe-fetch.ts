/** Outbound fetch for URLs a workspace supplies: webhooks, alert
 * destinations and knowledge sources. It allows https only, refuses private,
 * loopback, link-local and IP-literal hosts (checked again after DNS),
 * re-checks every redirect by hand and caps the size and the time.
 *
 * Workers egress reaches the public internet only, so a name that resolves
 * to a private address is not reachable from here anyway. The DNS check is a
 * second line, and the host rules keep Templ's own zones and obvious local
 * names out before any request leaves. Callers (alert delivery, knowledge
 * refresh) inject `fetch` and `resolve` in tests. */

export type SafeFetchOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  /** The response body is refused past this many bytes. */
  maxBytes: number;
  /** The whole exchange, redirects included. */
  timeoutMs: number;
  /** Each hop is checked again; zero follows none. */
  maxRedirects?: number;
  /** When set, any other response type is refused. */
  contentTypes?: readonly string[];
  /** A redirect must stay on the first URL's host (registry sync). Default
   * false: each hop only has to pass the host rules. */
  sameHost?: boolean;
  /** Keep the query string (webhook receivers put tokens there). Default
   * true; knowledge sources pass false. */
  allowQuery?: boolean;
  /** The account's own workers.dev subdomain, refused as a target. */
  workersDevSubdomain?: string;
  /** Cancel the response body unread (alert delivery needs only the
   * status). */
  discardBody?: boolean;
};

export type SafeFetchResult = {
  status: number;
  /** The URL that answered, after redirects. */
  url: string;
  headers: Headers;
  body: Uint8Array;
};

/** Host rule refusals map onto the contract's reasons: a scheme, port,
 * credential or length problem reads `not-https`; a reserved, local or Templ
 * name reads `private-address`. */
export type SafeFetchRefusal =
  | "not-https"
  | "ip-literal"
  | "private-address"
  | "redirect"
  | "too-large"
  | "timeout"
  | "content-type"
  | "unavailable";

export class SafeFetchRefused extends Error {
  readonly reason: SafeFetchRefusal;
  constructor(reason: SafeFetchRefusal) {
    super(`safe-fetch refused: ${reason}`);
    this.reason = reason;
    this.name = "SafeFetchRefused";
  }
}

export type SafeFetchDependencies = {
  fetch?: typeof fetch;
  /** DNS answers for a host name (A and AAAA). */
  resolve?: (host: string) => Promise<string[]>;
};

export const SAFE_FETCH_URL_MAX = 2_048;
/** Special-use and local suffixes (RFC 6761, 6762, 7686, 8375) and the
 * documentation zones. */
const RESERVED_SUFFIXES = [
  "local",
  "localhost",
  "internal",
  "test",
  "invalid",
  "example",
  "onion",
  "arpa",
  "home.arpa",
  "lan",
  "intranet",
  "corp",
  "private",
] as const;
/** Templ's own zones: an alert must never call back into Templ. */
export const TEMPL_ZONES = ["templ.fun", "templ.vip", "usetempl.com"] as const;

const refuse = (reason: SafeFetchRefusal): never => {
  throw new SafeFetchRefused(reason);
};

function endsWithZone(host: string, zone: string) {
  return host === zone || host.endsWith(`.${zone}`);
}

/** The URL a workspace may send to, or a refusal. Pure: no DNS. The host
 * must be a public DNS name (with a dot, not an IP literal, not a reserved
 * or Templ name) on https with the default port and no credentials. */
export function checkPublicHttpsUrl(
  input: string,
  options: { allowQuery?: boolean; workersDevSubdomain?: string } = {},
): URL {
  if (typeof input !== "string" || input.length > SAFE_FETCH_URL_MAX)
    refuse("not-https");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return refuse("not-https");
  }
  if (url.protocol !== "https:") refuse("not-https");
  if (url.username || url.password) refuse("not-https");
  if (url.port && url.port !== "443") refuse("not-https");
  url.hash = "";
  if (options.allowQuery === false) url.search = "";
  // WHATWG parsing lowercases the host, turns IDN into punycode and
  // normalises numeric IPv4 forms ("0x7f.1", "2130706433") to dotted quads.
  let host = url.hostname;
  if (host.startsWith("[") || host.includes(":")) refuse("ip-literal");
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (!host || host.endsWith(".")) refuse("private-address");
  if (/^[0-9.]+$/.test(host)) refuse("ip-literal");
  if (!host.includes(".")) refuse("private-address");
  if (host.split(".").some((label) => !label || label.length > 63))
    refuse("private-address");
  for (const suffix of RESERVED_SUFFIXES)
    if (endsWithZone(host, suffix)) refuse("private-address");
  for (const zone of TEMPL_ZONES)
    if (endsWithZone(host, zone)) refuse("private-address");
  const workers = options.workersDevSubdomain?.trim().toLowerCase();
  if (workers && endsWithZone(host, `${workers}.workers.dev`))
    refuse("private-address");
  return url;
}

function ipv4Parts(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) =>
    /^(?:0|[1-9][0-9]{0,2})$/.test(part) ? Number(part) : NaN,
  );
  return numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? numbers
    : null;
}
function privateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}
/** Eight 16-bit groups, or null. */
function ipv6Groups(value: string): number[] | null {
  let text = value.toLowerCase().replace(/%.*$/, "");
  const cut = text.lastIndexOf(":");
  const last = text.slice(cut + 1);
  if (last.includes(".")) {
    const v4 = ipv4Parts(last);
    if (!v4) return null;
    text = `${text.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) =>
    part === ""
      ? []
      : part
          .split(":")
          .map((group) =>
            /^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
          );
  const head = parse(halves[0]);
  let groups = head;
  if (halves.length === 2) {
    const rest = parse(halves[1]);
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...rest];
  }
  return groups.length === 8 && groups.every((g) => Number.isInteger(g))
    ? groups
    : null;
}
function privateIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const v4 = [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff];
  if (groups.every((g) => g === 0)) return true; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true; // ::1
  // IPv4-mapped, IPv4-compatible and NAT64 forms carry an IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0)
    if (g5 === 0xffff || g5 === 0) return privateIpv4(v4);
  if (g0 === 0x64 && g1 === 0xff9b) return privateIpv4(v4);
  if (g0 === 0x2002) return privateIpv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard
  if (g0 === 0x2001 && g1 < 0x0200) return true; // IETF protocol assignments
  return false;
}
/** True for an address no alert or source may reach: loopback, private,
 * shared, link-local, multicast, documentation and reserved ranges, in
 * IPv4 and IPv6. An unreadable answer counts as private. */
export function privateAddress(address: string): boolean {
  const v4 = ipv4Parts(address);
  if (v4) return privateIpv4(v4);
  const v6 = ipv6Groups(address);
  return v6 ? privateIpv6(v6) : true;
}

type DohAnswer = { Answer?: { type?: unknown; data?: unknown }[] };
/** A and AAAA answers through DNS over HTTPS (JSON). CNAME rows are
 * skipped; the resolver follows them and lists the final addresses. */
export async function resolveOverHttps(
  host: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const addresses: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    const response = await fetcher(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("dns");
    }
    const parsed = (await response.json()) as DohAnswer;
    for (const answer of parsed.Answer ?? [])
      if ((answer.type === 1 || answer.type === 28) && typeof answer.data === "string")
        addresses.push(answer.data);
  }
  return addresses;
}

async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    refuse("too-large");
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      refuse("too-large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mediaType(headers: Headers) {
  return (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

export async function safeFetch(
  url: string,
  options: SafeFetchOptions,
  dependencies: SafeFetchDependencies = {},
): Promise<SafeFetchResult> {
  const fetcher = dependencies.fetch ?? fetch;
  const resolve =
    dependencies.resolve ?? ((host: string) => resolveOverHttps(host, fetcher));
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 0 ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0
  )
    refuse("unavailable");
  const maxRedirects = Math.max(0, Math.min(5, options.maxRedirects ?? 0));
  const check = (target: string) =>
    checkPublicHttpsUrl(target, {
      allowQuery: options.allowQuery ?? true,
      workersDevSubdomain: options.workersDevSubdomain,
    });
  const controller = new AbortController();
  const deadline = Date.now() + options.timeoutMs;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const timedOut = () => controller.signal.aborted || Date.now() >= deadline;
  let current = check(url);
  const firstHost = current.hostname;
  try {
    for (let hop = 0; ; hop++) {
      let addresses: string[];
      try {
        addresses = await resolve(current.hostname);
      } catch {
        if (timedOut()) refuse("timeout");
        return refuse("unavailable");
      }
      if (!addresses.length) refuse("unavailable");
      if (addresses.some(privateAddress)) refuse("private-address");
      let response: Response;
      try {
        response = await fetcher(current.toString(), {
          method: options.method ?? "GET",
          headers: options.headers,
          ...(options.body !== undefined ? { body: options.body } : {}),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        if (timedOut()) refuse("timeout");
        return refuse("unavailable");
      }
      // 304 answers a conditional request (If-None-Match); it is not a
      // redirect.
      if (
        response.status >= 300 &&
        response.status < 400 &&
        response.status !== 304
      ) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (hop >= maxRedirects || !location) refuse("redirect");
        let next: URL;
        try {
          next = check(new URL(location!, current).toString());
        } catch (error) {
          if (error instanceof SafeFetchRefused) refuse("redirect");
          return refuse("redirect");
        }
        if (options.sameHost && next.hostname !== firstHost) refuse("redirect");
        current = next;
        continue;
      }
      if (
        options.contentTypes &&
        !options.contentTypes.includes(mediaType(response.headers))
      ) {
        await response.body?.cancel();
        refuse("content-type");
      }
      let body: Uint8Array;
      try {
        if (options.discardBody) {
          await response.body?.cancel();
          body = new Uint8Array(0);
        } else body = await readCapped(response, options.maxBytes);
      } catch (error) {
        if (error instanceof SafeFetchRefused) throw error;
        if (timedOut()) refuse("timeout");
        return refuse("unavailable");
      }
      return {
        status: response.status,
        url: current.toString(),
        headers: response.headers,
        body,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}
