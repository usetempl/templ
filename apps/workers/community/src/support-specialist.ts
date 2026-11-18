/** The Specialist role: case-scoped read access through a follow-up.
 *
 * Only the manager grants the role (`handleFollowUps`, code `f`), a
 * registered bot never holds it, and the role alone reads nothing. A
 * specialist reads one request while one of these holds, checked again on
 * every request from current records:
 * - they own an open or blocked follow-up on it (a person on the team made
 *   them owner, or they took one routed to a group the manager put them in);
 * - a person on the team mentioned them in a note on it in the last 14 days,
 *   while the request is still open.
 * Case access ends when the case closes.
 *
 * The access covers that request's own messages, notes and screenshots from
 * its first message, never an earlier or later request in the thread. A specialist
 * adds notes and works their own follow-ups; every other thread route
 * answers the same 404 as a thread they can't read. The dispatcher here is
 * an allowlist: it never enters the team's code paths. */
import { effectivePermissions } from "@templ/chat/moderation-permissions";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type {
  SupportActivity,
  SupportAttachment,
  SupportNote,
} from "@templ/chat/support";
import { readStoredSupportContext } from "@templ/chat/support-context";
import { FOLLOW_UP_LIMITS } from "@templ/chat/support-follow-ups";
import { HttpError, json } from "./common";
import { staffRefusal } from "./product-entitlements";
import { messagePagination } from "./export";
import { readSupportAttachment } from "./media";
import {
  assertMessageBudgetAvailable,
  MESSAGE_BUDGET_AVAILABLE_HEADER,
} from "./message-budget";
import {
  messageKey,
  renderMessages,
  type StoredMessage,
} from "./message-store";
import { refusePhrase } from "./secret-guard";
import { readCase } from "./support-case-data";
import { applyCaseEvent } from "./support-cases";
import {
  FOLLOW_UP_OWNER_PREFIX,
  dueKey,
  followUpLineView,
  isActive,
  mentionByKey,
  mentionKey,
  noteSpecialistRead,
  readFollowUp,
  threadFollowUps,
  type FollowUpRecord,
} from "./support-follow-ups";
import { currentGroupMembers } from "./support-routing";
import { reserveSupportMessage } from "./support-retention";
import {
  queueSupportNotification,
  recordSupportActivity,
  supportRecord,
  supportSettings,
} from "./support-workflow";
import {
  CONVERSATION_NOT_FOUND_ERROR,
  conversationView,
  readConversation,
  type ConversationContext,
  type TeamConversationRecord,
} from "./team-conversations";
import { wakeRoomAt } from "./room-alarm";

type Storage = DurableObjectTransaction;
type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;
const DAY_MS = 86_400_000;
const notFound = () => new HttpError(404, CONVERSATION_NOT_FOUND_ERROR);
const iso = (at: number) => new Date(at).toISOString();
const natural = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** A specialist now: the role, and no team authority (the team path wins
 * for someone who holds both). Widget sessions carry no permissions, so a
 * widget session is never a specialist. */
export function isSpecialistViewer(
  context: Pick<ConversationContext, "viewer" | "isBot">,
): boolean {
  const viewer = context.viewer;
  if (!viewer.principalId || context.isBot) return false;
  if (viewer.isManager) return false;
  const effective = effectivePermissions(viewer.permissions);
  return (
    effective.includes("handleFollowUps") &&
    !effective.includes("handleConversations")
  );
}

export type SpecialistWindow = {
  seq: number;
  from: number;
  to: number | null;
  via: ("owner" | "mention")[];
  until: number | null;
};
export type SpecialistScope = {
  record: FollowUpRecord;
  windows: SpecialistWindow[];
};
type Mention = { seq: number; at: number; by: ChatPrincipalId; until: number };
function checkedMention(raw: unknown): Mention | null {
  const m = raw as Mention | undefined;
  return m &&
    typeof m === "object" &&
    natural(m.seq) &&
    m.seq >= 1 &&
    natural(m.at) &&
    natural(m.until) &&
    typeof m.by === "string"
    ? m
    : null;
}
/** Which requests of this thread the specialist may read now, computed from
 * records on every call. Null means none (every route answers 404). */
