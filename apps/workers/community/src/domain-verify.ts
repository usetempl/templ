import {
  featureOn,
  workspaceFeatureEnvFromValues,
  type WorkspaceFlagEnv,
} from "./workspace-flags";
import { indexSupportDomain } from "./hosted-support";
/** Verified domain. A workspace Admin proves the team
 * controls a domain its widget runs on by publishing a TXT record Templ
 * names: `_templ-verify.<domain>` with the value `templ-verify=<token>`.
 * Templ reads it through two DNS-over-HTTPS resolvers, and both must return
 * the value. The widget then shows "Verified domain: <domain>" under its
 * title on that domain and its subdomains.
 *
 * It proves the real widget runs on a domain the team controls. It does not
 * stop a fake page from drawing the same words, and it holds nothing and
 * reports nothing. Templ checks again at most once a day while the widget
 * is used; three failed checks at least a day apart remove the
 * verification. The token is random per domain and stored with it; the
 * value is public once it is in DNS.
 *
 * Rows live in the widget settings object:
 * at most five domains, pending or verified. */
import { HttpError, json, readJson } from "./common";
import { nativeRecord, nativeRoomId, NATIVE_UUID } from "./native-rooms";
import { requireWorkspaceAdminAuth } from "./privileged-auth";
import { requireSafetyAccess, type SafetyEnv } from "./safety";
import { sessionPrincipals, type ServiceSession } from "./service-principals";
import type { AuthMethod } from "@templ/chat/principal";

export type VerifiedDomain = {
  domain: string;
  token: string;
  verifiedAt: number;
  lastCheckedAt: number;
  /** Failed checks at least a day apart since the last success. */
  failures: number;
  failedAt?: number;
};
export type PendingDomain = {
  domain: string;
  token: string;
  addedAt: number;
  /** The last check that did not find the record. */
  checkedAt?: number;
};
export type WidgetDomainRows = {
  verifiedDomains?: VerifiedDomain[];
  pendingDomains?: PendingDomain[];
};
export type DomainVerifyEnv = WorkspaceFlagEnv & {
  /** "true" turns verified domains on. */
  SUPPORT_DOMAIN_VERIFY_ENABLED?: string;
};

export const DOMAIN_LIMITS = {
  domains: 5,
  recheckAfterMs: 24 * 60 * 60_000,
  failuresToRemove: 3,
  /** A manager's check of one domain runs at most this often. */
  checkEveryMs: 30_000,
} as const;
export const DOMAIN_RECORD_PREFIX = "_templ-verify.";
export const DOMAIN_VALUE_PREFIX = "templ-verify=";
const TOKEN = /^[a-z2-7]{32}$/;
const RESOLVERS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
] as const;

export const domainVerifyOffered = (env: DomainVerifyEnv) =>
  featureOn(env, undefined, "verifiedDomain");

const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A lowercase DNS name of at least two labels, not an IP address. */
export function isDomainName(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  return (
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    !/^\d+$/.test(labels[labels.length - 1])
  );
}
/** The host of an HTTPS origin equals `domain` or sits under it. */
export const coversOrigin = (domain: string, origin: string) => {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" &&
      (url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    );
  } catch {
    return false;
  }
};

/** Stored rows that read back as written; anything else is dropped. */
export function checkedDomainRows(value: Record<string, unknown>): {
  verifiedDomains: VerifiedDomain[];
  pendingDomains: PendingDomain[];
} {
  const verified = Array.isArray(value.verifiedDomains)
    ? value.verifiedDomains.filter(
        (row): row is VerifiedDomain =>
          !!row &&
          isDomainName(row.domain) &&
          TOKEN.test(row.token) &&
          natural(row.verifiedAt) &&
          natural(row.lastCheckedAt) &&
          natural(row.failures) &&
          row.failures < DOMAIN_LIMITS.failuresToRemove &&
          (row.failedAt === undefined || natural(row.failedAt)),
      )
    : [];
  const pending = Array.isArray(value.pendingDomains)
    ? value.pendingDomains.filter(
        (row): row is PendingDomain =>
          !!row &&
          isDomainName(row.domain) &&
          TOKEN.test(row.token) &&
          natural(row.addedAt) &&
          (row.checkedAt === undefined || natural(row.checkedAt)),
      )
    : [];
  return {
    verifiedDomains: verified.slice(0, DOMAIN_LIMITS.domains),
    pendingDomains: pending.slice(0, DOMAIN_LIMITS.domains),
  };
}

