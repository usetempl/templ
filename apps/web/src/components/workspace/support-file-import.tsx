"use client";

import { useState } from "react";
import { KNOWLEDGE_LIMITS } from "@templ/chat/protocol-profile";
import {
  IMPORT_REASON,
  type SupportImportPreview,
} from "@templ/chat/support-imports";
import { chatMutation } from "@/lib/chat-api";
import { roomPath } from "@/lib/community-client";
import { Callout, Field, Spinner } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export function SupportFileImport({
  context,
  kind,
  onImported,
}: {
  context: WorkspaceContext;
  kind: "knowledge" | "saved-replies";
  onImported: () => void;
}) {
  const [file, setFile] = useState<{
    filename: string;
    content: string;
  } | null>(null);
  const [preview, setPreview] = useState<SupportImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saved = kind === "saved-replies";
  const path = roomPath(context.room, `conversations/${kind}/import`);
  async function select(selected?: File) {
    setFile(null);
    setPreview(null);
    setError("");
    setNotice("");
    if (!selected) return;
    if (selected.size > KNOWLEDGE_LIMITS.pageBytes) {
      setError("This file is too large. Split it into smaller files.");
      return;
    }
    setBusy(true);
    try {
      const input = { filename: selected.name, content: await selected.text() };
      if (saved)
        setPreview(
          await chatMutation<SupportImportPreview>(context.account, path, {
            action: "preview",
            ...input,
          }),
        );
      setFile(input);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The file could not be read.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const result = await chatMutation<{
        added?: number;
        counts?: SupportImportPreview["counts"];
      }>(context.account, path, {
        ...file,
        ...(saved
          ? { action: "confirm", digest: preview?.digest, confirmed: true }
          : {}),
      });
      const count = result.counts?.added ?? result.added ?? 0;
      setNotice(
        `${count} ${saved ? (count === 1 ? "saved reply" : "saved replies") : count === 1 ? "knowledge source" : "knowledge sources"} imported.`,
      );
      setFile(null);
      setPreview(null);
      onImported();
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The file could not be imported.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.stack}>
      <UnsavedChanges dirty={file !== null} />
      <Field
        label={saved ? "Import saved replies" : "Import knowledge"}
        hint={
          saved
            ? "CSV: title,body,shortcut. Markdown: one reply per ## heading."
            : "CSV: title,body,url. Markdown: one source per ## heading."
        }
      >
        <input
          type="file"
          accept=".md,.csv"
          disabled={busy}
          onChange={(event) => void select(event.target.files?.[0])}
        />
      </Field>
      {busy && (
        <p role="status">
          <Spinner /> Reading the file…
        </p>
      )}
      {preview && (
        <div>
          <p>Review the entries before importing.</p>
          <ul className={styles.replyList}>
            {preview.rows.map((row) => (
              <li key={row.row}>
                <div>
                  <strong>{row.title}</strong>
                  <p>
                    {row.status === "add"
                      ? "Will be added"
                      : row.status === "skip"
                        ? "Skipped"
                        : "Refused"}
                    {row.reason ? `: ${IMPORT_REASON[row.reason]}` : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {file && (
        <button
          type="button"
          className="button small"
          disabled={busy || (saved && !preview?.counts.added)}
          onClick={() => void confirm()}
        >
          {saved ? "Import approved replies" : "Import knowledge"}
        </button>
      )}
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
