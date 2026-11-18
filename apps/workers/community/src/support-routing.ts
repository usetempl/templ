/** Routing from a handoff reason to a follow-up group.
 *
 * The manager names groups of people (team members or specialists) and
 * support leads choose which handoff reasons make a follow-up for which
 * group. Group membership is standing eligibility to take a follow-up, and
 * taking one gives a specialist access to that request, so only the manager
 * changes who is in a group. A routed follow-up has a fixed title, since a
 * handoff carries a code and never text.
 *
 * Routing never refuses or delays a handoff: every check runs before any
 * write and a failure is logged with a fixed label and skipped. */
import {
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_ROUTE_TITLES,
  GROUP_ID,
  SUPPORT_FOLLOW_UP_TYPES,
  followUpLabelRisk,
  type SupportFollowUpGroup,
  type SupportFollowUpRoute,
  type SupportFollowUpSettings,
  type SupportFollowUpSettingsView,
} from "@templ/chat/support-follow-ups";
import {
  SUPPORT_HANDOFF_REASONS,
  type SupportHandoffReason,
} from "@templ/chat/support";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import { HttpError } from "./common";
import { uuidv7 } from "./uuidv7";
import { refusePhrase, refuseSecretRequest } from "./secret-guard";
import { holdsNow, isRegisteredBot } from "./support-follow-up-access";
import type { TemplStaffEnv } from "./templ-staff";
import {
  createFollowUp,
  routeKey,
  type FollowUpContext,
  type FollowUpRecord,
  type StoredFollowUp,
} from "./support-follow-ups";

type Storage = DurableObjectTransaction;
type ReadStorage = Pick<DurableObjectStorage, "get" | "list">;

export const FOLLOW_UP_SETTINGS_KEY = "support-follow-up-settings-v1";
export type StoredFollowUpSettings = SupportFollowUpSettings & {
  schemaVersion: 1;
};
const EMPTY: StoredFollowUpSettings = {
  schemaVersion: 1,
  revision: 0,
  groups: [],
  routes: [],
};
const PRINCIPAL = (value: unknown): value is ChatPrincipalId =>
  typeof value === "string" && normalizeChatPrincipal(value) === value;
const invalidRules = () =>
  new HttpError(400, "Check the routing rules.", undefined, "routing-invalid");

function checkedGroup(raw: unknown): SupportFollowUpGroup | null {
  const g = raw as SupportFollowUpGroup | undefined;
  if (
    !g ||
    typeof g !== "object" ||
    typeof g.id !== "string" ||
    !GROUP_ID.test(g.id) ||
    typeof g.name !== "string" ||
    !g.name.trim() ||
    g.name.length > FOLLOW_UP_LIMITS.groupNameChars ||
    !Array.isArray(g.members) ||
    g.members.length > FOLLOW_UP_LIMITS.groupMembers ||
    !g.members.every(PRINCIPAL) ||
    new Set(g.members).size !== g.members.length
  )
    return null;
  return { id: g.id, name: g.name, members: [...g.members] };
}
function checkedRoute(
  raw: unknown,
  groups: ReadonlySet<string>,
): SupportFollowUpRoute | null {
  const r = raw as SupportFollowUpRoute | undefined;
  if (
    !r ||
    typeof r !== "object" ||
    !(SUPPORT_HANDOFF_REASONS as readonly unknown[]).includes(r.reason) ||
    !(SUPPORT_FOLLOW_UP_TYPES as readonly unknown[]).includes(r.type) ||
    typeof r.group !== "string" ||
    !groups.has(r.group) ||
    (r.publicLabel !== null && followUpLabelRisk(r.publicLabel) !== null) ||
    !Number.isSafeInteger(r.nextUpdateDays) ||
    r.nextUpdateDays < 1 ||
    r.nextUpdateDays > FOLLOW_UP_LIMITS.nextUpdateMaxDays ||
    (r.dueDays !== null &&
      (!Number.isSafeInteger(r.dueDays) ||
        r.dueDays < 1 ||
        r.dueDays > FOLLOW_UP_LIMITS.dueMaxDays)) ||
    typeof r.memberVisible !== "boolean"
  )
    return null;
  return {
    reason: r.reason,
    type: r.type,
    group: r.group,
    publicLabel: r.publicLabel,
    nextUpdateDays: r.nextUpdateDays,
    dueDays: r.dueDays,
    memberVisible: r.memberVisible,
  };
}
/** Stored settings, strictly: anything off makes the whole record
 * unreadable (routing off, a save replaces it). */