export async function specialistScope(
  storage: ReadStorage,
  context: Pick<ConversationContext, "viewer" | "aliases" | "room" | "isBot">,
  thread: string,
  now: number,
): Promise<SpecialistScope | null> {
  if (!isSpecialistViewer(context)) return null;
  const record = (await readConversation(
    storage,
    thread,
  )) as FollowUpRecord | null;
  if (!record || record.room !== context.room) return null;
  const aliases = context.aliases.slice(0, 8);
  const found = new Map<number, Set<"owner" | "mention">>();
  const untils = new Map<number, number>();
  for (const alias of aliases) {
    const rows = await storage.list<{ seq?: number }>({
      prefix: `${FOLLOW_UP_OWNER_PREFIX}${alias}:${thread}:`,
      limit: FOLLOW_UP_LIMITS.perCase + 1,
    });
    for (const key of rows.keys()) {
      const id = key.slice(key.lastIndexOf(":") + 1);
      const f = await readFollowUp(storage, thread, id);
      // An index row that doesn't match its record grants nothing.
      if (!f || f.owner !== alias || !isActive(f)) continue;
      (found.get(f.seq) ?? found.set(f.seq, new Set()).get(f.seq)!).add(
        "owner",
      );
    }
    const mention = checkedMention(
      await storage.get(mentionKey(thread, alias)),
    );
    if (mention && now < mention.until) {
      (
        found.get(mention.seq) ??
        found.set(mention.seq, new Set()).get(mention.seq)!
      ).add("mention");
      untils.set(
        mention.seq,
        Math.max(untils.get(mention.seq) ?? 0, mention.until),
      );
    }
  }
  const windows: SpecialistWindow[] = [];
  for (const [seq, found_] of found) {
    const read = await readCase(storage, {
      thread: thread as `tc-${string}`,
      seq,
    });
    // A gone or unreadable case grants nothing.
    if (!read || read.case.resolvedAt !== null || read.case.abandonedAt != null) continue;
    const via = [...found_];
    windows.push({
      seq,
      from: read.case.openedAt,
      to: null,
      via: via.sort(),
      until: via.includes("mention") ? (untils.get(seq) ?? null) : null,
    });
  }
  if (!windows.length) return null;
  windows.sort((a, b) => a.seq - b.seq);
  return { record, windows };
}
const inWindows = (windows: readonly SpecialistWindow[], at: number) =>
  windows.some((w) => at >= w.from && (w.to === null || at <= w.to));
const earliest = (windows: readonly SpecialistWindow[]) =>
  Math.min(...windows.map((w) => w.from));
function accessView(scope: SpecialistScope) {
  const via = [...new Set(scope.windows.flatMap((w) => w.via))].sort();
  const untils = scope.windows
    .map((w) => w.until)
    .filter((value): value is number => value !== null);
  return {
    via,
    until:
      untils.length && !via.includes("owner") ? iso(Math.max(...untils)) : null,
    from: iso(earliest(scope.windows)),
  };
}
/** The conversation as a specialist reads it: the member line and state,
 * no linked threads, no claim or takeover controls, and never a reply. */
function specialistConversation(
  record: FollowUpRecord,
  context: ConversationContext,
  now: number,
) {
  const base = conversationView(record, "team", context.viewer, true, {
    aliases: context.aliases,
    canClaim: false,
  });
  const {
    linkedConversations: _linked,
    canClaim: _claim,
    canRelease: _release,
    canTakeover: _takeover,
    replyBlocked: _blocked,
    ai: _ai,
    assignment: _assignment,
    ...rest
  } = base as typeof base & Record<string, unknown>;
  void [_linked, _claim, _release, _takeover, _blocked, _ai, _assignment];
  const line = followUpLineView(record, now);
  return {
    ...rest,
    viewer: "specialist" as const,
    canPost: false,
    postBlockedReason: "specialist" as const,
    ...(line ? { followUp: line } : {}),
  };
}

/** Grants a specialist mentioned by a person on the team read access to the
 * request for 14 days (a repeat mention extends it). */
