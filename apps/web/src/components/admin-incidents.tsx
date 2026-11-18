"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ChatPrincipalId } from "@templ/chat/principal";
import { useChatAuth } from "@/lib/chat-auth";
import { isChatSignInCanceled } from "@/lib/chat-auth-cancellation";
import { CommunityApiError } from "@/lib/community-client";
import {
  communitySessionRevision,
  subscribeCommunitySession,
} from "@/lib/community-auth";
import {
  incidentId,
  incidentsAdmin,
  type OperatorIncident,
} from "@/lib/incidents-admin-client";
import {
  INCIDENT_KINDS,
  INCIDENT_TITLES,
  utcTime,
  type IncidentKind,
} from "@/lib/status-client";
import styles from "./cost-dashboard.module.css";

/** The operator's words for a refused change, by reason code. */
export function incidentError(reason: unknown): string {
  if (!(reason instanceof CommunityApiError))
    return "The change didn't save. Try again.";
  const code = (reason.details as { reason?: unknown } | undefined)?.reason;
  if (reason.status === 403 && code !== "strong-auth-required")
    return "Only Templ operators can post notices.";
  if (code === "note-refused")
    return "Notes can't contain links, emails or wallets.";
  if (code === "incidents-full")
    return "Three notices are already open. Mark one fixed first.";
  if (code === "incident-revision" || code === "incident-conflict")
    return "This notice changed. Reload and try again.";
  return reason.message;
}

/** `/admin/incidents`: post, update and fix notices about Templ's service. */
export function AdminIncidentsPanel() {
  const auth = useChatAuth();
  const principal = auth.session?.principalId;
  const revision = useSyncExternalStore(
    subscribeCommunitySession,
    communitySessionRevision,
    () => 0,
  );
  const [signInError, setSignInError] = useState("");
  return (
    <main className={styles.page}>
      <h1>Incident notices</h1>
      <p>
        Notices show on the status page and in team inboxes. Customer widgets
        show a fixed line for delays, sign-in problems and maintenance, never
        the note.
      </p>
      {auth.restoring ? (
        <p role="status">Checking sign-in…</p>
      ) : !principal ? (
        <div>
          <p>Sign in with a Templ operator account.</p>
          <button
            type="button"
            onClick={() => {
              setSignInError("");
              void auth.signIn().catch((error) => {
                if (!isChatSignInCanceled(error))
                  setSignInError("Sign-in did not finish. Try again.");
              });
            }}
          >
            Sign in
          </button>
          {signInError && <p role="alert">{signInError}</p>}
        </div>
      ) : (
        <Incidents key={`${principal}:${revision}`} principal={principal} />
      )}
    </main>
  );
}

export function Incidents({ principal }: { principal: ChatPrincipalId }) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    key: number;
    rows?: OperatorIncident[];
    error?: string;
  }>();
  const current = result?.key === refresh ? result : undefined;
  useEffect(() => {
    const controller = new AbortController();
    void incidentsAdmin(principal)
      .list(controller.signal)
      .then(
        (rows) => {
          if (!controller.signal.aborted) setResult({ key: refresh, rows });
        },
        (reason) => {
          if (!controller.signal.aborted)
            setResult({
              key: refresh,
              error:
                reason instanceof CommunityApiError && reason.status === 403
                  ? "Only Templ operators can post notices."
                  : "Notices could not be loaded. Try again.",
            });
        },
      );
    return () => controller.abort();
  }, [principal, refresh]);
  const reload = () => setRefresh((value) => value + 1);
  const open = current?.rows?.filter((row) => row.state === "open") ?? [];
  const fixed = current?.rows?.filter((row) => row.state !== "open") ?? [];
  return (
    <>
      <PostNotice principal={principal} onPosted={reload} />
      {!current && <p role="status">Loading notices…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {current?.rows && (
        <>
          <section aria-labelledby="incidents-open">
            <h2 id="incidents-open">Open</h2>
            {open.length ? (
              open.map((row) => (
                <OpenNotice
                  key={`${row.id}:${row.revision}`}
                  principal={principal}
                  incident={row}
                  onChanged={reload}
                />
              ))
            ) : (
              <p>No open incidents.</p>
            )}
          </section>
          <section aria-labelledby="incidents-fixed">
            <h2 id="incidents-fixed">Fixed in the last 90 days</h2>
            {fixed.length ? (
              <ul>
                {fixed.map((row) => (
                  <li key={row.id}>
                    {INCIDENT_TITLES[row.kind]}. Started{" "}
                    {utcTime(row.startedAt)}, fixed{" "}
                    {row.resolvedAt ? utcTime(row.resolvedAt) : "–"}.
                  </li>
                ))}
              </ul>
            ) : (
              <p>None.</p>
            )}
          </section>
        </>
      )}
    </>
  );
}

function PostNotice({
  principal,
  onPosted,
}: {
  principal: ChatPrincipalId;
  onPosted: () => void;
}) {
  const [kind, setKind] = useState<IncidentKind>("slow-replies");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // One id per notice being written, so a retried post doesn't open a
  // second notice.
  const [id, setId] = useState(() => incidentId());
  return (
    <section aria-labelledby="incidents-post">
      <h2 id="incidents-post">Post a notice</h2>
      <form
        className={styles.controls}
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          void incidentsAdmin(principal)
            .post({ id, kind, note })
            .then(
              () => {
                setNote("");
                setId(incidentId());
                onPosted();
              },
              (reason) => setError(incidentError(reason)),
            )
            .finally(() => setBusy(false));
        }}
      >
        <label>
          Kind
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as IncidentKind);
              setId(incidentId());
            }}
          >
            {INCIDENT_KINDS.map((value) => (
              <option key={value} value={value}>
                {INCIDENT_TITLES[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note for the status page (optional, no links)
          <input
            value={note}
            maxLength={280}
            onChange={(event) => {
              setNote(event.target.value);
              setId(incidentId());
            }}
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Posting…" : "Post"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

function OpenNotice({
  principal,
  incident,
  onChanged,
}: {
  principal: ChatPrincipalId;
  incident: OperatorIncident;
  onChanged: () => void;
}) {
  const [note, setNote] = useState(incident.note ?? "");
  const [busy, setBusy] = useState<"note" | "fix" | null>(null);
  const [error, setError] = useState("");
  const change = (kind: "note" | "fix") => {
    setBusy(kind);
    setError("");
    void incidentsAdmin(principal)
      .update(incident.id, {
        expectedRevision: incident.revision,
        ...(kind === "note" ? { note } : { resolve: true }),
      })
      .then(onChanged, (reason) => setError(incidentError(reason)))
      .finally(() => setBusy(null));
  };
  return (
    <article aria-label={INCIDENT_TITLES[incident.kind]}>
      <h3>{INCIDENT_TITLES[incident.kind]}</h3>
      <p>
        Started {utcTime(incident.startedAt)}. Updated{" "}
        {utcTime(incident.updatedAt)}.
      </p>
      <div className={styles.controls}>
        <label>
          Note
          <input
            value={note}
            maxLength={280}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => change("note")}
        >
          {busy === "note" ? "Saving…" : "Update note"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => change("fix")}
        >
          {busy === "fix" ? "Saving…" : "Mark fixed"}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
