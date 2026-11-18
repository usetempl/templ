"use client";

import { TeamConversationsPane } from "@/components/team-conversations";
import { StatusNotice } from "@/components/status-notice";
import type { WorkspaceContext } from "./support-workspace";

export function WorkspaceInbox({
  context,
  conversation,
}: {
  context: WorkspaceContext;
  conversation: string | null;
}) {
  return (
    <>
      {/* Templ's incident notice, only while one is open. */}
      <StatusNotice />
      <TeamConversationsPane
        key={`${context.room}:${context.account}:${context.revision}`}
        features={context.state?.features}
        room={context.room}
        communityName={context.workspace.name}
        view="team"
        visibility={context.workspace.visibility}
        revision={context.revision}
        initialConversation={conversation}
      />
    </>
  );
}
