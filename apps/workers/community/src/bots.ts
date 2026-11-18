import { canManageWorkspace } from "@templ/chat/moderation-permissions";
import {
  BOT_LIMITS,
  normalizeBotDisplayName,
  type ChatBot,
  type ChatBots,
} from "@templ/chat/bots";
import {
  normalizeChatPrincipal,
  type ChatPrincipalId,
} from "@templ/chat/principal";
import type { ChatViewer } from "@templ/chat/index";
import { HttpError, json } from "./common";
import { principal, principalList } from "./principal";
import { actsAs } from "./service-principals";
import type { PendingEvent } from "./room-events";
import type { PendingAudit } from "./room-audit";
import { managedPrincipal } from "./managed-agent/principal";
import {
  isOperatorAdmin,
  isTrialOperatorAdmin,
  type OperatorAdminEnv,
} from "./operator-admin";

/** Registered AI agent identities live in `chat-settings`, with `botsRevision`.
 * Registration grants no permission. Each agent uses its own session and roles.
 * Storage validation checks every accepted field; readers receive only the identity projection. */
type StoredBot = ChatBot & {
  commands?: readonly unknown[];
  commandsUpdatedAt?: string | null;
};
export type BotSettings = {
  bots: StoredBot[];
  botsRevision: number;
  /** Retained identity, independent of the removable agent display registry. */
  aiPrincipals?: ChatPrincipalId[];
};
type Storage = Pick<DurableObjectTransaction, "get" | "put">;
type BotOperatorEnv = OperatorAdminEnv & {
  RECOVERY_OPERATOR_PRINCIPALS?: string;
  CORPUS_READER_PRINCIPALS?: string;
};
const SETTINGS_KEY = "chat-settings";
export const BOT_SETTINGS_ERROR = "AI agent settings are unavailable.";

function isoTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function isBot(value: unknown): value is StoredBot {
  if (!value || typeof value !== "object") return false;
  const bot = value as Record<string, unknown>;
  const principalId = normalizeChatPrincipal(bot.principalId);
  const registeredBy = normalizeChatPrincipal(bot.registeredBy);
  if (
    !principalId ||
    principalId !== bot.principalId ||
    !registeredBy ||
    registeredBy !== bot.registeredBy ||
    !isoTime(bot.registeredAt) ||
    (bot.commands !== undefined && !Array.isArray(bot.commands)) ||
    (bot.commandsUpdatedAt !== undefined &&
      bot.commandsUpdatedAt !== null &&
      !isoTime(bot.commandsUpdatedAt))
  )
    return false;
  try {
    return normalizeBotDisplayName(bot.displayName) === bot.displayName;
  } catch {
    return false;
  }
}
/** What every reader sees. */
const current = (bot: StoredBot): ChatBot => ({
  principalId: bot.principalId,
  displayName: bot.displayName,
  registeredBy: bot.registeredBy,
  registeredAt: bot.registeredAt,
});
/** The current bot registry stored in `chat-settings`. A missing or malformed
 * registry is not interpreted as an empty one: doing that could silently
 * remove bot identity from authorization and author badges. */
