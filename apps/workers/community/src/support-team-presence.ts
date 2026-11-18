import type { ChatMessage, TeamConversationJoin } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { managedPrincipal } from "./managed-agent/principal";
import { readTeamName } from "./staff-display-name";
import {
  isTemplStaff,
  listedTemplStaff,
  type TemplStaffEnv,
} from "./templ-staff";
import type {
  ConversationContext,
  TeamConversationRecord,
} from "./team-conversations";

/** Join lines one thread keeps; the oldest case's line goes first. */
export const MAX_TEAM_JOINS = 20;

/** The first person to reply, claim or receive each case. The caller has
 * checked their team permission; a join never participates in that check. */
export async function recordTeamJoin(
  record: TeamConversationRecord,
  context: ConversationContext,
  principal: ChatPrincipalId,
  caseSeq: number,
): Promise<void> {
  if (
    record.teamJoins?.some((join) => join.caseSeq === caseSeq) ||
    (principal === context.viewer.principalId && context.isBot) ||
    context.bots?.includes(principal) ||
    principal === (await managedPrincipal(record.room))
  )
    return;
  record.teamJoins = [
    ...(record.teamJoins ?? []),
    { principalId: principal, at: context.now, caseSeq },
  ].slice(-MAX_TEAM_JOINS);
}

/** The join lines for one page of a member's read, called only after the
 * thread's access check. A page with older messages before it carries only
 * the joins from its first message on. Each line carries the person's name
 * for members, never their account. */
export async function teamJoins(
  storage: Pick<DurableObjectStorage, "get">,
  record: TeamConversationRecord,
  messages: readonly ChatMessage[],
  olderExist: boolean,
  env: TemplStaffEnv = {},
): Promise<TeamConversationJoin[]> {
  const from = olderExist ? (messages[0]?.createdAt ?? null) : "";
  if (from === null) return [];
  const shown = (record.teamJoins ?? [])
    .map((join) => ({ ...join, iso: new Date(join.at).toISOString() }))
    .filter((join) => join.iso >= from);
  const names = new Map(
    await Promise.all(
      [...new Set(shown.map((join) => join.principalId))].map(
        async (id) =>
          [
            id,
            listedTemplStaff(env, id) || (await isTemplStaff(storage, id))
              ? null
              : await readTeamName(storage, id),
          ] as const,
      ),
    ),
  );
  return shown.map((join) => {
    const name = names.get(join.principalId);
    return { at: join.iso, ...(name ? { name } : {}) };
  });
}