/** The verified domain a widget on `origin` shows: the longest one that
 * covers the website, or null. */
export function verifiedDomainFor(
  rows: WidgetDomainRows,
  origin: string,
): VerifiedDomain | null {
  let best: VerifiedDomain | null = null;
  for (const row of rows.verifiedDomains ?? [])
    if (
      coversOrigin(row.domain, origin) &&
      (!best || row.domain.length > best.domain.length)
    )
      best = row;
  return best;
}

/** The names of the verified domains, for the access log. */
export const domainAuditList = (rows: WidgetDomainRows) =>
  (rows.verifiedDomains ?? []).map((row) => row.domain).sort();

/** 32 random base32 characters. */
function newToken() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from(
    crypto.getRandomValues(new Uint8Array(32)),
    (byte) => alphabet[byte & 31],
  ).join("");
}

type DomainRows = ReturnType<typeof checkedDomainRows>;
/** One domain change inside the settings transaction: the rows to store,
 * whether the verified list changed (the caller logs it for a manager's
 * change) and the answer. The settings object calls it with its current
 * domain rows. */
export function widgetDomainOp(
  body: Record<string, unknown>,
  current: DomainRows & { origins: string[] },
  now: number,
): { rows: DomainRows; answer: Record<string, unknown> } {
  const domain = body.domain;
  if (!isDomainName(domain))
    throw new HttpError(400, "Enter a domain such as example.com.");
  const verified = [...current.verifiedDomains];
  const pending = [...current.pendingDomains];
  const known = verified.find((row) => row.domain === domain);
  const waiting = pending.find((row) => row.domain === domain);
  if (body.op === "domain-add") {
    if (known || waiting)
      return {
        rows: current,
        answer: { domain: domainView(known ?? waiting!) },
      };
    if (verified.length + pending.length >= DOMAIN_LIMITS.domains)
      throw new HttpError(
        409,
        "Add up to 5 domains.",
        undefined,
        "domain-limit",
      );
    const row = { domain, token: newToken(), addedAt: now };
    return {
      rows: { verifiedDomains: verified, pendingDomains: [...pending, row] },
      answer: { domain: domainView(row) },
    };
  }
  if (body.op === "domain-remove") {
    if (!known && !waiting)
      throw new HttpError(
        404,
        "That domain isn't listed.",
        undefined,
        "domain-unknown",
      );
    return {
      rows: {
        verifiedDomains: verified.filter((row) => row !== known),
        pendingDomains: pending.filter((row) => row !== waiting),
      },
      answer: { removed: domain },
    };
  }
  if (body.op !== "domain-result" || typeof body.found !== "boolean")
    throw new HttpError(400, "Invalid widget settings.");
  // The token the worker looked up must still be this row's: a domain
  // removed and added again meanwhile gets a new one.
  if (waiting && body.token === waiting.token) {
    if (!body.found) {
      const row = { ...waiting, checkedAt: now };
      return {
        rows: {
          verifiedDomains: verified,
          pendingDomains: pending.map((item) =>
            item === waiting ? row : item,
          ),
        },
        answer: { domain: domainView(row), found: false },
      };
    }
    const row: VerifiedDomain = {
      domain,
      token: waiting.token,
      verifiedAt: now,
      lastCheckedAt: now,
      failures: 0,
    };
    return {
      rows: {
        verifiedDomains: [...verified, row],
        pendingDomains: pending.filter((item) => item !== waiting),
      },
      answer: { domain: domainView(row), found: true },
    };
  }
  if (!known || body.token !== known.token)
    throw new HttpError(
      404,
      "That domain isn't listed.",
      undefined,
      "domain-unknown",
    );
  let row: VerifiedDomain;
  if (body.found) row = { ...known, lastCheckedAt: now, failures: 0 };
  else {
    const { failedAt: _last, ...rest } = known;
    // Failures count at most once a day, so a short DNS outage can't remove
    // a verification.
    const counts =
      known.failedAt === undefined ||
      now - known.failedAt >= DOMAIN_LIMITS.recheckAfterMs;
    row = counts
      ? {
          ...rest,
          lastCheckedAt: now,
          failures: known.failures + 1,
          failedAt: now,
        }
      : { ...known, lastCheckedAt: now };
  }
  const removed = row.failures >= DOMAIN_LIMITS.failuresToRemove;
  return {
    rows: {
      verifiedDomains: removed
        ? verified.filter((item) => item !== known)
        : verified.map((item) => (item === known ? row : item)),
      pendingDomains: pending,
    },
    answer: removed
      ? { removed: domain, found: false }
      : { domain: domainView(row), found: body.found },
  };
}

