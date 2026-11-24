import { requireConnectDeadline } from "./connect-deadline";
import { readSupportJson } from "./support-body";
import {
  publicWidgetAppearance,
  type WidgetAppearance,
} from "@templ/chat/widget-appearance";
import {
  readWidgetAppearance,
  prepareWidgetAppearance,
  WIDGET_APPEARANCE_KEY,
} from "./widget-appearance-config";
import {
  widgetIntroAuditValue,
  widgetIntroFields,
  widgetIntroPrompts,
  widgetIntroReplyHours,
} from "./widget-intro";
import { refusePhrase, refuseSecretRequest } from "./secret-guard";
import { releaseActivationEnv } from "./release-activation";
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import {
  featureOn,
  roomFlags,
  OWN_TRIAL_FEATURES,
  workspaceFeatureEnvFromFlags,
} from "./workspace-flags";
import {
  isWorkspaceFlagKey,
  type WorkspaceFlag,
} from "@templ/chat/workspace-flags";
import {
  hostedPageOffered,
  hostedPageHref,
  hostedSupportDescriptor,
  indexSupportDomain,
} from "./hosted-support";
import { corpusNoticeField, type CorpusEnv } from "./support-corpus";
import {
  widgetClosed,
  widgetClosureOp,
  workspaceClosedError,
} from "./workspace-deletion";
import { supportNotificationsConfigured } from "./support-notifications";
import { recoverMessageAddress, isHex } from "viem";
import { createSiweMessage } from "viem/siwe";
import { isSupportSiweChainId } from "@templ/chat/chains";
import { createSolanaSignInMessage } from "@templ/chat/solana";
import {
  decodeWidgetSolanaSignature,
  WIDGET_WALLET_SHARE_STATEMENT,
  formatCaip10,
  isLoopbackOrigin,
  parseWidgetWalletClaim,
  DEFAULT_WALLET_IDENTIFICATION,
  readWalletIdentification,
  type WalletIdentification,
  readStoredWidgetWallet,
  WIDGET_SOLANA_SIGNATURE,
  widgetSignInResource,
  WIDGET_REMEMBER_STATEMENT,
  WIDGET_SIGN_IN_STATEMENT,
  type WidgetWallet,
} from "@templ/chat/widget-wallet";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import {
  meetsMinimumLevel,
  SUPPORT_MINIMUM_LEVELS,
  type SupportAccessLevel,
  type SupportMinimumLevel,
} from "@templ/chat/support";
import {
  NATIVE_UUID,
  nativeRecord,
  nativeRoomId,
  prefetchNativeRoom,
} from "./native-rooms";
// Install checks use scoped member sessions.
// The settings object stores hashed, session-bound permits.
import {
  installCheckOperation,
  requireInstallCheck,
  widgetInstallCheck,
  resolveInstallFixture,
  INSTALL_PREVIEW,
} from "./support-install-check";
import {
  identityRequest,
  newAccountId,
  type AccountIdentity,
} from "./account-identity";
import { verifySolanaSignature } from "./solana";
import type { AuthData, GuestSession } from "./auth-record";
import { markWorkspaceStep } from "./funnel-metrics";
import {
  readWidgetOriginRefusals,
  refusalWindowDays,
} from "./support-refusals";
import { widgetWebsiteOrigin } from "./widget-origin";
import { admitFunnelRequest } from "./funnel-routes";
import {
  defer,
  PRINCIPAL_HINT_HEADER,
  principalHint,
  requestPrefetch,
  started,
  timed,
} from "./request-context";
import { prefetchSafety, type SafetyEnv } from "./safety";
import {
  prefetchSessionIdentity,
  sessionIdentity,
  walletSignsIn,
} from "./linked-wallets";
import {
  isCounterfactualSignature,
  verifySessionAuthority,
  verifyWidgetSmartWallet,
} from "./chain";
import {
  createFamily,
  endFamily,
  forgetFamily,
  parseRememberCredential,
  resumeFamily,
  type RememberedFamily,
} from "./widget-remember";
import {
  GUEST_CHECK_COPY,
  GUEST_CHECK_TOKEN,
  guestCheckPage,
  verifyGuestCheck,
} from "./turnstile";
import {
  guestCheckOffered,
  loopbackOffered,
  realtimeOffered,
  rememberOffered,
  smartWalletsOffered,
  type WidgetSessionEnv,
} from "./widget-session-config";
import { clientIpDigest } from "./realtime";
import {
  frameRequirement,
  frameSocketUrl,
  widgetFrameOrigin,
  frameUnavailable,
  sameWidgetScope,
  widgetFrameRequired,
  widgetRequestOrigin,
  widgetScopeFor,
  type WidgetFrameEnv,
} from "./widget-frame";
import {
  checkedDomainRows,
  domainAuditList,
  verifiedDomainFor,
  widgetDomainOp,
  type WidgetDomainRows,
} from "./domain-verify";
import { WIDGET_HOST_ORIGIN_HEADER } from "@templ/chat/widget-frame";
import {
  isScreenshotUpload,
  readScreenshotUpload,
  screenshotsOffered,
  type MemberScreenshotEnv,
} from "./support-member-screenshots";
import {
  domainVerifyOffered,
  recheckDomain,
  type DomainVerifyEnv,
} from "./domain-verify";
import {
  address,
  config,
  errorBody,
  HttpError,
  json,
  legacyRecord,
  recordByHash,
  NONCE_TTL,
  WALLET_SHARE_RECEIPT_TTL,
  randomToken,
  readJson,
  record,
  SESSION_COOKIE,
  sha256Hex,
  type Env,
} from "./common";

export const WIDGET_SCOPE = Symbol("support-widget-scope");
/** Widget builds that must reload before they are served again, by the id
 * each sends in `X-Templ-Widget`: a build with a security defect. Reviewed
 * in code, like PUBLISHED_WIDGET_BUILDS in support-failures.ts. */
export const REVOKED_WIDGET_BUILDS: readonly string[] = [];
/** A build id the widget sends: 16 hex characters, or "dev" in the demo. */
const WIDGET_BUILD = /^(?:[0-9a-f]{16}|dev)$/;
/** The workspace and website a widget record belongs to; `frame` marks one
 * made inside Templ's frame (widget-frame.ts). */
export type WidgetScope = {
  room: string;
  origin: string;
  frame?: true;
  hosted?: true;
};
export type WidgetEnv = Env & {
  [WIDGET_SCOPE]?: WidgetScope & { askPerson?: boolean };
};
const SESSION_MS = 60 * 60_000;
/** A guest credential lets the same browser find its thread again. It names
 * one widget scope and one account id, and grants nothing else. */
const GUEST_TTL = 90 * 24 * 60 * 60_000;
type WidgetSettings = {
  walletIdentification?: WalletIdentification | null;
  appearance?: WidgetAppearance | null;
  appearanceRevision?: number;
  appearanceUnavailable?: boolean;
  origins: string[];
  minimumLevel: SupportMinimumLevel;
  hostedPage?: boolean;
  walletFallback?: boolean;
  askPerson?: boolean;
  /** Remembered sign-in on this workspace's sites; absent reads as on. It
   * does anything only while Templ offers remembered sign-in. */
  remember?: boolean;
  /** Bumped to sign every remembered member out: a family or session from
   * an earlier epoch is refused at its next request. Absent reads as 0. */
  rememberEpoch?: number;
  /** A visitor check before a guest's first message; absent reads as off. */
  guestCheck?: GuestCheck;
  /** The widget says "We never DM you first."; absent reads as off. */
  safetyLine?: boolean;
  /** Manager-approved public questions; null keeps the host app's defaults. */
  prompts?: string[] | null;
  /** The manager's reply estimate, in hours; null hides the line. */
  replyHours?: number | null;
  /** Inline pages are refused and only Templ's frame may show the chat
   * (widget-frame.ts); absent reads as off. */
  frameRequired?: boolean;
} & WidgetDomainRows;
export type GuestCheck = "off" | "turnstile";
const LEVEL_REQUIRED = {
  signed: "This team asks you to sign in with your wallet.",
  connected: "Connect your wallet to contact this team.",
} as const;
const internal = (path: string, body?: unknown) =>
  new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Saved website origins: HTTPS, or, with `loopback`, a development
 * origin on this computer over http. */
export function widgetOrigins(value: unknown, loopback = false): string[] {
  if (!Array.isArray(value) || value.length > 10)
    throw new HttpError(400, "Add up to 10 website origins.");
  return [
    ...new Set(
      value.map((entry) => {
        if (typeof entry !== "string")
          throw new HttpError(
            400,
            "Use an HTTPS origin, such as https://app.example.com.",
          );
        let url: URL;
        try {
          url = new URL(entry);
        } catch {
          throw new HttpError(
            400,
            "Use an HTTPS origin, such as https://app.example.com.",
          );
        }
        if (
          !(
            url.protocol === "https:" ||
            (loopback && url.protocol === "http:" && isLoopbackOrigin(entry))
          ) ||
          url.origin !== entry ||
          url.username ||
          url.password
        )
          throw new HttpError(
            400,
            "Use an HTTPS origin without a path or trailing slash.",
          );
        return url.origin;
      }),
    ),
  ];
}

export function widgetMinimumLevel(value: unknown): SupportMinimumLevel {
  if (!SUPPORT_MINIMUM_LEVELS.includes(value as SupportMinimumLevel))
    throw new HttpError(400, "Choose who can start a case.");
  return value as SupportMinimumLevel;
}
function widgetChoice(value: unknown): boolean {
  if (typeof value !== "boolean") throw new HttpError(400, "Choose on or off.");
  return value;
}
function widgetRemember(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new HttpError(400, "Choose whether users stay signed in.");
  return value;
}
function widgetGuestCheck(value: unknown): GuestCheck {
  if (!GUEST_CHECKS.includes(value as GuestCheck))
    throw new HttpError(400, "Choose whether to check visitors.");
  return value as GuestCheck;
}
function widgetSafetyLine(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw new HttpError(
      400,
      "Choose whether the widget shows the safety line.",
    );
  return value;
}

/** Widget settings changes waiting for the room's access log. They live in
 * the settings object because one transaction can't cover both objects:
 * each change is written with the settings, the worker delivers pending
 * entries to the room after a save or an open, and `audit-ack` drops what
 * the room recorded. */
const WIDGET_AUDIT_KEY = "widget-config-audit-v1";
/** At most this many undelivered changes; past it a changing save waits. */
export const WIDGET_AUDIT_OUTBOX = 16;
export type WidgetAuditEntry = {
  seq: number;
  actor: ChatPrincipalId;
  /** The manager's sign-in proof time, when the session carried one. */
  authenticatedAt: number | null;
  at: number;
} & (
  | {
      action: "widget.origins";
      before: { origins: string[] };
      after: { origins: string[] };
    }
  | {
      action: "widget.level";
      before: { minimumLevel: SupportMinimumLevel };
      after: { minimumLevel: SupportMinimumLevel };
    }
  | {
      action: "widget.hosted-page";
      before: { hostedPage: boolean };
      after: { hostedPage: boolean };
    }
  | {
      action: "widget.wallet-fallback";
      before: { walletFallback: boolean };
      after: { walletFallback: boolean };
    }
  | {
      action: "widget.wallet-identification";
      before: WalletIdentification | null;
      after: WalletIdentification;
    }
  | {
      action: "widget.ask-person";
      before: { askPerson: boolean };
      after: { askPerson: boolean };
    }
  | {
      action: "widget.remember";
      before: { remember: boolean };
      after: { remember: boolean };
    }
  | {
      action: "widget.sessions-ended";
      before: { rememberEpoch: number };
      after: { rememberEpoch: number; reason: EpochReason };
    }
  | {
      action: "widget.guest-check";
      before: { guestCheck: GuestCheck };
      after: { guestCheck: GuestCheck };
    }
  | {
      action: "widget.appearance";
      before: { appearanceRevision: number };
      after: { appearanceRevision: number };
    }
  | {
      action: "widget.safety-line";
      before: { safetyLine: boolean };
      after: { safetyLine: boolean };
    }
  | {
      action: "widget.intro";
      before: { questions: number; replyHours: number | null };
      after: { questions: number; replyHours: number | null };
    }
  // Frame mode required, and the verified domain list.
  | {
      action: "widget.frame";
      before: { frameRequired: boolean };
      after: { frameRequired: boolean };
    }
  | {
      action: "widget.domain";
      before: { domains: string[] };
      after: { domains: string[] };
    }
);
/** Why every remembered member was signed out: the manager asked, a website
 * was removed, or remembered sign-in was turned off. */
type EpochReason = "manager" | "origin-removed" | "remember-off";
const EPOCH_REASONS: readonly EpochReason[] = [
  "manager",
  "origin-removed",
  "remember-off",
];
const GUEST_CHECKS: readonly GuestCheck[] = ["off", "turnstile"];
type WidgetAuditOutbox = {
  schema: 1;
  next: number;
  entries: WidgetAuditEntry[];
};
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function checkedOrigins(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  try {
    // Stored lists may hold a development origin approved while Templ
    // allowed them; each request still checks it against the current rule.
    const origins = widgetOrigins(value.origins, true);
    return (value.origins as unknown[]).length === origins.length
      ? origins
      : null;
  } catch {
    return null;
  }
}
function checkedLevel(value: unknown): SupportMinimumLevel | null {
  return isRecord(value) &&
    SUPPORT_MINIMUM_LEVELS.includes(value.minimumLevel as SupportMinimumLevel)
    ? (value.minimumLevel as SupportMinimumLevel)
    : null;
}
/** One outbox entry as it crosses an object boundary: a known action, a
 * normalized principal, natural times and sequence, and before/after values
 * that are exactly an origin list or an access level. */