export async function grantMention(
  storage: Storage,
  context: Pick<ConversationContext, "now" | "pendingAudit">,
  record: TeamConversationRecord,
  input: { principal: ChatPrincipalId; seq: number; by: ChatPrincipalId },
) {
  const now = context.now;
  const until = now + FOLLOW_UP_LIMITS.mentionAccessDays * DAY_MS;
  const previous = checkedMention(
    await storage.get(mentionKey(record.id, input.principal)),
  );
  if (previous)
    await storage.delete(
      dueKey(previous.until, record.id, `m-${input.principal}`),
    );
  await storage.put(mentionKey(record.id, input.principal), {
    seq: input.seq,
    at: now,
    by: input.by,
    until,
  } satisfies Mention);
  await storage.put(mentionByKey(input.principal, record.id), true);
  await storage.put(dueKey(until, record.id, `m-${input.principal}`), {
    kind: "mention-expiry",
  });
  await wakeRoomAt(storage as never, until);
  context.pendingAudit.push({
    actor: input.by,
    action: "support.specialist.mention",
    channelId: record.id,
    target: input.principal,
    after: { until: iso(until) },
  });
}
/** A person on the team ends a specialist's mention access. Ownership ends
 * by closing, reassigning or giving back the follow-up. */
export async function endMentionAccess(
  storage: Storage,
  context: Pick<ConversationContext, "pendingAudit">,
  record: TeamConversationRecord,
  input: { principal: ChatPrincipalId; by: ChatPrincipalId },
): Promise<boolean> {
  const previous = checkedMention(
    await storage.get(mentionKey(record.id, input.principal)),
  );
  if (!previous) return false;
  await storage.delete(mentionKey(record.id, input.principal));
  await storage.delete(mentionByKey(input.principal, record.id));
  await storage.delete(
    dueKey(previous.until, record.id, `m-${input.principal}`),
  );
  context.pendingAudit.push({
    actor: input.by,
    action: "support.specialist.end",
    channelId: record.id,
    target: input.principal,
    after: { by: "team" },
  });
  return true;
}

const TEXT_LIMIT = 4000;
/** Whether follow-ups are on (the rollout switch and the workflow) and the
 * team may write now (Support on for the workspace). */
export type SpecialistGate = { enabled: boolean; writable: boolean };
/** A specialist's internal note: the team's note path, with mentions of
 * team staff only (a specialist can't extend anyone's access). It passes
 * the same checks a team note does: the feature on and Support on for the
 * workspace. */
