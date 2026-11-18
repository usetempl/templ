"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ChatRoomId } from "@templ/chat/index";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { CorpusWorkspaceView } from "@templ/chat/support-corpus";
import { corpusAction, readCorpus, readCorpusOn, readCaseCopyPrivacy } from "@/lib/corpus-client";
import {
  CORPUS_COPY as c,
  CORPUS_PURPOSE_TEXT,
  deletedText,
  keptText,
  monthName,
  readsLine,
} from "@/lib/copy/corpus";
import { Card, Stat } from "@/components/ui/ui";
import { TalkToTempl } from "@/components/talk-to-templ";
import styles from "./workspace.module.css";
import own from "./staff-data.module.css";

/** The workspace's counts, read once per mount; null while hidden. */
function useCorpus(room: ChatRoomId) {
  const [view, setView] = useState<CorpusWorkspaceView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readCorpus(room, controller.signal)
      .then(setView)
      .catch(() => setView(null));
    return () => controller.abort();
  }, [room]);
  return view;
}

/** Whether the copy is on for this workspace, and whether the viewer may
 * act on a member's request; null while off or unknown. */
function useCorpusOn(room: ChatRoomId) {
  const [on, setOn] = useState<{ lead: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readCorpusOn(room, controller.signal)
      .then(setOn)
      .catch(() => setOn(null));
    return () => controller.abort();
  }, [room]);
  return on;
}

/** Settings: copies kept and last month's reads by Templ. Shown to the
 * manager and support leads while the copy is on. */
export function ImprovementCopyCard({ room }: { room: ChatRoomId }) {
  const view = useCorpus(room);
  if (!view) return null;
  return (
    <Card title={c.title} description={c.description}>
      <div className={styles.grid2}>
        <Stat label={c.kept} value={keptText(view.rows)} />
        <Stat
          label={c.readLastMonth}
          value={keptText(view.reads.rows)}
          hint={
            view.reads.rows
              ? view.reads.purposes.map((p) => CORPUS_PURPOSE_TEXT[p]).join(", ")
              : monthName(view.reads.month)
          }
        />
      </div>
      <p className={styles.small}>
        <Link className={styles.inlineLink} href="/privacy#improvement">
          {c.privacy}
        </Link>
      </p>
      <ContractLink />
    </Card>
  );
}

/** The only way to leave the copy out: a custom contract, through Talk to
 * us. */
function ContractLink() {
  return (
    <p className={styles.small}>
      <TalkToTempl className={styles.inlineLink} label={c.contractLabel}>
        {c.contract}
      </TalkToTempl>
    </p>
  );
}

/** Plan and usage: what the copy is and how to get a contract without it.
 * Shown to everyone who sees the Plan tab while the copy is on. */
export function ImprovementCopyPlanCard({ room }: { room: ChatRoomId }) {
  const on = useCorpusOn(room);
  if (!on) return null;
  return (
    <Card title={c.title} description={c.description}>
      <ContractLink />
    </Card>
  );
}

/** Activity: the month's line about Templ's reads. */
export function TemplReadsLine({ room }: { room: ChatRoomId }) {
  const view = useCorpus(room);
  if (!view) return null;
  return (
    <p className={styles.muted} role="note">
      {readsLine(view.reads.month, view.reads.rows, view.reads.purposes)}
    </p>
  );
}

/** A thread's panel for the manager and support leads: delete every copy
 * of the member's chats for a privacy request or an objection. One confirm
 * step each. */
export function ThreadCopyPanel({
  room,
  account,
  thread,
}: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
}) {
  const [on, setOn] = useState<Awaited<ReturnType<typeof readCaseCopyPrivacy>>>(null);
  useEffect(() => {
    const controller = new AbortController();
    readCaseCopyPrivacy(room, controller.signal).then(setOn).catch(() => setOn(null));
    return () => controller.abort();
  }, [room]);
  const [asking, setAsking] = useState<"delete" | "object" | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!on?.lead) return null;
  async function run(action: "delete" | "object") {
    setBusy(true);
    setError(null);
    try {
      const { deleted } = await corpusAction(room, account, thread, action);
      setResult(on?.learning
        ? "Privacy request recorded. Linked automatic FAQ entries were removed where they had no other source. Admin edits stay for review."
        : deletedText(deleted, action));
      setAsking(null);
    } catch {
      setError(c.error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className={styles.small}>
      <summary>{on.learning ? "Learned knowledge and case copies" : c.panelTitle}</summary>
      <div className={styles.stack} style={{ gap: 10, marginTop: 10 }}>
        {result ? (
          <p role="status" className={styles.status}>
            {result}
          </p>
        ) : asking ? (
          <>
            <p>{on.learning
              ? "Remove automatic FAQ entries linked only to this user and eligible case copies? Future learning from these cases stops. Admin edits stay for review."
              : asking === "delete" ? c.deleteConfirm : c.objectConfirm}</p>
            <div className={own.actions}>
              <button
                type="button"
                className={`button secondary ${own.dangerButton}`}
                disabled={busy}
                onClick={() => void run(asking)}
              >
                {on.learning ? "Record request" : c.confirm}
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => setAsking(null)}
              >
                {c.cancel}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className={styles.muted}>{on.learning
              ? "Use these when the user asks to delete their data or objects to learning from their cases."
              : c.panelHint}</p>
            <div className={own.actions}>
              <button type="button" className="button secondary" onClick={() => setAsking("delete")}>
                {c.deleteLabel}
              </button>
              <button type="button" className="button secondary" onClick={() => setAsking("object")}>
                {c.objectLabel}
              </button>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className={styles.error}>
            {on.learning ? "The request could not be recorded. Try again." : error}
          </p>
        )}
      </div>
    </details>
  );
}