export function checkedWidgetAuditEntry(
  value: unknown,
): WidgetAuditEntry | null {
  if (
    !isRecord(value) ||
    !natural(value.seq) ||
    value.seq < 1 ||
    !natural(value.at) ||
    !(value.authenticatedAt === null || natural(value.authenticatedAt)) ||
    typeof value.actor !== "string" ||
    normalizeChatPrincipal(value.actor) !== value.actor
  )
    return null;
  const base = {
    seq: value.seq,
    actor: value.actor as ChatPrincipalId,
    authenticatedAt: value.authenticatedAt as number | null,
    at: value.at,
  };
  if (value.action === "widget.origins") {
    const before = checkedOrigins(value.before);
    const after = checkedOrigins(value.after);
    return before && after
      ? {
          ...base,
          action: value.action,
          before: { origins: before },
          after: { origins: after },
        }
      : null;
  }
  if (value.action === "widget.level") {
    const before = checkedLevel(value.before);
    const after = checkedLevel(value.after);
    return before && after
      ? {
          ...base,
          action: value.action,
          before: { minimumLevel: before },
          after: { minimumLevel: after },
        }
      : null;
  }
  const only = (side: unknown, key: string) =>
    isRecord(side) && Object.keys(side).join() === key ? side[key] : undefined;
  if (value.action === "widget.intro") {
    const before = widgetIntroAuditValue(value.before);
    const after = widgetIntroAuditValue(value.after);
    return before && after
      ? { ...base, action: value.action, before, after }
      : null;
  }
  if (value.action === "widget.hosted-page") {
    const before = only(value.before, "hostedPage");
    const after = only(value.after, "hostedPage");
    return typeof before === "boolean" && typeof after === "boolean"
      ? {
          ...base,
          action: value.action,
          before: { hostedPage: before },
          after: { hostedPage: after },
        }
      : null;
  }
  if (value.action === "widget.wallet-identification") {
    const before = readWalletIdentification(value.before);
    const after = readWalletIdentification(value.after);
    return (before || value.before === null) && after ? { ...base, action: value.action, before, after } : null;
  }
  if (value.action === "widget.wallet-fallback") {
    const before = only(value.before, "walletFallback");
    const after = only(value.after, "walletFallback");
    return typeof before === "boolean" && typeof after === "boolean"
      ? {
          ...base,
          action: value.action,
          before: { walletFallback: before },
          after: { walletFallback: after },
        }
      : null;
  }
  if (value.action === "widget.ask-person") {
    const before = only(value.before, "askPerson");
    const after = only(value.after, "askPerson");
    return typeof before === "boolean" && typeof after === "boolean"
      ? {
          ...base,
          action: value.action,
          before: { askPerson: before },
          after: { askPerson: after },
        }
      : null;
  }
  if (value.action === "widget.remember") {
    const before = only(value.before, "remember");
    const after = only(value.after, "remember");
    return typeof before === "boolean" && typeof after === "boolean"
      ? {
          ...base,
          action: value.action,
          before: { remember: before },
          after: { remember: after },
        }
      : null;
  }
  if (value.action === "widget.sessions-ended") {
    const before = only(value.before, "rememberEpoch");
    const after = value.after;
    return natural(before) &&
      isRecord(after) &&
      Object.keys(after).sort().join() === "reason,rememberEpoch" &&
      after.rememberEpoch === before + 1 &&
      EPOCH_REASONS.includes(after.reason as EpochReason)
      ? {
          ...base,
          action: value.action,
          before: { rememberEpoch: before },
          after: {
            rememberEpoch: before + 1,
            reason: after.reason as EpochReason,
          },
        }
      : null;
  }
  if (value.action === "widget.safety-line") {
    const before = only(value.before, "safetyLine");
    const after = only(value.after, "safetyLine");
    return typeof before === "boolean" && typeof after === "boolean"
      ? {
          ...base,
          action: value.action,
          before: { safetyLine: before },
          after: { safetyLine: after },
        }
      : null;
  }
  if (value.action === "widget.appearance") {
    const before = only(value.before, "appearanceRevision");
    const after = only(value.after, "appearanceRevision");
    return natural(before) && natural(after) && after === before + 1
      ? {
          ...base,
          action: value.action,
          before: { appearanceRevision: before },
          after: { appearanceRevision: after },
        }
      : null;
  }
  if (value.action === "widget.frame") {
    const before = only(value.before, "frameRequired");
    const after = only(value.after, "frameRequired");
    return typeof before === "boolean" && typeof after === "boolean"
      ? {
          ...base,
          action: value.action,
          before: { frameRequired: before },
          after: { frameRequired: after },
        }
      : null;
  }
  if (value.action === "widget.domain") {
    const before = only(value.before, "domains");
    const after = only(value.after, "domains");
    const domains = (side: unknown) =>
      Array.isArray(side) &&
      side.length <= 5 &&
      side.every(
        (domain) =>
          typeof domain === "string" && /^[a-z0-9.-]{3,253}$/.test(domain),
      );
    return domains(before) && domains(after)
      ? {
          ...base,
          action: value.action,
          before: { domains: [...(before as string[])] },
          after: { domains: [...(after as string[])] },
        }
      : null;
  }
  if (value.action === "widget.guest-check") {
    const before = only(value.before, "guestCheck");
    const after = only(value.after, "guestCheck");
    return GUEST_CHECKS.includes(before as GuestCheck) &&
      GUEST_CHECKS.includes(after as GuestCheck)
      ? {
          ...base,
          action: value.action,
          before: { guestCheck: before as GuestCheck },
          after: { guestCheck: after as GuestCheck },
        }
      : null;
  }
  return null;
}
/** Absent is an empty outbox. Anything unreadable is null: a changing save
 * is then refused rather than left unlogged. */
function checkedOutbox(value: unknown): WidgetAuditOutbox | null {
  if (value === undefined) return { schema: 1, next: 1, entries: [] };
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    !natural(value.next) ||
    value.next < 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length > WIDGET_AUDIT_OUTBOX
  )
    return null;
  const entries: WidgetAuditEntry[] = [];
  for (const raw of value.entries) {
    const entry = checkedWidgetAuditEntry(raw);
    if (
      !entry ||
      entry.seq >= value.next ||
      (entries.length && entry.seq <= entries[entries.length - 1].seq)
    )
      return null;
    entries.push(entry);
  }
  return { schema: 1, next: value.next, entries };
}

/** The workspace's widget settings object. `open` is the manager's read
 * from the app, after the worker found the workspace: it writes the defaults
 * the first time. `read` is a widget request naming the page's origin; it
 * never writes settings, and it marks onboarding steps only for a workspace
 * whose settings exist, so an unknown id stores nothing. `refusals` returns
 * retained origin refusal counts. `marked`
 * says a first-time step was recorded and awaits `flushWorkspaceSteps`. */
export async function widgetConfigRecord(
  request: Request,
  storage: DurableObjectStorage,
): Promise<{ response: Response; marked: boolean } | null> {
  if (new URL(request.url).pathname !== "/widget-config") return null;
  const body = await readJson(request);
  try {
    return await widgetConfigTransaction(storage, body);
  } catch (error) {
    // The settings object's own error answer drops reason codes; keep them.
    if (error instanceof HttpError && error.reason)
      return {
        response: json(errorBody(error, ""), error.status),
        marked: false,
      };
    throw error;
  }
}
function widgetConfigTransaction(
  storage: DurableObjectStorage,
  body: Record<string, unknown>,
): Promise<{ response: Response; marked: boolean }> {
  return storage.transaction(async (local) => {
    // A workspace set to be deleted closes its widget here.
    if (body.op === "workspace-flags") {
      if (
        !Number.isSafeInteger(body.revision) ||
        Number(body.revision) < 1 ||
        !Array.isArray(body.flags) ||
        body.flags.some(
          (flag) =>
            !flag ||
            !isWorkspaceFlagKey(flag.key) ||
            flag.on !== true ||
            !Number.isFinite(Date.parse(flag.until)),
        )
      )
        throw new HttpError(400, "Invalid feature list.");
      if (
        (await local.get<{ deletedAt?: number }>("widget-closed-v1"))?.deletedAt
      )
        return {
          response: json({ ok: true, revision: body.revision }),
          marked: false,
        };
      const current = await local.get<{
        revision: number;
        flags: WorkspaceFlag[];
      }>("workspace-flags-snapshot-v1");
      const revision = Number(body.revision);
      if (!current || revision > current.revision)
        await local.put("workspace-flags-snapshot-v1", {
          revision,
          flags: body.flags,
        });
      return {
        response: json({
          ok: true,
          revision: Math.max(revision, current?.revision ?? 0),
        }),
        marked: false,
      };
    }
    const closure = await widgetClosureOp(local, body);
    if (closure) return { response: closure, marked: false };
    const saved = await local.get<Partial<WidgetSettings>>("widget-config");
    const stored = saved ?? {};
    const appearance = await readWidgetAppearance(local);
    const current: Required<WidgetSettings> = {
      ...appearance,
      origins: stored.origins ?? [],
      // Workspaces saved before access levels existed accept anyone, as the
      // founder chose for every workspace.
      minimumLevel: SUPPORT_MINIMUM_LEVELS.includes(
        stored.minimumLevel as SupportMinimumLevel,
      )
        ? stored.minimumLevel!
        : "anyone",
      hostedPage: stored.hostedPage === true,
      walletIdentification: stored.walletIdentification ?? null,
      walletFallback: stored.walletFallback !== false,
      askPerson: stored.askPerson !== false,
      remember: stored.remember !== false,
      rememberEpoch: natural(stored.rememberEpoch) ? stored.rememberEpoch : 0,
      guestCheck: stored.guestCheck === "turnstile" ? "turnstile" : "off",
      safetyLine: stored.safetyLine === true,
      prompts:
        stored.prompts === undefined || stored.prompts === null
          ? null
          : widgetIntroPrompts(stored.prompts),
      replyHours:
        stored.replyHours === undefined
          ? null
          : widgetIntroReplyHours(stored.replyHours),
      // Frame mode and verified domains.
      frameRequired: stored.frameRequired === true,
      ...checkedDomainRows(stored as Record<string, unknown>),
    };
    // Transactional install permits and results.
    // Results contain fixed ids, times and pass or fail.
    const install = await installCheckOperation(local, body);
    if (install) return { response: install, marked: false };
    const flags =
      (
        await local.get<{ flags: WorkspaceFlag[] }>(
          "workspace-flags-snapshot-v1",
        )
      )?.flags ?? [];
    const now = Date.now();
    // A verified domain added, checked or removed.
    if (
      body.op === "domain-add" ||
      body.op === "domain-remove" ||
      body.op === "domain-result"
    ) {
      const { rows, answer } = widgetDomainOp(body, current, now);
      const next = { ...current, ...rows };
      const before = domainAuditList(current);
      const after = domainAuditList(next);
      // A manager's change of the verified list is logged; Templ's own
      // daily re-check removing one is not a person's action.
      const actor = normalizeChatPrincipal(body.actor);
      const changes =
        actor && JSON.stringify(before) !== JSON.stringify(after)
          ? [
              {
                action: "widget.domain" as const,
                before: { domains: before },
                after: { domains: after },
              },
            ]
          : [];
      const audit = await appendWidgetAudit(
        local,
        changes,
        actor,
        natural(body.authenticatedAt) ? body.authenticatedAt : null,
        now,
      );
      await local.put("widget-config", shown(next));
      return { response: json({ ...answer, audit }), marked: false };
    }
    if (body.op === "save") {
      const actor = normalizeChatPrincipal(body.actor);
      if (
        !actor ||
        !(body.authenticatedAt === null || natural(body.authenticatedAt))
      )
        throw new HttpError(400, "Invalid widget settings.");
      // Retrying creation can never reverse a manager's later guest settings.
      if (body.initializeOnly === true && (saved || body.hostedPageAvailable !== true)) {
        const outbox = checkedOutbox(await local.get(WIDGET_AUDIT_KEY));
        return { response: json({ ...shown(current), audit: outbox?.entries ?? [] }), marked: false };
      }
      const intro = widgetIntroFields(body, body.widgetIntroAvailable === true);
      const updatedAppearance =
        body.appearance === undefined
          ? null
          : prepareWidgetAppearance(
              appearance,
              body.appearance,
              body.appearanceRevision,
            );
      if (updatedAppearance?.appearance?.headerNotice?.text) {
        await refusePhrase(
          updatedAppearance.appearance.headerNotice.text,
          "saved",
        );
        refuseSecretRequest(updatedAppearance.appearance.headerNotice.text);
      }
      for (const prompt of intro.prompts ?? []) {
        await refusePhrase(prompt, "saved");
        refuseSecretRequest(prompt);
      }
      // Each field saves on its own; saving origins never resets the level.
      const next: Required<WidgetSettings> = {
        ...appearance,
        walletIdentification: body.walletIdentification === undefined
          ? current.walletIdentification : readWalletIdentification(body.walletIdentification),
        ...(updatedAppearance
          ? {
              appearance: updatedAppearance.appearance,
              appearanceRevision: updatedAppearance.appearanceRevision,
              appearanceUnavailable: false,
            }
          : {}),
        origins:
          body.origins === undefined
            ? current.origins
            : widgetOrigins(body.origins, body.loopback === true),
        minimumLevel:
          body.minimumLevel === undefined
            ? current.minimumLevel
            : widgetMinimumLevel(body.minimumLevel),
        hostedPage:
          body.hostedPage === undefined
            ? current.hostedPage
            : widgetChoice(body.hostedPage),
        walletFallback:
          body.walletFallback === undefined
            ? current.walletFallback
            : widgetChoice(body.walletFallback),
        askPerson:
          body.askPerson === undefined
            ? current.askPerson
            : widgetChoice(body.askPerson),
        remember:
          body.remember === undefined
            ? current.remember
            : widgetRemember(body.remember),
        rememberEpoch: current.rememberEpoch,
        guestCheck:
          body.guestCheck === undefined
            ? current.guestCheck
            : widgetGuestCheck(body.guestCheck),
        safetyLine:
          body.safetyLine === undefined
            ? current.safetyLine
            : widgetSafetyLine(body.safetyLine),
        prompts: intro.prompts === undefined ? current.prompts : intro.prompts,
        replyHours:
          intro.replyHours === undefined
            ? current.replyHours
            : intro.replyHours,
        frameRequired:
          body.frameRequired === undefined
            ? current.frameRequired
            : widgetFrameRequired(body.frameRequired),
        verifiedDomains: current.verifiedDomains,
        pendingDomains: current.pendingDomains,
      };
      if (
        next.hostedPage &&
        !current.hostedPage &&
        body.hostedPageAvailable !== true
      )
        throw new HttpError(
          409,
          "Hosted support pages are unavailable on this site.",
        );
      // Requiring frame mode needs it on at Templ; turning it off always
      // works.
      if (
        next.frameRequired &&
        !current.frameRequired &&
        body.frameAvailable !== true
      )
        throw frameUnavailable();
      // Turning the visitor check on needs Templ's keys and switch; turning
      // it off always works.
      if (
        next.guestCheck === "turnstile" &&
        current.guestCheck !== "turnstile" &&
        body.guestCheckAvailable !== true
      )
        throw new HttpError(
          409,
          "Templ has paused this check for now.",
          undefined,
          "guest-check-unavailable",
        );
      // Every remembered member signs in again when the manager asks or
      // remembered sign-in is turned off.
      const reason: EpochReason | null =
        body.endSessions === true
          ? "manager"
          : current.remember && !next.remember
            ? "remember-off"
            : null;
      if (body.endSessions !== undefined && body.endSessions !== true)
        throw new HttpError(400, "Invalid widget settings.");
      if (reason) next.rememberEpoch = current.rememberEpoch + 1;
      const changes: Omit<
        WidgetAuditEntry,
        "seq" | "actor" | "authenticatedAt" | "at"
      >[] = [];
      if (updatedAppearance?.changed)
        changes.push({
          action: "widget.appearance",
          before: { appearanceRevision: current.appearanceRevision },
          after: { appearanceRevision: next.appearanceRevision },
        });
      if (JSON.stringify(current.origins) !== JSON.stringify(next.origins))
        changes.push({
          action: "widget.origins",
          before: { origins: current.origins },
          after: { origins: next.origins },
        });
      if (current.minimumLevel !== next.minimumLevel)
        changes.push({
          action: "widget.level",
          before: { minimumLevel: current.minimumLevel },
          after: { minimumLevel: next.minimumLevel },
        });
      if (current.hostedPage !== next.hostedPage)
        changes.push({
          action: "widget.hosted-page",
          before: { hostedPage: current.hostedPage },
          after: { hostedPage: next.hostedPage },
        });
      if (body.walletIdentification !== undefined && !next.walletIdentification)
        throw new HttpError(400, "Choose the wallet verification settings.");
      if (next.walletIdentification && JSON.stringify(current.walletIdentification) !== JSON.stringify(next.walletIdentification))
        changes.push({ action: "widget.wallet-identification", before: current.walletIdentification, after: next.walletIdentification });
      if (current.walletFallback !== next.walletFallback)
        changes.push({
          action: "widget.wallet-fallback",
          before: { walletFallback: current.walletFallback },
          after: { walletFallback: next.walletFallback },
        });
      if (current.askPerson !== next.askPerson)
        changes.push({
          action: "widget.ask-person",
          before: { askPerson: current.askPerson },
          after: { askPerson: next.askPerson },
        });
      if (current.remember !== next.remember)
        changes.push({
          action: "widget.remember",
          before: { remember: current.remember },
          after: { remember: next.remember },
        });
      if (reason)
        changes.push({
          action: "widget.sessions-ended",
          before: { rememberEpoch: current.rememberEpoch },
          after: { rememberEpoch: next.rememberEpoch, reason },
        });
      if (current.guestCheck !== next.guestCheck)
        changes.push({
          action: "widget.guest-check",
          before: { guestCheck: current.guestCheck },
          after: { guestCheck: next.guestCheck },
        });
      if (current.safetyLine !== next.safetyLine)
        changes.push({
          action: "widget.safety-line",
          before: { safetyLine: current.safetyLine },
          after: { safetyLine: next.safetyLine },
        });
      if (
        JSON.stringify(current.prompts) !== JSON.stringify(next.prompts) ||
        current.replyHours !== next.replyHours
      )
        changes.push({
          action: "widget.intro",
          before: {
            questions: current.prompts?.length ?? 0,
            replyHours: current.replyHours,
          },
          after: {
            questions: next.prompts?.length ?? 0,
            replyHours: next.replyHours,
          },
        });
      if (current.frameRequired !== next.frameRequired)
        changes.push({
          action: "widget.frame",
          before: { frameRequired: current.frameRequired },
          after: { frameRequired: next.frameRequired },
        });
      const outbox = checkedOutbox(await local.get(WIDGET_AUDIT_KEY));
      // Every change reaches the log: with the outbox full or unreadable, a
      // change waits until the room has taken what is pending.
      if (
        changes.length &&
        (!outbox ||
          outbox.entries.length + changes.length > WIDGET_AUDIT_OUTBOX)
      )
        throw new HttpError(
          503,
          "Widget settings are catching up. Try again shortly.",
          undefined,
          "widget-audit-busy",
        );
      requireConnectDeadline(body.approvalExpiresAt);
      await local.put("widget-config", shown(next));
      if (updatedAppearance?.changed)
        await local.put(WIDGET_APPEARANCE_KEY, {
          revision: next.appearanceRevision,
          value: next.appearance,
        });
      let audit = outbox?.entries ?? [];
      if (changes.length && outbox) {
        audit = [
          ...outbox.entries,
          ...changes.map(
            (change, index) =>
              ({
                ...change,
                seq: outbox.next + index,
                actor,
                authenticatedAt: body.authenticatedAt as number | null,
                at: now,
              }) as WidgetAuditEntry,
          ),
        ];
        await local.put(WIDGET_AUDIT_KEY, {
          schema: 1,
          next: outbox.next + changes.length,
          entries: audit,
        } satisfies WidgetAuditOutbox);
      }
      const marked =
        !current.origins.length && next.origins.length > 0
          ? await markWorkspaceStep(local, "widget_site_approved", now)
          : false;
      return { response: json({ ...shown(next), audit }), marked };
    }
    if (body.op === "open") {
      if (!saved) await local.put("widget-config", shown(current));
      const outbox = checkedOutbox(await local.get(WIDGET_AUDIT_KEY));
      return {
        response: json({ ...shown(current), audit: outbox?.entries ?? [] }),
        marked: false,
      };
    }
    if (body.op === "audit-ack") {
      if (!natural(body.upTo))
        throw new HttpError(400, "Invalid widget settings.");
      const upTo = body.upTo;
      const outbox = checkedOutbox(await local.get(WIDGET_AUDIT_KEY));
      if (outbox && outbox.entries.some((entry) => entry.seq <= upTo))
        await local.put(WIDGET_AUDIT_KEY, {
          ...outbox,
          entries: outbox.entries.filter((entry) => entry.seq > upTo),
        } satisfies WidgetAuditOutbox);
      return { response: json({ ok: true }), marked: false };
    }
    if (body.op === "refusals")
      return {
        response: json(
          await readWidgetOriginRefusals(local, {
            days: refusalWindowDays(body.days),
            nowMs: now,
          }),
        ),
        marked: false,
      };
    if (body.op !== "read" || typeof body.origin !== "string")
      throw new HttpError(400, "Invalid widget settings.");
    // The first load from a valid website counts once per workspace.
    const marked =
      saved && widgetWebsiteOrigin(body.origin, true)
        ? await markWorkspaceStep(local, "widget_seen", now)
        : false;
    return {
      response: json({
        ...shown(current),
        ...(flags.length ? { workspaceFlags: flags } : {}),
        known: Boolean(saved),
        ...((await widgetClosed(local)) ? { closed: true } : {}),
      }),
      marked,
    };
  });
}
/** Settings as the settings object answers them: the sign-in fields only
 * where they differ from their defaults. */
