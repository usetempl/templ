"use client";

import { useId, useState } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { ChatRoomId } from "@templ/chat/index";
import type { LearnedFaqCorrectionSource, LearnedFaqCorrectionView } from "@templ/chat/support-learning";
import { pauseLearnedSource, reviewLearnedSources } from "@/lib/knowledge-client";
import { Badge, Spinner } from "@/components/ui/ui";
import styles from "./workspace-quality.module.css";

/** Current server permissions and saved citations choose the available
 * correction. A problem label by itself never pauses knowledge. */
export function LearnedFaqCorrection({ room, account, thread, message }: {
  room: ChatRoomId;
  account: ChatPrincipalId | undefined;
  thread: string;
  message: number;
}) {
  const [view, setView] = useState<LearnedFaqCorrectionView | null>(null);
  const [selected, setSelected] = useState<LearnedFaqCorrectionSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const groupId = useId();
  async function review() {
    setBusy(true); setError(""); setNotice(""); setSelected(null);
    try { setView(await reviewLearnedSources(room, account, thread, message)); }
    catch (reason) { setView(null); setError(reason instanceof Error ? reason.message : "Learned sources could not load. Try again."); }
    finally { setBusy(false); }
  }
  async function pause(source: LearnedFaqCorrectionSource) {
    setBusy(true); setError(""); setNotice("");
    try {
      setView(await pauseLearnedSource(room, account, thread, message, source));
      setSelected(null);
      setNotice("Learned answer paused. AI will not use it while it waits for Admin review.");
    } catch (reason) {
      setSelected(null); setView(null);
      setError(reason instanceof Error ? reason.message : "The learned answer could not be paused. Review it again.");
    } finally { setBusy(false); }
  }
  return (
    <div className={styles.correction}>
      <button type="button" className="button small secondary" disabled={busy} onClick={() => void review()}>
        {busy && <Spinner />}Review learned sources
      </button>
      {view && (
        <div>
          {!view.sources.length && <p className={styles.note}>No unchanged automatic FAQ entry is cited by this reply. Review other sources in Brain.</p>}
          {view.sources.map((source) => (
            <div key={source.id}>
              <p className={styles.label}>{source.title}</p>
              {source.pausedAt ? (
                <p className={styles.note}><Badge tone="warning">Paused for review</Badge> Paused {new Date(source.pausedAt).toLocaleString()}.</p>
              ) : view.canPause ? (
                <button type="button" className="button small secondary" disabled={busy} aria-expanded={selected?.id === source.id} aria-controls={`${groupId}-${source.id}`} onClick={() => setSelected(source)}>Pause learned answer</button>
              ) : <p className={styles.note}>Ask a workspace Admin to pause this learned answer. The problem label stays in the review queue.</p>}
              {selected?.id === source.id && (
                <div id={`${groupId}-${source.id}`} role="group" aria-label="Pause learned answer">
                  <p className={styles.note}>AI will stop using this automatic FAQ entry. An Admin can review and edit it in Brain. Original sources stay unchanged.</p>
                  <div className={styles.actions}>
                    <button type="button" className="button small" disabled={busy} onClick={() => void pause(source)}>Pause answer</button>
                    <button type="button" className="button small secondary" disabled={busy} onClick={() => setSelected(null)}>Keep answer</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {notice && <p role="status" className={styles.status}>{notice}</p>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
    </div>
  );
}
