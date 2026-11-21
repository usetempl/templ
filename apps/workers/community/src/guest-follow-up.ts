/** A guest's verified notice address belongs to one thread. It grants no wallet authority. */
import { FEATURE_LIMITS } from "@templ/chat/feature-limits";
import { SUPPORT_LIMITS } from "@templ/chat/support";
import { OWN_SUPPORT_ENDPOINT } from "@templ/e2ee/protocol";
import { encryptedCaseStateKey, type RelayCaseState } from "@templ/e2ee/relay";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { HttpError, json, recordByHash, siteOrigins, type Env } from "./common";
import { keyedHex, sha256Hex } from "./alert-crypto";
import { normalizeEmail, type EmailEnv } from "./email-delivery";
import type { AuthData } from "./auth-record";
import type { NativeRoomRecord } from "./native-rooms";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";
import {
  queueNotificationJob,
  supportNotificationsConfigured,
} from "./support-notifications";
import { widgetConfigSnapshot } from "./support-widget";
import { hostedPageHref, hostedPageOffered } from "./hosted-support";
import { widgetWebsiteOrigin } from "./widget-origin";
import { loopbackOffered } from "./widget-session-config";
import {
  activeWorkspaceFlags,
  workspaceFeatureEnvFromFlags,
} from "./workspace-flags";

const HASH = /^[0-9a-f]{64}$/;
const THREAD = /^tc-[0-9a-f]{32}$/;
export const guestFollowUpKey = (thread: string) =>
  `guest-follow-up-v1:${thread}:address`;
const tokenKey = (thread: string, hash: string) =>
  `guest-follow-up-v1:${thread}:resume:${hash}`;
