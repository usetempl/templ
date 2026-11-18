/** A manager registers AI agent identities for a workspace.
 * The list sets the AI label. Every action uses the agent's own session and roles. */
import type { ChatPrincipalId } from "./principal";
import { normalizeDisplayName } from "./profiles";

export const BOT_LIMITS = Object.freeze({
  botsPerRoom: 10,
  displayNameMax: 32,
});
export type ChatBot = {
  /** The bot's canonical principal, usually its wallet address. */
  principalId: ChatPrincipalId;
  /** Same rules as member display names: 2 to 32 characters, no addresses, no staff terms. */
  displayName: string;
  /** Manager or a moderation-role holder with manageRoles. */
  registeredBy: ChatPrincipalId;
  registeredAt: string;
};
export type ChatBots = { bots: ChatBot[]; revision: number };

/** Bot names follow member display-name rules. Throws Error with text for the person. */
export function normalizeBotDisplayName(value: unknown): string {
  return normalizeDisplayName(value);
}