function shown(settings: Required<WidgetSettings>): WidgetSettings {
  const {
    appearance,
    walletIdentification,
    appearanceRevision,
    appearanceUnavailable,
    hostedPage,
    walletFallback,
    askPerson,
    remember,
    rememberEpoch,
    guestCheck,
    safetyLine,
    prompts,
    replyHours,
    frameRequired,
    verifiedDomains,
    pendingDomains,
    ...rest
  } = settings;
  return {
    ...rest,
    ...(walletIdentification ? { walletIdentification } : {}),
    ...(appearanceRevision > 0 ? { appearance, appearanceRevision } : {}),
    ...(appearanceUnavailable ? { appearanceUnavailable } : {}),
    ...(hostedPage ? { hostedPage } : {}),
    ...(walletFallback ? {} : { walletFallback }),
    ...(askPerson ? {} : { askPerson }),
    ...(remember ? {} : { remember }),
    ...(rememberEpoch ? { rememberEpoch } : {}),
    ...(guestCheck === "turnstile" ? { guestCheck } : {}),
    ...(safetyLine ? { safetyLine } : {}),
    ...(prompts === null ? {} : { prompts }),
    ...(replyHours === null ? {} : { replyHours }),
    ...(frameRequired ? { frameRequired } : {}),
    ...(verifiedDomains.length ? { verifiedDomains } : {}),
    ...(pendingDomains.length ? { pendingDomains } : {}),
  };
}
/** Appends a change made outside a settings save to the
 * access log outbox, as the save does, and returns what waits for the
 * room. A full or unreadable outbox refuses the change. */
async function appendWidgetAudit(
  local: DurableObjectTransaction,
  changes: Omit<WidgetAuditEntry, "seq" | "actor" | "authenticatedAt" | "at">[],
  actor: ChatPrincipalId | null,
  authenticatedAt: number | null,
  now: number,
): Promise<WidgetAuditEntry[]> {
  const outbox = checkedOutbox(await local.get(WIDGET_AUDIT_KEY));
  if (!changes.length || !actor) return outbox?.entries ?? [];
  if (!outbox || outbox.entries.length + changes.length > WIDGET_AUDIT_OUTBOX)
    throw new HttpError(
      503,
      "Widget settings are catching up. Try again shortly.",
      undefined,
      "widget-audit-busy",
    );
  const entries = [
    ...outbox.entries,
    ...changes.map(
      (change, index) =>
        ({
          ...change,
          seq: outbox.next + index,
          actor,
          authenticatedAt,
          at: now,
        }) as WidgetAuditEntry,
    ),
  ];
  await local.put(WIDGET_AUDIT_KEY, {
    schema: 1,
    next: outbox.next + changes.length,
    entries,
  } satisfies WidgetAuditOutbox);
  return entries;
}
function widgetConfigRequest(env: Env, room: string, body: unknown) {
  return timed(
    env,
    "config",
    env.AUTH_RECORDS.get(
      env.AUTH_RECORDS.idFromName(
        `${config(env).namespace}:widget-config:${room}`,
      ),
    ).fetch(internal("/widget-config", body)),
  );
}
/** Reads the AuthRecord snapshot only. A caller already holding this room's
 * transaction must resolve current flags from that transaction before use. */
export function widgetConfigSnapshot(env: Env, room: string, origin: string) {
  return widgetConfigRequest(env, room, { op: "read", origin });
}
export async function widgetConfig(
  env: Env,
  room: string,
  body:
    | { op: "open" }
    | { op: "read"; origin: string }
    | {
        op: "save";
        initializeOnly?: boolean;
        /** A worker-bound connect request deadline, checked within the save. */
        approvalExpiresAt?: number;
        origins?: unknown;
        minimumLevel?: unknown;
        hostedPage?: unknown;
        hostedPageAvailable?: boolean;
        walletIdentification?: WalletIdentification;
        walletFallback?: unknown;
        askPerson?: unknown;
        /** Remembered sign-in, the sign-out-all action and the visitor
         * check, with what the worker knows about Templ's own switches. */
        remember?: unknown;
        endSessions?: unknown;
        guestCheck?: unknown;
        safetyLine?: unknown;
        appearance?: unknown;
        appearanceRevision?: unknown;
        prompts?: unknown;
        replyHours?: unknown;
        widgetIntroAvailable?: boolean;
        frameRequired?: unknown;
        loopback?: boolean;
        guestCheckAvailable?: boolean;
        frameAvailable?: boolean;
        actor: ChatPrincipalId | undefined;
        authenticatedAt: number | null;
      }
    | { op: "refusals"; days: number }
    | { op: "audit-ack"; upTo: number }
    // Verified domains (domain-verify.ts).
    | {
        op: "domain-add" | "domain-remove" | "domain-result";
        [field: string]: unknown;
      },
) {
  const requestBody =
    (body.op as string) === "install-check-create"
      ? { ...body, loopback: loopbackOffered(env as WidgetSessionEnv) }
      : body;
  const response = await widgetConfigRequest(env, room, requestBody);
  if (response.ok && body.op === "save" && body.hostedPage === true) {
    const settings = await response.clone().json<Record<string, unknown>>();
    for (const row of checkedDomainRows(settings).verifiedDomains)
      await indexSupportDomain(env, row.domain, room);
  }
  if (response.ok && body.op === "read") {
    const settings = await response
      .clone()
      .json<{ workspaceFlags?: WorkspaceFlag[] }>();
    if (
      settings.workspaceFlags?.some(
        (flag) =>
          flag.key === "rememberSignIn" ||
          flag.key === "emailNotices" ||
          OWN_TRIAL_FEATURES.has(flag.key),
      )
    ) {
      const current = await roomFlags(env, room, { op: "read" });
      return new Response(
        JSON.stringify({ ...settings, workspaceFlags: current.flags }),
        { status: response.status, headers: response.headers },
      );
    }
  }
  return response;
}

export function matchesWidgetScope(data: AuthData, scope?: WidgetScope) {
  return data.widgetScope
    ? data.purpose === "widget-session" &&
        sameWidgetScope(data.widgetScope, scope)
    : !scope;
}

export function sessionLevel(
  data: Pick<AuthData, "authMethod" | "guestClaim" | "walletConsent">,
): SupportAccessLevel {
  return data.authMethod === "guest"
    ? data.walletConsent === true && data.guestClaim
      ? "connected"
      : "anonymous"
    : "signed";
}

const CLAIM_REFUSED = {
  "invalid-network":
    "Your wallet reported a network Templ can't read. Reconnect it and try again.",
  "invalid-claim":
    "Templ can't read this wallet. Connect it again and try again.",
} as const;
/** The wallet a guest's app reported: an EVM account on any EIP-155 chain,
 * or a Solana account. It is kept as a claim only; it proves nothing. */
function guestClaim(value: unknown): WidgetWallet {
  const claim = parseWidgetWalletClaim(value);
  if (!claim.ok)
    throw new HttpError(
      400,
      CLAIM_REFUSED[claim.reason],
      undefined,
      claim.reason,
    );
  return claim.wallet;
}
/** A signed challenge that doesn't match what this widget issued: edited,
 * from another site or workspace, or redeemed without the guest's own
 * bearer. */
const challengeMismatch = () =>
  new HttpError(
    401,
    "Signature does not match this support sign-in.",
    undefined,
    "challenge-mismatch",
  );

const roomStub = (env: Env, room: string) =>
  env.ROOMS.get(env.ROOMS.idFromName(`native-room:${nativeRoomId(room)}`));

/** A bearer header as sent: absent, malformed, or a session read already
 * started. Its result is judged only where the route checks the bearer. */
type BearerRead =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "read"; token: string; read: Promise<Response> };
function bearerToken(request: Request) {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  return /^Bearer ([0-9a-f]{64})$/.exec(header)?.[1] ?? "";
}
function startBearer(request: Request, env: Env): BearerRead {
  const token = bearerToken(request);
  if (token === null) return { kind: "none" };
  if (!token) return { kind: "malformed" };
  return {
    kind: "read",
    token,
    read: started(
      (async () =>
        (await record(env, "session", token)).fetch(internal("/read")))(),
    ),
  };
}
/** The scoped bearer on this request, or null when none was sent. A bearer
 * that is sent but unusable is an error, never silently ignored. */
async function bearerSession(
  bearer: BearerRead,
  scope: WidgetScope,
): Promise<{ token: string; session: AuthData } | null> {
  if (bearer.kind === "none") return null;
  if (bearer.kind === "malformed")
    throw new HttpError(401, "Sign in with your wallet to contact support.");
  const stored = await bearer.read;
  if (!stored.ok)
    throw new HttpError(
      stored.status === 401 ? 401 : 503,
      "Sign in with your wallet again.",
    );
  const session = await stored.json<AuthData>();
  if (!session.widgetScope || !matchesWidgetScope(session, scope))
    throw new HttpError(401, "This sign-in belongs to another support widget.");
  return { token: bearer.token, session };
}

/** A guest credential's record: from its shard, or, for a credential stored
 * in its own per-token object, from there. `carry` is that per-token record,
 * copied into the shard when the guest resumes. */
