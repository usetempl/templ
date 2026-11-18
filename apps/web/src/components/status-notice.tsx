"use client";

import { useRelease } from "@/lib/release-context";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  INCIDENT_STAFF_LINES,
  freshOpenIncidents,
  readIncidents,
  type Incident,
} from "@/lib/status-client";
import { staffDataFlags } from "@/lib/staff-data-release";
import styles from "./status-notice.module.css";

const POLL_MS = 60_000;
const systemNow = () => Date.now();

/** One line above the inbox while Templ has an open notice: the newest one
 * updated in the last 6 hours. Reads again every minute while the page is
 * visible. A failed read shows nothing. */
export function StatusNotice({
  enabled: suppliedEnabled,
  load = readIncidents,
  now = systemNow,
}: {
  enabled?: boolean;
  load?: typeof readIncidents;
  now?: () => number;
}) {
  const RELEASE = useRelease();
  const enabled = suppliedEnabled ?? staffDataFlags(RELEASE).incidentNotices;

  const [incident, setIncident] = useState<Incident | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const read = () => {
      if (document.visibilityState === "hidden") return;
      void load(undefined, controller.signal).then(
        (list) => {
          if (!controller.signal.aborted)
            setIncident(freshOpenIncidents(list, now())[0] ?? null);
        },
        () => {
          if (!controller.signal.aborted) setIncident(null);
        },
      );
    };
    read();
    const timer = setInterval(read, POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
    };
  }, [enabled, load, now]);
  if (!enabled || !incident) return null;
  return (
    <p className={styles.notice} role="status">
      <span>{INCIDENT_STAFF_LINES[incident.kind]}</span>
      {incident.note && <span className={styles.note}>{incident.note}</span>}
      <Link href="/status">Status</Link>
    </p>
  );
}
