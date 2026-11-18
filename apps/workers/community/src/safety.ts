import {
  legalNotice,
  SAFETY_REASONS,
  SAFETY_REPORT_LIMITS,
  type LegalNotice,
} from "@templ/chat/safety";
import { HttpError, json, readJson, siteOrigins, type Env } from "./common";
import { servicePrincipals } from "./service-principals";
import { principalList } from "./principal";
import type { OperatorAdminEnv } from "./operator-admin";
import { requestPrefetch, started, timed } from "./request-context";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { profileMediaHash } from "@templ/chat/profiles";
import { RETIRED_GROUP_FILE_LIMITS } from "./group-attachment-cleanup";
import { recoveryStoreRoute } from "./storage-recovery-store";
import { logVersionId } from "./ops-log";
import { requireWalletAuth } from "./privileged-auth";
import type { AuthMethod } from "@templ/chat/principal";

/** The file types stored group files may carry. Stored reports can name
 * them. */
const GROUP_ATTACHMENT_CONTENT_TYPES = [
  "application/octet-stream",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export interface SafetyEnv
  extends Env, Pick<OperatorAdminEnv, "TRIAL_OPERATOR_PRINCIPALS"> {
  SAFETY_ENABLED?: string;
  SAFETY_STORE?: DurableObjectNamespace;
  SAFETY_ADMIN_TOKEN?: string;
  /** Explicit Safety-only operators; wallet proof grants no customer role. */
  SAFETY_ADMIN_PRINCIPALS?: string;
}
export function safetyIsAdmin(
  env: SafetyEnv,
  actor: ChatPrincipalId,
  aliases?: unknown,
) {
  const identities = servicePrincipals(actor, aliases);
  const trials = principalList(env.TRIAL_OPERATOR_PRINCIPALS);
  if (identities.some((id) => trials.includes(id))) return false;
  const admins = principalList(env.SAFETY_ADMIN_PRINCIPALS);
  return identities.some((id) => admins.includes(id));
}
export const REPORT_RETENTION_MS = 90 * 86_400_000;
export const REPORT_REASONS = SAFETY_REASONS.map(([reason]) => reason);
type Reason = (typeof REPORT_REASONS)[number];
export type SafetyReport = {
  id: string;
  createdAt: string;
  expiresAt: number;
  reporter: ChatPrincipalId | null;
  reason: Reason;
  notice?: LegalNotice;
  authorityReview?: {
    status: "verified" | "rejected";
    checkedAt: string;
    independentSource: string;
    contactVerification: string;
    instrumentVerification: string;
  } | null;
  details: string;
  targetUrl: string;
  roomKey: string | null;
  /** The message as the reporter read it: the stored `ReportSnapshot` from
   * message-store plus its channel. `revision` is always present; `editedAt`
   * and `replyTo` appear only when the message carried them. */
  message: {
    id: string;
    channelId: string;
    author: string;
    text: string;
    attachments?: import("./group-attachment-cleanup").RetiredGroupAttachment[];
    createdAt: string;
    revision: number;
    editedAt?: string | null;
    replyTo?: string | null;
  } | null;
  mandatoryReview?: {
    status: "validated" | "rejected";
    checkedAt: string;
    applicableLaw: string;
    jurisdictionCheck: string;
    scopeCheck: string;
  } | null;
  urgentReview?: {
    status: "validated" | "rejected";
    checkedAt: string;
    applicableLaw: string;
    evidenceReview: string;
    urgencyReview: string;
    scopeCheck: string;
  } | null;
  relatedReportId: string | null;
  status: "open" | "reviewed";
  held: boolean;
  /** What a hold keeps from support retention: a whole workspace
   * (`conversation: null`) or one support conversation in it. Set by the
   * operator with the `hold` review; a room-level report without a message
   * holds its workspace. */
  holdScope?: HoldScope | null;
  retainedForEnforcement: boolean;
};
export type HoldScope = { roomKey: string; conversation: string | null };
/** A report's hold may restrict or keep data only while its authority check
 * still passes: a verified authority request or a validated legal duty. */
export function holdAuthorized(report: SafetyReport) {
  return (
    (report.reason === "legal-request" &&
      Boolean(report.notice?.authority) &&
      report.authorityReview?.status === "verified") ||
    (report.reason === "mandatory-notice" &&
      Boolean(report.notice?.noticeObligation) &&
      report.mandatoryReview?.status === "validated") ||
    (["child-safety", "imminent-harm"].includes(report.reason) &&
      report.urgentReview?.status === "validated")
  );
}
const CONVERSATION = /^tc-[0-9a-f]{32}$/;
/** The explicit scope, else the whole workspace of a room-level report. */
function heldScopeOf(report: SafetyReport): HoldScope | null {
  if (report.holdScope) return report.holdScope;
  return report.roomKey && !report.message
    ? { roomKey: report.roomKey, conversation: null }
    : null;
}
const heldScopeKey = (scope: HoldScope, reportId: string) =>
  `held-scope:${scope.roomKey}:${scope.conversation ?? "*"}:${reportId}`;
/** Backfill state for `held-scope` entries of reports held before scopes. */
const HOLD_INDEX_KEY = "retention-hold-index-v1";
const HOLD_INDEX_PAGE = 200;
/** Most scope or message entries read for one workspace's holds. */
const HOLD_ENTRIES = 1000;
function receiptView(id: string, report?: SafetyReport) {
  const reviewStatus =
    report?.reason === "legal-request"
      ? (report.authorityReview?.status ?? "pending-authority-verification")
      : report?.reason === "mandatory-notice"
        ? (report.mandatoryReview?.status ?? "pending-legal-duty-validation")
        : null;
  return { id, received: true, ...(reviewStatus ? { reviewStatus } : {}) };
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roomPattern =
  /^room:[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** The scope a `hold` review names, checked against the report. */
function checkedHoldScope(value: unknown, report: SafetyReport): HoldScope {
  const scope = value as Record<string, unknown> | null;
  if (
    !scope ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    Object.keys(scope).some(
      (key) => key !== "roomKey" && key !== "conversation",
    ) ||
    typeof scope.roomKey !== "string" ||
    !roomPattern.test(scope.roomKey) ||
    !(
      scope.conversation === null ||
      (typeof scope.conversation === "string" &&
        CONVERSATION.test(scope.conversation))
    )
  )
    throw new HttpError(
      400,
      "Choose a workspace and, optionally, one case to hold.",
    );
  if (report.roomKey && report.roomKey !== scope.roomKey)
    throw new HttpError(409, "The hold must name the reported workspace.");
  return {
    roomKey: scope.roomKey,
    conversation: scope.conversation as string | null,
  };
}
const groupMediaPattern =
  /^\/rooms\/([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/channels\/([a-z0-9][a-z0-9-]{0,47})\/attachments\/([0-9a-f]{64})$/;
function groupMediaTarget(url: URL, communityOrigin: string) {
  return url.origin === communityOrigin
    ? groupMediaPattern.exec(url.pathname)
    : null;
}
function reportedGroupMediaId(report: SafetyReport, communityOrigin: string) {
  const match = groupMediaTarget(new URL(report.targetUrl), communityOrigin);
  if (
    !match ||
    report.roomKey !== `room:${match[1]}` ||
    report.message?.channelId !== match[2] ||
    !report.message.attachments?.some((file) => file.id === match[3])
  )
    return null;
  return match[3];
}
const text = (value: unknown, max: number) => {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    // Reject control bytes while allowing ordinary line breaks in reports.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
    throw new HttpError(400, "Describe the issue in plain text.");
  return value.trim();
};
export function safetyAvailable(env: SafetyEnv) {
  return (
    env.SAFETY_ENABLED === "true" &&
    Boolean(env.SAFETY_STORE) &&
    /^[0-9a-f]{64}$/.test(env.SAFETY_ADMIN_TOKEN ?? "")
  );
}
export async function safetyDigest(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function safetyAdmin(request: Request, env: SafetyEnv) {
  if (!safetyAvailable(env))
    throw new HttpError(503, "Safety review is not configured.");
  const supplied = request.headers.get("Authorization") ?? "";
  const actual = await safetyDigest(supplied);
  const expected = await safetyDigest(`Bearer ${env.SAFETY_ADMIN_TOKEN}`);
  let different = 0;
  for (let i = 0; i < actual.length; i++)
    different |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (different) throw new HttpError(403, "Not allowed.");
}
export async function safetyRequest(
  env: SafetyEnv,
  body: Record<string, unknown>,
) {
  if (!safetyAvailable(env))
    throw new HttpError(503, "Reporting is temporarily unavailable.");
  return timed(env, "safety", async () => {
    const namespace = env.SAFETY_STORE!;
    const id = namespace.idFromName("templ-platform-safety:v1");
    const encoded = JSON.stringify(body);
    const status = body.op === "status";
    for (let attempt = 1; ; attempt++) {
      try {
        // An exception can break a stub. Every attempt gets a fresh one.
        return await namespace.get(id).fetch(
          new Request("https://internal/safety", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: encoded,
          }),
        );
      } catch (error) {
        const failure = error as {
          retryable?: unknown;
          overloaded?: unknown;
          remote?: unknown;
        } | null;
        const overloaded = failure?.overloaded === true;
        const retryable = failure?.retryable === true;
        // Only status is read-only. Reports and enforcement never replay.
        const retry = status && retryable && !overloaded && attempt < 3;
        console.error("TEMPL_SAFETY_REQUEST_FAILURE", {
          schemaVersion: 1,
          versionId: logVersionId(env),
          operation: status ? "status" : "mutation",
          category: overloaded
            ? "overloaded"
            : retryable
              ? "retryable"
              : failure?.remote === true
                ? "remote"
                : "other",
          attempt,
          retry,
        });
        if (!retry) throw error;
        // At most two short waits; no cached authorization result is used.
        const delay = 100 * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  });
}
type MessageRef = { channelId: string; id: string };
const heldMessageKey = (roomKey: string, ref: MessageRef, reportId = "") =>
  `held-message:${roomKey}:${ref.channelId}:${ref.id}:${reportId}`;
const heldFileChannelKey = (
  roomKey: string,
  channelId: string,
  reportId = "",
) => `held-file-channel:${roomKey}:${channelId}:${reportId}`;
const MESSAGE_ID = /^[1-9][0-9]{0,14}$/;
const CHANNEL_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
function messageRefs(value: unknown): MessageRef[] {
  const refs = value ?? [];
  if (
    !Array.isArray(refs) ||
    refs.length > 10 ||
    refs.some(
      (ref) =>
        !ref ||
        typeof ref !== "object" ||
        Array.isArray(ref) ||
        typeof ref.channelId !== "string" ||
        !CHANNEL_ID.test(ref.channelId) ||
        typeof ref.id !== "string" ||
        !MESSAGE_ID.test(ref.id),
    )
  )
    throw new HttpError(400, "Invalid message.");
  return refs.map((ref) => ({ channelId: ref.channelId, id: ref.id }));
}
/** Marks an edit or delete of a message under an operator hold: a
 * conversation message, or a message of a stored group channel. The store
 * is asked for the exact reference and, for a conversation, for a hold on
 * that conversation or its workspace; an unreachable store fails closed. */
export async function attachMessageHold(
  env: SafetyEnv,
  headers: Headers,
  roomKey: string,
  method: string,
  path: string,
) {
  if (env.SAFETY_ENABLED !== "true" || method !== "POST") return;
  const match =
    /^\/(?:channels\/([a-z0-9][a-z0-9-]{0,47})|conversations\/(tc-[0-9a-f]{32}))\/messages\/([1-9][0-9]{0,14})\/(?:edit|delete)$/.exec(
      path,
    );
  if (!match) return;
  const ref = { channelId: match[1] ?? match[2], id: match[3] };
  const conversation = match[2];
  const response = await safetyRequest(env, {
    op: "status",
    roomKeys: [roomKey],
    messageRefs: [ref],
    ...(conversation ? { conversation } : {}),
  });
  if (!response.ok)
    throw new HttpError(503, "Chat is temporarily unavailable.");
  const { heldMessages, conversationHeld } = await response.json<{
    heldMessages?: MessageRef[];
    conversationHeld?: boolean;
  }>();
  if (
    !Array.isArray(heldMessages) ||
    heldMessages.some(
      (held) => held.channelId === ref.channelId && held.id === ref.id,
    ) ||
    // Absent means a store without scoped holds, so none applies; any
    // value other than false counts as held.
    (conversation &&
      conversationHeld !== undefined &&
      conversationHeld !== false)
  )
    headers.set("X-Message-Held", "true");
}
const statusBody = (
  roomKey: string | null,
  principalId: ChatPrincipalId | null,
  principals: ChatPrincipalId[],
) => ({
  op: "status",
  roomKeys: roomKey ? [roomKey] : [],
  principalId,
  servicePrincipals: principals,
});
const samePrincipals = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  [...left].sort().join(",") === [...right].sort().join(",");
/** Starts one room's suspension status for a principal set the request is
 * expected to verify. `requireSafetyAccess` uses it only for exactly that
 * room, principal and set; anything else reads again. A set that is not a
 * valid service-principal set starts nothing. */
export function prefetchSafety(
  env: SafetyEnv,
  roomKey: string | null,
  principalId: ChatPrincipalId | null,
  aliases?: unknown,
) {
  if (env.SAFETY_ENABLED !== "true") return;
  let principals: ChatPrincipalId[];
  try {
    principals = servicePrincipals(principalId, aliases);
  } catch {
    return;
  }
  requestPrefetch(env).safety = {
    roomKey,
    principalId,
    principals,
    status: started(
      safetyRequest(env, statusBody(roomKey, principalId, principals)),
    ),
  };
}
/** Whether a started status already covers this exact room and set. */
export function safetyPrefetched(
  env: SafetyEnv,
  roomKey: string | null,
  principalId: ChatPrincipalId | null,
  aliases?: unknown,
) {
  const early = requestPrefetch(env).safety;
  if (!early || early.roomKey !== roomKey || early.principalId !== principalId)
    return false;
  try {
    return samePrincipals(
      early.principals,
      servicePrincipals(principalId, aliases),
    );
  } catch {
    return false;
  }
}
export async function requireSafetyAccess(
  env: SafetyEnv,
  roomKey: string | null,
  principalId?: ChatPrincipalId | null,
  aliases?: ChatPrincipalId[],
) {
  if (env.SAFETY_ENABLED !== "true") return;
  const actor = principalId ?? null;
  const principals = servicePrincipals(actor, aliases);
  // Decided on the exact final set: a status started for another room,
  // principal or alias set is dropped and read again.
  const prefetch = requestPrefetch(env);
  const early = prefetch.safety;
  if (early) delete prefetch.safety;
  const response = await (early &&
  early.roomKey === roomKey &&
  early.principalId === actor &&
  samePrincipals(early.principals, principals)
    ? (early.status as Promise<Response>)
    : safetyRequest(env, statusBody(roomKey, actor, principals)));
  if (!response.ok)
    throw new HttpError(503, "Chat is temporarily unavailable.");
  const result = await response.json<{
    blockedRooms: string[];
    principalBlocked: boolean;
  }>();
  if (result.blockedRooms.length || result.principalBlocked)
    throw new HttpError(
      403,
      "Access is suspended under Templ’s rules. You can appeal from Safety.",
    );
}

/** The `status` read: suspensions for rooms, media and a principal set,
 * plus held messages and file channels. It only reads, so it runs outside a
 * transaction and reads every suspension key at once. */
async function readSafetyStatus(
  storage: Pick<DurableObjectStorage, "get" | "list">,
  body: Record<string, unknown>,
  communityOrigin: string,
) {
  if (
    !Array.isArray(body.roomKeys) ||
    body.roomKeys.length > 50 ||
    body.roomKeys.some(
      (key) => typeof key !== "string" || !roomPattern.test(key),
    )
  )
    throw new HttpError(400, "Invalid chat.");
  const actor =
    body.principalId == null ? null : normalizeChatPrincipal(body.principalId);
  if (body.principalId != null && !actor)
    throw new HttpError(400, "Invalid user.");
  const aliases = servicePrincipals(actor, body.servicePrincipals);
  const mediaKeys = body.mediaKeys ?? [];
  if (
    !Array.isArray(mediaKeys) ||
    mediaKeys.length > 50 ||
    mediaKeys.some(
      (key) => typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key),
    )
  )
    throw new HttpError(400, "Invalid image.");
  // Every suspension this status names, in one read.
  const roomKeys = body.roomKeys as string[];
  const keys = [
    ...roomKeys.map((key) => `suspension:room:${key}`),
    ...(mediaKeys as string[]).map((key) => `suspension:media:${key}`),
    ...aliases.map((id) => `suspension:principal:${id}`),
  ];
  const suspensions = keys.length
    ? await storage.get<unknown>(keys)
    : new Map<string, unknown>();
  const blockedRooms = roomKeys.filter((key) =>
    Boolean(suspensions.get(`suspension:room:${key}`)),
  );
  const blockedMedia = (mediaKeys as string[]).filter((key) =>
    Boolean(suspensions.get(`suspension:media:${key}`)),
  );
  const heldMessages: MessageRef[] = [];
  const heldFileChannels: string[] = [];
  if (body.heldFileChannel !== undefined) {
    if (
      typeof body.heldFileChannel !== "string" ||
      !CHANNEL_ID.test(body.heldFileChannel) ||
      body.roomKeys.length !== 1
    )
      throw new HttpError(400, "Invalid channel.");
    const index = await storage.list({
      prefix: heldFileChannelKey(
        body.roomKeys[0] as string,
        body.heldFileChannel,
      ),
      limit: 1,
    });
    if (index.size) heldFileChannels.push(body.heldFileChannel);
  }
  for (const ref of messageRefs(body.messageRefs))
    for (const roomKey of body.roomKeys as string[]) {
      const index = await storage.list<string>({
        prefix: heldMessageKey(roomKey, ref),
        limit: 5,
      });
      let held = false;
      for (const reportId of index.values()) {
        const report = await storage.get<SafetyReport>(`report:${reportId}`);
        const fileId = report
          ? reportedGroupMediaId(report, communityOrigin)
          : null;
        const suspended = fileId
          ? await storage.get<{ reportId: string }>(
              `suspension:media:${fileId}`,
            )
          : null;
        if (
          report &&
          (report.held || suspended?.reportId === reportId) &&
          report.roomKey === roomKey &&
          report.message?.channelId === ref.channelId &&
          report.message.id === ref.id
        )
          held = true;
      }
      if (held) heldMessages.push(ref);
    }
  // A hold on one support conversation, or on its whole workspace.
  let conversationHeld: boolean | undefined;
  if (body.conversation !== undefined) {
    if (
      typeof body.conversation !== "string" ||
      !CONVERSATION.test(body.conversation) ||
      body.roomKeys.length !== 1
    )
      throw new HttpError(400, "Invalid case.");
    conversationHeld = false;
    for (const scope of ["*", body.conversation]) {
      const index = await storage.list<string>({
        prefix: `held-scope:${body.roomKeys[0]}:${scope}:`,
        limit: 101,
      });
      // More entries than this read covers: treat the conversation as held.
      if (index.size > 100) conversationHeld = true;
      for (const reportId of index.values()) {
        const report = await storage.get<SafetyReport>(`report:${reportId}`);
        if (report?.held && holdAuthorized(report)) conversationHeld = true;
      }
    }
  }
  return json({
    blockedRooms,
    blockedMedia,
    heldMessages,
    heldFileChannels,
    ...(conversationHeld === undefined ? {} : { conversationHeld }),
    principalBlocked: aliases.some((id) =>
      Boolean(suspensions.get(`suspension:principal:${id}`)),
    ),
  });
}

/** The workspace and support conversations that authorized holds keep from
 * retention. Reports held before scopes existed are indexed first, a page
 * at a time; until that is done, or when a workspace has more entries than
 * one read covers, the answer is `ready: false` and nothing is deleted. */
async function retentionHolds(
  storage: DurableObjectTransaction,
  roomKey: string,
): Promise<
  { ready: false } | { ready: true; room: boolean; threads: string[] }
> {
  const index = await storage.get<{ done?: boolean; cursor?: string }>(
    HOLD_INDEX_KEY,
  );
  if (index?.done !== true) {
    const page = await storage.list<SafetyReport>({
      prefix: "report:",
      limit: HOLD_INDEX_PAGE,
      ...(index?.cursor ? { startAfter: index.cursor } : {}),
    });
    let cursor = index?.cursor;
    for (const [key, report] of page) {
      cursor = key;
      const scope = heldScopeOf(report);
      if (report.held && scope)
        await storage.put(heldScopeKey(scope, report.id), report.id);
    }
    const done = page.size < HOLD_INDEX_PAGE;
    await storage.put(HOLD_INDEX_KEY, done ? { done } : { done, cursor });
    if (!done) return { ready: false };
  }
  const [scoped, messages] = await Promise.all([
    storage.list<string>({
      prefix: `held-scope:${roomKey}:`,
      limit: HOLD_ENTRIES + 1,
    }),
    storage.list<string>({
      prefix: `held-message:${roomKey}:`,
      limit: HOLD_ENTRIES + 1,
    }),
  ]);
  if (scoped.size > HOLD_ENTRIES || messages.size > HOLD_ENTRIES)
    return { ready: false };
  let room = false;
  const threads = new Set<string>();
  for (const [key, reportId] of scoped) {
    const report = await storage.get<SafetyReport>(`report:${reportId}`);
    if (!report?.held || !holdAuthorized(report)) continue;
    const target = key.slice(`held-scope:${roomKey}:`.length).split(":")[0];
    if (target === "*") room = true;
    else if (CONVERSATION.test(target)) threads.add(target);
  }
  for (const [key, reportId] of messages) {
    const report = await storage.get<SafetyReport>(`report:${reportId}`);
    const channel = report?.message?.channelId;
    if (
      report?.held &&
      holdAuthorized(report) &&
      report.roomKey === roomKey &&
      channel &&
      CONVERSATION.test(channel) &&
      key.startsWith(`held-message:${roomKey}:${channel}:`)
    )
      threads.add(channel);
  }
  return { ready: true, room, threads: [...threads] };
}

export type RetentionHolds = { room: boolean; threads: ReadonlySet<string> };
/** The holds that keep a workspace's support history from deletion. Read
 * whatever SAFETY_ENABLED says: holds are stored data, and a disabled flag
 * never unlocks deletion. With no binding no report can exist. null means
 * the answer is unknown, and the caller deletes nothing. */
export async function readRetentionHolds(
  env: SafetyEnv,
  roomKey: string,
): Promise<RetentionHolds | null> {
  if (!env.SAFETY_STORE) return { room: false, threads: new Set() };
  try {
    const response = await env.SAFETY_STORE.get(
      env.SAFETY_STORE.idFromName("templ-platform-safety:v1"),
    ).fetch(
      new Request("https://internal/safety", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ op: "retention-holds", roomKey }),
      }),
    );
    if (!response.ok) return null;
    const value = await response.json<{
      ready?: unknown;
      room?: unknown;
      threads?: unknown;
    }>();
    if (
      value?.ready !== true ||
      typeof value.room !== "boolean" ||
      !Array.isArray(value.threads) ||
      value.threads.some(
        (thread) => typeof thread !== "string" || !CONVERSATION.test(thread),
      )
    )
      return null;
    return { room: value.room, threads: new Set(value.threads as string[]) };
  } catch {
    return null;
  }
}

/** Platform-only report and enforcement storage. No room manager can read this binding. */
export class SafetyStore {
  constructor(
    private state: DurableObjectState,
    private env: Pick<Env, "APP_ORIGIN">,
  ) {}
  async fetch(request: Request) {
    // The storage recovery tool's records, which no restore touches.
    if (new URL(request.url).pathname === "/recovery")
      return recoveryStoreRoute(this.state.storage, request);
    try {
      if (
        new URL(request.url).pathname !== "/safety" ||
        request.method !== "POST"
      )
        return json({ error: "Not found." }, 404);
      const body = await readJson(request, 24_000);
      if (body.op === "status")
        return await readSafetyStatus(
          this.state.storage,
          body,
          siteOrigins(this.env).communityOrigin,
        );
      return await this.state.storage.transaction(async (storage) => {
        const now = Date.now();
        if (body.op === "report" || body.op === "report-receipt") {
          const { appOrigin, communityOrigin } = siteOrigins(this.env);
          if (typeof body.requestId !== "string" || !uuid.test(body.requestId))
            throw new HttpError(400, "Invalid report ID.");
          if (!REPORT_REASONS.includes(body.reason as Reason))
            throw new HttpError(400, "Choose a report reason.");
          const reporter =
            body.principalId == null
              ? null
              : normalizeChatPrincipal(body.principalId);
          if (body.principalId != null && !reporter)
            throw new HttpError(400, "Invalid user.");
          const aliases = servicePrincipals(reporter, body.servicePrincipals);
          if (
            typeof body.ipDigest !== "string" ||
            !/^[0-9a-f]{64}$/.test(body.ipDigest)
          )
            throw new HttpError(400, "Invalid report request.");
          let targetUrl: URL;
          try {
            targetUrl = new URL(text(body.targetUrl, 2048));
          } catch {
            throw new HttpError(400, "Use a valid Templ page link.");
          }
          const groupTarget = groupMediaTarget(targetUrl, communityOrigin);
          if (
            !(
              targetUrl.origin === appOrigin ||
              (targetUrl.origin === communityOrigin &&
                (/^\/media\/[0-9a-f]{64}$/.test(targetUrl.pathname) ||
                  groupTarget !== null))
            ) ||
            targetUrl.username ||
            targetUrl.password ||
            targetUrl.hash ||
            targetUrl.search
          )
            throw new HttpError(
              400,
              "Use a Templ page link without an invitation secret.",
            );
          if (
            body.roomKey != null &&
            (typeof body.roomKey !== "string" ||
              !roomPattern.test(body.roomKey))
          )
            throw new HttpError(400, "Invalid chat.");
          const details = text(body.details, 2000);
          const relatedReportId =
            body.relatedReportId == null ? null : String(body.relatedReportId);
          if (relatedReportId && !uuid.test(relatedReportId))
            throw new HttpError(400, "Check the report ID.");
          const message =
            body.message == null
              ? null
              : (body.message as SafetyReport["message"]);
          if (
            message &&
            (!/^[1-9][0-9]{0,14}$/.test(message.id) ||
              !/^[a-z0-9][a-z0-9-]{0,47}$/.test(message.channelId) ||
              !normalizeChatPrincipal(message.author) ||
              typeof message.text !== "string" ||
              new TextEncoder().encode(message.text).length > 4000 ||
              (message.attachments !== undefined &&
                (!Array.isArray(message.attachments) ||
                  message.attachments.length >
                    RETIRED_GROUP_FILE_LIMITS.filesPerMessage ||
                  message.attachments.some(
                    (attachment) =>
                      !attachment ||
                      typeof attachment.id !== "string" ||
                      !/^[0-9a-f]{64}$/.test(attachment.id) ||
                      typeof attachment.name !== "string" ||
                      !GROUP_ATTACHMENT_CONTENT_TYPES.includes(
                        attachment.contentType as (typeof GROUP_ATTACHMENT_CONTENT_TYPES)[number],
                      ) ||
                      !Number.isSafeInteger(attachment.bytes) ||
                      attachment.bytes < 1 ||
                      attachment.bytes > RETIRED_GROUP_FILE_LIMITS.fileBytes,
                  ))) ||
              !Number.isFinite(Date.parse(message.createdAt)))
          )
            throw new HttpError(400, "Invalid reported message.");
          const reference =
            body.messageRef ??
            (message ? { id: message.id, channelId: message.channelId } : null);
          let messageRef: { id: string; channelId: string } | null = null;
          if (reference != null) {
            const ref = reference as Record<string, unknown>;
            if (
              typeof reference !== "object" ||
              Array.isArray(reference) ||
              Object.keys(reference).length !== 2 ||
              typeof ref.id !== "string" ||
              !/^[1-9][0-9]{0,14}$/.test(ref.id) ||
              typeof ref.channelId !== "string" ||
              !/^[a-z0-9][a-z0-9-]{0,47}$/.test(ref.channelId) ||
              !body.roomKey ||
              !reporter
            )
              throw new HttpError(400, "Invalid reported message reference.");
            messageRef = {
              id: ref.id,
              channelId: ref.channelId,
            };
          }
          if (body.op === "report-receipt") {
            if (!reporter || !messageRef || message)
              throw new HttpError(400, "Invalid report receipt request.");
          } else if (
            messageRef &&
            (!message ||
              message.id !== messageRef.id ||
              message.channelId !== messageRef.channelId)
          )
            throw new HttpError(
              400,
              "Reported content does not match its reference.",
            );
          if (
            groupTarget &&
            body.op === "report" &&
            (body.roomKey !== `room:${groupTarget[1]}` ||
              !messageRef ||
              messageRef.channelId !== groupTarget[2] ||
              !message?.attachments?.some((file) => file.id === groupTarget[3]))
          )
            throw new HttpError(400, "Report a file from its message.");
          const scope = reporter ?? body.ipDigest;
          const dedupe = `report-request:${scope}:${body.requestId}`;
          // Bind the caller's intent, not the mutable message snapshot. A retry
          // must never replace the first accepted evidence or expose it.
          const intentFingerprint = await safetyDigest(
            JSON.stringify([
              body.reason,
              details,
              targetUrl.href,
              body.roomKey ?? null,
              messageRef,
              relatedReportId,
              ...(body.notice === undefined ? [] : [body.notice]),
            ]),
          );
          type PriorReport = {
            id: string;
            intentFingerprint: string;
            expiresAt: number;
          };
          const candidates = await Promise.all(
            (reporter ? aliases : [scope]).map((id) =>
              storage.get<PriorReport>(
                `report-request:${id}:${body.requestId}`,
              ),
            ),
          );
          const live = candidates.filter((value): value is PriorReport =>
            Boolean(value && value.expiresAt > now),
          );
          if (new Set(live.map((value) => value.id)).size > 1)
            throw new HttpError(
              409,
              "This report ID belongs to multiple linked histories.",
            );
          const previous = live[0];
          if (previous && previous.expiresAt > now) {
            if (previous.intentFingerprint !== intentFingerprint)
              throw new HttpError(
                409,
                "This report ID belongs to different details.",
              );
            return json(
              receiptView(
                previous.id,
                await storage.get<SafetyReport>(`report:${previous.id}`),
              ),
            );
          }
          if (body.op === "report-receipt")
            return json({ error: "Report receipt not found." }, 404);
          let notice: LegalNotice;
          try {
            notice = legalNotice(String(body.reason), body.notice);
          } catch (error) {
            throw new HttpError(400, (error as Error).message);
          }
          const day = Math.floor(now / 86_400_000);
          if (reporter) {
            const counts = await Promise.all(
              aliases.map((id) =>
                storage.get<number>(`report-budget:${day}:principal:${id}`),
              ),
            );
            if (
              counts.reduce<number>((sum, count) => sum + (count ?? 0), 0) >=
              SAFETY_REPORT_LIMITS.principal
            )
              throw new HttpError(
                429,
                "Too many reports. Please try again tomorrow.",
              );
          }
          for (const [scopeName, max] of [
            ["service", SAFETY_REPORT_LIMITS.service],
            [`ip:${body.ipDigest}`, SAFETY_REPORT_LIMITS.ip],
            ...(reporter
              ? [
                  [
                    `principal:${reporter}`,
                    SAFETY_REPORT_LIMITS.principal,
                  ] as const,
                ]
              : []),
          ] as const) {
            const key = `report-budget:${day}:${scopeName}`;
            const count = (await storage.get<number>(key)) ?? 0;
            if (count >= max)
              throw new HttpError(
                429,
                "Too many reports. Please try again tomorrow.",
              );
            await storage.put(key, count + 1);
          }
          const count = (await storage.get<number>("report-count")) ?? 0;
          if (count >= 20_000)
            throw new HttpError(503, "Reporting is temporarily unavailable.");
          const report: SafetyReport = {
            id: crypto.randomUUID(),
            createdAt: new Date(now).toISOString(),
            expiresAt: now + REPORT_RETENTION_MS,
            reporter,
            reason: body.reason as Reason,
            notice,
            authorityReview: null,
            mandatoryReview: null,
            urgentReview: null,
            details,
            targetUrl: targetUrl.href,
            roomKey: (body.roomKey as string) ?? null,
            message,
            relatedReportId,
            status: "open",
            held: false,
            retainedForEnforcement: false,
          };
          await storage.put(`report:${report.id}`, report);
          await storage.put(
            `report-expiry:${report.expiresAt}:${report.id}`,
            report.id,
          );
          await storage.put(dedupe, {
            id: report.id,
            intentFingerprint,
            expiresAt: now + 7 * 86_400_000,
          });
          await storage.put(
            `request-expiry:${now + 7 * 86_400_000}:${report.id}`,
            dedupe,
          );
          await storage.put("report-count", count + 1);
          const scheduled = await storage.getAlarm();
          if (scheduled === null || scheduled > now + 3_600_000)
            await storage.setAlarm(now + 3_600_000);
          return json(receiptView(report.id, report), 201);
        }
        if (body.op === "list") {
          if (body.reportIds !== undefined) {
            if (
              !Array.isArray(body.reportIds) ||
              body.reportIds.length < 1 ||
              body.reportIds.length > 10 ||
              body.cursor != null ||
              body.reportIds.some(
                (id) => typeof id !== "string" || !uuid.test(id),
              ) ||
              new Set(body.reportIds).size !== body.reportIds.length
            )
              throw new HttpError(
                400,
                "Choose up to ten report IDs without a cursor.",
              );
            const selected = await Promise.all(
              (body.reportIds as string[]).map((id) =>
                storage.get<SafetyReport>(`report:${id}`),
              ),
            );
            return json({
              reports: selected.filter((report) => report !== undefined),
              nextCursor: null,
            });
          }
          const cursor = body.cursor == null ? null : String(body.cursor);
          if (cursor && !uuid.test(cursor))
            throw new HttpError(400, "Invalid cursor.");
          const reports = [
            ...(
              await storage.list<SafetyReport>({
                prefix: "report:",
                limit: 51,
                ...(cursor ? { startAfter: `report:${cursor}` } : {}),
              })
            ).values(),
          ];
          return json({
            reports: reports.slice(0, 50),
            nextCursor: reports.length > 50 ? reports[49].id : null,
          });
        }
        if (body.op === "review") {
          const reviewer = normalizeChatPrincipal(body.reviewer);
          if (!reviewer) throw new HttpError(403, "Operator access required.");
          const authenticatedAt = requireWalletAuth(
            {
              authenticatedAt: body.authenticatedAt as number,
              authMethod: body.authMethod as AuthMethod,
            },
            body.confirmed,
            now,
          );
          if (typeof body.reportId !== "string" || !uuid.test(body.reportId))
            throw new HttpError(400, "Invalid report ID.");
          const report = await storage.get<SafetyReport>(
            `report:${body.reportId}`,
          );
          if (!report) throw new HttpError(404, "Report not found.");
          const note = text(body.note, 2000);
          if (
            ![
              "reviewed",
              "verify-authority",
              "reject-authority",
              "validate-notice-duty",
              "reject-notice-duty",
              "validate-urgent-duty",
              "reject-urgent-duty",
              "hold",
              "release-hold",
              "suspend-room",
              "restore-room",
              "suspend-author",
              "restore-author",
              "suspend-media",
              "restore-media",
            ].includes(String(body.action))
          )
            throw new HttpError(400, "Choose a review action.");
          const countKey = `review-count:${report.id}`;
          const count = (await storage.get<number>(countKey)) ?? 0;
          if (count >= 100)
            throw new HttpError(
              409,
              "This report has reached its review limit.",
            );
          if (
            ["verify-authority", "reject-authority"].includes(
              String(body.action),
            )
          ) {
            if (!report.notice?.authority)
              throw new HttpError(
                409,
                "This report contains no legal authority request.",
              );
            const review = body.authorityReview as
              | Record<string, unknown>
              | undefined;
            if (!review || typeof review !== "object" || Array.isArray(review))
              throw new HttpError(
                400,
                "Record the independent authority checks.",
              );
            report.authorityReview = {
              status:
                body.action === "verify-authority" ? "verified" : "rejected",
              checkedAt: new Date(now).toISOString(),
              independentSource: text(review.independentSource, 1000),
              contactVerification: text(review.contactVerification, 1000),
              instrumentVerification: text(review.instrumentVerification, 1000),
            };
          }
          if (
            ["validate-notice-duty", "reject-notice-duty"].includes(
              String(body.action),
            )
          ) {
            if (
              report.reason !== "mandatory-notice" ||
              !report.notice?.noticeObligation
            )
              throw new HttpError(
                409,
                "This report contains no claimed statutory notice duty.",
              );
            const review = body.mandatoryReview as
              | Record<string, unknown>
              | undefined;
            if (!review || typeof review !== "object" || Array.isArray(review))
              throw new HttpError(
                400,
                "Record the legal-duty applicability checks.",
              );
            report.mandatoryReview = {
              status:
                body.action === "validate-notice-duty"
                  ? "validated"
                  : "rejected",
              checkedAt: new Date(now).toISOString(),
              applicableLaw: text(review.applicableLaw, 1000),
              jurisdictionCheck: text(review.jurisdictionCheck, 1000),
              scopeCheck: text(review.scopeCheck, 1000),
            };
          }
          if (
            ["validate-urgent-duty", "reject-urgent-duty"].includes(
              String(body.action),
            )
          ) {
            if (!["child-safety", "imminent-harm"].includes(report.reason))
              throw new HttpError(
                409,
                "This report contains no urgent legal exception.",
              );
            const review = body.urgentReview as
              | Record<string, unknown>
              | undefined;
            if (!review || typeof review !== "object" || Array.isArray(review))
              throw new HttpError(
                400,
                "Record the urgent legal duty, evidence and scope.",
              );
            report.urgentReview = {
              status:
                body.action === "validate-urgent-duty"
                  ? "validated"
                  : "rejected",
              checkedAt: new Date(now).toISOString(),
              applicableLaw: text(review.applicableLaw, 1000),
              evidenceReview: text(review.evidenceReview, 1000),
              urgencyReview: text(review.urgencyReview, 1000),
              scopeCheck: text(review.scopeCheck, 1000),
            };
          }
          if (
            (body.action === "hold" ||
              String(body.action).startsWith("suspend-")) &&
            !holdAuthorized(report)
          )
            throw new HttpError(
              409,
              "New restrictions require a verified authority request or a validated legal duty. An appeal alone cannot authorize a restriction.",
            );
          const previousScope = heldScopeOf(report);
          // A hold may name the workspace, or one conversation in it, that
          // support retention keeps; null clears a scope set earlier.
          if (body.action === "hold" && body.holdScope !== undefined)
            report.holdScope =
              body.holdScope === null
                ? null
                : checkedHoldScope(body.holdScope, report);
          if (body.action === "hold") report.held = true;
          if (body.action === "release-hold") report.held = false;
          if (String(body.action).endsWith("-room")) {
            if (!report.roomKey)
              throw new HttpError(
                409,
                "Verify a room-specific report before changing access.",
              );
            const key = `suspension:room:${report.roomKey}`;
            const existing = await storage.get<{ reportId: string }>(key);
            if (existing && existing.reportId !== report.id)
              throw new HttpError(
                409,
                "Review the active suspension’s original report.",
              );
            if (body.action === "suspend-room")
              await storage.put(key, {
                reportId: report.id,
                at: now,
                reason: report.reason,
                reviewAfter: now + 30 * 86_400_000,
              });
            else await storage.delete(key);
          }
          if (String(body.action).endsWith("-author")) {
            if (!report.message)
              throw new HttpError(
                409,
                "Verify a message author before changing access.",
              );
            const key = `suspension:principal:${report.message.author}`;
            const existing = await storage.get<{ reportId: string }>(key);
            if (existing && existing.reportId !== report.id)
              throw new HttpError(
                409,
                "Review the active suspension’s original report.",
              );
            if (body.action === "suspend-author")
              await storage.put(key, {
                reportId: report.id,
                at: now,
                reason: report.reason,
                reviewAfter: now + 30 * 86_400_000,
              });
            else await storage.delete(key);
          }
          const communityOrigin = siteOrigins(this.env).communityOrigin;
          const mediaId =
            profileMediaHash(report.targetUrl, communityOrigin) ??
            reportedGroupMediaId(report, communityOrigin);
          if (String(body.action).endsWith("-media")) {
            if (!mediaId)
              throw new HttpError(
                409,
                "Use a report for a specific uploaded file.",
              );
            const key = `suspension:media:${mediaId}`;
            const existing = await storage.get<{ reportId: string }>(key);
            if (existing && existing.reportId !== report.id)
              throw new HttpError(
                409,
                "Review the active suspension’s original report.",
              );
            if (body.action === "suspend-media")
              await storage.put(key, {
                reportId: report.id,
                at: now,
                reason: report.reason,
                reviewAfter: now + 30 * 86400000,
              });
            else await storage.delete(key);
          }
          const mediaSuspension = mediaId
            ? await storage.get<{ reportId: string }>(
                `suspension:media:${mediaId}`,
              )
            : null;
          if (report.roomKey && report.message) {
            const protectedFile = Boolean(
              reportedGroupMediaId(report, communityOrigin) &&
              mediaSuspension?.reportId === report.id,
            );
            const protectedMessage = report.held || protectedFile;
            const key = heldMessageKey(
              report.roomKey,
              report.message,
              report.id,
            );
            if (protectedMessage) await storage.put(key, report.id);
            else await storage.delete(key);
            if (report.message.attachments?.length) {
              const fileChannel = heldFileChannelKey(
                report.roomKey,
                report.message.channelId,
                report.id,
              );
              if (protectedMessage) await storage.put(fileChannel, report.id);
              else await storage.delete(fileChannel);
            }
          }
          const scope = heldScopeOf(report);
          if (
            previousScope &&
            (!scope ||
              heldScopeKey(previousScope, report.id) !==
                heldScopeKey(scope, report.id))
          )
            await storage.delete(heldScopeKey(previousScope, report.id));
          if (scope) {
            if (report.held)
              await storage.put(heldScopeKey(scope, report.id), report.id);
            else await storage.delete(heldScopeKey(scope, report.id));
          }
          const roomSuspension = report.roomKey
            ? await storage.get<{ reportId: string }>(
                `suspension:room:${report.roomKey}`,
              )
            : null;
          const authorSuspension = report.message
            ? await storage.get<{ reportId: string }>(
                `suspension:principal:${report.message.author}`,
              )
            : null;
          report.retainedForEnforcement =
            roomSuspension?.reportId === report.id ||
            authorSuspension?.reportId === report.id ||
            mediaSuspension?.reportId === report.id;
          if (report.held || report.retainedForEnforcement)
            await storage.delete(
              `report-expiry:${report.expiresAt}:${report.id}`,
            );
          else
            await storage.put(
              `report-expiry:${report.expiresAt}:${report.id}`,
              report.id,
            );
          report.status = "reviewed";
          await storage.put(`report:${report.id}`, report);
          await storage.put(
            `review:${report.id}:${String(count + 1).padStart(3, "0")}`,
            {
              at: now,
              reviewer,
              authenticatedAt,
              authMethod: body.authMethod,
              action: body.action,
              note,
              ...(["validate-urgent-duty", "reject-urgent-duty"].includes(
                String(body.action),
              )
                ? { urgentReview: report.urgentReview }
                : {}),
              ...(["validate-notice-duty", "reject-notice-duty"].includes(
                String(body.action),
              )
                ? { mandatoryReview: report.mandatoryReview }
                : {}),
              ...(["verify-authority", "reject-authority"].includes(
                String(body.action),
              )
                ? { authorityReview: report.authorityReview }
                : {}),
            },
          );
          await storage.put(countKey, count + 1);
          return json({ ok: true });
        }
        if (body.op === "retention-holds") {
          const roomKey = body.roomKey;
          if (typeof roomKey !== "string" || !roomPattern.test(roomKey))
            throw new HttpError(400, "Invalid chat.");
          return json(await retentionHolds(storage, roomKey));
        }
        throw new HttpError(404, "Not found.");
      });
    } catch (error) {
      return json(
        {
          error:
            error instanceof HttpError
              ? error.message
              : "Safety service is temporarily unavailable.",
        },
        error instanceof HttpError ? error.status : 503,
      );
    }
  }
  async alarm() {
    await this.state.storage.transaction(async (storage) => {
      const now = Date.now();
      const expired = await storage.list<string>({
        prefix: "report-expiry:",
        end: `report-expiry:${now}:~`,
        limit: 250,
      });
      let removed = 0;
      for (const [key, id] of expired) {
        const report = await storage.get<SafetyReport>(`report:${id}`);
        if (report?.held || report?.retainedForEnforcement) {
          await storage.delete(key);
          continue;
        }
        if (report) {
          await storage.delete(`report:${id}`);
          removed++;
        }
        for (const review of (
          await storage.list({ prefix: `review:${id}:`, limit: 100 })
        ).keys())
          await storage.delete(review);
        await storage.delete(`review-count:${id}`);
        await storage.delete(key);
      }
      if (removed)
        await storage.put(
          "report-count",
          Math.max(
            0,
            ((await storage.get<number>("report-count")) ?? 0) - removed,
          ),
        );
      const requests = await storage.list<string>({
        prefix: "request-expiry:",
        end: `request-expiry:${now}:~`,
        limit: 250,
      });
      for (const [key, dedupe] of requests) {
        const latest = await storage.get<{ expiresAt: number }>(dedupe);
        if (latest && latest.expiresAt <= now) await storage.delete(dedupe);
        await storage.delete(key);
      }
      const day = Math.floor(now / 86_400_000);
      for (const key of (
        await storage.list({ prefix: "report-budget:", limit: 500 })
      ).keys())
        if (Number(key.split(":")[1]) < day) await storage.delete(key);
      await storage.setAlarm(now + 3_600_000);
    });
  }
}
