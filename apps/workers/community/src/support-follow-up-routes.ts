import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import { featureOn } from "./workspace-flags";
/** Follow-up, routing and specialist routes, mounted in the conversation
 * module's routes.
 *
 * Who may do what, checked on every request against current authority
 * (the actor letters of the design's route table):
 * - The manager and people with `handleConversations` read, add and change
 *   follow-ups, read the queue and the routing settings. Support leads and
 *   the manager change routes; only the manager changes group members.
 * - The workspace's registered AI agent reads and adds follow-ups with the
 *   default member line and no owner, and can't change one.
 * - A specialist reaches only the threads its follow-ups or a mention give
 *   it, through the allowlist in support-specialist.ts, and the queue views
 *   "mine" and "group".
 * - Members, widget sessions, billing-only staff, revoked staff and
 *   outsiders get the same 404 as for a thread they can't read.
 * Nothing here counts usage or posts a message. */
import {
  FOLLOW_UP_LIMITS,
  followUpId,
  type SupportFollowUpQueueView,
  type SupportFollowUpRow,
  type SupportFollowUpType,
  SUPPORT_FOLLOW_UP_TYPES,
  currentFollowUp,
} from "@templ/chat/support-follow-ups";
import {
  SUPPORT_HANDOFF_REASONS,
  type SupportHandoffReason,
} from "@templ/chat/support";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError, json } from "./common";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import { PRODUCT_STATE_KEY, readProductSupport } from "./product-entitlements";
import { readCase, readThreadCases } from "./support-case-data";
import {
  FOLLOW_UP_OPEN_PREFIX,
  FOLLOW_UP_OVERDUE_PREFIX,
  FOLLOW_UP_OWNER_PREFIX,
  assertNoOpenFollowUps,
  assertFollowUpGate,
  cancelOpenFollowUps,
  changeFollowUp,
  createFollowUp,
  discardUnreadableFollowUp,
  followUpView,
  isActive,
  readFollowUp,
  threadFollowUps,
  followUpLineView,
  withIds,
  type FollowUpActor,
  type FollowUpContext,
  type FollowUpRecord,
  type StoredFollowUp,
} from "./support-follow-ups";
import {
  currentGroupMembers,
  groupIds,
  readFollowUpSettings,
  routeHandoff,
  saveFollowUpSettings,
  settingsView,
} from "./support-routing";
import {
  endMentionAccess,
  grantMention,
  isSpecialistViewer,
  specialistScope,
  specialistThreadRoute,
} from "./support-specialist";
import { buildWatch, enabledWatchNetworks } from "./support-watches";
import {
  supportRecord,
  supportSettings,
  type SupportRecord,
} from "./support-workflow";
import {
  conversationAuthority,
  CONVERSATION_NOT_FOUND_ERROR,
  readConversation,
  type ConversationContext,
  type TeamConversationRecord,
} from "./team-conversations";
import type { AlertEnv } from "./alert-outbox";
import { positionRoute } from "./support-positions";

type Storage = DurableObjectTransaction;
export type FollowUpRouteDeps = {
  /** The conversation module's one access predicate for this request. */
  authorize(id: string): Promise<{
    record: TeamConversationRecord;
    role: "member" | "team";
  }>;
};
const THREAD_PATH =
  /^\/conversations\/(tc-[0-9a-f]{32})(?:\/([a-z-]+)(?:\/(.+))?)?$/;
const notFound = () => new HttpError(404, CONVERSATION_NOT_FOUND_ERROR);
const toolsNotFound = () => new HttpError(404, "Support tools not found.");
type FollowUpEnv = AlertEnv & { SUPPORT_FOLLOW_UPS_ENABLED?: string };

/** The rollout switch and whether the team may write now (Support on for
 * the workspace, not paused or suspended). */
