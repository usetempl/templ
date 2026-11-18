import { supportWalletChain } from "@templ/chat/chains";
import type { TeamConversation } from "@templ/chat/index";
import type { SupportActivity } from "@templ/chat/support";
import { supportUtcTime } from "@templ/chat/support-time";

/** A UTC time, with the date when it is not today or the caller asks for it. */
export const inboxTime = supportUtcTime;

/** Known chains use the shared chain table; an unknown id remains readable. */
export function inboxNetworkName(network: string): string {
  if (
    network === "solana" ||
    network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
  )
    return "Solana";
  const chain = /^eip155:([1-9][0-9]*)$/.exec(network);
  return chain
    ? (supportWalletChain(Number(chain[1]))?.name ?? network)
    : network;
}

export function inboxOwner(
  assignment: TeamConversation["assignment"],
  viewer: string | undefined,
  fallback: (id: string) => string,
): string {
  if (!assignment) return "No owner";
  const name =
    assignment.principalId === viewer
      ? "You"
      : assignment.teamName || fallback(assignment.principalId);
  return `Owner: ${name}`;
}

export function inboxSystemEvent(
  activity: SupportActivity,
  members: readonly string[] = [],
): string | null {
  if (
    activity.action === "status" &&
    activity.detail === "resolved" &&
    members.includes(activity.actor)
  )
    return "User said solved";
  if (activity.action === "handoff" && activity.detail === "person")
    return "The user asked for a person";
  if (activity.action === "confirmed" && activity.detail === "solved")
    return "User said solved";
  if (activity.action === "confirmed" && activity.detail === "not-solved")
    return "User said not solved";
  return null;
}