async function readGuest(env: Env, credential: string) {
  const stored = await (
    await record(env, "guest", credential)
  ).fetch(internal("/read"));
  if (stored.status !== 401) return { stored, carry: null };
  const earlier = await (
    await legacyRecord(env, "guest", credential)
  ).fetch(internal("/read"));
  if (!earlier.ok)
    return { stored: earlier.status === 401 ? stored : earlier, carry: null };
  const carry = await earlier.json<AuthData>();
  return { stored: json(carry), carry };
}
/** Notes a widget session on the guest credential that started it: in its
 * shard, or, for a `carry` record, in the shard copy made now. */
async function noteGuestSession(
  env: Env,
  credential: string,
  carry: AuthData | null,
  session: GuestSession,
  /** The wallet the guest shares from now on; null stops sharing it. */
  claim?: WidgetWallet | null,
): Promise<Response> {
  const shard = await record(env, "guest", credential);
  if (carry) {
    const created = await shard.fetch(
      internal("/create", {
        ...carry,
        ...(claim
          ? {
              guestClaim: claim,
              walletConsent: true as const,
              walletUnavailable: undefined,
            }
          : claim === null
            ? { guestClaim: undefined, walletConsent: undefined }
            : {}),
        sessions: [...(carry.sessions ?? []), session],
      } satisfies AuthData),
    );
    if (created.ok)
      defer(env, async () => {
        await (
          await legacyRecord(env, "guest", credential)
        ).fetch(internal("/revoke"));
      });
    if (created.status !== 409) return created;
  }
  return shard.fetch(
    internal("/guest/session", {
      ...session,
      ...(claim
        ? { guestClaim: claim, walletConsent: true }
        : claim === null
          ? { stopSharing: true }
          : {}),
    }),
  );
}

/** A guest credential the protocol's page held, moved into
 * Templ's frame for the same workspace and website. The old credential is
 * consumed first, so it ends everywhere and two tabs can't both move it, and
 * every widget session and socket it started on the page ends with it. The
 * new one keeps the account, the visitor check mark and the original expiry.
 * Only a credential made on the page moves: a page script can plant any
 * value in the page's storage, so a credential made in a frame is refused
 * rather than shared with whoever planted it. No session is made here: the
 * frame resumes with the credential as it always does. */
async function adoptGuest(
  env: Env,
  input: {
    read: Awaited<ReturnType<typeof readGuest>> | null;
    credential: string;
    scope: WidgetScope;
  },
): Promise<{ credential: string; principalId: string; adopted: true }> {
  const expired = () =>
    new HttpError(401, "Start a new case.", undefined, "guest-expired");
  const stored = input.read?.stored;
  if (!stored || (!stored.ok && stored.status !== 401))
    throw new HttpError(503, "Support is unavailable. Try again.");
  const seen = stored.ok ? await stored.json<AuthData>() : null;
  if (!seen || seen.purpose !== "widget-guest") throw expired();
  const inline = { room: input.scope.room, origin: input.scope.origin };
  if (!input.scope.frame || !sameWidgetScope(seen.widgetScope, inline))
    throw expired();
  const source = await (input.read!.carry ? legacyRecord : record)(
    env,
    "guest",
    input.credential,
  );
  const next = await rotateGuestCredential(env, source, inline, input.scope);
  return {
    credential: next.credential,
    principalId: next.principalId,
    adopted: true,
  };
}

/** Rotates the existing guest record and ends every session it issued. */
async function rotateGuestCredential(
  env: Env,
  source: { fetch(request: Request): Promise<Response> },
  previous: WidgetScope,
  scope: WidgetScope,
) {
  const expired = () =>
    new HttpError(401, "Start a new case.", undefined, "guest-expired");
  const consumed = await source.fetch(internal("/consume"));
  if (!consumed.ok) {
    await consumed.body?.cancel();
    if (consumed.status === 401) throw expired();
    throw new HttpError(503, "Support is unavailable. Try again.");
  }
  const guest = await consumed.json<AuthData>();
  const principalId = normalizeChatPrincipal(guest.principalId);
  if (
    !principalId ||
    guest.purpose !== "widget-guest" ||
    !sameWidgetScope(guest.widgetScope, previous) ||
    !(guest.expiresAt > Date.now())
  )
    throw expired();
  const credential = randomToken();
  const target = await record(env, "guest", credential);
  const ok = (result: PromiseSettledResult<Response>) =>
    result.status === "fulfilled" && result.value.ok;
  const [created, ...ended] = await Promise.allSettled([
    target.fetch(
      internal("/create", {
        address: null,
        principalId,
        purpose: "widget-guest",
        widgetScope: scope,
        expiresAt: guest.expiresAt,
        ...(guest.guestCheck ? { guestCheck: guest.guestCheck } : {}),
        ...(guest.walletConsent === true && guest.guestClaim
          ? { guestClaim: guest.guestClaim, walletConsent: true as const }
          : {}),
        ...(guest.walletUnavailable ? { walletUnavailable: true } : {}),
      } satisfies AuthData),
    ),
    ...(guest.sessions ?? []).map((session) =>
      recordByHash(env, "session", session.hash).fetch(
        internal("/end", { expiresAt: session.expiresAt }),
      ),
    ),
  ]);
  if (!ok(created) || !ended.every(ok)) {
    // The page keeps its credential for the next try.
    if (ok(created)) defer(env, () => target.fetch(internal("/revoke")));
    await source.fetch(internal("/create", guest));
    throw new HttpError(503, "Support is unavailable. Try again.");
  }
  endSockets(env, scope.room, principalId, previous.origin);
  return { credential, principalId, guest };
}
async function resumeGuestLink(
  env: Env,
  input: {
    room: string;
    origin: string;
    scope: WidgetScope;
    hosted: boolean;
    minimumLevel: SupportMinimumLevel;
    walletFallback: boolean;
    body: Record<string, unknown>;
  },
) {
  const { thread, token } = input.body;
  if (
    typeof thread !== "string" ||
    !/^tc-[0-9a-f]{32}$/.test(thread) ||
    typeof token !== "string" ||
    !/^[0-9a-f]{64}$/.test(token)
  )
    throw new HttpError(404, "Support link not found.");
  const room = env.ROOMS.get(env.ROOMS.idFromName(`native-room:${input.room}`));
  const tokenHash = await sha256Hex(token);
  const route = async (op: string, body: Record<string, unknown>) => {
    const response = await room.fetch(
      internal(`/private/support/alerts/${op}`, { thread, tokenHash, ...body }),
    );
    const data = await response.json<Record<string, unknown>>();
    if (!response.ok)
      throw new HttpError(
        response.status,
        typeof data.error === "string"
          ? data.error
          : "This support link expired.",
      );
    return data;
  };
  const found = await route("guest-resume", {
    origin: input.origin,
    hosted: input.hosted,
  });
  const source = recordByHash(env, "guest", found.credentialHash as string);
  const read = await source.fetch(internal("/read"));
  if (!read.ok) throw new HttpError(410, "This support link expired.");
  const guest = await read.json<AuthData>();
  if (
    guest.principalId !== found.principal ||
    guest.widgetScope?.room !== input.room ||
    guest.widgetScope.origin !== found.origin
  )
    throw new HttpError(404, "Support link not found.");
  // The wallet the guest's app reported when they started is still only a
  // claim: it lets a guest back in where an attached wallet is enough.
  const claim =
    guest.walletConsent === true
      ? readStoredWidgetWallet(guest.guestClaim)
      : null;
  if (
    input.minimumLevel !== "anyone" &&
    !(input.walletFallback && guest.walletUnavailable) &&
    !(input.minimumLevel === "connected" && claim)
  )
    throw new HttpError(403, LEVEL_REQUIRED[input.minimumLevel]);
  await route("guest-resume", {
    origin: input.origin,
    hosted: input.hosted,
    consume: true,
    credentialHash: found.credentialHash,
  });
  let rotated: Awaited<ReturnType<typeof rotateGuestCredential>>;
  try {
    rotated = await rotateGuestCredential(
      env,
      source,
      guest.widgetScope,
      input.scope,
    );
  } catch (error) {
    await route("guest-rotation-failed", {}).catch(() => undefined);
    throw error;
  }
  const credentialHash = await sha256Hex(rotated.credential);
  await route("guest-rotated", { credentialHash, origin: input.origin });
  const sessionToken = randomToken(),
    expiresAt = Date.now() + SESSION_MS;
  const session: AuthData = {
    address: null,
    principalId: rotated.principalId,
    servicePrincipals: [rotated.principalId],
    authMethod: "guest",
    guestCredentialHash: credentialHash,
    authenticatedAt: Date.now(),
    expiresAt,
    authorizationExpiresAt: expiresAt,
    walletRevision: 0,
    purpose: "widget-session",
    widgetScope: input.scope,
    ...(claim ? { guestClaim: claim, walletConsent: true as const } : {}),
    ...(guest.walletUnavailable ? { walletUnavailable: true } : {}),
  };
  const sessionRecord = await record(env, "session", sessionToken);
  const created = await sessionRecord.fetch(internal("/create", session));
  const noted = await noteGuestSession(env, rotated.credential, null, {
    hash: await sha256Hex(sessionToken),
    expiresAt,
  });
  if (!created.ok || !noted.ok) {
    await sessionRecord.fetch(internal("/end", { expiresAt }));
    throw new HttpError(503, "Support is unavailable. Try again.");
  }
  return {
    token: sessionToken,
    expiresAt,
    principalId: rotated.principalId,
    servicePrincipals: [rotated.principalId],
    credential: rotated.credential,
    level: sessionLevel(session),
    thread,
  };
}

/** Browser preflights for (workspace, site) pairs a settings read in this
 * isolate approved during the last minute. Only OPTIONS answers use it: a
 * preflight only lets the browser attempt the real request, and every real
 * request reads the settings again. A read that refuses the site drops it. */
const PREFLIGHT_MEMO_MS = 60_000;
const PREFLIGHT_MEMO_SIZE = 1024;
const preflightMemo = new Map<string, number>();
function preflightApproved(key: string) {
  const until = preflightMemo.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  preflightMemo.delete(key);
  return false;
}
function rememberPreflight(key: string, approved: boolean) {
  preflightMemo.delete(key);
  if (!approved) return;
  if (preflightMemo.size >= PREFLIGHT_MEMO_SIZE)
    preflightMemo.delete(preflightMemo.keys().next().value!);
  preflightMemo.set(key, Date.now() + PREFLIGHT_MEMO_MS);
}
const preflight = () =>
  new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": `Content-Type, Authorization, ${PRINCIPAL_HINT_HEADER}, X-Templ-Widget, ${WIDGET_HOST_ORIGIN_HEADER}`,
      "Access-Control-Max-Age": "7200",
    },
  });

const READABLE =
  /^\/conversations(?:\/status|\/tc-[0-9a-f]{32}(?:\/messages|\/workflow)?)?$/;
/** Workflow actions a widget member may send: share details, answer "Did
 * this solve it?" and ask for a person. Every other action is the team's;
 * the room still checks that the sender is the thread's member. */
const WIDGET_WORKFLOW_ACTIONS: readonly unknown[] = [
  "context",
  "confirm",
  "ask-person",
  "guest-email",
];
const WRITABLE =
  /^\/conversations\/(?:join|ask|tc-[0-9a-f]{32}\/(?:messages|resolve|stop|workflow))$/;
/** More member routes a widget session may reach, by method. Each still goes
 * through the room's own checks as the thread's member. */
const WIDGET_FEATURE_ROUTES: readonly {
  method: "GET" | "POST";
  path: RegExp;
}[] = [
  // Customer-origin clients use the same scoped member session. These
  // routes grant no staff role, recovery authority or private key.
  { method: "GET", path: /^\/conversations\/encryption$/ },
  { method: "POST", path: /^\/conversations\/encryption\/prepare$/ },
  // The Own endpoint's signed revocation removes access only. A native
  // member bearer alone cannot revoke or enroll a decryption device.
  { method: "POST", path: /^\/conversations\/encryption\/revoke-device$/ },
  { method: "GET", path: /^\/conversations\/tc-[0-9a-f]{32}\/encryption\/[1-9][0-9]{0,7}(?:\/(?:directory|history|outcome|control|contact))?$/ },
  { method: "POST", path: /^\/conversations\/tc-[0-9a-f]{32}\/encryption\/[1-9][0-9]{0,7}\/(?:enroll|fence|revoke|contact)$/ },
  // Install check results from a scoped member.
  // The token binds the member to the manager’s check.
  { method: "POST", path: /^\/install-check$/ },
  { method: "POST", path: /^\/conversations\/tc-[0-9a-f]{32}\/outcome$/ },
  { method: "GET", path: /^\/conversations\/tc-[0-9a-f]{32}\/guest-email$/ },
  { method: "POST", path: /^\/conversations\/tc-[0-9a-f]{32}\/guest-email$/ },
  // Remembered sign-in and guest resume routes.
  // The member's socket ticket (widget-live.ts). The
  // room issues it for the member's own threads only.
  { method: "POST", path: /^\/conversations\/live$/ },
  // The member's reply-email ticket and reply-email preference. The room
  // answers both to signed members only and lets the widget turn reply
  // emails off, never on.
  { method: "POST", path: /^\/conversations\/alert-ticket$/ },
  { method: "GET", path: /^\/conversations\/preferences$/ },
  { method: "POST", path: /^\/conversations\/preferences$/ },
  // The member's widget showed the notice line about
  // Templ's de-identified copy. The room keeps the first time per version.
  { method: "POST", path: /^\/conversations\/notice$/ },
];
const readablePath = (path: string) =>
  READABLE.test(path) ||
  WIDGET_FEATURE_ROUTES.some(
    (route) => route.method === "GET" && route.path.test(path),
  );
const writablePath = (path: string) =>
  WRITABLE.test(path) ||
  WIDGET_FEATURE_ROUTES.some(
    (route) => route.method === "POST" && route.path.test(path),
  );

type WidgetReads = {
  bearer: BearerRead;
  body?: Promise<Record<string, unknown>>;
  /** A member screenshot's bytes, read like a body. */
  upload?: Promise<{ bytes: Uint8Array; clientId: string }>;
  guest?: Promise<Awaited<ReturnType<typeof readGuest>> | null>;
};
/** Reads a route will need, started with the settings read. A POST's body
 * is read in full first, within the route's size cap: the session, identity
 * and safety reads start only once it has arrived, so a sign-out or
 * suspension that completes while the body is still uploading applies to
 * this request. Nothing here decides anything or writes: each result, the
 * body's included, is judged after the checks that come before it. */