async function followUpGate(storage: Storage, context: ConversationContext) {
  const env = context.mediaEnv as unknown as FollowUpEnv;
  const conversations = context.headers.get("X-Conversations") === "true";
  const workflow =
    conversations && context.headers.get("X-Support-Workflow") === "true";
  const scopeEnabled = workflow && env.SUPPORT_FOLLOW_UPS_ENABLED === "true";
  const enabled = workflow && featureOn(env, undefined, "followUps");
  const access = (await storage.get(PRODUCT_STATE_KEY))
    ? await readProductSupport(storage, context.now)
    : null;
  const writable = enabled && Boolean(access?.enabled);
  return { enabled, writable, scopeEnabled };
}
function followUpContext(context: ConversationContext): FollowUpContext {
  return {
    now: context.now,
    room: context.room,
    appOrigin: context.appOrigin,
    pending: context.pending,
    pendingAudit: context.pendingAudit,
    isSupportStaff: context.isSupportStaff,
    isSpecialist: context.isSpecialist,
    bots: context.bots,
    headers: context.headers,
    env: context.mediaEnv as unknown as AlertEnv,
  };
}
const isLead = (context: ConversationContext) =>
  context.viewer.isManager ||
  context.viewer.permissions.includes("manageSupport");
function teamActor(context: ConversationContext): FollowUpActor {
  const principal = context.viewer.principalId!;
  return context.isBot
    ? { kind: "bot", principal }
    : { kind: "person", principal, lead: isLead(context) };
}
function specialistActor(context: ConversationContext): FollowUpActor {
  return {
    kind: "specialist",
    principal: context.viewer.principalId!,
    aliases: context.aliases,
  };
}
const widget = (context: ConversationContext) =>
  context.headers.get("X-Support-Widget") !== null;

/* ---------------------------------------------------------------------- */
/* Thread follow-ups                                                        */
/* ---------------------------------------------------------------------- */

async function threadFollowUpRoute(
  storage: Storage,
  context: ConversationContext,
  record: FollowUpRecord,
  actor: FollowUpActor,
  rest: string | null,
  scopeSeqs: number[] | null,
): Promise<Response> {
  const gate = await followUpGate(storage, context);
  const ctx = followUpContext(context);
  const options = {
    gate,
    groupMembers: (group: string) => currentGroupMembers(storage, group, context.mediaEnv, context.now),
    groups: () => groupIds(storage),
    setWatch: (f: StoredFollowUp, value: unknown, now: number) =>
      buildWatch(storage, {
        headers: context.headers,
        actor: context.viewer.principalId!,
        followUp: f,
        value,
        now,
      }),
  };
  const listView = async (focus?: StoredFollowUp) => {
    const all = await threadFollowUps(storage, record.id);
    const inScope = (seq: number) => !scopeSeqs || scopeSeqs.includes(seq);
    const requested = context.query.get("case");
    const seqFilter =
      requested && requested !== "all" && /^[1-9][0-9]{0,7}$/.test(requested)
        ? Number(requested)
        : null;
    const list = all.list.filter(
      (f) => inScope(f.seq) && (seqFilter === null || f.seq === seqFilter),
    );
    const bySeq = new Map<number, StoredFollowUp[]>();
    for (const f of all.list)
      (bySeq.get(f.seq) ?? bySeq.set(f.seq, []).get(f.seq)!).push(f);
    const currents = new Map(
      [...bySeq].map(([seq, items]) => [seq, currentFollowUp(withIds(items))]),
    );
    const cases = (
      await readThreadCases(storage, record.id as `tc-${string}`, {
        limit: 20,
      })
    )
      .filter((c) => inScope(c.seq))
      .map((c) => ({
        seq: c.seq,
        openedAt: new Date(c.case.openedAt).toISOString(),
        resolvedAt:
          c.case.resolvedAt === null
            ? null
            : new Date(c.case.resolvedAt).toISOString(),
        waitingOnTeam: (bySeq.get(c.seq) ?? []).some(isActive),
      }));
    return {
      followUps: list
        .sort((a, b) => a.seq - b.seq || a.order - b.order)
        .map((f) => followUpView(f, currents.get(f.seq) ?? null)),
      cases,
      line: followUpLineView(record, context.now),
      available: gate.enabled && gate.writable,
      watchNetworks: gate.enabled ? enabledWatchNetworks(context.headers) : [],
      unreadable: scopeSeqs ? 0 : all.unreadable.length,
      unreadableIds: scopeSeqs ? [] : all.unreadable.slice(0, 20),
      timeZone: (await supportSettings(storage)).timezone,
      ...(focus
        ? { followUp: followUpView(focus, currents.get(focus.seq) ?? null) }
        : {}),
    };
  };
  if (rest === null && context.method === "GET") return json(await listView());
  if (rest === null && context.method === "POST") {
    const { followUp, created } = await createFollowUp(
      storage,
      ctx,
      record,
      context.body,
      actor,
      options,
    );
    return json(
      {
        ...(await listView(followUp)),
        conversation: { revision: record.revision },
      },
      created ? 201 : 200,
    );
  }
  if (rest !== null && context.method === "POST") {
    // A team person may clear a row that failed its check, after a
    // confirmation in the app.
    if (context.body.op === "discard-unreadable") {
      if (actor.kind !== "person") throw notFound();
      assertFollowUpGate(gate);
      await discardUnreadableFollowUp(
        storage,
        context,
        record,
        rest,
        actor.principal,
      );
      return json({
        ...(await listView()),
        conversation: { revision: record.revision },
      });
    }
    if (scopeSeqs) {
      const target = await readFollowUp(storage, record.id, rest);
      if (!target || !scopeSeqs.includes(target.seq))
        throw new HttpError(404, "Follow-up not found.");
    }
    const f = await changeFollowUp(
      storage,
      ctx,
      record,
      rest,
      context.body,
      actor,
      options,
    );
    return json({
      ...(await listView(f)),
      conversation: { revision: record.revision },
    });
  }
  throw notFound();
}

