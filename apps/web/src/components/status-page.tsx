"use client";

import { useEffect, useState } from "react";
import {
  INCIDENT_STALE_MS,
  INCIDENT_TITLES,
  readIncidents,
  utcTime,
  type Incident,
} from "@/lib/status-client";
import styles from "./status-page.module.css";

const REFRESH_MS = 60_000;

/** The public status page: Templ's open notices and the ones fixed in the
 * last 14 days, in UTC. */
export function StatusPage({
  load = readIncidents,
  now = () => Date.now(),
}: {
  load?: typeof readIncidents;
  now?: () => number;
}) {
  const [state, setState] = useState<{
    incidents?: Incident[];
    failed?: boolean;
  }>({});
  useEffect(() => {
    const controller = new AbortController();
    const read = () =>
      load(undefined, controller.signal).then(
        (incidents) => {
          if (!controller.signal.aborted) setState({ incidents });
        },
        () => {
          if (!controller.signal.aborted)
            setState((previous) =>
              previous.incidents ? previous : { failed: true },
            );
        },
      );
    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load]);
  const open = state.incidents?.filter((row) => row.state === "open") ?? [];
  const fixed = state.incidents?.filter((row) => row.state !== "open") ?? [];
  return (
    <main id="main-content" tabIndex={-1} className={styles.page}>
      <h1>Status</h1>
      <p className={styles.lead}>
        Problems with Templ that we&apos;re working on, and ones fixed in the
        last 14 days. Times are in UTC.
      </p>
      {state.failed ? (
        <p role="alert">
          Status can&apos;t load right now. Try again in a minute.
        </p>
      ) : !state.incidents ? (
        <p role="status">Loading status…</p>
      ) : (
        <>
          <section className={styles.section} aria-labelledby="status-open">
            <h2 id="status-open">Open</h2>
            {open.length ? (
              <IncidentList incidents={open} now={now()} />
            ) : (
              <p className={styles.empty}>No open incidents.</p>
            )}
          </section>
          <section className={styles.section} aria-labelledby="status-fixed">
            <h2 id="status-fixed">Fixed</h2>
            {fixed.length ? (
              <IncidentList incidents={fixed} now={now()} />
            ) : (
              <p className={styles.empty}>
                Nothing reported in the last 14 days.
              </p>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function IncidentList({
  incidents,
  now,
}: {
  incidents: Incident[];
  now: number;
}) {
  return (
    <ul className={styles.list}>
      {incidents.map((incident) => {
        const quiet =
          incident.state === "open" &&
          now - Date.parse(incident.updatedAt) >= INCIDENT_STALE_MS;
        return (
          <li
            key={incident.id}
            className={styles.item}
            data-state={incident.state}
          >
            <h3>{INCIDENT_TITLES[incident.kind]}</h3>
            <p className={styles.times}>
              <span>Started {utcTime(incident.startedAt)}</span>
              {incident.resolvedAt ? (
                <span>Fixed {utcTime(incident.resolvedAt)}</span>
              ) : quiet ? (
                <span>No update since {utcTime(incident.updatedAt)}</span>
              ) : (
                <span>Updated {utcTime(incident.updatedAt)}</span>
              )}
            </p>
            {incident.note && <p className={styles.note}>{incident.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}
