import type { ReactNode } from "react";
import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import { OPERATOR, operatorName, suppliedOperatorLines } from "@/lib/operator";
import styles from "./policy-page.module.css";

export const POLICY_PAGES = [
  "terms",
  "privacy",
  "dpa",
  "safety",
  "trust",
] as const;
export type PolicyPageId = (typeof POLICY_PAGES)[number];
const POLICY_LABELS: Record<PolicyPageId, string> = {
  terms: "Terms",
  privacy: "Privacy",
  dpa: "DPA",
  safety: "Safety",
  trust: "Trust",
};
export const POLICY_UPDATED = "30 September 2026";

export function PolicyPage({
  title,
  description,
  active,
  updated = POLICY_UPDATED,
  children,
}: {
  title: string;
  description: string;
  active: PolicyPageId;
  updated?: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          <IconArrowLeft aria-hidden="true" /> Back to Templ
        </Link>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      <nav className={styles.navigation} aria-label="Templ policies">
        {POLICY_PAGES.map((item) => (
          <Link
            key={item}
            href={`/${item}`}
            aria-current={active === item ? "page" : undefined}
          >
            {POLICY_LABELS[item]}
          </Link>
        ))}
      </nav>
      <div className={styles.content}>{children}</div>
      <aside className={styles.draft} aria-label="Policy draft status">
        <strong>Policy draft</strong>
        <p>Counsel has not reviewed this text yet.</p>
        {/* Trust lists the operator's details in its own section. */}
        {active === "trust" ? (
          <p>Updated {updated}.</p>
        ) : (
          <OperatorStatus updated={updated} />
        )}
      </aside>
    </div>
  );
}

/** The operator line every policy page ends with, from lib/operator.ts. */
export function OperatorStatus({
  updated = POLICY_UPDATED,
}: { updated?: string } = {}) {
  const supplied = suppliedOperatorLines(OPERATOR);
  return (
    <>
      <p>
        Updated {updated}. Templ is run by {operatorName(OPERATOR)}.
      </p>
      {supplied.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </>
  );
}

export function PolicySection({
  title,
  id,
  children,
}: {
  title: string;
  /** An anchor other pages can link to, such as /trust#providers. */
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section} id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
