"use client";

/** Verified domain in the widget settings: the manager
 * adds a domain the team's websites are on, publishes the TXT record Templ
 * names, and checks it. The widget on that domain then shows "Verified
 * domain: <domain>" under its title. Shown only once the verified domain
 * passed its hosted check (`verifiedDomainVerified`). Each change needs the
 * manager's valid wallet session; the verified list lands in the activity
 * log. */
import { useEffect, useRef, useState } from "react";
import { IconCircleCheck, IconTrash } from "@tabler/icons-react";
import { communityFetch, roomPath } from "@/lib/community-client";
import { chatMutation } from "@/lib/chat-api";
import { Card, CopyInline, Spinner, ui } from "@/components/ui/ui";
import type { WorkspaceContext } from "./support-workspace";
import styles from "./workspace.module.css";
import { UnsavedChanges } from "./unsaved-changes";

export type DomainRow = {
  domain: string;
  state: "pending" | "verified";
  record: { name: string; type: "TXT"; value: string };
  verifiedAt?: number;
  lastCheckedAt?: number;
  failures?: number;
};

export const DOMAIN_COPY = {
  title: "Verified domain",
  points: [
    "Prove your team controls your domain with one DNS record.",
    "The widget on that domain then shows “Verified domain” and the domain under its title.",
    "A fake page can copy those words, so keep telling people where your app lives.",
  ],
  add: "Add domain",
  placeholder: "yourprotocol.xyz",
  pending:
    "Add this TXT record at your DNS provider, then check. DNS changes can take a few minutes.",
  verified: "Verified",
  check: "Check now",
  notFound: "The record isn't visible yet. Try again in a few minutes.",
  found: "Verified.",
  remove: "Remove",
} as const;

export function WidgetVerifiedDomain({
  context,
  live = context.state?.features?.verifiedDomain === true,
}: {
  context: WorkspaceContext;
  /** Verified domains passed their hosted check. */
  live?: boolean;
}) {
  const { room, account } = context;
  const current = useRef(room);
  const [rows, setRows] = useState<DomainRow[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [entry, setEntry] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  // Bumped after each change, so the list reads again.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    setError("");
    current.current = room;
    void communityFetch<{ available: boolean; domains: DomainRow[] }>(
      roomPath(room, "widget/domains"),
      undefined,
      controller.signal,
    )
      .then((data) => {
        if (!controller.signal.aborted) {
          if (
            typeof data.available !== "boolean" ||
            (data.available && !Array.isArray(data.domains))
          )
            throw new Error("Verified domains could not load.");
          setUnavailable(!data.available);
          setRows(data.available ? data.domains : null);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Verified domains could not load.");
      });
    return () => controller.abort();
  }, [room, live, revision]);
  if (!live || unavailable) return null;
  if (rows === null)
    return (
      <Card title={DOMAIN_COPY.title}>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button
              type="button"
              className="button secondary"
              onClick={() => setRevision((value) => value + 1)}
            >
              Try again
            </button>
          </>
        ) : (
          <Spinner />
        )}
      </Card>
    );
  function change(
    op: "add" | "check" | "remove",
    domain: string,
    after: (data: { found?: boolean }) => string,
  ) {
    setBusy(`${op}:${domain}`);
    setNotice("");
    setError("");
    void chatMutation<{ found?: boolean }>(
      account as never,
      roomPath(room, "widget/domains"),
      { op, domain, confirmed: true },
    )
      .then((data) => {
        if (current.current !== room) return;
        setRevision((value) => value + 1);
        setNotice(after(data));
      })
      .catch(
        (reason) =>
          current.current === room &&
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not save the domain.",
          ),
      )
      .finally(() => {
        if (current.current === room) setBusy("");
      });
  }
  return (
    <Card title={DOMAIN_COPY.title}>
      <UnsavedChanges dirty={Boolean(entry.trim())} />
      <div className={styles.stack} style={{ gap: 12 }}>
        <ul className={styles.small}>
          {DOMAIN_COPY.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
        {rows.map((row) => (
          <div key={row.domain} className={styles.stack} style={{ gap: 8 }}>
            <p>
              <strong>{row.domain}</strong>{" "}
              {row.state === "verified" && (
                <span className={styles.status}>
                  <IconCircleCheck size={15} aria-hidden="true" />{" "}
                  {DOMAIN_COPY.verified}
                </span>
              )}
            </p>
            {row.state === "pending" && (
              <>
                <p className={styles.small}>{DOMAIN_COPY.pending}</p>
                <div>
                  <p className={styles.sectionTitle}>Name</p>
                  <CopyInline value={row.record.name} label="Copy" />
                </div>
                <div>
                  <p className={styles.sectionTitle}>Value</p>
                  <CopyInline value={row.record.value} label="Copy" />
                </div>
              </>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              {row.state === "pending" && (
                <button
                  type="button"
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    change("check", row.domain, (data) =>
                      data.found ? DOMAIN_COPY.found : DOMAIN_COPY.notFound,
                    )
                  }
                >
                  {busy === `check:${row.domain}` && <Spinner />}
                  {DOMAIN_COPY.check}
                </button>
              )}
              <button
                type="button"
                className="button secondary"
                disabled={!!busy}
                aria-label={`${DOMAIN_COPY.remove} ${row.domain}`}
                onClick={() => change("remove", row.domain, () => "Removed.")}
              >
                <IconTrash aria-hidden="true" /> {DOMAIN_COPY.remove}
              </button>
            </div>
          </div>
        ))}
        <form
          className={styles.addRow}
          onSubmit={(event) => {
            event.preventDefault();
            const domain = entry.trim().toLowerCase().replace(/\.$/, "");
            if (!domain) return;
            change("add", domain, () => {
              setEntry("");
              return "Added. Publish the record, then check.";
            });
          }}
        >
          <input
            className={ui.input}
            aria-label="Domain to verify"
            placeholder={DOMAIN_COPY.placeholder}
            value={entry}
            onChange={(event) => setEntry(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="button secondary" disabled={!!busy}>
            {busy.startsWith("add:") && <Spinner />}
            {DOMAIN_COPY.add}
          </button>
        </form>
        {(notice || error) && (
          <p
            className={error ? styles.error : styles.status}
            role={error ? "alert" : "status"}
          >
            {!error && <IconCircleCheck size={15} aria-hidden="true" />}{" "}
            {error || notice}
          </p>
        )}
      </div>
    </Card>
  );
}