async function startWidgetReads(
  request: Request,
  env: Env,
  room: string,
  path: string,
): Promise<WidgetReads> {
  const post = request.method === "POST";
  if (post && path === "/install-check/fixture") {
    const body = started(readJson(request));
    await body.catch(() => undefined);
    return { body, bearer: { kind: "none" } };
  }
  if (post && path === "/auth/guest") {
    const body = started(readJson(request));
    const guest = started(
      body.then((value) =>
        typeof value.credential === "string" &&
        /^[0-9a-f]{64}$/.test(value.credential)
          ? readGuest(env, value.credential)
          : null,
      ),
    );
    return { body, guest, bearer: { kind: "none" } };
  }
  if (
    request.method === "OPTIONS" ||
    (request.method === "GET" && path === "/auth/policy")
  )
    return { bearer: { kind: "none" } };
  // A remembered sign-in is its own credential: any bearer sent with it is
  // ignored, so resuming never moves a guest's thread.
  if (
    post &&
    (path === "/auth/resume" ||
      path === "/auth/forget" ||
      path === "/auth/guest-link")
  ) {
    const body = started(readJson(request));
    await body.catch(() => undefined);
    return { body, bearer: { kind: "none" } };
  }
  const writable = post && writablePath(path);
  const conversation =
    (request.method === "GET" && readablePath(path)) || writable;
  // The room's record decides no access, so it is read alongside the body.
  if (conversation && bearerToken(request)) prefetchNativeRoom(env, room);
  // A member screenshot's bytes are read in full first,
  // within the member limit, the way a JSON body is.
  const upload =
    isScreenshotUpload(path, request) &&
    screenshotsOffered(env as MemberScreenshotEnv)
      ? started(readScreenshotUpload(request, new URL(request.url)))
      : undefined;
  if (upload) await upload.catch(() => undefined);
  const body =
    !upload &&
    (writable ||
      (post &&
        [
          "/auth/nonce",
          "/auth/verify",
          "/auth/share-wallet",
          "/auth/unlink-wallet",
          "/auth/resume",
          "/auth/forget",
          "/auth/logout",
        ].includes(path)))
      ? started(writable ? readSupportJson(request, path, 24_000) : readJson(request))
      : undefined;
  if (body) await body.catch(() => undefined);
  const bearer = startBearer(request, env);
  if (bearer.kind === "read" && conversation) {
    const roomKey = `room:${room}`;
    requestPrefetch(env).safetyTarget = roomKey;
    const hint = principalHint(
      request.headers.get(PRINCIPAL_HINT_HEADER),
      normalizeChatPrincipal,
    );
    if (hint) {
      prefetchSessionIdentity(env, hint[0]);
      prefetchSafety(env as SafetyEnv, roomKey, hint[0], hint);
    }
  }
  return { body, bearer, upload };
}

/** Only the member ticket surface accepts the scoped bearer. It never becomes
 * an ambient app cookie and cannot confer staff or management authority. */
async function readOwnWidgetMode(env: Env, room: string, origin: string) {
  if (env.TEMPL_SUPPORT_WORKSPACE !== room ||
      (origin !== env.APP_ORIGIN && origin !== OWN_SUPPORT_ENDPOINT.clientOrigin)) return;
  const response = await roomStub(env, room).fetch(internal("/private/support/own-new-chat-mode", {}));
  if (!response.ok) return;
  const { mode } = await response.json<{ mode?: string }>();
  if (mode === "standard" || mode === "encrypted") return mode;
}

