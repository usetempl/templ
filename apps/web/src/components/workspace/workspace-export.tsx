"use client";

import { useRef, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { CommunityApiError } from "@/lib/community-client";
import { saveConversationExport } from "@/lib/conversation-export";
import {
  exportWorkspace,
  type WorkspaceExportResult,
  type WorkspaceExportStop,
} from "@/lib/workspace-export";
import { Card, Spinner } from "@/components/ui/ui";
import styles from "./workspace.module.css";
import own from "./staff-data.module.css";

/** The section id the deletion screen scrolls to. */
export const WORKSPACE_EXPORT_SECTION = "workspace-export";
const STOPPED: Record<WorkspaceExportStop, string> = {
  "access-ended": "Your manager access changed.",
  "rate-limited": "Templ asked to slow down. Try again in a few minutes.",
  expired: "This export ran past 24 hours. Start a new one.",
  failed: "The connection dropped.",
  cancelled: "You canceled the export.",
};
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);

function startError(reason: unknown) {
  if (reason instanceof CommunityApiError) {
    const code = (reason.details as { reason?: unknown } | undefined)?.reason;
    if (code === "export-daily-limit")
      return "You can start 3 workspace exports a day. Try again tomorrow.";
    if (code === "export-unavailable")
      return "Workspace export isn't available yet.";
    return reason.message;
  }
  return "The export couldn't start. Try again.";
}

/** Settings > Export every chat, for the manager only. */
export function WorkspaceExport({
  room,
  account,
  manager,
  enabled = false,
  run = exportWorkspace,
}: {
  room: ChatRoomId;
  account?: ChatPrincipalId;
  manager: boolean;
  enabled?: boolean;
  run?: typeof exportWorkspace;
}) {
  const [notes, setNotes] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ threads: 0, messages: 0 });
  const [result, setResult] = useState<WorkspaceExportResult | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  if (!enabled || !manager) return null;
  async function start() {
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setError("");
    setResult(null);
    setProgress({ threads: 0, messages: 0 });
    try {
      setResult(
        await run({
          room,
          account,
          notes,
          signal: abort.signal,
          onProgress: setProgress,
        }),
      );
    } catch (reason) {
      if (!abort.signal.aborted) setError(startError(reason));
    } finally {
      setBusy(false);
      controller.current = null;
    }
  }
  return (
    <Card
      id={WORKSPACE_EXPORT_SECTION}
      title="Export every case"
      description="Download every case in this workspace as one JSONL file. Only you can do this, and Activity shows each export."
    >
      <label className={own.checkbox}>
        <input
          type="checkbox"
          checked={notes}
          disabled={busy}
          onChange={(event) => setNotes(event.target.checked)}
        />
        <span>
          Include internal notes
          <br />
          <small className={styles.muted}>
            Notes are for your team. Leave this off if the file will leave your
            team.
          </small>
        </span>
      </label>
      <div className={own.actions}>
        {busy ? (
          <>
            <span role="status" className={own.progress}>
              <Spinner /> Exported {count(progress.messages)} messages from{" "}
              {count(progress.threads)} cases
            </span>
            <button
              type="button"
              className="button secondary"
              onClick={() => controller.current?.abort()}
            >
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="button" onClick={() => void start()}>
            Export cases
          </button>
        )}
        {result && !busy && (
          <button
            type="button"
            className="button secondary"
            onClick={() => saveConversationExport(result as never)}
          >
            Save file
          </button>
        )}
      </div>
      {result && !busy && !result.partial && (
        <p role="status" className={styles.status}>
          Export ready.
        </p>
      )}
      {result?.partial && !busy && (
        <p role="status">
          The export stopped early. The file has {count(result.threads)} cases.
          <br />
          {STOPPED[result.reason ?? "failed"]}
        </p>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </Card>
  );
}
