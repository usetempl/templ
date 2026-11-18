"use client";

import { useEffect, useRef, useState } from "react";
import { IconDownload } from "@tabler/icons-react";
import type { ChatRoomId } from "@templ/chat/index";
import {
  exportConversation,
  saveConversationExport,
  type ConversationExport,
} from "@/lib/conversation-export";
import { Spinner } from "@/components/ui/ui";
import styles from "@/components/team-conversations.module.css";

type State =
  | { kind: "idle" }
  | { kind: "running"; count: number }
  | { kind: "saved"; result: ConversationExport }
  | { kind: "stopped"; result: ConversationExport }
  | { kind: "error"; message: string };

const plural = (count: number) =>
  `${count.toLocaleString("en-US")} ${count === 1 ? "message" : "messages"}`;

/** What a partial file holds and why it stopped. */
function partialNote(result: ConversationExport) {
  const kept = `The file has the newest ${plural(result.messages)} and says it’s partial.`;
  if (result.reason === "access-ended")
    return `Your access to this case ended during the download. ${kept}`;
  if (result.reason === "rate-limited")
    return `Templ limits how fast a case downloads. ${kept} Try again in a few minutes.`;
  if (result.reason === "cancelled") return `You stopped the download. ${kept}`;
  return `The download stopped early. ${kept}`;
}

/** Saves one conversation as a JSONL file through the export route. Staff
 * and the member both use it; the worker checks access on every page. */
export function DownloadChat({
  room,
  conversationId,
  viewer,
}: {
  room: ChatRoomId;
  conversationId: string;
  viewer: "team" | "member";
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function download() {
    if (controller.current) return;
    const current = new AbortController();
    controller.current = current;
    setState({ kind: "running", count: 0 });
    try {
      const result = await exportConversation({
        room,
        conversationId,
        signal: current.signal,
        onProgress: (count) => {
          if (!current.signal.aborted) setState({ kind: "running", count });
        },
      });
      if (result.reason === "cancelled") {
        if (controller.current === current)
          setState({ kind: "stopped", result });
        return;
      }
      saveConversationExport(result);
      setState({ kind: "saved", result });
    } catch (reason) {
      if (current.signal.aborted) {
        if (controller.current === current) setState({ kind: "idle" });
        return;
      }
      setState({
        kind: "error",
        message:
          reason instanceof Error && reason.message
            ? reason.message
            : "This case could not be downloaded.",
      });
    } finally {
      if (controller.current === current) controller.current = null;
    }
  }

  const running = state.kind === "running";
  return (
    <div className={styles.detailSection}>
      <h3>Download</h3>
      <p className={styles.detailMuted}>
        Saves every message in this case as a file.
        {viewer === "team" ? " Internal notes aren’t included." : ""} Anyone
        with the file can read it, and Templ can’t recall it.
      </p>
      {running ? (
        <>
          <p className={styles.detailText} role="status">
            <Spinner size={14} /> Downloading… {plural(state.count)}
          </p>
          <button
            type="button"
            className="button small quiet"
            onClick={() => controller.current?.abort()}
          >
            Stop
          </button>
        </>
      ) : (
        <button
          type="button"
          className="button small quiet"
          onClick={() => void download()}
        >
          <IconDownload aria-hidden="true" /> Download case
        </button>
      )}
      {state.kind === "saved" &&
        (state.result.partial ? (
          <p className={styles.note} role="status">
            {partialNote(state.result)}
          </p>
        ) : (
          <p className={styles.detailText} role="status">
            Saved {plural(state.result.messages)}.
          </p>
        ))}
      {state.kind === "stopped" && (
        <>
          <p className={styles.note} role="status">
            Stopped after {plural(state.result.messages)}.
          </p>
          <button
            type="button"
            className="button small"
            onClick={() => {
              saveConversationExport(state.result);
              setState({ kind: "saved", result: state.result });
            }}
          >
            Save them as a partial file
          </button>
        </>
      )}
      {state.kind === "error" && (
        <p className={styles.error} role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