export async function supportWidgetRoute(
  request: Request,
  env: Env,
  forward: (request: Request, env: WidgetEnv) => Promise<Response>,
  deps: { verifySessionAuthority?: typeof verifySessionAuthority } = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/widget/")) return null;
  const match = /^\/widget\/([^/]+)(\/.*)$/.exec(url.pathname);
  // The visitor check's page is framed by the website, so it carries no
  // Origin header; it names the website in its query instead.
  if (match?.[2] === "/check" && NATIVE_UUID.test(match[1]))
    return guestCheckRoute(request, env, match[1], url);
  let origin = request.headers.get("Origin") ?? "";
  // From Templ's frame, the website is the page the frame
  // names, and CORS answers the frame (widget-frame.ts).
  let frame = false;
  let corsOrigin = origin;
  let allowed = false;
  let response: Response;
  try {
    if (!match || !NATIVE_UUID.test(match[1]))
      throw new HttpError(404, "Widget not found.");
    const [, room, requestedPath] = match;
    const ownWallet = /^\/auth\/own-encrypted\/(nonce|verify)$/.test(requestedPath);
    const path = ownWallet ? requestedPath.replace("/own-encrypted/", "/") : requestedPath;
    const limiter = path.startsWith("/auth/")
      ? env.AUTH_RATE_LIMITER
      : isScreenshotUpload(path, request)
        ? env.MEDIA_RATE_LIMITER
        : request.method === "GET" || request.method === "OPTIONS"
          ? env.CHAT_READ_RATE_LIMITER
          : env.CHAT_RATE_LIMITER;
    if (
      !limiter ||
      !(
        await timed(
          env,
          "limit",
          limiter.limit({
            key: request.headers.get("CF-Connecting-IP") ?? "unknown",
          }),
        )
      ).success
    )
      throw new HttpError(
        429,
        "Too many requests. Try again shortly.",
        path.startsWith("/auth/") ? 60 : undefined,
      );
    env = await releaseActivationEnv(env);
    const requested = widgetRequestOrigin(request, env as WidgetFrameEnv, url);
    origin = requested.origin;
    frame = requested.frame;
    corsOrigin = frame ? requested.frameOrigin! : origin;
    const scope = widgetScopeFor(room, origin, frame);
    const memoKey = `${config(env).namespace}|${room}|${origin}`;
    // A frame preflight names no website; it grants nothing, and every real
    // frame request reads the settings for the website it names.
    if (request.method === "OPTIONS" && frame) {
      allowed = true;
      admitFunnelRequest(env);
      response = preflight();
    } else if (request.method === "OPTIONS" && preflightApproved(memoKey)) {
      allowed = true;
      admitFunnelRequest(env);
      response = preflight();
    } else {
      const visitorReplyPolicy = path === "/auth/policy" && !frame && origin === env.APP_ORIGIN &&
        room === env.TEMPL_SUPPORT_WORKSPACE;
      const workspaceRead =
        path.startsWith("/auth/") &&
        !["/auth/logout", "/auth/forget"].includes(path)
          ? started(nativeRecord(env, room, visitorReplyPolicy))
          : null;
      const settingsRead = started(
        widgetConfig(env, room, {
          op: "read",
          origin,
        }),
      );
      const early = await startWidgetReads(request, env, room, path);
      const settings = await settingsRead;
      if (!settings.ok)
        throw new HttpError(503, "Support settings are unavailable.");
      const current = await settings.json<
        WidgetSettings & { closed?: boolean; workspaceFlags?: WorkspaceFlag[] }
      >();
      env = workspaceFeatureEnvFromFlags(
        env,
        current.workspaceFlags ?? [],
        room,
      );
      if (ownWallet && (room !== OWN_SUPPORT_ENDPOINT.workspace ||
          env.TEMPL_SUPPORT_WORKSPACE !== room || origin !== OWN_SUPPORT_ENDPOINT.clientOrigin || frame ||
          env.APP_ORIGIN !== "https://usetempl.com"))
        throw new HttpError(404, "Encrypted wallet verification is unavailable.");
      if (
        frame &&
        (!widgetFrameOrigin(env as WidgetFrameEnv) ||
          (origin === env.APP_ORIGIN && !hostedPageOffered(env)))
      )
        throw new HttpError(400, "Widget frame mode is unavailable here.");
      const { closed } = current;
      const hosted =
        hostedPageOffered(env) &&
        current.hostedPage === true &&
        origin === env.APP_ORIGIN;
      const minimumLevel = hosted ? "anyone" : current.minimumLevel;
      const walletSettings = current.walletIdentification ?? DEFAULT_WALLET_IDENTIFICATION;
      const allowsIdentification = (network: unknown) => walletSettings.enabled &&
        ((network === "evm" && walletSettings.evm) ||
        (network === "solana" && walletSettings.solana && featureOn(env, undefined, "solanaSignIn")));
      if (path === "/hosted" && request.method === "GET") {
        if (!hosted || closed)
          throw new HttpError(404, "Support page not found.");
        const descriptor = await hostedSupportDescriptor(env, room);
        if (!descriptor) throw new HttpError(404, "Support page not found.");
        return json(descriptor, 200, {
          "Access-Control-Allow-Origin": corsOrigin,
        });
      }
      const validOrigin = widgetWebsiteOrigin(
        origin,
        loopbackOffered(env as WidgetSessionEnv),
      );
      // A workspace set to be deleted answers every widget
      // request with its closed line, before the room. A valid website
      // gets it with its CORS headers so the widget can show the line; its
      // preflight still passes. Any other caller gets the same 410 with no
      // CORS headers.
      if (closed && !validOrigin) throw workspaceClosedError();
      rememberPreflight(memoKey, validOrigin);
      if (!validOrigin)
        throw new HttpError(
          403,
          "Open this support widget on an HTTPS website.",
        );
      if (!closed && workspaceRead) {
        await workspaceRead;
        requestPrefetch(env).native = { id: room, read: workspaceRead };
      }
      allowed = true;
      if (closed && request.method !== "OPTIONS") throw workspaceClosedError();
      // A workspace that requires frame mode.
      const frameRefusal = frameRequirement({
        frameRequired: current.frameRequired === true,
        frame,
        frameOrigin: requested.frameOrigin,
        path,
        method: request.method,
      });
      if (frameRefusal) throw frameRefusal;
      if (ownWallet && request.method !== "OPTIONS") {
        // A new edge can reach an older room during rollback. That room must
        // refuse before a challenge or wallet session is created; never retry
        // its legacy account-linking route. The room reads its current flag,
        // policy and admitted release, including proof-only recovery requests.
        const availability = await roomStub(env, room).fetch(
          internal("/private/support/own-encrypted-wallet-auth", { origin }),
        );
        if (!availability.ok)
          throw new HttpError(404, "Wallet verification is unavailable. You can keep this chat anonymous.");
      }
      // Past the rate limiter with a valid website: this outcome counts.
      admitFunnelRequest(env);
      // Remembered sign-in: Templ offers it, this workspace has it on, and
      // the site is an HTTPS site rather than a development origin.
      const rememberAvailable =
        rememberOffered(env as WidgetSessionEnv) &&
        current.remember !== false &&
        origin.startsWith("https://") &&
        !isLoopbackOrigin(origin);
      const rememberEpoch = Number.isSafeInteger(current.rememberEpoch)
        ? current.rememberEpoch!
        : 0;
      // A malformed build header is only left out of the build counts; a
      // revoked build must reload before it is served.
      const build = request.headers.get("X-Templ-Widget");
      if (
        request.method !== "OPTIONS" &&
        build !== null &&
        WIDGET_BUILD.test(build) &&
        REVOKED_WIDGET_BUILDS.includes(build)
      )
        throw new HttpError(
          426,
          "This support widget is out of date. Reload the page to update it.",
          undefined,
          "widget-update-required",
        );
      if (request.method === "OPTIONS") {
        response = preflight();
      } else if (
        path === "/install-check/fixture" &&
        request.method === "POST"
      ) {
        if (frame) throw new HttpError(404, "Install check not found.");
        response = await resolveInstallFixture(
          env,
          { workspace: room, origin, body: await early.body! },
          (body) => widgetConfig(env, room, body as never),
        );
      } else if (path === "/auth/policy" && request.method === "GET") {
        const chatMode = await readOwnWidgetMode(env, room, origin);
        const shownDomain = domainVerifyOffered(env as DomainVerifyEnv)
          ? verifiedDomainFor(current, origin)
          : null;
        const workspace = (await workspaceRead)?.record;
        const contacts = workspace?.supportProfiles;
        // `replyEmail`: a signed member can ask for an email
        // when the team replies; present only while email delivery is on.
        // The saved visitor requirement stays visible during an outage.
        response = json({
          minimumLevel,
          ...(current.walletIdentification ? { walletIdentification: {
            enabled: walletSettings.enabled, evm: allowsIdentification("evm"), solana: allowsIdentification("solana"),
          } } : {}),
          ...(visitorReplyPolicy && typeof workspace?.aiReplyExpected === "boolean"
            ? { aiReplyExpected: chatMode !== "encrypted" && workspace.aiReplyExpected } : {}),
          ...(chatMode === "standard" || chatMode === "encrypted" ? { chatMode } : {}),
          ...(featureOn(env, undefined, "solanaSignIn")
            ? { solanaSignIn: true }
            : {}),
          ...(env.TEMPL_SUPPORT_WORKSPACE === room
            ? { templLeadCapture: true }
            : {}),
          ...(hosted ? { hosted: true } : {}),
          ...(contacts ? {
            supportProfiles: {
              founder: contacts.founder,
              ...(contacts.teamLink ? { teamLink: contacts.teamLink } : {}),
              assistant: contacts.assistantEnabled && workspace?.supportResponderConfigured
                ? contacts.assistant : null,
            },
          } : {}),
          ...(current.walletFallback === false
            ? { walletFallback: false }
            : {}),
          ...(current.askPerson === false ? { askPerson: false } : {}),
          ...(supportNotificationsConfigured(env) ? { replyEmail: true } : {}),
          ...(current.guestCheck === "turnstile"
            ? { guestCheck: "turnstile" }
            : {}),
          // Member sockets are on: the widget may ask for a ticket.
          ...(realtimeOffered(env as WidgetSessionEnv) ? { live: true } : {}),
          // The manager's "We never DM you first." line; off unless set.
          ...(current.safetyLine === true ? { safetyLine: true } : {}),
          ...(featureOn(env, undefined, "supportDiagnostics") ? { diagnostics: true } : {}),
          ...(featureOn(env, undefined, "supportSingleConversation") ? { singleConversation: true } : {}),
          ...(featureOn(env, undefined, "supportChatFirst") ? { chatFirst: true } : {}),
          ...(featureOn(env, undefined, "supportParallelConversations") ? { newConversation: true } : {}),
          ...((current.appearanceRevision ?? 0) > 0
            ? {
                appearance:
                  publicWidgetAppearance(current.appearance ?? null, origin) ??
                  {},
              }
            : {}),
          ...(featureOn(env, undefined, "widgetIntro")
            ? {
                ...(current.prompts === null
                  ? {}
                  : { prompts: current.prompts }),
                ...(current.replyHours === null
                  ? {}
                  : { replyHours: current.replyHours }),
              }
            : {}),
          // The notice line about Templ's de-identified copy, while this
          // workspace builds one.
          ...corpusNoticeField(env as CorpusEnv, room),
          // The domain this website proved, and member
          // screenshots while Templ has them on.
          ...(shownDomain ? { verifiedDomain: shownDomain.domain } : {}),
          ...(screenshotsOffered(env as MemberScreenshotEnv)
            ? { screenshots: true }
            : {}),
        });
        // Templ checks the shown domain again at most once a day.
        if (shownDomain)
          defer(env, () =>
            recheckDomain(shownDomain, {
              config: (body) => widgetConfig(env, room, body as never),
            }),
          );
      } else if (
        path === "/auth/guest" &&
        request.method === "POST" &&
        (await early.body!).adopt !== undefined
      ) {
        // The frame moves a guest its page held into its
        // own storage, once (adoptGuest). Frame requests only.
        const body = await early.body!;
        if (body.walletConsent !== undefined && body.walletConsent !== true)
          throw new HttpError(400, "Choose whether to share the wallet.");
        if (
          body.adopt !== true ||
          !frame ||
          typeof body.credential !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.credential)
        )
          throw new HttpError(400, "Invalid support credential.");
        const adoptRead = await early.guest!;
        const adoptRecord = adoptRead?.stored.ok
          ? await adoptRead.stored.clone().json<AuthData>()
          : null;
        if (
          minimumLevel === "signed" &&
          !(
            current.walletFallback !== false &&
            adoptRecord?.walletUnavailable === true
          )
        )
          throw new HttpError(
            403,
            LEVEL_REQUIRED.signed,
            undefined,
            "access-level-required",
          );
        response = json(
          await adoptGuest(env, {
            read: await early.guest!,
            credential: body.credential,
            scope,
          }),
        );
      } else if (path === "/auth/guest" && request.method === "POST") {
        const body = await early.body!;
        if (body.walletConsent !== undefined && body.walletConsent !== true)
          throw new HttpError(400, "Choose whether to share the wallet.");
        const saved = body.credential ? await early.guest! : null;
        const stored = saved?.stored.ok
          ? await saved.stored.clone().json<AuthData>()
          : null;
        // A shared wallet comes back only while the page still reports it:
        // `reportedWallet` is a match check, never a claim or consent.
        const reported =
          body.reportedWallet === undefined || body.reportedWallet === null
            ? null
            : parseWidgetWalletClaim(body.reportedWallet);
        const heldClaim =
          stored?.walletConsent === true &&
          sameWidgetScope(stored.widgetScope, scope)
            ? readStoredWidgetWallet(stored.guestClaim)
            : null;
        const storedClaim =
          heldClaim &&
          reported?.ok &&
          formatCaip10(reported.wallet) === formatCaip10(heldClaim)
            ? heldClaim
            : null;
        if (
          body.walletUnavailable !== undefined &&
          body.walletUnavailable !== true
        )
          throw new HttpError(400, "Invalid support case.");
        const incomingClaim =
          body.walletConsent === true &&
          body.wallet !== undefined &&
          body.wallet !== null
            ? guestClaim(body.wallet)
            : undefined;
        let walletUnavailable = body.walletUnavailable === true;
        if (body.credential && !walletUnavailable && !incomingClaim) {
          walletUnavailable =
            stored?.walletUnavailable === true &&
            sameWidgetScope(stored.widgetScope, scope);
        }
        const fallback = walletUnavailable && current.walletFallback !== false;
        if (walletUnavailable && !fallback && minimumLevel !== "anyone")
          throw new HttpError(
            403,
            "This team asks you to connect your wallet.",
            undefined,
            "access-level-required",
          );
        const claim = walletUnavailable
          ? undefined
          : (incomingClaim ?? storedClaim ?? undefined);
        if (minimumLevel === "signed" && !fallback)
          throw new HttpError(
            403,
            LEVEL_REQUIRED.signed,
            undefined,
            "access-level-required",
          );
        if (minimumLevel === "connected" && !claim && !fallback)
          throw new HttpError(
            403,
            LEVEL_REQUIRED.connected,
            undefined,
            "access-level-required",
          );
        let credential: string | null = null;
        if (body.credential !== undefined && body.credential !== null) {
          if (
            typeof body.credential !== "string" ||
            !/^[0-9a-f]{64}$/.test(body.credential)
          )
            throw new HttpError(400, "Invalid support credential.");
          credential = body.credential;
        }
        const token = randomToken(),
          expiresAt = Date.now() + SESSION_MS;
        let credentialHash: string;
        const session = (principalId: ChatPrincipalId): AuthData => ({
          address: null,
          principalId,
          servicePrincipals: [principalId],
          authMethod: "guest",
          guestCredentialHash: credentialHash,
          authenticatedAt: Date.now(),
          expiresAt,
          authorizationExpiresAt: expiresAt,
          walletRevision: 0,
          purpose: "widget-session",
          widgetScope: scope,
          ...(claim ? { guestClaim: claim, walletConsent: true as const } : {}),
          ...(walletUnavailable ? { walletUnavailable: true } : {}),
        });
        const sessionRecord = await record(env, "session", token);
        let principalId: ChatPrincipalId;
        let checked = false;
        const opening = !credential && !claim && !walletUnavailable && origin === env.APP_ORIGIN;
        if (credential) {
          const read = await early.guest!;
          const stored = read!.stored;
          if (!stored.ok && stored.status !== 401)
            throw new HttpError(503, "Support is unavailable. Try again.");
          const guest = stored.ok ? await stored.json<AuthData>() : null;
          const id = normalizeChatPrincipal(guest?.principalId);
          if (
            !guest ||
            !id ||
            guest.purpose !== "widget-guest" ||
            !sameWidgetScope(guest.widgetScope, scope)
          )
            throw new HttpError(
              401,
              "Start a new case.",
              undefined,
              "guest-expired",
            );
          principalId = id;
          credentialHash = await sha256Hex(credential);
          // The session is noted on the credential beside its creation.
          // Moving the guest consumes the credential first and then ends the
          // sessions noted on it, holding each ended hash until its expiry,
          // so either this note fails or the move ends this session.
          const noted = { hash: await sha256Hex(token), expiresAt };
          const [saved, note] = await Promise.allSettled([
            sessionRecord.fetch(internal("/create", session(principalId))),
            noteGuestSession(
              env,
              credential,
              read!.carry,
              noted,
              claim ?? (heldClaim ? null : undefined),
            ),
          ]);
          const done = (result: PromiseSettledResult<Response>) =>
            result.status === "fulfilled" && result.value.ok;
          if (!done(note)) {
            defer(env, () =>
              sessionRecord.fetch(internal("/end", { expiresAt })),
            );
            const status =
              note.status === "fulfilled" ? note.value.status : 503;
            if (status === 401)
              throw new HttpError(
                401,
                "Start a new case.",
                undefined,
                "guest-expired",
              );
            if (status === 429)
              throw new HttpError(
                429,
                "Too many open support chats. Close one and try again.",
              );
            throw new HttpError(503, "Could not start a case. Try again.");
          }
          if (!done(saved))
            throw new HttpError(503, "Could not start a case. Try again.");
        } else {
          // The workspace's visitor check, for a new guest only, after the
          // site and the level passed. A required check fails closed when
          // the feature or its keys are unavailable.
          const checkOn = current.guestCheck === "turnstile";
          if (checkOn) {
            if (!guestCheckOffered(env as WidgetSessionEnv))
              throw new HttpError(
                503,
                GUEST_CHECK_COPY.unavailable,
                undefined,
                "guest-check-unavailable",
              );
            if (body.check === undefined || body.check === null)
              throw new HttpError(
                403,
                GUEST_CHECK_COPY.required,
                undefined,
                "guest-check-required",
              );
            if (
              typeof body.check !== "string" ||
              !GUEST_CHECK_TOKEN.test(body.check)
            )
              throw new HttpError(400, "Invalid visitor check.");
            await verifyGuestCheck(env as WidgetSessionEnv, body.check, {
              room,
              origin,
              hostname: url.hostname,
              frame,
            });
          }
          credential = randomToken();
          credentialHash = await sha256Hex(credential);
          principalId = newAccountId();
          const guestRecord = await record(env, "guest", credential);
          // Both records are new and independent: they are written together.
          // If one fails, the other is removed after the response.
          const [guestSaved, sessionSaved] = await Promise.allSettled([
            guestRecord.fetch(
              internal("/create", {
                address: null,
                principalId,
                purpose: "widget-guest",
                widgetScope: scope,
                expiresAt: Date.now() + GUEST_TTL,
                ...(claim
                  ? { guestClaim: claim, walletConsent: true as const }
                  : {}),
                ...(walletUnavailable ? { walletUnavailable: true } : {}),
                sessions: [{ hash: await sha256Hex(token), expiresAt }],
                ...(checkOn ? { guestCheck: "turnstile" as const } : {}),
              } satisfies AuthData),
            ),
            sessionRecord.fetch(internal("/create", session(principalId))),
          ]);
          const ok = (result: PromiseSettledResult<Response>) =>
            result.status === "fulfilled" && result.value.ok;
          if (!ok(guestSaved) || !ok(sessionSaved)) {
            if (ok(guestSaved))
              defer(env, () => guestRecord.fetch(internal("/revoke")));
            if (ok(sessionSaved))
              defer(env, () => sessionRecord.fetch(internal("/revoke")));
            for (const result of [guestSaved, sessionSaved])
              if (result.status === "rejected") throw result.reason;
            throw new HttpError(503, "Could not start a case. Try again.");
          }
          if (checkOn) checked = true;
        }
        // Read after the guest is saved. This replaces the browser's mode
        // round trip for a first send. Case admission still checks current mode.
        const newChatMode = opening
          ? await readOwnWidgetMode(env, room, origin).catch(() => undefined)
          : undefined;
        response = json({
          token,
          expiresAt,
          principalId,
          servicePrincipals: [principalId],
          credential,
          level: sessionLevel(session(principalId)),
          ...(newChatMode === "standard" ? { standardOpening: true } : {}),
          ...(claim ? { wallet: claim } : {}),
          ...(checked ? { checked: "turnstile" } : {}),
        });
      } else if (path === "/auth/guest-link" && request.method === "POST") {
        if (!supportNotificationsConfigured(env))
          throw new HttpError(404, "Support action not found.");
        response = json(
          await resumeGuestLink(env, {
            room,
            origin,
            scope,
            hosted,
            minimumLevel,
            walletFallback: current.walletFallback !== false,
            body: await early.body!,
          }),
        );
      } else if (path === "/auth/unlink-wallet" && request.method === "POST") {
        const guest = await bearerSession(early.bearer, scope);
        const body = await early.body!;
        if (guest?.session.authMethod !== "guest" || typeof body.conversation !== "string" || !/^tc-[0-9a-f]{32}$/.test(body.conversation) ||
          typeof body.address !== "string" || body.address.length > 64)
          throw new HttpError(403, "Choose a wallet from your own conversation.");
        const saved = await roomStub(env, room).fetch(internal("/private/support/unlink-wallet", {
          guest: guest.session.principalId, conversation: body.conversation, address: body.address,
        }));
        if (!saved.ok) throw new HttpError(saved.status === 403 ? 403 : 503, "Could not remove this wallet.");
        response = json({ removed: true });
      } else if (path === "/auth/share-wallet" && request.method === "POST") {
        const guest = await bearerSession(early.bearer, scope);
        const body = await early.body!;
        if (guest?.session.authMethod !== "guest" || typeof body.receipt !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.receipt) || typeof body.conversation !== "string" ||
          !/^tc-[0-9a-f]{32}$/.test(body.conversation))
          throw new HttpError(403, "Verify your wallet for this conversation.");
        const grant = await record(env, "nonce", body.receipt);
        const bound = await grant.fetch(internal("/bind-shared-wallet", {
          guest: guest.session.principalId, scope, conversation: body.conversation,
        }));
        if (!bound.ok) throw new HttpError(bound.status === 503 ? 503 : 403, "Verify your wallet again for this conversation.");
        const wallet = await bound.json<WidgetWallet & { proofIssuedAt?: number }>();
        if (!allowsIdentification(wallet.network))
          throw new HttpError(403, "This workspace has turned off verification for this wallet.");
        const saved = await roomStub(env, room).fetch(internal("/private/support/share-wallet", {
          ...wallet, guest: guest.session.principalId, conversation: body.conversation, multiple: current.walletIdentification?.enabled === true,
        }));
        if (!saved.ok) throw new HttpError(saved.status === 403 ? 403 : 503, "Could not share the address in this conversation.");
        response = json({ shared: true });
      } else if (path === "/auth/nonce" && request.method === "POST") {
        // A challenge requested from a guest session can only be redeemed by
        // that same session; redeeming it moves the guest's thread.
        const guest = await bearerSession(early.bearer, scope);
        if (guest && guest.session.authMethod !== "guest")
          throw new HttpError(409, "You are already signed in.");
        const body = await early.body!;
        const shareConversation = body.shareConversation;
        if (shareConversation !== undefined && (!guest ||
          typeof shareConversation !== "string" || (shareConversation !== "next" && !/^tc-[0-9a-f]{32}$/.test(shareConversation))))
          throw new HttpError(403, "Start a guest session before sharing a wallet.");
        // `network` picks the proof: SIWE for an EVM wallet (the default,
        // as widgets built before Solana sign-in send no network) or Sign In
        // With Solana. Both challenges bind this site's domain and URI, a
        // single-use nonce, a five-minute expiry and this workspace.
        const network = body.network === undefined ? "evm" : body.network;
        if (shareConversation !== undefined && !allowsIdentification(network))
          throw new HttpError(403, "This workspace has turned off verification for this wallet.");
        // The guest session stays usable on a refusal, so the answer offers
        // writing on only where this website allows it.
        const unsupported = () =>
          new HttpError(
            400,
            minimumLevel === "signed"
              ? "Sign-in doesn't work on this network yet. Switch your wallet to Ethereum, Base, Arbitrum or another supported network."
              : "Sign-in doesn't work on this network yet. Switch your wallet to Ethereum, Base, Arbitrum or another supported network, or keep writing without signing in.",
            undefined,
            "network-not-supported",
          );
        const now = Date.now(),
          nonce = randomToken(),
          expiresAt = now + NONCE_TTL;
        // A widget that asked to stay signed in gets the remember statement
        // only where remembered sign-in is available; otherwise today's.
        const remember = shareConversation === undefined && body.remember === true && rememberAvailable;
        const challenge = {
          domain: new URL(origin).host,
          uri: hosted ? hostedPageHref(origin, room) : origin,
          nonce,
          // Every widget challenge, SIWE and SIWS; the widget and Templ's
          // hourly check compare it word for word.
          statement: shareConversation ? WIDGET_WALLET_SHARE_STATEMENT : remember
              ? WIDGET_REMEMBER_STATEMENT
              : WIDGET_SIGN_IN_STATEMENT,
          issuedAt: new Date(now),
          expirationTime: new Date(expiresAt),
          resources: [widgetSignInResource(env.APP_ORIGIN, room)],
        };
        let message: string;
        let signer: Pick<AuthData, "address" | "solanaAddress" | "network">;
        if (network === "solana") {
          if (!featureOn(env, undefined, "solanaSignIn"))
            throw new HttpError(503, "Solana sign-in is not available here.");
          // Any Solana key that can sign a message. The text names Solana
          // mainnet; a multisig vault can't sign and fails at verify.
          const wallet = guestClaim({
            network,
            address: body.address,
            chainId: body.chainId,
          });
          message = createSolanaSignInMessage({
            ...challenge,
            address: wallet.address,
          });
          signer = { address: null, solanaAddress: wallet.address, network };
        } else if (network === "evm") {
          const wallet = address(body.address);
          // An ordinary wallet signs in on any listed network; the message
          // binds the chain.
          if (!isSupportSiweChainId(body.chainId)) throw unsupported();
          message = createSiweMessage({
            ...challenge,
            address: wallet,
            chainId: body.chainId,
            // http only for a development origin on this computer.
            scheme: new URL(origin).protocol === "http:" ? "http" : "https",
            version: "1",
          });
          signer = { address: wallet, network };
        } else throw unsupported();
        const saved = await (
          await record(env, "nonce", nonce)
        ).fetch(
          internal("/create", {
            ...signer,
            message,
            nonce,
            expiresAt,
            purpose: "widget-login",
            widgetScope: scope,
            ...(guest ? { guestPrincipal: guest.session.principalId } : {}),
            ...(typeof shareConversation === "string" ? { shareConversation } : {}),
            ...(remember ? { remember: true as const } : {}),
          } satisfies AuthData),
        );
        if (!saved.ok)
          throw new HttpError(503, "Could not create a sign-in challenge.");
        response = json({ message, nonce, expiresAt });
      } else if (path === "/auth/verify" && request.method === "POST") {
        const body = await early.body!;
        // An EVM signature is hex; a Solana one is padded base64 of 64
        // bytes. Which one the challenge needs is read from the stored
        // challenge, never from the request.
        if (
          typeof body.nonce !== "string" ||
          !/^[0-9a-f]{64}$/.test(body.nonce) ||
          typeof body.message !== "string" ||
          typeof body.signature !== "string" ||
          !(
            (isHex(body.signature) && body.signature.length <= 8194) ||
            WIDGET_SOLANA_SIGNATURE.test(body.signature)
          )
        )
          throw new HttpError(400, "Invalid signed message.");
        // Consumed only once the origin is valid, so a refused site never
        // burns a challenge.
        const consumed = await (
          await record(env, "nonce", body.nonce)
        ).fetch(internal("/consume"));
        if (!consumed.ok)
          throw new HttpError(
            consumed.status === 401 ? 401 : 503,
            "Request a new sign-in challenge.",
            undefined,
            consumed.status === 401 ? "challenge-mismatch" : undefined,
          );
        const challenge = await consumed.json<AuthData>();
        if (
          challenge.purpose !== "widget-login" ||
          !sameWidgetScope(challenge.widgetScope, scope) ||
          challenge.nonce !== body.nonce ||
          challenge.message !== body.message ||
          challenge.expiresAt <= Date.now()
        )
          throw challengeMismatch();
        let proof: WidgetWallet;
        let contractChain: number | undefined;
        if (challenge.network === "solana") {
          if (!featureOn(env, undefined, "solanaSignIn"))
            throw new HttpError(503, "Solana sign-in is not available here.");
          // Ed25519 over the exact text, by the key the challenge named.
          const signature = decodeWidgetSolanaSignature(body.signature);
          if (
            challenge.address !== null ||
            !challenge.solanaAddress ||
            !signature ||
            !(await verifySolanaSignature(
              body.message,
              signature,
              challenge.solanaAddress,
            ))
          )
            throw new HttpError(
              401,
              "This widget needs a Solana wallet that can sign messages. Multisig vaults can't sign in.",
              undefined,
              "signature-invalid",
            );
          proof = { network: "solana", address: challenge.solanaAddress };
        } else {
          let signer: string | undefined;
          try {
            signer =
              challenge.address && isHex(body.signature)
                ? await recoverMessageAddress({
                    message: body.message,
                    signature: body.signature,
                  })
                : undefined;
          } catch {
            /* Unsupported wallet proofs fail closed. */
          }
          const chainId = Number(
            /\nChain ID: ([0-9]+)\n/.exec(challenge.message ?? "")?.[1],
          );
          if (
            challenge.address &&
            signer?.toLowerCase() !== challenge.address &&
            isHex(body.signature)
          ) {
            // A contract wallet on Ethereum or Katana,
            // checked on chain; its account belongs to that chain alone.
            const site = new URL(origin);
            const verified = await verifyWidgetSmartWallet(env, {
              message: body.message,
              signature: body.signature,
              address: challenge.address as `0x${string}`,
              nonce: body.nonce,
              domain: site.host,
              scheme: site.protocol.slice(0, -1),
            }).catch((error) => {
              if (error instanceof HttpError && error.status === 503)
                throw error;
              return false;
            });
            if (verified) contractChain = chainId;
          }
          if (
            !challenge.address ||
            (signer?.toLowerCase() !== challenge.address && !contractChain)
          )
            throw new HttpError(
              401,
              smartWalletsOffered(env as WidgetSessionEnv)
                ? "This wallet couldn't sign in here. Smart wallets sign in on Ethereum or Katana."
                : "This widget needs an EVM wallet that can sign messages. Smart-wallet signatures are not supported yet.",
              undefined,
              isHex(body.signature) && body.signature.length > 132
                ? "smart-wallet-unsupported"
                : "signature-invalid",
            );
          proof = {
            network: "evm",
            address: challenge.address as `0x${string}`,
            chainId,
          };
        }
        // A guest-bound challenge needs the guest's own bearer as well as the
        // wallet proof, so nobody else can move that guest's thread.
        const guest = challenge.guestPrincipal
          ? await bearerSession(early.bearer, scope)
          : null;
        if (
          challenge.guestPrincipal &&
          (!guest ||
            guest.session.authMethod !== "guest" ||
            guest.session.principalId !== challenge.guestPrincipal)
        )
          throw challengeMismatch();
        if (challenge.shareConversation) {
          if (!allowsIdentification(proof.network))
            throw new HttpError(403, "This workspace has turned off verification for this wallet.");
          if (!guest)
            throw challengeMismatch();
          let walletReceipt: string | undefined;
          let expiresAt: number | undefined;
          if (challenge.shareConversation === "next") {
            walletReceipt = randomToken();
            expiresAt = Math.min(guest.session.expiresAt, Date.now() + WALLET_SHARE_RECEIPT_TTL);
            const created = await (await record(env, "nonce", walletReceipt)).fetch(internal("/create", {
              purpose: "widget-wallet-share", address: null, shareConversation: "next", sharedWallet: proof,
              authenticatedAt: challenge.expiresAt - NONCE_TTL,
              guestPrincipal: guest.session.principalId, widgetScope: scope, expiresAt,
            } satisfies AuthData));
            if (!created.ok) throw new HttpError(503, "Could not save the wallet proof. Try again.");
          } else {
            const saved = await roomStub(env, room).fetch(internal(
              "/private/support/share-wallet", {
              guest: guest.session.principalId,
              conversation: challenge.shareConversation,
              proofIssuedAt: challenge.expiresAt - NONCE_TTL,
              multiple: current.walletIdentification?.enabled === true,
              ...proof,
            }));
            if (!saved.ok) {
              if (saved.status === 403 || saved.status === 404)
                throw new HttpError(403, "Choose your Standard conversation to share a wallet.");
              throw new HttpError(503, "Could not save the verified wallet. Try again.");
            }
          }
          return json({
            token: guest.token,
            principalId: guest.session.principalId,
            expiresAt: guest.session.expiresAt,
            wallet: proof,
            shareConversation: challenge.shareConversation,
            ...(walletReceipt ? { walletReceipt, walletReceiptExpiresAt: expiresAt } : {}),
          }, 200, {
            "Access-Control-Allow-Origin": corsOrigin,
            "Vary": `Origin, ${WIDGET_HOST_ORIGIN_HEADER}`,
          });
        }
        // The account that holds this key, or a new one on first use. A key
        // another account holds signs in to that account; the guest's own
        // account is never merged into it.
        const account: Pick<
          AccountIdentity,
          "principalId" | "servicePrincipals"
        > =
          proof.network === "solana"
            ? (
                (await identityRequest(env, {
                  op: "solana-login",
                  address: proof.address,
                })) as unknown as { identity: AccountIdentity }
              ).identity
            : contractChain
              ? await identityRequest(env, {
                  op: "contract-login",
                  chainId: contractChain,
                  address: proof.address,
                })
              : await identityRequest(env, {
                  op: "wallet-login",
                  wallet: proof.address,
                  kind: "eoa",
                  chainId: proof.chainId,
                });
        let transfer:
          | { moved: boolean; conversation: string | null; linked?: string }
          | undefined;
        if (guest) {
          const moved = await timed(
            env,
            "move",
            roomStub(env, room).fetch(
              internal(ownWallet ? "/private/support/own-encrypted-widget-verify" : "/private/support/widget-verify", {
                guest: guest.session.principalId,
                wallet: account.principalId,
                aliases: account.servicePrincipals,
                ...proof,
                origin,
                authenticatedAt: Date.now(),
              }),
            ),
          );
          if (!moved.ok) {
            const detail = await moved
              .json<{ error?: string }>()
              .catch(() => ({}) as { error?: string });
            throw new HttpError(
              moved.status === 403 ? 403 : ownWallet && moved.status === 404 ? 404 : 503,
              moved.status === 403 && detail.error
                ? detail.error
                : ownWallet && moved.status === 404
                  ? "Wallet verification is unavailable. You can keep this chat anonymous."
                : "Could not keep your case. Try again.",
            );
          }
          transfer = await moved.json();
        }
        const token = randomToken(),
          authenticatedAt = Date.now(),
          expiresAt = authenticatedAt + SESSION_MS;
        // A challenge that offered the remember statement, while remembered
        // sign-in is still available here: the session names its family. An
        // undeployed smart wallet's simulated proof holds for this hour only.
        const familyId =
          challenge.remember === true &&
          rememberAvailable &&
          !(
            proof.network === "evm" &&
            isCounterfactualSignature(body.signature as `0x${string}`)
          )
            ? randomToken().slice(0, 32)
            : null;
        const remembered = familyId
          ? {
              remembered: await sha256Hex(familyId),
              rememberEpoch,
            }
          : {};
        const signedIn = {
          principalId: account.principalId,
          servicePrincipals: account.servicePrincipals,
          authenticatedAt,
          expiresAt,
          authorizationExpiresAt: expiresAt,
          walletRevision: 0,
          purpose: "widget-session",
          widgetScope: scope,
          ...remembered,
        } satisfies Partial<AuthData>;
        const session: AuthData =
          proof.network === "solana"
            ? {
                ...signedIn,
                address: null,
                solanaAddress: proof.address,
                network: "solana",
                authMethod: "solana",
                // The worker checks this proof again on every read.
                solanaAuthorization: {
                  message: body.message,
                  signature: body.signature,
                },
              }
            : {
                ...signedIn,
                address: proof.address,
                network: "evm",
                authMethod: "wallet",
                walletAuthorizationExpiresAt: expiresAt,
                authorization: {
                  message: body.message,
                  signature: body.signature as `0x${string}`,
                },
                ...(contractChain ? { contractChain } : {}),
              };
        // The guest bearer has done its job; the wallet session replaces it.
        // Both writes finish before the response.
        const [saved] = await Promise.all([
          (await record(env, "session", token)).fetch(
            internal("/create", session),
          ),
          guest
            ? (await record(env, "session", guest.token)).fetch(
                internal("/revoke"),
              )
            : null,
        ]);
        if (!saved.ok)
          throw new HttpError(503, "Could not sign in. Try again.");
        // The guest's sockets end with its session.
        if (guest) endSockets(env, room, guest.session.principalId, origin);
        // A failed family write still signs the member in, only without
        // staying signed in.
        const family = familyId
          ? await createFamily(env as Env & WidgetSessionEnv, familyId, {
              widgetScope: scope,
              principalId: account.principalId,
              servicePrincipals: account.servicePrincipals,
              network: proof.network,
              address: session.address as `0x${string}` | null,
              ...(session.solanaAddress
                ? { solanaAddress: session.solanaAddress }
                : {}),
              authMethod: session.authMethod as "wallet" | "solana",
              ...(session.authorization
                ? { authorization: session.authorization }
                : {}),
              ...(session.solanaAuthorization
                ? { solanaAuthorization: session.solanaAuthorization }
                : {}),
              ...(contractChain ? { contractChain } : {}),
              authenticatedAt,
              epoch: rememberEpoch,
            })
          : null;
        response = json({
          token,
          expiresAt,
          principalId: account.principalId,
          servicePrincipals: account.servicePrincipals,
          address: proof.address,
          wallet: proof,
          ...(transfer ? { transfer } : {}),
          ...(family
            ? {
                remember: {
                  credential: family.credential,
                  expiresAt: family.expiresAt,
                },
              }
            : {}),
        });
      } else if (path === "/live" && request.method === "GET") {
        // The member socket. A browser socket carries
        // no bearer; the ticket in its first frame is the credential.
        return await widgetSocket(request, env, room, origin, frame);
      } else if (
        (path === "/auth/resume" || path === "/auth/forget") &&
        request.method === "POST"
      ) {
        // Remembered sign-in (widget-remember.ts). The origin is valid
        // already; nothing below reads a bearer.
        if (!rememberAvailable)
          throw new HttpError(
            404,
            "Sign in with your wallet.",
            undefined,
            "remember-off",
          );
        const body = await early.body!;
        const credential = parseRememberCredential(body.credential);
        if (path === "/auth/forget") {
          // No oracle: the same answer whatever the credential was.
          if (credential)
            await forgetFamily(
              env as Env & WidgetSessionEnv,
              credential,
              scope,
            );
          response = json({ ok: true });
        } else {
          if (!credential) throw new HttpError(400, "Invalid sign-in key.");
          if (body.wallet === undefined || body.wallet === null)
            throw new HttpError(
              409,
              "Connect the wallet you signed in with.",
              undefined,
              "remember-wallet-needed",
            );
          response = await resumeRemembered(
            env as Env & WidgetSessionEnv,
            credential,
            {
              scope,
              epoch: rememberEpoch,
              claim: guestClaim(body.wallet),
              verifyAuthority:
                deps.verifySessionAuthority ?? verifySessionAuthority,
            },
          );
        }
      } else {
        if (early.bearer.kind !== "read")
          throw new HttpError(
            401,
            "Sign in with your wallet to contact support.",
          );
        const token = early.bearer.token;
        const stored = await early.bearer.read;
        if (!stored.ok)
          throw new HttpError(
            stored.status === 401 ? 401 : 503,
            "Sign in with your wallet again.",
          );
        const session = await stored.json<AuthData>();
        if (!session.widgetScope || !matchesWidgetScope(session, scope))
          throw new HttpError(
            hosted ? 404 : 401,
            hosted
              ? "Support case not found."
              : "This sign-in belongs to another support widget.",
          );
        // The workspace signed every remembered member out after this
        // session was made: it ends now, before anything else reads it.
        if (
          session.rememberEpoch !== undefined &&
          !(session.rememberEpoch >= rememberEpoch)
        ) {
          await (
            await record(env, "session", token)
          ).fetch(internal("/revoke"));
          throw new HttpError(401, "Sign in again to keep your case.");
        }
        // A raised minimum applies to sessions that already exist. The guest
        // can still sign in through /auth/nonce and keep their thread.
        if (
          path !== "/auth/logout" &&
          !meetsMinimumLevel(sessionLevel(session), minimumLevel) &&
          !(
            session.authMethod === "guest" &&
            session.walletUnavailable === true &&
            current.walletFallback !== false
          )
        )
          throw new HttpError(
            403,
            minimumLevel === "signed"
              ? LEVEL_REQUIRED.signed
              : LEVEL_REQUIRED.connected,
            undefined,
            "access-level-required",
          );
        if (path === "/auth/logout" && request.method === "POST") {
          // Sign out with `forget` also ends the remembered sign-in; a
          // wallet change sends none and keeps it for switching back.
          const body = await early.body?.catch(
            () => ({}) as Record<string, unknown>,
          );
          if (body?.forget === true && session.remembered)
            await endFamily(env, session.remembered);
          const revoked = await (
            await record(env, "session", token)
          ).fetch(internal("/revoke"));
          if (!revoked.ok)
            throw new HttpError(503, "Could not sign out. Try again.");
          endSockets(env, room, session.principalId, origin);
          response = json({ ok: true });
        } else {
          if (
            !(
              (request.method === "GET" && readablePath(path)) ||
              (request.method === "POST" && writablePath(path))
            ) ||
            url.searchParams.has("attachment")
          )
            throw new HttpError(404, "Support action not found.");
          // A member screenshot, only while Templ has
          // them on; its bytes were read like a body.
          const shot = isScreenshotUpload(path, request);
          if (shot && !early.upload)
            throw new HttpError(404, "Support action not found.");
          const upload = shot ? await early.upload : undefined;
          // Read in full before the session read above started.
          const body =
            request.method === "POST" && !shot ? await early.body : undefined;
          if (
            current.askPerson === false &&
            body &&
            ((path.endsWith("/workflow") && body.action === "ask-person") ||
              (path === "/conversations/ask" && body.handoff !== undefined))
          )
            throw new HttpError(
              403,
              "This team has turned off requests for a person.",
            );
          if (
            path.endsWith("/workflow") &&
            body &&
            !WIDGET_WORKFLOW_ACTIONS.includes(body.action)
          )
            throw new HttpError(
              403,
              "This action is only available in the team inbox.",
            );
          if (
            path === "/conversations/live" &&
            !realtimeOffered(env as WidgetSessionEnv)
          )
            throw new HttpError(
              404,
              "Support action not found.",
              undefined,
              "live-off",
            );
          // Only a checked permit marks an install preview.
          // A browser body or header cannot mark a request as a preview.
          let installPreview = false;
          if (path === "/conversations/ask" && body?.installCheck) {
            requireInstallCheck(env);
            const checked = await widgetInstallCheck(
              env,
              {
                workspace: room,
                origin,
                member: session.principalId!,
                session: token,
                body: { run: body.installCheck },
                preview: true,
              },
              (data) => widgetConfig(env, room, data as never),
            );
            if (!checked.ok)
              throw new HttpError(404, "Install check not found.");
            installPreview = true;
          }
          const headers = new Headers({
            Origin: env.APP_ORIGIN,
            Cookie: `${SESSION_COOKIE}=${token}`,
            "Content-Type": upload ? "image/png" : "application/json",
          });
          const ip = request.headers.get("CF-Connecting-IP");
          if (ip) headers.set("CF-Connecting-IP", ip);
          // The room route uses this checked record instead of reading it
          // again, and still runs every session check on it.
          requestPrefetch(env).session = {
            token,
            record: Promise.resolve(session),
          };
          const search = upload
            ? `?${new URLSearchParams({
                clientId: upload.clientId,
                expectedPrincipalId: session.principalId!,
              })}`
            : url.search;
          // Bounded imports and scoped install forwarding.
          // Current session and room checks remain authoritative.
          const guestEmail = path.endsWith("/guest-email");
          const forwardedPath = guestEmail
            ? path.replace(/\/guest-email$/, "/workflow")
            : path === "/install-check"
              ? "/conversations/install-check"
              : path;
          const forwardedSearch =
            guestEmail && request.method === "GET"
              ? "?view=guest-email"
              : search;
          response = await forward(
            new Request(
              `${url.origin}/rooms/${room}${forwardedPath}${forwardedSearch}`,
              {
                method: request.method,
                headers,
                ...(upload
                  ? { body: upload.bytes }
                  : body
                    ? {
                        body: JSON.stringify({
                          ...body,
                          ...(guestEmail ? { action: "guest-email" } : {}),
                          expectedPrincipalId: session.principalId,
                        }),
                      }
                    : {}),
              },
            ),
            {
              ...env,
              [WIDGET_SCOPE]: {
                ...scope,
                askPerson: current.askPerson !== false,
                ...(hosted ? { hosted: true } : {}),
              },
              [INSTALL_PREVIEW]: installPreview,
            } as WidgetEnv,
          );
          // The ticket names the socket on this host and workspace; in a
          // frame, with the website the upgrade is checked against.
          if (path === "/conversations/live" && response.ok)
            response = json({
              ...(await response.json<Record<string, unknown>>()),
              socketUrl: frame
                ? frameSocketUrl(url.host, room, origin)
                : `wss://${url.host}/widget/${room}/live`,
            });
        }
      }
    }
  } catch (error) {
    response = json(
      errorBody(error, "Support is unavailable. Try again shortly."),
      error instanceof HttpError ? error.status : 503,
    );
  }
  const headers = new Headers(response.headers);
  headers.delete("Set-Cookie");
  headers.set("Vary", `Origin, ${WIDGET_HOST_ORIGIN_HEADER}`);
  if (allowed) {
    headers.set("Access-Control-Allow-Origin", corsOrigin);
    headers.set("Access-Control-Expose-Headers", "Retry-After, Server-Timing");
    headers.set("Timing-Allow-Origin", corsOrigin);
  }
  if (response.status === 429 && !headers.has("Retry-After"))
    headers.set("Retry-After", "60");
  return new Response(response.body, { status: response.status, headers });
}