export function checkedFollowUpSettings(
  raw: unknown,
): StoredFollowUpSettings | null {
  const s = raw as StoredFollowUpSettings | undefined;
  if (
    !s ||
    typeof s !== "object" ||
    s.schemaVersion !== 1 ||
    !Number.isSafeInteger(s.revision) ||
    s.revision < 0 ||
    !Array.isArray(s.groups) ||
    s.groups.length > FOLLOW_UP_LIMITS.groups ||
    !Array.isArray(s.routes) ||
    s.routes.length > SUPPORT_HANDOFF_REASONS.length
  )
    return null;
  const groups = s.groups.map(checkedGroup);
  if (groups.some((g) => g === null)) return null;
  const ids = new Set(groups.map((g) => g!.id));
  if (ids.size !== groups.length) return null;
  const routes = s.routes.map((r) => checkedRoute(r, ids));
  if (routes.some((r) => r === null)) return null;
  if (new Set(routes.map((r) => r!.reason)).size !== routes.length) return null;
  return {
    schemaVersion: 1,
    revision: s.revision,
    groups: groups as SupportFollowUpGroup[],
    routes: routes as SupportFollowUpRoute[],
  };
}
export async function readFollowUpSettings(
  storage: Pick<DurableObjectStorage, "get">,
): Promise<StoredFollowUpSettings | "unreadable"> {
  const raw = await storage.get(FOLLOW_UP_SETTINGS_KEY);
  if (raw === undefined) return EMPTY;
  const checked = checkedFollowUpSettings(raw);
  if (!checked) {
    console.warn(
      JSON.stringify({ event: "TEMPL_SUPPORT_FOLLOW_UP_SETTINGS_UNREADABLE" }),
    );
    return "unreadable";
  }
  return checked;
}
/** A group's members who still hold a staff or specialist role (the stored
 * list can name someone who lost the role since). Empty with unreadable
 * settings. */
export async function currentGroupMembers(
  storage: ReadStorage,
  group: string,
  env: TemplStaffEnv = {},
  now = Date.now(),
): Promise<ChatPrincipalId[]> {
  const settings = await readFollowUpSettings(storage);
  if (settings === "unreadable") return [];
  const found = settings.groups.find((item) => item.id === group);
  if (!found) return [];
  const out: ChatPrincipalId[] = [];
  for (const member of found.members)
    if (
      !(await isRegisteredBot(storage, member)) &&
      ((await holdsNow(storage, member, "handleConversations", env, now)) ||
        (await holdsNow(storage, member, "handleFollowUps", env, now)))
    )
      out.push(member);
  return out;
}
export async function groupIds(
  storage: Pick<DurableObjectStorage, "get">,
): Promise<Set<string> | "unreadable"> {
  const settings = await readFollowUpSettings(storage);
  return settings === "unreadable"
    ? "unreadable"
    : new Set(settings.groups.map((group) => group.id));
}

