import { useEffect } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportWorkflow } from "@templ/chat/support";
import { CommunityApiError } from "@/lib/community-client";
import {
  readSupportWorkflow,
  updateSupportWorkflow,
} from "@/lib/team-conversations-client";

export function useStaffChatWorkflow(
  room: ChatRoomId,
  thread: string | null,
  revision: number,
  receive: (workflow: SupportWorkflow | undefined) => void,
) {
  useEffect(() => {
    if (!thread) return;
    const controller = new AbortController();
    let reading = false;
    async function read() {
      if (reading || controller.signal.aborted) return;
      reading = true;
      try {
        const result = await readSupportWorkflow(
          room,
          thread!,
          controller.signal,
        );
        if (!controller.signal.aborted) receive(result.workflow);
      } catch (error) {
        if (
          !controller.signal.aborted &&
          error instanceof CommunityApiError &&
          [401, 403, 404].includes(error.status)
        )
          receive(undefined);
      } finally {
        reading = false;
      }
    }
    void read();
    const interval = window.setInterval(() => {
      if (!document.hidden) void read();
    }, 15000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [room, thread, revision, receive]);
}

export function useStaffChatPresence(
  room: ChatRoomId,
  account: ChatPrincipalId | undefined,
  thread: string | null,
  messagesShown: boolean,
  composing: boolean,
) {
  useEffect(() => {
    if (!thread || !messagesShown) return;
    void updateSupportWorkflow(account, room, thread, {
      action: "read",
    }).catch(() => {});
  }, [account, room, thread, messagesShown]);
  useEffect(() => {
    if (!thread || !messagesShown) return;
    let pending = false;
    const update = () => {
      if (!document.hidden && !pending) {
        pending = true;
        // `typed` says `composing` means typed in this thread since it
        // opened: a restored draft is not a person stepping in.
        void updateSupportWorkflow(account, room, thread, {
          action: "presence",
          composing,
          typed: true,
        })
          .catch(() => {})
          .finally(() => {
            pending = false;
          });
      }
    };
    update();
    const timer = window.setInterval(update, 20_000);
    return () => window.clearInterval(timer);
  }, [account, room, thread, composing, messagesShown]);
}