export function botsFromSettings(
  settings: object | null | undefined,
): ChatBot[] {
  const list = (settings as { bots?: unknown } | null | undefined)?.bots;
  if (
    !Array.isArray(list) ||
    list.length > BOT_LIMITS.botsPerRoom ||
    !list.every(isBot) ||
    new Set(list.map((bot) => bot.principalId)).size !== list.length
  )
    throw new HttpError(503, BOT_SETTINGS_ERROR);
  return list.map(current);
}
export function botsRevision(settings: object | null | undefined): number {
  const value = (settings as { botsRevision?: unknown } | null | undefined)
    ?.botsRevision;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HttpError(503, BOT_SETTINGS_ERROR);
  return value;
}
/** Removing an agent label cannot grant human authority to its account. */
export function aiPrincipalsFromSettings(settings: object): ChatPrincipalId[] {
  const bots = botsFromSettings(settings).map((bot) => bot.principalId);
  const stored = (settings as { aiPrincipals?: unknown }).aiPrincipals;
  if (stored === undefined) return bots;
  if (
    !Array.isArray(stored) ||
    stored.some(
      (id) => !normalizeChatPrincipal(id) || normalizeChatPrincipal(id) !== id,
    ) ||
    new Set(stored).size !== stored.length
  )
    throw new HttpError(503, BOT_SETTINGS_ERROR);
  return [...new Set([...stored, ...bots])] as ChatPrincipalId[];
}
export function aiRole(role: {
  id: string;
  moderationPermissions?: readonly string[];
}): boolean {
  return (
    !["support-member", "support-lead", "support-specialist", "support-admin"].includes(
      role.id,
    ) &&
    (role.moderationPermissions ?? []).every(
      (permission) => permission === "handleConversations",
    )
  );
}
export async function aiPrincipals(
  storage: Pick<DurableObjectTransaction, "get">,
  settings: object,
  room?: string,
): Promise<ChatPrincipalId[]> {
  const native = room
    ? undefined
    : await storage.get<{ room: { id: string } }>("native-room");
  const id = room ?? (native ? `room:${native.room.id}` : null);
  return [
    ...new Set([
      ...aiPrincipalsFromSettings(settings),
      ...(id ? [await managedPrincipal(id)] : []),
    ]),
  ];
}
/** Stored AI ownership blocks workspace authority until operator recovery. */
export function requireHumanManager(
  agents: readonly ChatPrincipalId[],
  manager: ChatPrincipalId,
) {
  if (agents.includes(manager))
    throw new HttpError(503, "Workspace manager authority is unavailable.");
}
async function settingsRecord(storage: Storage) {
  const settings = await storage.get<BotSettings & Record<string, unknown>>(
    SETTINGS_KEY,
  );
  if (!settings)
    throw new HttpError(409, "Set up this workspace before adding AI agents.");
  return settings;
}
function view(settings: BotSettings): ChatBots {
  return { bots: botsFromSettings(settings), revision: botsRevision(settings) };
}
async function write(
  storage: Storage,
  settings: BotSettings & Record<string, unknown>,
  bots: StoredBot[],
  identities: readonly ChatPrincipalId[] = [],
): Promise<ChatBots> {
  const next = {
    ...settings,
    bots,
    aiPrincipals: [
      ...new Set([...aiPrincipalsFromSettings(settings), ...identities]),
    ],
    botsRevision: botsRevision(settings) + 1,
  };
  await storage.put(SETTINGS_KEY, next);
  return view(next);
}

