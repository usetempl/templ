import { IconArrowRight } from "@tabler/icons-react";
import {
  PILOT_MEASURES,
  PILOT_RESULTS,
  type PilotResult,
  type PilotValue,
} from "@/lib/pilot-results";
import styles from "./landing-results.module.css";

const day = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
const number = (value: number) => value.toLocaleString("en-US");

function amount(value: PilotValue, kind: "minutes" | "count", of: string) {
  return kind === "count"
    ? `${number(value.value)} of ${number(value.denominator)} ${of}`
    : `${number(value.value)} min, ${number(value.denominator)} ${of}`;
}

/** Results from paid pilots. Renders nothing until the list holds a record
 * the release gate accepted: no heading, placeholder or link. */
export function LandingResults({
  results = PILOT_RESULTS,
}: {
  results?: PilotResult[];
}) {
  if (results.length === 0) return null;
  return (
    <section
      id="results"
      className={styles.results}
      aria-labelledby="results-title"
    >
      <h2 id="results-title" className={styles.title} data-reveal>
        Results from <span className={styles.accent}>paid pilots.</span>
      </h2>
      <div className={styles.grid} data-reveal>
        {results.map((result) => (
          <article
            key={result.id}
            className={styles.card}
            aria-labelledby={`pilot-${result.id}`}
          >
            <h3 id={`pilot-${result.id}`}>{result.team ?? "A DeFi team"}</h3>
            <ul className={styles.facts}>
              <li>
                {day(result.window.from)} to {day(result.window.to)}
              </li>
              <li>
                {result.design === "randomized"
                  ? "Cases split at random"
                  : "Compared with the team’s usual process"}
              </li>
              <li>
                {number(result.cases.baseline)} cases without Templ,{" "}
                {number(result.cases.pilot)} with Templ
              </li>
              {result.smallSample && <li>Small sample</li>}
            </ul>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Without Templ</th>
                  <th scope="col">With Templ</th>
                </tr>
              </thead>
              <tbody>
                {result.measures.map((measure) => {
                  const { label, kind, of } = PILOT_MEASURES[measure.id];
                  return (
                    <tr key={measure.id}>
                      <th scope="row">{label}</th>
                      <td>{amount(measure.baseline, kind, of)}</td>
                      <td>{amount(measure.pilot, kind, of)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <a href={result.method} className={styles.method}>
              How we measured <IconArrowRight aria-hidden="true" />
            </a>
          </article>
        ))}
      </div>
    </section>
  );
}