async function specialistNote(
  storage: Storage,
  context: ConversationContext,
  scope: SpecialistScope,
  gate: SpecialistGate,
): Promise<Response> {
  const actor = context.viewer.principalId!;
  const body = context.body;
  if (!gate.enabled)
    throw new HttpError(503, "Support tools are being tested.");
  if (!gate.writable) throw staffRefusal();
  if (context.viewer.banned || context.viewer.mutedUntil)
    throw new HttpError(403, "You cannot change this case right now.");
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "action",
          "text",
          "clientId",
          "mentions",
          "expectedPrincipalId",
        ].includes(key),
    )
  )
    throw new HttpError(400, "This note has a field Templ doesn't know.");
  const mentions: ChatPrincipalId[] = [];
  const raw = body.mentions ?? [];
  if (!Array.isArray(raw) || raw.length > 10)
    throw new HttpError(400, "Mention team staff only.");
  for (const value of raw) {
    const principal = normalizeChatPrincipal(value);
    if (
      !principal ||
      (context.bots ?? []).includes(principal) ||
      !(await context.isSupportStaff?.(principal))
    )
      throw new HttpError(400, "Mention team staff only.");
    if (!mentions.includes(principal)) mentions.push(principal);
  }
  const clientId =
    typeof body.clientId === "string" ? body.clientId.slice(0, 80) : "";
  if (!clientId) throw new HttpError(400, "Send a valid note id.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > TEXT_LIMIT)
    throw new HttpError(400, "Write a note of up to 4,000 characters.");
  await refusePhrase(text, "saved");
  const record = scope.record;
  const data = await supportRecord(storage, record);
  if (
    !scope.windows.some(
      (window) => window.seq === data.caseSeq && window.to === null,
    )
  )
    throw notFound();
  const retryKey = `support-note-client-v1:${record.id}:${clientId}`;
  const previousKey = await storage.get<string>(retryKey);
  const existing = previousKey
    ? await storage.get<SupportNote>(previousKey)
    : undefined;
  if (
    existing &&
    (existing.author !== actor ||
      existing.text !== text ||
      existing.mentions.join() !== mentions.join())
  )
    throw new HttpError(409, "This note retry does not match the original.");
  let committed = false;
  if (!existing) {
    assertMessageBudgetAvailable(
      context.headers.get(MESSAGE_BUDGET_AVAILABLE_HEADER) !== "false",
    );
    if ((data.noteCount ?? 0) >= 1_000)
      throw new HttpError(
        409,
        "This case has reached its internal-note limit.",
      );
    await reserveSupportMessage(storage, context.now, "team");
    data.noteCount = (data.noteCount ?? 0) + 1;
    const noteKey = `support-note-v1:${record.id}:${String(data.noteCount).padStart(8, "0")}`;
    await storage.put(noteKey, {
      id: clientId,
      author: actor,
      text,
      mentions,
      at: iso(context.now),
    } satisfies SupportNote);
    await storage.put(retryKey, noteKey);
    committed = true;
    context.pendingAudit.push({
      actor,
      action: "support.note",
      channelId: record.id,
      target: clientId,
      after: { mentions: mentions.length },
    });
    await applyCaseEvent(storage, record, data, {
      kind: "note",
      at: context.now,
    });
    await recordSupportActivity(storage, record.id, data, {
      actor,
      action: "note",
      at: context.now,
    });
    for (const mentioned of mentions)
      await queueSupportNotification(
        storage,
        context,
        record,
        mentioned,
        "mention",
      );
  }
  return json(
    { workflow: await specialistWorkflow(storage, context, scope) },
    201,
    committed ? { "X-Message-Budget-Used": "true" } : undefined,
  );
}
async function specialistWorkflow(
  storage: Storage,
  context: ConversationContext,
  scope: SpecialistScope,
) {
  const record = scope.record;
  const data = await supportRecord(storage, record);
  const settings = await supportSettings(storage);
  const currentCaseVisible = scope.windows.some(
    (window) => window.seq === data.caseSeq && window.to === null,
  );
  const notes = [
    ...(
      await storage.list<SupportNote>({
        prefix: `support-note-v1:${record.id}:`,
        reverse: true,
        limit: 200,
      })
    ).values(),
  ]
    .filter((note) => inWindows(scope.windows, Date.parse(note.at)))
    .slice(0, 50)
    .map((note) =>
      (context.bots ?? []).includes(note.author)
        ? { ...note, byAgent: true as const }
        : note,
    );
  const activity = [
    ...(
      await storage.list<SupportActivity>({
        prefix: `support-activity-v1:${record.id}:`,
        reverse: true,
        limit: 100,
      })
    ).values(),
  ]
    .filter((entry) => inWindows(scope.windows, Date.parse(entry.at)))
    .slice(0, 50);
  const context_ = currentCaseVisible
    ? readStoredSupportContext(data.context)
    : null;
  return {
    context: context_ === "unreadable" ? null : context_,
    wallet: currentCaseVisible ? (data.wallet ?? null) : null,
    access:
      currentCaseVisible && data.access
        ? {
            level: data.access.level,
            ...(data.access.claimedWallet
              ? { claimedWallet: data.access.claimedWallet }
              : {}),
            at: iso(data.access.at),
          }
        : null,
    attachments: data.attachments.filter((item: SupportAttachment) =>
      inWindows(scope.windows, Date.parse(item.at)),
    ),
    settings: { timezone: settings.timezone },
    notes,
    activity,
    staff: (await context.supportStaff?.()) ?? [],
    canManage: false,
    specialistAccess: accessView(scope),
    cases: scope.windows.map((w) => w.seq),
  };
}

/** The only routes a specialist reaches on a thread. Anything else answers
 * 404, so a specialist can't reply, edit, react, type, resolve, reopen,
 * stop, claim, assign, tag, request verification, upload, share context,
 * export or report. `followUps` handles the follow-up routes. */