/** What the settings route needs from the request. */
export type SettingsActor = {
  principal: ChatPrincipalId;
  manager: boolean;
  admin?: boolean;
  lead: boolean;
  isSupportStaff: (principal: ChatPrincipalId) => Promise<boolean>;
  isSpecialist: (principal: ChatPrincipalId) => Promise<boolean>;
  bots: readonly ChatPrincipalId[];
  /** A change of group members needs a valid wallet session and a
   * confirmed review (`confirmed: true`); returns the sign-in time. */
  confirm: () => number;
};
const sameGroups = (
  a: readonly SupportFollowUpGroup[],
  b: readonly SupportFollowUpGroup[],
) =>
  JSON.stringify(
    [...a]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((g) => ({
        ...g,
        members: [...g.members].sort(),
      })),
  ) ===
  JSON.stringify(
    [...b]
      .sort((x, y) => x.id.localeCompare(y.id))
      .map((g) => ({
        ...g,
        members: [...g.members].sort(),
      })),
  );
/** `POST /conversations/follow-up-settings`: the manager edits groups and
 * routes (a group change with a valid signed-in session and `confirmed: true`), a
 * support lead edits routes only. Returns the saved settings and
 * the audit fields. */
export async function saveFollowUpSettings(
  storage: Storage,
  actor: SettingsActor,
  body: Record<string, unknown>,
): Promise<{
  saved: StoredFollowUpSettings;
  before: StoredFollowUpSettings | "unreadable";
  changed: string[];
  authenticatedAt: number | null;
}> {
  if (!actor.manager && !actor.admin)
    throw new HttpError(
      403,
      "Only workspace admins can change routing.",
      undefined,
      "routing-admin-only",
    );
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "revision",
          "groups",
          "routes",
          "confirmed",
          "expectedPrincipalId",
        ].includes(key),
    )
  )
    throw invalidRules();
  const before = await readFollowUpSettings(storage);
  const revision = before === "unreadable" ? null : before.revision;
  // Unreadable settings: a save replaces them whatever revision it names.
  if (revision !== null && body.revision !== revision)
    throw new HttpError(
      409,
      "Routing changed since you opened it. Reload and try again.",
      undefined,
      "routing-stale",
    );
  if (!Array.isArray(body.groups) || !Array.isArray(body.routes))
    throw invalidRules();
  if (
    body.groups.length > FOLLOW_UP_LIMITS.groups ||
    body.groups.some(
      (group) =>
        !Array.isArray((group as SupportFollowUpGroup)?.members) ||
        (group as SupportFollowUpGroup).members.length >
          FOLLOW_UP_LIMITS.groupMembers,
    )
  )
    throw new HttpError(
      400,
      "Choose up to 10 groups with up to 25 people each.",
      undefined,
      "routing-groups-limit",
    );
  const groups: SupportFollowUpGroup[] = [];
  for (const raw of body.groups) {
    const group = raw as SupportFollowUpGroup;
    if (typeof group?.name === "string") {
      await refusePhrase(group.name, "saved");
      refuseSecretRequest(group.name);
    }
    const checked = checkedGroup(
      typeof group?.name === "string"
        ? { ...group, name: group.name.trim() }
        : group,
    );
    if (!checked) throw invalidRules();
    groups.push(checked);
  }
  if (new Set(groups.map((g) => g.id)).size !== groups.length)
    throw invalidRules();
  const beforeGroups = before === "unreadable" ? [] : before.groups;
  const groupsChanged = !sameGroups(groups, beforeGroups);
  if (groupsChanged)
    for (const group of groups)
      for (const member of group.members) {
        const bot =
          actor.bots.includes(member) ||
          (await isRegisteredBot(storage, member));
        const eligible =
          !bot &&
          ((await actor.isSupportStaff(member)) ||
            (await actor.isSpecialist(member)));
        if (!eligible)
          throw new HttpError(
            400,
            "Add only people on the team or specialists to a group.",
            undefined,
            "routing-member",
          );
      }
  const ids = new Set(groups.map((g) => g.id));
  const routes: SupportFollowUpRoute[] = [];
  for (const raw of body.routes) {
    const route = raw as SupportFollowUpRoute;
    if (typeof route?.publicLabel === "string") {
      await refusePhrase(route.publicLabel, "saved");
      refuseSecretRequest(route.publicLabel);
    }
    const checked = checkedRoute(
      route && typeof route === "object"
        ? {
            ...route,
            publicLabel:
              typeof route.publicLabel === "string" && route.publicLabel.trim()
                ? route.publicLabel.trim()
                : route.publicLabel === undefined || route.publicLabel === ""
                  ? null
                  : route.publicLabel,
            dueDays: route.dueDays === undefined ? null : route.dueDays,
          }
        : route,
      ids,
    );
    if (!checked) throw invalidRules();
    routes.push(checked);
  }
  if (new Set(routes.map((r) => r.reason)).size !== routes.length)
    throw invalidRules();
  // Last check before the write: who is in a group decides who may take
  // its follow-ups, so the manager confirms it as a staff role grant.
  const authenticatedAt = groupsChanged ? actor.confirm() : null;
  const saved: StoredFollowUpSettings = {
    schemaVersion: 1,
    revision: (revision ?? 0) + 1,
    groups,
    routes,
  };
  await storage.put(FOLLOW_UP_SETTINGS_KEY, saved);
  const changed = [
    ...(groupsChanged ? ["groups"] : []),
    ...(before === "unreadable" ||
    JSON.stringify(before.routes) !== JSON.stringify(routes)
      ? ["routes"]
      : []),
  ];
  return { saved, before, changed, authenticatedAt };
}
export function settingsView(
  settings: StoredFollowUpSettings | "unreadable",
  eligible: SupportFollowUpSettingsView["eligible"],
  viewer: { manager: boolean; admin?: boolean; lead: boolean },
): SupportFollowUpSettingsView {
  const base = settings === "unreadable" ? EMPTY : settings;
  return {
    revision: base.revision,
    groups: base.groups,
    routes: base.routes,
    status: settings === "unreadable" ? "unreadable" : "ok",
    eligible,
    canEditRoutes: viewer.manager || viewer.admin === true,
    canEditGroups: viewer.manager || viewer.admin === true,
  };
}