/** A row as the manager sees it: the TXT record to publish and its state. */
export function domainView(row: VerifiedDomain | PendingDomain) {
  return {
    domain: row.domain,
    state: "verifiedAt" in row ? "verified" : "pending",
    record: {
      name: `${DOMAIN_RECORD_PREFIX}${row.domain}`,
      type: "TXT",
      value: `${DOMAIN_VALUE_PREFIX}${row.token}`,
    },
    ...("verifiedAt" in row
      ? {
          verifiedAt: row.verifiedAt,
          lastCheckedAt: row.lastCheckedAt,
          failures: row.failures,
        }
      : { addedAt: row.addedAt }),
  };
}

/** The TXT strings one resolver returns for `name`; a quoted value split in
 * several strings is joined. Throws when the resolver can't be read. */
async function resolverTxt(
  fetcher: typeof fetch,
  resolver: string,
  name: string,
): Promise<string[]> {
  const url = `${resolver}?name=${encodeURIComponent(name)}&type=TXT`;
  const response = await fetcher(url, {
    headers: { accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200) throw new Error("resolver");
  const body = (await response.json()) as {
    Status?: unknown;
    Answer?: { type?: unknown; data?: unknown }[];
  };
  // NXDOMAIN answers 3: the name has no record.
  if (body.Status === 3) return [];
  if (body.Status !== 0) throw new Error("resolver");
  return (Array.isArray(body.Answer) ? body.Answer : [])
    .filter((answer) => answer.type === 16 && typeof answer.data === "string")
    .map(
      (answer) =>
        [...(answer.data as string).matchAll(/"((?:[^"\\]|\\.)*)"/g)]
          .map((part) => part[1])
          .join("") || (answer.data as string),
    );
}

/** Whether both resolvers return the domain's value. Null when either
 * could not be read: the check says nothing then. */
export async function domainHasToken(
  fetcher: typeof fetch,
  domain: string,
  token: string,
): Promise<boolean | null> {
  const name = `${DOMAIN_RECORD_PREFIX}${domain}`;
  const value = `${DOMAIN_VALUE_PREFIX}${token}`;
  try {
    const answers = await Promise.all(
      RESOLVERS.map((resolver) => resolverTxt(fetcher, resolver, name)),
    );
    return answers.every((texts) => texts.includes(value));
  } catch {
    return null;
  }
}

type RouteSession = ServiceSession & {
  authenticatedAt?: number;
  authMethod?: AuthMethod;
};
export type DomainRouteDeps = {
  session: () => Promise<RouteSession>;
  /** The settings object call (support-widget.ts `widgetConfig`). */
  config: (room: string, body: Record<string, unknown>) => Promise<Response>;
  /** Delivers the settings object's pending access log entries. */
  relay: (
    room: string,
    stub: { fetch(request: Request): Promise<Response> },
    response: Response,
  ) => Promise<Response>;
  /** A widget session reaches no workspace route. */
  widget: boolean;
  admin?: (context: Awaited<ReturnType<typeof nativeRecord>>, session: RouteSession) => Promise<boolean>;
  fetcher?: typeof fetch;
};

const unavailable = () =>
  new HttpError(
    409,
    "Domain verification isn't available yet.",
    undefined,
    "domain-verify-unavailable",
  );

/** `GET /rooms/<id>/widget/domains` lists the workspace's domains with the
 * TXT record each needs; `POST` with `op` "add", "check" or "remove" and a
 * `domain` changes them. The owner or current human Admin, with a valid signed-in session
 * sign-in and `confirmed: true` for each change. */
export async function domainVerifyRoute(
  request: Request,
  env: DomainVerifyEnv &
    SafetyEnv & {
      ROOMS: DurableObjectNamespace;
      AUTH_RECORDS: DurableObjectNamespace;
      APP_ORIGIN: string;
    },
  deps: DomainRouteDeps,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = /^\/rooms\/([^/]+)\/widget\/domains$/.exec(url.pathname);
  if (!match) return null;
  if (deps.widget || !NATIVE_UUID.test(match[1]))
    throw new HttpError(404, "Not found.");
  const write = request.method === "POST";
  if (!write && request.method !== "GET")
    throw new HttpError(404, "Not found.");
  const body = write ? await readJson(request, 2_048) : null;
  const id = nativeRoomId(match[1]);
  const context = nativeRecord(env, id);
  const session = await deps.session();
  const { record, room, features } = await context;
  const aliases = sessionPrincipals(session);
  if (!aliases.includes(record.room.manager) && !(await deps.admin?.({ record, room, features }, session)))
    throw new HttpError(
      403,
      "Only workspace admins can change widget settings.",
    );
  await requireSafetyAccess(env, `room:${id}`, session.principalId, aliases);
  if (features) env = workspaceFeatureEnvFromValues(env, features, id);
  const offered = domainVerifyOffered(env);
  if (!body) {
    const opened = await deps.relay(
      id,
      room,
      await deps.config(id, { op: "open" }),
    );
    if (!opened.ok) return opened;
    const rows = checkedDomainRows(await opened.json());
    return json({
      available: offered,
      domains: [...rows.verifiedDomains, ...rows.pendingDomains].map(
        domainView,
      ),
    });
  }
  if (body.expectedPrincipalId !== session.principalId)
    throw new HttpError(401, "Your sign-in changed. Try again.");
  if (!offered) throw unavailable();
  const authenticatedAt = requireWorkspaceAdminAuth(session, aliases.includes(record.room.manager), body.confirmed);
  const actor = { actor: session.principalId, authenticatedAt };
  if (body.op === "add" || body.op === "remove") {
    if (body.op === "remove" && isDomainName(body.domain))
      await indexSupportDomain(env, body.domain, id, true);
    return deps.relay(
      id,
      room,
      await deps.config(id, {
        op: body.op === "add" ? "domain-add" : "domain-remove",
        domain: body.domain,
        ...actor,
      }),
    );
  }
  if (body.op !== "check")
    throw new HttpError(400, "Choose add, check or remove.");
  if (!isDomainName(body.domain))
    throw new HttpError(400, "Enter a domain such as example.com.");
  const opened = await deps.config(id, { op: "open" });
  if (!opened.ok) return opened;
  const rows = checkedDomainRows(await opened.json());
  const row =
    rows.pendingDomains.find((item) => item.domain === body.domain) ??
    rows.verifiedDomains.find((item) => item.domain === body.domain);
  if (!row)
    throw new HttpError(
      404,
      "That domain isn't listed.",
      undefined,
      "domain-unknown",
    );
  const last =
    "lastCheckedAt" in row ? row.lastCheckedAt : (row.checkedAt ?? 0);
  if (Date.now() - last < DOMAIN_LIMITS.checkEveryMs)
    throw new HttpError(429, "Check again in a few seconds.", 30);
  const found = await domainHasToken(
    deps.fetcher ?? fetch,
    row.domain,
    row.token,
  );
  if (found === null)
    throw new HttpError(
      503,
      "Templ couldn't read DNS right now. Try again in a minute.",
      undefined,
      "domain-dns-unavailable",
    );
  if (found) await indexSupportDomain(env, row.domain, id);
  return deps.relay(
    id,
    room,
    await deps.config(id, {
      op: "domain-result",
      domain: row.domain,
      token: row.token,
      found,
      ...actor,
    }),
  );
}

/** The widget's daily re-check of the domain it shows, after the answer. A
 * resolver that can't be read changes nothing. */
export async function recheckDomain(
  row: VerifiedDomain,
  deps: {
    config: (body: Record<string, unknown>) => Promise<Response>;
    fetcher?: typeof fetch;
    now?: number;
  },
) {
  if (
    (deps.now ?? Date.now()) - row.lastCheckedAt <
    DOMAIN_LIMITS.recheckAfterMs
  )
    return;
  const found = await domainHasToken(
    deps.fetcher ?? fetch,
    row.domain,
    row.token,
  );
  if (found === null) return;
  const answer = await deps.config({
    op: "domain-result",
    domain: row.domain,
    token: row.token,
    found,
  });
  await answer.body?.cancel();
}