export async function specialistThreadRoute(
  storage: Storage,
  context: ConversationContext,
  scope: SpecialistScope,
  path: { sub: string | null; rest: string | null },
  followUps: () => Promise<Response | null>,
  gate: SpecialistGate,
): Promise<Response> {
  const now = context.now;
  const record = scope.record;
  const principal = context.viewer.principalId!;
  const read = () =>
    noteSpecialistRead(storage, context.pendingAudit, {
      principal,
      thread: record.id,
      via: accessView(scope).via as ("owner" | "mention")[],
      now,
    });
  if (path.sub === "follow-ups") {
    const response = await followUps();
    if (response) return response;
    throw notFound();
  }
  if (path.rest !== null) throw notFound();
  if (path.sub === null && context.method === "GET") {
    await read();
    return json({
      conversation: specialistConversation(record, context, now),
      specialistAccess: accessView(scope),
    });
  }
  if (path.sub === "messages" && context.method === "GET") {
    await read();
    const { before, limit } = messagePagination(
      new URL(`https://internal${context.pathname}?${context.query}`),
      50,
    );
    const from = earliest(scope.windows);
    const entries = await storage.list<StoredMessage>({
      prefix: `channel-message:${record.id}:`,
      reverse: true,
      limit: limit + 1,
      ...(before ? { end: messageKey(record.id, Number(before)) } : {}),
    });
    const newest = [...entries.values()];
    const page = newest.slice(0, limit);
    const visible = page.filter((row) =>
      inWindows(scope.windows, Date.parse(row.createdAt)),
    );
    const reachedStart = page.some((row) => Date.parse(row.createdAt) < from);
    const rows = visible.reverse();
    const messages = (
      await renderMessages(storage, record.id, rows, {
        aliases: context.aliases,
      })
    ).map((message) =>
      message.reply?.createdAt &&
      !inWindows(scope.windows, Date.parse(message.reply.createdAt))
        ? { ...message, reply: null }
        : message,
    );
    return json({
      conversation: specialistConversation(record, context, now),
      deletionRevision:
        (await storage.get<number>(`channel-deletions:${record.id}`)) ?? 0,
      messages,
      nextBefore:
        !reachedStart && newest.length > limit
          ? (rows[0]?.id ?? page.at(-1)?.id ?? null)
          : null,
      ...(await context.authors(messages)),
    });
  }
  if (path.sub === "workflow" && context.method === "GET") {
    const attachmentId = context.query.get("attachment");
    if (attachmentId) {
      const data = await supportRecord(storage, record);
      const attachment = data.attachments.find(
        (item) => item.id === attachmentId,
      );
      const media = data.attachmentMedia[attachmentId];
      if (
        !attachment ||
        !media ||
        !inWindows(scope.windows, Date.parse(attachment.at))
      )
        throw new HttpError(404, "Screenshot not found.");
      await read();
      const object = await readSupportAttachment(
        context.mediaEnv,
        {
          room: record.room,
          conversation: record.id,
          attachment: attachmentId,
        },
        attachment,
        media,
      );
      return new Response(object.body, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(object.size),
          "Cache-Control": "no-store",
          "Content-Disposition": 'inline; filename="support-screenshot.png"',
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    }
    await read();
    return json({
      workflow: await specialistWorkflow(storage, context, scope),
    });
  }
  if (
    path.sub === "workflow" &&
    context.method === "POST" &&
    context.body.action === "note"
  )
    return specialistNote(storage, context, scope, gate);
  throw notFound();
}

/** Whether a queued email may still reach a specialist who holds the
 * role: they still have scope on the thread, or, for a follow-up email,
 * they are in the group of an open follow-up nobody owns yet (the email
 * that tells a group about it, and its reminders). Used by delivery at send
 * time. */
export async function specialistMayReceive(
  storage: ReadStorage,
  input: {
    aliases: readonly ChatPrincipalId[];
    thread: string;
    now: number;
    kind: "follow-up" | "mention";
  },
): Promise<boolean> {
  const record = await readConversation(storage, input.thread);
  if (!record) return false;
  const scope = await specialistScope(
    storage,
    {
      viewer: {
        principalId: input.aliases[0],
        isManager: false,
        permissions: ["handleFollowUps"],
      } as unknown as ConversationContext["viewer"],
      aliases: input.aliases,
      room: record.room,
      isBot: false,
    },
    input.thread,
    input.now,
  );
  if (scope) return true;
  if (input.kind !== "follow-up") return false;
  const { list } = await threadFollowUps(storage, input.thread);
  const groups = new Set<string>();
  for (const followUp of list) {
    if (
      !isActive(followUp) ||
      followUp.owner !== null ||
      followUp.group === null
    )
      continue;
    const read = await readCase(storage, {
      thread: input.thread as `tc-${string}`,
      seq: followUp.seq,
    });
    if (read && read.case.resolvedAt === null && read.case.abandonedAt == null) groups.add(followUp.group);
  }
  for (const group of groups) {
    const members = await currentGroupMembers(storage, group);
    if (members.some((member) => input.aliases.includes(member))) return true;
  }
  return false;
}