type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;
export type GuestFollowUp = {
  principal: ChatPrincipalId;
  credentialHash: string;
  origin: string;
  returnOrigin: string;
  path: string;
  email: string;
  generation: string;
  confirmedAt?: number;
  confirmationHash: string;
  /** The hash of the one-click stop link in this address's reply emails. */
  unsubscribeHash?: string;
  expiresAt: number;
  rotation?: string;
};
const gone = () =>
  new HttpError(
    410,
    "This link expired or has been used. Open the chat to ask for another.",
  );
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
export async function currentGuestFollowUp(
  storage: Pick<Storage, "get">,
  thread: string,
): Promise<GuestFollowUp | null> {
  const [row, record, native, privacy] = await Promise.all([
    storage.get<GuestFollowUp>(guestFollowUpKey(thread)),
    storage.get<TeamConversationRecord>(`conversation-v1:${thread}`),
    storage.get<NativeRoomRecord>("native-room"),
    storage.get<{ visibility: string }>("room-privacy"),
  ]);
  if (
    !row ||
    !record ||
    !native ||
    record.deleting ||
    record.stopped ||
    record.room !== `room:${native.room.id}` ||
    record.member !== row.principal
  )
    return null;
  if (
    (privacy?.visibility ?? native.room.visibility) === "private" &&
    native.room.manager !== row.principal &&
    !(await storage.get(`room-member:${row.principal}`))
  )
    return null;
  return row;
}
export async function guestCredentialActive(
  env: Env,
  workspace: string,
  row: GuestFollowUp,
) {
  const response = await recordByHash(env, "guest", row.credentialHash).fetch(
    new Request("https://internal/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const guest = await response.json<AuthData>();
  return (
    guest.purpose === "widget-guest" &&
    guest.principalId === row.principal &&
    guest.widgetScope?.room === workspace &&
    guest.widgetScope.origin === row.origin &&
    guest.expiresAt > Date.now()
  );
}
export async function guestFollowUpThread(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
) {
  if (
    context.query.get("view") !== "guest-email" &&
    context.body.action !== "guest-email"
  )
    return null;
  const hash = context.headers.get("X-Support-Guest-Credential");
  const origin = context.headers.get("X-Support-Widget-Origin");
  if (
    role !== "member" ||
    context.viewer.principalId !== record.member ||
    context.headers.get("X-Support-Widget") !== "member" ||
    !hash ||
    !HASH.test(hash) ||
    !origin ||
    context.headers.get("X-Session-Auth-Method") !== "guest"
  )
    throw new HttpError(403, "Only this guest can change reply emails.");
  if (!supportNotificationsConfigured(context.mediaEnv))
    throw new HttpError(404, "Reply emails are not available.");
  const held = await currentGuestFollowUp(storage, record.id);
  if (context.method === "GET")
    return json({
      enabled: !!held?.confirmedAt,
      pending: !!held && !held.confirmedAt,
    });
  const workflow = await storage.get<{ lastMemberMessageAt?: number | null }>(
    `support-workflow-v1:${record.id}`,
  );
  // The Templ homepage can reserve a guest's own empty thread after the
  // visitor asks for notices. The same email confirmation and delivery
  // checks apply before and after their first message.
  const ownHome = context.appOrigin === "https://usetempl.com" &&
    origin === context.appOrigin &&
    context.room === `room:${OWN_SUPPORT_ENDPOINT.workspace}` &&
    context.mediaEnv.TEMPL_SUPPORT_WORKSPACE === OWN_SUPPORT_ENDPOINT.workspace &&
    record.state === "open" && !record.stopped && !record.deleting &&
    !record.encryptedCases && record.messageCount === 0;
  if (context.method !== "POST" || (!workflow?.lastMemberMessageAt && !ownHome))
    throw new HttpError(400, "Send your question first.");
  if (context.body.enabled === false) {
    if (held) await storage.delete(guestFollowUpKey(record.id));
    return json({ enabled: false, pending: false });
  }
  const email = normalizeEmail(context.body.email);
  const path = context.body.path;
  if (
    typeof path !== "string" ||
    path.length > SUPPORT_LIMITS.guestReturnPathChars ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\\\r\n]/.test(path) ||
    new URL(path, origin).origin !== origin ||
    new URL(path, origin).pathname !== path
  )
    throw new HttpError(
      400,
      "Open the chat on the team's website and try again.",
    );
  const day = dayOf(context.now);
  const countKey = `guest-follow-up-v1:${record.id}:confirmations:${day}`;
  const confirmations = (await storage.get<number>(countKey)) ?? 0;
  if (confirmations >= FEATURE_LIMITS.guestEmailConfirmationsPerDay)
    throw new HttpError(
      429,
      "Too many confirmation links today. Try again tomorrow.",
    );
  const generation = crypto.randomUUID();
  const secret = (context.mediaEnv as EmailEnv).EMAIL_AUTH_SECRET!;
  const token = await keyedHex(
    secret,
    `guest-confirm:${context.room}:${record.id}:${generation}`,
  );
  const row: GuestFollowUp = {
    principal: record.member,
    credentialHash: hash,
    origin,
    returnOrigin: origin,
    path,
    email,
    generation,
    confirmationHash: await sha256Hex(token),
    expiresAt: context.now + SUPPORT_LIMITS.guestLinkMs,
  };
  if (
    !(await guestCredentialActive(context.mediaEnv, context.room.slice(5), row))
  )
    throw new HttpError(401, "Open the chat again.");
  await storage.put(guestFollowUpKey(record.id), row);
  await storage.put(countKey, confirmations + 1);
  const queued = await queueNotificationJob(storage, {
    now: context.now,
    room: context.room,
    appOrigin: context.appOrigin,
    recipient: record.member,
    kind: "guest-confirmation",
    conversation: record.id,
    bucketMs: 1,
    facts: { guestGeneration: generation },
  }, context.mediaEnv);
  if (!queued)
    throw new HttpError(
      503,
      "The confirmation email could not be queued. Try again.",
    );
  return json({ enabled: false, pending: true });
}

export async function guestFollowUpPrivate(
  storage: Storage,
  op: string,
  body: Record<string, unknown>,
  now: number,
  env: Env,
): Promise<Response | null> {
  if (!op.startsWith("guest-")) return null;
  const thread = body.thread;
  if (typeof thread !== "string" || !THREAD.test(thread)) throw gone();
  const row = await currentGuestFollowUp(storage, thread);
  if (op === "guest-unsubscribe") {
    // The same answer whether or not the link matched.
    if (
      row?.unsubscribeHash &&
      typeof body.tokenHash === "string" &&
      body.tokenHash === row.unsubscribeHash
    )
      await storage.delete(guestFollowUpKey(thread));
    return json({ ok: true });
  }
  if (!row) throw new HttpError(404, "Support link not found.");
  if (op === "guest-confirm") {
    if (
      typeof body.tokenHash !== "string" ||
      body.tokenHash !== row.confirmationHash ||
      row.confirmedAt ||
      row.expiresAt <= now
    )
      throw gone();
    const native = await storage.get<{ room: { id: string } }>("native-room");
    if (!native || !(await guestCredentialActive(env, native.room.id, row)))
      throw gone();
    row.confirmedAt = now;
    await storage.put(guestFollowUpKey(thread), row);
    return json({ enabled: true });
  }
  if (op === "guest-resume") {
    if (
      !(
        body.origin === row.origin ||
        body.origin === row.returnOrigin ||
        (body.hosted === true && body.origin === env.APP_ORIGIN)
      )
    )
      throw new HttpError(404, "Support link not found.");
    if (
      typeof body.tokenHash !== "string" ||
      !HASH.test(body.tokenHash) ||
      !row.confirmedAt ||
      row.rotation
    )
      throw gone();
    const key = tokenKey(thread, body.tokenHash);
    const token = await storage.get<{
      generation: string;
      expiresAt: number;
      used?: boolean;
    }>(key);
    if (!token || token.generation !== row.generation)
      throw new HttpError(404, "Support link not found.");
    if (token.used || token.expiresAt <= now) throw gone();
    if (body.consume !== true)
      return json({
        principal: row.principal,
        credentialHash: row.credentialHash,
        origin: row.origin,
      });
    if (body.credentialHash !== row.credentialHash) throw gone();
    await storage.put(key, { ...token, used: true });
    row.rotation = body.tokenHash;
    await storage.put(guestFollowUpKey(thread), row);
    return json({
      principal: row.principal,
      credentialHash: row.credentialHash,
      origin: row.origin,
    });
  }
  if (op === "guest-rotation-failed") {
    if (row.rotation === body.tokenHash) {
      delete row.rotation;
      await storage.put(guestFollowUpKey(thread), row);
    }
    return json({ ok: true });
  }
  if (op === "guest-rotated") {
    if (
      row.rotation !== body.tokenHash ||
      typeof body.credentialHash !== "string" ||
      !HASH.test(body.credentialHash) ||
      typeof body.origin !== "string"
    )
      throw gone();
    row.credentialHash = body.credentialHash;
    row.origin = body.origin;
    delete row.rotation;
    await storage.put(guestFollowUpKey(thread), row);
    return json({ ok: true });
  }
  throw gone();
}
async function ownEncryptedReturnOrigin(storage: Storage, workspace: string, conversation: string, origin: string, returnOrigin: string, env: Partial<EmailEnv>) {
  if (env.APP_ORIGIN !== "https://usetempl.com" || workspace !== OWN_SUPPORT_ENDPOINT.workspace ||
      origin !== OWN_SUPPORT_ENDPOINT.clientOrigin || returnOrigin !== origin) return undefined;
  const data = await storage.get<{caseSeq?: number}>(`support-workflow-v1:${conversation}`);
  if (!Number.isSafeInteger(data?.caseSeq) || data!.caseSeq! < 1) return null;
  const state = await storage.get<RelayCaseState>(encryptedCaseStateKey({environment: "production", workspace, conversation, caseSeq: data!.caseSeq!}));
  return state && !state.deleted && state.profile.custody === "templ-own-support" &&
    state.profile.rootKey === (env as Partial<Env>).OWN_SUPPORT_ENCRYPTION_ROOT &&
    state.profile.clientOrigin === origin ? origin : null;
}
export async function guestEmailContent(
  storage: Storage,
  job: {
    id: string;
    kind: string;
    conversation: string | null;
    recipient: string;
    facts?: { guestGeneration?: string };
  },
  env: Partial<EmailEnv>,
  now: number,
) {
  if (!job.conversation || !env.EMAIL_AUTH_SECRET || !env.APP_ORIGIN)
    return null;
  const row = await currentGuestFollowUp(storage, job.conversation);
  const native = await storage.get<{ room: { id: string } }>("native-room");
  if (
    !row ||
    !native ||
    row.principal !== job.recipient ||
    !(await guestCredentialActive(env as Env, native.room.id, row))
  )
    return null;
  if (job.kind === "guest-confirmation") {
    if (
      row.generation !== job.facts?.guestGeneration ||
      row.confirmedAt ||
      row.expiresAt <= now
    )
      return null;
    const token = await keyedHex(
      env.EMAIL_AUTH_SECRET,
      `guest-confirm:room:${native.room.id}:${job.conversation}:${row.generation}`,
    );
    const href = `${siteOrigins(env as Env).communityOrigin}/alerts/guest/confirm?w=${native.room.id}&thread=${job.conversation}&t=${token}`;
    return {
      subject: "Confirm reply emails for your case",
      text: `Open this link to get an email when the team replies:\n\n${href}\n\nIf you did not ask for this, ignore this email.`,
    };
  }
  if (!row.confirmedAt) return null;
  // The sender holds this room's transaction. An ordinary widgetConfig
  // read would refresh flags by calling this same room and wait on itself.
  const settingsResponse = await widgetConfigSnapshot(
    env as Env,
    native.room.id,
    row.origin,
  );
  if (!settingsResponse.ok) return null;
  const settings = await settingsResponse.json<{
    hostedPage?: boolean;
    closed?: boolean;
  }>();
  if (settings.closed) return null;
  const scoped = workspaceFeatureEnvFromFlags(
    env as Env,
    await activeWorkspaceFlags(storage, Date.now(), env as Env),
    native.room.id,
  );
  if (!supportNotificationsConfigured(scoped)) return null;
  const ownSecure = await ownEncryptedReturnOrigin(storage, native.room.id, job.conversation, row.origin, row.returnOrigin, env);
  // An Own encrypted return must never move to a host without its keys.
  if (ownSecure === null) return null;
  const hosted = !ownSecure && hostedPageOffered(scoped) && settings.hostedPage;
  if (
    !hosted &&
    !widgetWebsiteOrigin(row.returnOrigin, loopbackOffered(scoped))
  )
    return null;
  const token = await keyedHex(
    env.EMAIL_AUTH_SECRET,
    `guest-resume:${native.room.id}:${job.conversation}:${row.generation}:${job.id}`,
  );
  const hash = await sha256Hex(token);
  const key = tokenKey(job.conversation, hash);
  if (!(await storage.get(key))) {
    const day = dayOf(now);
    const countKey = `guest-follow-up-v1:${job.conversation}:resumes:${day}`;
    const count = (await storage.get<number>(countKey)) ?? 0;
    if (count >= FEATURE_LIMITS.guestResumeLinksPerDay) return null;
    await storage.put(countKey, count + 1);
    await storage.put(key, {
      generation: row.generation,
      expiresAt: now + SUPPORT_LIMITS.guestLinkMs,
    });
    const tokens = await storage.list<{ expiresAt: number }>({
      prefix: `guest-follow-up-v1:${job.conversation}:resume:`,
    });
    for (const [old, entry] of tokens)
      if (entry.expiresAt <= now) await storage.delete(old);
  }
  const page = ownSecure ? `${ownSecure}/` : hosted
    ? hostedPageHref(env.APP_ORIGIN, native.room.id)
    : `${row.returnOrigin}${row.path}`;
  const href = `${page}#templ-guest=${native.room.id}.${job.conversation}.${token}`;
  // A stop link for this address on this thread; opening it never opens the
  // chat or touches the guest's credential.
  const stop = await keyedHex(
    env.EMAIL_AUTH_SECRET,
    `guest-unsub:${native.room.id}:${job.conversation}:${row.generation}`,
  );
  const stopHash = await sha256Hex(stop);
  if (row.unsubscribeHash !== stopHash) {
    row.unsubscribeHash = stopHash;
    await storage.put(guestFollowUpKey(job.conversation), row);
  }
  const unsubscribe = `${siteOrigins(env as Env).communityOrigin}/alerts/guest/unsubscribe?w=${native.room.id}&thread=${job.conversation}&t=${stop}`;
  return {
    subject: "The team replied in Templ Support",
    text: `The team replied to your case. Open your chat:\n\n${href}\n\nThis link works once and expires in 24 hours. To stop these emails, use this link: ${unsubscribe}`,
    headers: {
      "List-Unsubscribe": `<${unsubscribe}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
