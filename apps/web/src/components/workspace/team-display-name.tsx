"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Card, Field, Skeleton, ui } from "@/components/ui/ui";
import { chatMutation } from "@/lib/chat-api";
import { communityFetch, roomPath } from "@/lib/community-client";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

type TeamName = { teamName: string | null };

export function TeamDisplayName({ context }: { context: WorkspaceContext }) {
  const { room, account } = context;
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void communityFetch<TeamName>(
      roomPath(room, "conversations/team-name"),
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        setName(result.teamName ?? "");
        setSaved(result.teamName ?? "");
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Your name could not load.",
          );
      });
    return () => controller.abort();
  }, [room, account, attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || saved === undefined) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await chatMutation<TeamName>(
        account as never,
        roomPath(room, "conversations/team-name"),
        { teamName: name.trim() || null },
      );
      setName(result.teamName ?? "");
      setSaved(result.teamName ?? "");
      setNotice(result.teamName ? "Name saved." : "Users will see Team.");
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Your name could not save.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void save(event)}>
      <UnsavedChanges dirty={saved !== undefined && name.trim() !== saved} />
      <Card
        title="Your replies"
        footer={
          saved !== undefined ? (
            <button
              type="submit"
              className="button"
              disabled={busy || name === saved}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          ) : undefined
        }
      >
        {saved === undefined && !error ? (
          <Skeleton height={42} />
        ) : saved !== undefined ? (
          <Field
            label="Your name for users"
            hint="Users see this on your replies. Leave it empty to show Team."
          >
            <input
              className={ui.input}
              value={name}
              maxLength={32}
              disabled={busy}
              onChange={(event) => {
                setName(event.target.value);
                setNotice("");
              }}
            />
          </Field>
        ) : null}
        {notice && (
          <p className={styles.status} role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {error && saved === undefined && (
          <button
            type="button"
            className="button secondary"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Try again
          </button>
        )}
      </Card>
    </form>
  );
}
