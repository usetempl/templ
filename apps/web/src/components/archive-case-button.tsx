"use client";

import { useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { SupportSummary } from "@templ/chat/support";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";

export function ArchiveCaseButton({
  room,
  thread,
  account,
  summary,
  canManage,
  onArchived,
}: {
  room: ChatRoomId;
  thread: string;
  account?: ChatPrincipalId;
  summary: SupportSummary;
  canManage: boolean;
  onArchived: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  if (
    !canManage ||
    summary.archivedAt ||
    !["resolved", "abandoned", "spam"].includes(summary.state)
  )
    return null;
  async function archive() {
    setBusy(true);
    setError("");
    try {
      await chatMutation(
        account,
        roomPath(room, `conversations/${thread}/archive`),
        {},
      );
      setDone(true);
      onArchived();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The case could not be archived.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="button quiet"
        disabled={busy || done}
        onClick={() => void archive()}
      >
        {done ? "Archived" : busy ? "Archiving…" : "Archive"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