/* ---------------------------------------------------------------------- */
/* Queue                                                                    */
/* ---------------------------------------------------------------------- */

const QUEUE_VIEWS: readonly SupportFollowUpQueueView[] = [
  "open",
  "overdue",
  "mine",
  "group",
];
const CURSOR = /^[0-9]{16}-tc-[0-9a-f]{32}-[1-9][0-9]{0,7}-[1-9][0-9]?$/;
const OPEN_KEY =
  /^support-follow-up-open-v1:(.+):([0-9]{16}):(tc-[0-9a-f]{32}):([1-9][0-9]{0,7}-[1-9][0-9]?)$/;
const badView = () =>
  new HttpError(
    400,
    "Choose a valid follow-up view.",
    undefined,
    "follow-up-view",
  );
async function queueRoute(
  storage: Storage,
  context: ConversationContext,
  specialist: boolean,
  authorize: FollowUpRouteDeps["authorize"],
): Promise<Response> {
  const view = context.query.get("view") ?? "open";
  if (!QUEUE_VIEWS.includes(view as SupportFollowUpQueueView)) throw badView();
  if (specialist && (view === "open" || view === "overdue"))
    throw new HttpError(
      403,
      "Choose your follow-ups or your groups.",
      undefined,
      "specialist-queue",
    );
  const limitRaw =
    context.query.get("limit") ?? String(FOLLOW_UP_LIMITS.queuePage);
  const limit = Number(limitRaw);
  if (
    !/^[1-9][0-9]{0,2}$/.test(limitRaw) ||
    limit > FOLLOW_UP_LIMITS.queuePageMax
  )
    throw badView();
  const cursor = context.query.get("cursor");
  if (cursor !== null && !CURSOR.test(cursor)) throw badView();
  const ownerFilter = context.query.get("owner");
  const groupFilter = context.query.get("group");
  const typeFilter = context.query.get("type");
  if (
    typeFilter !== null &&
    !(SUPPORT_FOLLOW_UP_TYPES as readonly string[]).includes(typeFilter)
  )
    throw badView();
  const settings = await readFollowUpSettings(storage);
  const aliases = context.aliases;
  const myGroups =
    settings === "unreadable"
      ? []
      : settings.groups
          .filter(
            (group) =>
              !specialist ||
              group.members.some((member) => aliases.includes(member)),
          )
          .map((group) => group.id);
  // Candidate keys: thread, id, created time, owner key.
  const candidates: { thread: string; id: string; createdAt: number }[] = [];
  let complete = true;
  const cap = FOLLOW_UP_LIMITS.openPerWorkspace + 1;
  if (view === "open") {
    const rows = await storage.list({
      prefix: FOLLOW_UP_OPEN_PREFIX,
      limit: cap,
    });
    if (rows.size >= cap) complete = false;
    for (const key of rows.keys()) {
      const match = OPEN_KEY.exec(key);
      if (match)
        candidates.push({
          thread: match[3],
          id: match[4],
          createdAt: Number(match[2]),
        });
    }
  } else if (view === "overdue") {
    const rows = await storage.list({
      prefix: FOLLOW_UP_OVERDUE_PREFIX,
      limit: cap,
    });
    if (rows.size >= cap) complete = false;
    for (const key of rows.keys()) {
      const match = /:(tc-[0-9a-f]{32}):([1-9][0-9]{0,7}-[1-9][0-9]?)$/.exec(
        key,
      );
      if (match)
        candidates.push({ thread: match[1], id: match[2], createdAt: 0 });
    }
  } else if (view === "mine") {
    for (const alias of aliases.slice(0, 8)) {
      const rows = await storage.list({
        prefix: `${FOLLOW_UP_OWNER_PREFIX}${alias}:`,
        limit: cap,
      });
      for (const key of rows.keys()) {
        const match = /:(tc-[0-9a-f]{32}):([1-9][0-9]{0,7}-[1-9][0-9]?)$/.exec(
          key,
        );
        if (match)
          candidates.push({ thread: match[1], id: match[2], createdAt: 0 });
      }
    }
  } else {
    for (const group of myGroups) {
      if (groupFilter && group !== groupFilter) continue;
      const rows = await storage.list({
        prefix: `${FOLLOW_UP_OPEN_PREFIX}group:${group}:`,
        limit: cap,
      });
      for (const key of rows.keys()) {
        const match = OPEN_KEY.exec(key);
        if (match)
          candidates.push({
            thread: match[3],
            id: match[4],
            createdAt: Number(match[2]),
          });
      }
    }
  }
  // Records are the authority: read each, drop what no longer matches.
  const found: StoredFollowUp[] = [];
  for (const candidate of candidates) {
    const f = await readFollowUp(storage, candidate.thread, candidate.id);
    if (!f || !isActive(f)) continue;
    if (specialist) {
      const record = await readConversation(storage, f.thread);
      if (!record || record.room !== context.room) continue;
      const case_ = await readCase(storage, {
        thread: f.thread as `tc-${string}`,
        seq: f.seq,
      });
      if (!case_ || case_.case.resolvedAt !== null || case_.case.abandonedAt != null) continue;
    } else {
      const access = await authorize(f.thread).catch((error) => {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      });
      if (!access || access.role !== "team") continue;
    }
    if (view === "overdue" && f.overdueSince === null) continue;
    if (view === "mine" && (!f.owner || !aliases.includes(f.owner))) continue;
    if (
      view === "group" &&
      (f.owner !== null || !f.group || !myGroups.includes(f.group))
    )
      continue;
    if (typeFilter && f.type !== (typeFilter as SupportFollowUpType)) continue;
    if (ownerFilter) {
      if (ownerFilter === "none" ? f.owner !== null : f.owner !== ownerFilter)
        continue;
    }
    if (groupFilter && f.group !== groupFilter) continue;
    found.push(f);
  }
  const unique = new Map(
    found.map((f) => [`${f.thread}:${followUpId(f.seq, f.n)}`, f]),
  );
  const sorted = [...unique.values()].sort(
    (a, b) =>
      a.createdAt - b.createdAt ||
      a.thread.localeCompare(b.thread) ||
      a.seq - b.seq ||
      a.n - b.n,
  );
  const cursorOf = (f: StoredFollowUp) =>
    `${String(f.createdAt).padStart(16, "0")}-${f.thread}-${followUpId(f.seq, f.n)}`;
  const start = cursor ? sorted.findIndex((f) => cursorOf(f) > cursor) : 0;
  const page = start < 0 ? [] : sorted.slice(start, start + limit);
  const owners = new Map<
    string,
    {
      owner: ChatPrincipalId | null;
      group: string | null;
      open: number;
      blocked: number;
      overdue: number;
      oldestAt: number;
    }
  >();
  for (const f of sorted) {
    const key = f.owner ?? `group:${f.group ?? "none"}`;
    const row = owners.get(key) ?? {
      owner: f.owner,
      group: f.owner ? null : f.group,
      open: 0,
      blocked: 0,
      overdue: 0,
      oldestAt: f.createdAt,
    };
    if (f.state === "blocked") row.blocked++;
    else row.open++;
    if (f.overdueSince !== null) row.overdue++;
    row.oldestAt = Math.min(row.oldestAt, f.createdAt);
    owners.set(key, row);
  }
  const rows: SupportFollowUpRow[] = page.map((f) => {
    const mine = f.owner !== null && aliases.includes(f.owner);
    // Before taking a group follow-up a specialist sees its type, the
    // handoff reason, its age and due date: never the title.
    const readable = !specialist || mine;
    return {
      conversation: f.thread,
      readable,
      ageMs: Math.max(0, context.now - f.createdAt),
      followUp: readable
        ? followUpView(f, null)
        : {
            id: followUpId(f.seq, f.n),
            seq: f.seq,
            type: f.type,
            reason: f.reason,
            group: f.group,
            state: f.state,
            dueAt: f.dueAt === null ? null : new Date(f.dueAt).toISOString(),
            createdAt: new Date(f.createdAt).toISOString(),
            revision: f.revision,
            overdue: f.overdueSince !== null,
          },
    };
  });
  return json({
    view,
    rows,
    owners: specialist
      ? []
      : [...owners.values()]
          .sort((a, b) => a.oldestAt - b.oldestAt)
          .map((row) => ({
            ...row,
            oldestAt: new Date(row.oldestAt).toISOString(),
          })),
    nextCursor:
      start >= 0 && start + limit < sorted.length
        ? cursorOf(page[page.length - 1])
        : null,
    complete,
  });
}