/** `POST /widget/:ws/auth/resume` after the settings allowed it: the family
 * rotates on its shard, the account and the proof are checked again, and a
 * one-hour widget session built from the original proof is written. Four
 * serial storage tiers (settings, family, identity, session): the family
 * write waits for the origin check and the identity check is the resume's
 * own required check. */
async function resumeRemembered(
  env: Env & WidgetSessionEnv,
  credential: { familyId: string; secret: string },
  input: {
    scope: WidgetScope;
    epoch: number;
    claim: WidgetWallet;
    verifyAuthority: typeof verifySessionAuthority;
  },
): Promise<Response> {
  const now = Date.now();
  const outcome = await resumeFamily(env, credential, {
    scope: input.scope,
    epoch: input.epoch,
    claim: input.claim,
    now,
  });
  if (!outcome.ok)
    throw new HttpError(
      outcome.status,
      outcome.status === 409
        ? "Connect the wallet you signed in with."
        : outcome.status === 503
          ? "Support is unavailable. Try again."
          : "Sign in again to keep your case.",
      undefined,
      outcome.reason,
    );
  const family: RememberedFamily = outcome.family;
  const remember = {
    credential: outcome.credential,
    expiresAt: family.expiresAt,
  };
  const hash = await sha256Hex(credential.familyId);
  try {
    return await resumedSession(env, family, hash, remember, input, now);
  } catch (error) {
    // The family ended: sign in again.
    if (error instanceof HttpError && error.status === 401) throw error;
    // The family moved to the next key before the check that failed. The
    // answer hands that key over, so the member keeps the sign-in for the
    // next try instead of presenting a key that has become the old one.
    return json(
      {
        ...errorBody(error, "Support is unavailable. Try again."),
        remember,
      },
      error instanceof HttpError && error.status >= 400 ? error.status : 503,
    );
  }
}