/** The handoff hook: one unowned follow-up for the route's group per
 * request and reason. Null when nothing was routed. Never throws. */
export async function routeHandoff(
  storage: Storage,
  ctx: FollowUpContext,
  record: FollowUpRecord,
  input: {
    seq: number;
    reason: SupportHandoffReason;
    actor: ChatPrincipalId;
    gate: { enabled: boolean; writable: boolean };
  },
): Promise<StoredFollowUp | null> {
  try {
    if (!input.gate.enabled || !input.gate.writable || input.seq < 1)
      return null;
    const settings = await readFollowUpSettings(storage);
    if (settings === "unreadable") return null;
    const route = settings.routes.find((item) => item.reason === input.reason);
    if (!route) return null;
    const key = routeKey(record.id, input.seq, input.reason);
    if (await storage.get(key)) return null;
    const { followUp } = await createFollowUp(
      storage,
      ctx,
      record,
      {
        clientId: uuidv7(ctx.now),
        type: route.type,
        title: FOLLOW_UP_ROUTE_TITLES[input.reason],
        group: route.group,
      },
      { kind: "service", principal: input.actor, reason: "route" },
      {
        gate: input.gate,
        groupMembers: (group) => currentGroupMembers(storage, group, ctx.env, ctx.now),
        groups: async () => new Set(settings.groups.map((g) => g.id)),
        route: {
          reason: input.reason,
          publicLabel: route.publicLabel,
          nextUpdateDays: route.nextUpdateDays,
          dueDays: route.dueDays,
          memberVisible: route.memberVisible,
        },
      },
    );
    await storage.put(key, `${followUp.seq}-${followUp.n}`);
    return followUp;
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    console.warn(
      JSON.stringify({ event: "TEMPL_SUPPORT_FOLLOW_UP_ROUTE_SKIPPED" }),
    );
    return null;
  }
}
export { FOLLOW_UP_LIMITS };
export type { SupportHandoffReason };