/* ---------------------------------------------------------------------- */
/* Entry points                                                             */
/* ---------------------------------------------------------------------- */

/** The follow-up routes at the top of `conversationRoomRoute`.
 * Null for every path it does not own, so the conversation module goes on
 * (resolve and end-access guards return null after their check). */
export async function followUpFeatureRoute(
  storage: Storage,
  context: ConversationContext,
  deps: FollowUpRouteDeps,
): Promise<Response | null> {
  const path = context.pathname;
  const viewer = context.viewer;
  const team = conversationAuthority(viewer).team;
  const specialist = isSpecialistViewer(context);
  if (path === "/conversations/follow-ups") {
    if (widget(context) || !viewer.principalId || (!team && !specialist))
      throw toolsNotFound();
    if (context.method !== "GET") throw toolsNotFound();
    // With the rollout switch off, the queue doesn't exist.
    if (!(await followUpGate(storage, context)).enabled) throw toolsNotFound();
    return queueRoute(storage, context, !team && specialist, deps.authorize);
  }
  if (path === "/conversations/follow-up-settings") {
    if (widget(context) || !viewer.principalId || !team) throw toolsNotFound();
    // With the rollout switch off, routing and the Specialists list don't
    // exist and a save answers 503.
    const gate = await followUpGate(storage, context);
    if (context.method === "GET" && !gate.enabled) throw toolsNotFound();
    if (context.method === "POST" && !gate.enabled)
      throw new HttpError(
        503,
        "Follow-ups aren't available yet.",
        undefined,
        "follow-ups-unavailable",
      );
    if (context.method === "GET") {
      const lead = isLead(context);
      return json(
        settingsView(
          await readFollowUpSettings(storage),
          {
            staff: ((await context.supportStaff?.()) ?? []).filter(
              (id) => !(context.bots ?? []).includes(id),
            ),
            specialists: (await context.specialists?.()) ?? [],
          },
          { manager: viewer.isManager, admin: canManageWorkspace(viewer, context.isBot), lead },
        ),
      );
    }
    if (context.method !== "POST") throw toolsNotFound();
    if (context.isBot)
      throw new HttpError(
        403,
        "Only workspace admins can change routing.",
        undefined,
        "routing-lead-only",
      );
    if (!viewer.isManager && canManageWorkspace(viewer))
      requireWorkspaceAdminHeaders(context.headers, false, true, context.now);
    const { saved, before, changed, authenticatedAt } =
      await saveFollowUpSettings(
        storage,
        {
          principal: viewer.principalId,
          manager: viewer.isManager,
          admin: canManageWorkspace(viewer, context.isBot),
          lead: isLead(context),
          isSupportStaff: async (id) =>
            (await context.isSupportStaff?.(id)) ?? false,
          isSpecialist: async (id) =>
            (await context.isSpecialist?.(id)) ?? false,
          bots: context.bots ?? [],
          // Group membership lets a specialist take a group's follow-ups and
          // so read those requests: the same signed-in session and confirmed
          // review a staff role grant needs.
          confirm: () =>
            requireWorkspaceAdminHeaders(
              context.headers,
              viewer.isManager,
              context.body.confirmed,
              context.now,
            ),
        },
        context.body,
      );
    context.pendingAudit.push({
      actor: viewer.principalId,
      action: "support.follow-up.settings",
      before:
        before === "unreadable"
          ? { unreadable: true }
          : { groups: before.groups.length, routes: before.routes.length },
      after: {
        groups: saved.groups.length,
        routes: saved.routes.length,
        changed,
      },
      ...(authenticatedAt !== null
        ? { authenticatedAt: new Date(authenticatedAt).toISOString() }
        : {}),
    });
    return json(
      settingsView(
        saved,
        {
          staff: ((await context.supportStaff?.()) ?? []).filter(
            (id) => !(context.bots ?? []).includes(id),
          ),
          specialists: (await context.specialists?.()) ?? [],
        },
        { manager: viewer.isManager, admin: canManageWorkspace(viewer, context.isBot), lead: isLead(context) },
      ),
    );
  }
  const match = THREAD_PATH.exec(path);
  if (!match) return null;
  const [, thread, sub = null, rest = null] = match;
  const owned = sub === "follow-ups" || sub === "positions";
  if (widget(context)) {
    if (owned) throw notFound();
    return null;
  }
  // Only these paths need this block; every other thread request goes on
  // to the conversation module with no extra read.
  const resolveGuard =
    sub === "resolve" &&
    context.method === "POST" &&
    context.body.resolved === true;
  const endAccess =
    sub === "workflow" &&
    rest === null &&
    context.method === "POST" &&
    context.body.action === "end-access";
  if (!owned && !specialist && !resolveGuard && !endAccess) return null;
  // The team's path first; the member of the thread gets the member path.
  const authorized = await deps.authorize(thread).catch((error) => {
    if (error instanceof HttpError && error.status === 404) return null;
    throw error;
  });
  if (!authorized) {
    if (!specialist) {
      if (owned) throw notFound();
      return null;
    }
  const gate = await followUpGate(storage, context);
    if (!gate.scopeEnabled) throw notFound();
    // Taking a group follow-up is how a specialist gets scope: it needs
    // group membership (checked by the take itself), not scope.
    if (
      sub === "follow-ups" &&
      rest !== null &&
      context.method === "POST" &&
      context.body.op === "take"
    ) {
    if (!gate.enabled) throw notFound();
      const record = (await readConversation(
        storage,
        thread,
      )) as FollowUpRecord | null;
      if (!record || record.room !== context.room) throw notFound();
      const target = await readFollowUp(storage, thread, rest);
      // Someone outside the group learns nothing about the thread.
      const members = target?.group
        ? await currentGroupMembers(storage, target.group, context.mediaEnv, context.now)
        : [];
      if (
        !target ||
        target.owner !== null ||
        !members.some((member) => context.aliases.includes(member))
      )
        throw notFound();
      const targetCase = await readCase(storage, {
        thread: record.id as `tc-${string}`,
        seq: target.seq,
      });
      if (!targetCase || targetCase.case.resolvedAt !== null || targetCase.case.abandonedAt != null) throw notFound();
      return threadFollowUpRoute(
        storage,
        context,
        record,
        specialistActor(context),
        rest,
        [target.seq],
      );
    }
    const scope = await specialistScope(storage, context, thread, context.now);
    if (!scope) throw notFound();
    return specialistThreadRoute(
      storage,
      context,
      scope,
      { sub, rest: sub === "follow-ups" ? null : rest },
      () =>
        threadFollowUpRoute(
          storage,
          context,
          scope.record,
          specialistActor(context),
          rest,
          scope.windows.map((w) => w.seq),
        ),
      gate,
    );
  }
  const { record, role } = authorized;
  if (sub === "follow-ups") {
    if (role !== "team") throw notFound();
    return threadFollowUpRoute(
      storage,
      context,
      record as FollowUpRecord,
      teamActor(context),
      rest,
      null,
    );
  }
  if (sub === "positions") {
    if (role !== "team") throw notFound();
    return positionRoute(storage, context, record, rest);
  }
  if (sub === "resolve" && context.method === "POST" && role === "team") {
    // The team can't resolve while a follow-up is open; the member can.
    if (context.body.resolved === true && record.state !== "resolved")
      await assertNoOpenFollowUps(storage, record.id);
    return null;
  }
  if (
    sub === "workflow" &&
    rest === null &&
    context.method === "POST" &&
    context.body.action === "end-access"
  ) {
    if (role !== "team") throw notFound();
    if (context.isBot)
      throw new HttpError(
        403,
        "Only a person on the team can end access.",
        undefined,
        "person-only",
      );
    const principal = normalizeChatPrincipal(context.body.principalId);
    if (!principal)
      throw new HttpError(
        400,
        "Choose a specialist.",
        undefined,
        "specialist-invalid",
      );
    const ended = await endMentionAccess(storage, context, record, {
      principal,
      by: viewer.principalId!,
    });
    return json({ ended });
  }
  return null;
}

