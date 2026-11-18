"use client";
import { useRef, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRoomId } from "@templ/chat/index";
import { ambiguousHexValues } from "@templ/chat/support-safety-hex";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";
import styles from "./redact-hex-button.module.css";

export function RedactHexButton({ room, account, thread, messageId, text, sharedHashes = [], canManage, onRedacted }: {
  room: ChatRoomId;
  account?: ChatPrincipalId;
  thread: string;
  messageId: string;
  text: string;
  sharedHashes?: readonly string[];
  canManage: boolean;
  onRedacted(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const pending = useRef(false);
  if (!ambiguousHexValues(text, sharedHashes).length || done) return null;
  async function redact() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await chatMutation(account, roomPath(room, `conversations/${thread}/messages/${messageId}/redact`), {});
      setDone(true);
      onRedacted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The value could not be redacted. Try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return <div className={styles.row}>
    <span className={styles.chip}>Could be a private key</span>
    {canManage && <button className={styles.button} type="button" disabled={busy} onClick={() => void redact()}>{busy ? "Redacting…" : "Redact"}</button>}
    {error && <span role="alert" className={styles.error}>{error}</span>}
  </div>;
}