export async function readBots(storage: Storage): Promise<ChatBots> {
  return view(await settingsRecord(storage));
}
export async function registerBot(
  storage: Storage,
  input: {
    principalId: unknown;
    displayName: unknown;
    actor: ChatPrincipalId;
    servicePrincipals?: readonly ChatPrincipalId[];
    now: number;
    operatorEnv: BotOperatorEnv;
  },
): Promise<ChatBots> {
  const settings = await settingsRecord(storage);
  const id = principal(input.principalId);
  const identities = input.servicePrincipals ?? [id];
  const reservedOperators = [
    ...principalList(input.operatorEnv.FEEDBACK_ADMIN_PRINCIPALS),
    ...principalList(input.operatorEnv.RECOVERY_OPERATOR_PRINCIPALS),
    ...principalList(input.operatorEnv.CORPUS_READER_PRINCIPALS),
  ];
  if (
    [id, ...identities].some(
      (identity) =>
        isOperatorAdmin(input.operatorEnv, identity, [identity]) ||
        isTrialOperatorAdmin(input.operatorEnv, identity, [identity]) ||
        reservedOperators.includes(identity),
    )
  )
    throw new HttpError(
      403,
      "A Templ operator cannot be registered as an AI agent.",
    );
  const native = await storage.get<{
    room: { manager: ChatPrincipalId; pendingManager: ChatPrincipalId | null };
  }>("native-room");
  if (
    native &&
    (actsAs(identities, native.room.manager) ||
      actsAs(identities, native.room.pendingManager))
  )
    throw new HttpError(403, "An AI agent cannot be the workspace manager.");
  const roles =
    (settings as { roles?: { id: string; moderationPermissions?: string[] }[] })
      .roles ?? [];
  for (const identity of identities) {
    const held = (await storage.get<string[]>(`roles:${identity}`)) ?? [];
    if (roles.some((role) => held.includes(role.id) && !aiRole(role)))
      throw new HttpError(
        403,
        "Remove human roles before registering an AI agent.",
      );
  }
  let displayName: string;
  try {
    displayName = normalizeBotDisplayName(input.displayName);
  } catch (error) {
    throw new HttpError(
      400,
      error instanceof Error ? error.message : "Use 2 to 32 characters.",
    );
  }
  const bots = botsFromSettings(settings);
  if (bots.some((bot) => bot.principalId === id))
    throw new HttpError(
      409,
      "This wallet is already registered as an AI agent.",
    );
  if (bots.length >= BOT_LIMITS.botsPerRoom)
    throw new HttpError(
      409,
      `This workspace has reached its limit of ${BOT_LIMITS.botsPerRoom} AI agents.`,
    );
  const bot: StoredBot = {
    principalId: id,
    displayName,
    registeredBy: input.actor,
    registeredAt: new Date(input.now).toISOString(),
  };
  return write(storage, settings, [...bots, bot], identities);
}
export async function removeBot(
  storage: Storage,
  principalId: unknown,
): Promise<ChatBots> {
  const settings = await settingsRecord(storage);
  const id = principal(principalId);
  const bots = botsFromSettings(settings);
  if (!bots.some((bot) => bot.principalId === id))
    throw new HttpError(404, "This wallet is not registered as an AI agent.");
  return write(
    storage,
    settings,
    bots.filter((bot) => bot.principalId !== id),
  );
}
const REMOVE = /^\/bots\/([^/]+)\/remove$/;
/** Matches the bot routes the room object serves; used by the worker dispatch. */
export const BOT_ROUTE = /^\/bots(?:\/[^/]+\/remove)?$/;

/** Room-object dispatch for `GET /bots`, `POST /bots` and
 * `POST /bots/:principal/remove`. Returns null for other paths. The caller
 * already resolved the viewer inside the room transaction;
 * `pending`/`pendingAudit` are written only with a 2xx result. */
export async function botsRoute(
  storage: Storage,
  input: {
    method: string;
    pathname: string;
    body: Record<string, unknown>;
    viewer: ChatViewer;
    pending: PendingEvent[];
    pendingAudit: PendingAudit[];
    now?: number;
    targetPrincipals?: readonly ChatPrincipalId[];
    operatorEnv: BotOperatorEnv;
  },
): Promise<Response | null> {
  const { method, pathname, body, viewer, pending, pendingAudit } = input;
  if (!BOT_ROUTE.test(pathname)) return null;
  const now = input.now ?? Date.now();
  if (pathname === "/bots" && method === "GET")
    return json(await readBots(storage));
  if (method !== "POST") return null;
  const actor = viewer.principalId;
  if (!actor) throw new HttpError(401, "Sign in to chat.");
  if (!canManageWorkspace(viewer) && !viewer.permissions.includes("manageRoles"))
    throw new HttpError(403, "You do not have permission to do that.");
  const remove = REMOVE.exec(pathname);
  if (remove) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(remove[1]);
    } catch {
      throw new HttpError(400, "Invalid user ID.");
    }
    const target = principal(decoded);
    const result = await removeBot(storage, target);
    pendingAudit.push({ actor, action: "bot.remove", target });
    pending.push({ type: "room.updated" });
    return json(result);
  }
  if (pathname === "/bots") {
    const result = await registerBot(storage, {
      principalId: body.principalId,
      displayName: body.displayName,
      actor,
      now,
      servicePrincipals: input.targetPrincipals,
      operatorEnv: input.operatorEnv,
    });
    const target = principal(body.principalId);
    pendingAudit.push({
      actor,
      action: "bot.register",
      target,
      after: {
        displayName: result.bots.find((bot) => bot.principalId === target)
          ?.displayName,
      },
    });
    pending.push({ type: "room.updated" });
    return json(result);
  }
  return null;
}