/** The follow-up step in `supportThreadRoute`, before the
 * workflow's own actions run in the same transaction (a later refusal rolls
 * these writes back). Always null: the workflow action goes on. */
export async function followUpWorkflowHook(
  storage: Storage,
  context: ConversationContext,
  record: TeamConversationRecord,
  role: "member" | "team",
  gate: { available: boolean; writable: boolean },
): Promise<null> {
  if (context.method !== "POST" || role !== "team") return null;
  const action = context.body.action;
  const actor = context.viewer.principalId;
  if (!actor) return null;
  if (action === "status") {
    if (context.body.state === "resolved" && record.state !== "resolved")
      await assertNoOpenFollowUps(storage, record.id);
    if (context.body.state === "spam")
      await cancelOpenFollowUps(
        storage,
        context,
        record as FollowUpRecord,
        actor,
      );
    return null;
  }
  if (action === "note" && !context.isBot) {
    // A person on the team may mention a specialist: the mention gives the
    // specialist read access to this request for 14 days. With follow-ups
    // off or Support paused, nothing is granted, and the note's own check
    // refuses a mention of anyone outside the team.
    const followGate = await followUpGate(storage, context);
    if (!followGate.enabled || !followGate.writable) return null;
    const mentions = Array.isArray(context.body.mentions)
      ? context.body.mentions
      : [];
    const specialists: ChatPrincipalId[] = [];
    for (const value of mentions.slice(0, 10)) {
      const principal = normalizeChatPrincipal(value);
      if (!principal || (context.bots ?? []).includes(principal)) continue;
      if (await context.isSupportStaff?.(principal)) continue;
      if (await context.isSpecialist?.(principal)) specialists.push(principal);
    }
    if (!specialists.length) return null;
    const staff = context.isSupportStaff;
    context.isSupportStaff = async (principal) =>
      specialists.includes(principal) || ((await staff?.(principal)) ?? false);
    const data: SupportRecord = await supportRecord(storage, record);
    const seq = data.caseSeq ?? 0;
    if (seq >= 1)
      for (const principal of specialists)
        await grantMention(storage, context, record, {
          principal,
          seq,
          by: actor,
        });
    return null;
  }
  if (
    action === "handoff" &&
    !record.handoff &&
    record.state !== "resolved" &&
    !record.stopped
  ) {
    const reason = context.body.reason;
    if (!(SUPPORT_HANDOFF_REASONS as readonly unknown[]).includes(reason))
      return null;
    const data = await supportRecord(storage, record);
    if (data.requestedAt === null) return null;
    const followGate = await followUpGate(storage, context);
    await routeHandoff(
      storage,
      followUpContext(context),
      record as FollowUpRecord,
      {
        seq: data.caseSeq ?? 0,
        reason: reason as SupportHandoffReason,
        actor,
        gate: {
          enabled: followGate.enabled && gate.available,
          writable: followGate.writable && gate.writable,
        },
      },
    );
  }
  return null;
}
