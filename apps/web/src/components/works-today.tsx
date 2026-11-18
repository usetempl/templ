"use client";
import { useRelease } from "@/lib/release-context";
import { IconCheck, IconCircleDashed, IconPlus } from "@tabler/icons-react";
import {
  landingCapabilities,
  type LandingCapability,
} from "@/lib/landing-capabilities";
import styles from "./works-today.module.css";

export const LATER_TITLE = "What isn’t live yet";
export const NOTHING_LIVE_LINE = "Nothing has passed every release check yet.";

/** What works today, computed from release flags and support constants, at
 * the top of the availability page. No dates, labels or links: a row moves
 * to "Live now" when its evidence does. The live rows sit in one strip; the rest wait
 * in a closed list under it that stays one click away. */
export function WorksToday({
  rows: suppliedRows,
}: {
  rows?: LandingCapability[];
}) {
  const RELEASE = useRelease();
  const rows = suppliedRows ?? landingCapabilities(RELEASE);

  const now = rows.filter((row) => row.live);
  const later = rows.filter((row) => !row.live);
  return (
    <section id="today" className={styles.today} aria-labelledby="today-title">
      <div className={styles.band} data-reveal>
        <div className={styles.now}>
          <h2 id="today-title" className={styles.title}>
            Live now
          </h2>
          {now.length > 0 ? (
            <ul aria-labelledby="today-title" data-live="true">
              {now.map((row) => (
                <li key={row.id} data-capability={row.id}>
                  <IconCheck aria-hidden="true" />
                  {row.label}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>{NOTHING_LIVE_LINE}</p>
          )}
        </div>
        {later.length > 0 && (
          <details className={styles.later} data-live="false">
            <summary>
              <span>{LATER_TITLE}</span>
              <IconPlus aria-hidden="true" />
            </summary>
            <ul>
              {later.map((row) => (
                <li key={row.id} data-capability={row.id}>
                  <IconCircleDashed aria-hidden="true" />
                  {row.label}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