/** The checks and the session write of one resume, after the rotation. */
async function resumedSession(
  env: Env & WidgetSessionEnv,
  family: RememberedFamily,
  hash: string,
  remember: { credential: string; expiresAt: number },
  input: {
    scope: WidgetScope;
    claim: WidgetWallet;
    verifyAuthority: typeof verifySessionAuthority;
  },
  now: number,
): Promise<Response> {
  const end = async () => {
    await endFamily(env, hash);
    throw new HttpError(
      401,
      "Sign in again to keep your case.",
      undefined,
      "remember-ended",
    );
  };
  // The account still holds this wallet.
  const { identity, linked } = await sessionIdentity(env, family.principalId);
  if (identity.principalId !== family.principalId) return end();
  if (family.network === "solana") {
    if (
      !family.solanaAddress ||
      !identity.solana?.some((entry) => entry.address === family.solanaAddress)
    )
      return end();
  } else if (
    !family.address ||
    (family.contractChain
      ? identity.contract?.chainId !== family.contractChain ||
        identity.contract.address !== family.address
      : identity.principalId.startsWith("account:")
        ? !walletSignsIn(linked, family.address)
        : identity.principalId !== family.address)
  )
    return end();
  // The proof still stands: an EOA recovers locally; a contract wallet is
  // read on chain, and an unreadable chain keeps the family (503).
  if (family.network === "solana") {
    const signature = decodeWidgetSolanaSignature(
      family.solanaAuthorization?.signature,
    );
    if (
      !signature ||
      !(await verifySolanaSignature(
        family.solanaAuthorization!.message,
        signature,
        family.solanaAddress!,
      ))
    )
      return end();
  } else if (
    !family.authorization ||
    // Never a family on a simulated (undeployed) proof; see verify.
    isCounterfactualSignature(family.authorization.signature) ||
    !(await input.verifyAuthority(env, family.address!, family.authorization))
  )
    return end();
  const token = randomToken();
  const expiresAt = Math.min(now + SESSION_MS, family.expiresAt);
  const signed = {
    principalId: identity.principalId,
    servicePrincipals: identity.servicePrincipals,
    authenticatedAt: family.authenticatedAt,
    expiresAt,
    authorizationExpiresAt: expiresAt,
    walletRevision: 0,
    purpose: "widget-session",
    widgetScope: input.scope,
    remembered: hash,
    rememberEpoch: family.epoch,
  } satisfies Partial<AuthData>;
  const session: AuthData =
    family.network === "solana"
      ? {
          ...signed,
          address: null,
          solanaAddress: family.solanaAddress,
          network: "solana",
          authMethod: "solana",
          solanaAuthorization: family.solanaAuthorization,
        }
      : {
          ...signed,
          address: family.address,
          network: "evm",
          authMethod: "wallet",
          walletAuthorizationExpiresAt: expiresAt,
          authorization: family.authorization,
          ...(family.contractChain
            ? { contractChain: family.contractChain }
            : {}),
        };
  const saved = await (
    await record(env, "session", token)
  ).fetch(internal("/create", session));
  if (!saved.ok) throw new HttpError(503, "Could not sign in. Try again.");
  return json({
    token,
    expiresAt,
    principalId: identity.principalId,
    servicePrincipals: identity.servicePrincipals,
    address: input.claim.address,
    wallet: input.claim,
    remember,
  });
}

/** `GET /widget/:ws/check?origin=<website>`: the visitor check's page, for
 * a valid website of a workspace with the check on while Templ has it
 * on. Anything else is 403 with no detail. Only a frame may load it. */
async function guestCheckRoute(
  request: Request,
  env: Env,
  room: string,
  url: URL,
): Promise<Response> {
  const refused = () =>
    new Response(null, {
      status: 403,
      headers: { "Cache-Control": "no-store", "X-Frame-Options": "DENY" },
    });
  if (request.method !== "GET") return refused();
  const limiter = env.CHAT_READ_RATE_LIMITER;
  if (
    !limiter ||
    !(
      await limiter.limit({
        key: `check:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
      })
    ).success
  )
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  env = await releaseActivationEnv(env);
  const origin = url.searchParams.get("origin") ?? "";
  const dest = request.headers.get("Sec-Fetch-Dest");
  // The check inside Templ's frame, one level deeper.
  const inFrame = url.searchParams.get("frame") === "1";
  const settings = await widgetConfig(env, room, { op: "read", origin });
  if (!settings.ok) return refused();
  const current = await settings.json<
    WidgetSettings & { closed?: boolean; workspaceFlags?: WorkspaceFlag[] }
  >();
  env = workspaceFeatureEnvFromFlags(env, current.workspaceFlags ?? [], room);
  const sessionEnv = env as WidgetSessionEnv;
  const frameOrigin = inFrame ? widgetFrameOrigin(env as WidgetFrameEnv) : null;
  if (
    (inFrame && (!frameOrigin || !/^https:\/\//.test(origin))) ||
    (url.searchParams.has("frame") && !inFrame) ||
    (dest !== null && dest !== "iframe") ||
    !guestCheckOffered(sessionEnv) ||
    !widgetWebsiteOrigin(origin, loopbackOffered(sessionEnv))
  )
    return refused();
  if (current.closed || current.guestCheck !== "turnstile") return refused();
  return guestCheckPage({
    room,
    origin,
    siteKey: sessionEnv.TURNSTILE_SITE_KEY!,
    ...(frameOrigin ? { frameOrigin } : {}),
  });
}

/** `GET /widget/:ws/live` after the website passed: the member socket,
 * forwarded to the workspace's room with only the upgrade, the client
 * network's digest and the website the worker checked. No cookie, bearer or
 * caller header crosses. The room's 101 goes back untouched. */
async function widgetSocket(
  request: Request,
  env: Env,
  room: string,
  origin: string,
  frame: boolean,
): Promise<Response> {
  if (!realtimeOffered(env as WidgetSessionEnv))
    throw new HttpError(
      404,
      "Support action not found.",
      undefined,
      "live-off",
    );
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    throw new HttpError(426, "Open this address as a WebSocket.");
  const digest = await clientIpDigest(request, env);
  return roomStub(env, room).fetch(
    new Request("https://internal/realtime", {
      headers: {
        Upgrade: "websocket",
        "X-Realtime-Upgrade": "1",
        "X-Realtime-Widget-Origin": origin,
        ...(frame ? { "X-Realtime-Widget-Frame": "1" } : {}),
        ...(digest ? { "X-Client-IP-Digest": digest } : {}),
      },
    }),
  );
}
/** Closes one member's widget sockets on one website, after the response. */
function endSockets(
  env: Env,
  room: string,
  principal: ChatPrincipalId | undefined,
  origin: string,
) {
  if (!principal || !realtimeOffered(env as WidgetSessionEnv)) return;
  defer(env, async () => {
    const ended = await roomStub(env, room).fetch(
      internal("/private/realtime/end", { principal, origin }),
    );
    await ended.body?.cancel();
  });
}
