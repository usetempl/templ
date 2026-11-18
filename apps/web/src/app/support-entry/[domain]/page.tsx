import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { readHostedSupport } from "@/lib/hosted-support";
import { TemplMark } from "@/components/brand/templ-mark";
import styles from "../../example/vault/vault.module.css";

export const metadata: Metadata = {
  title: "Support",
  robots: { index: false, follow: false },
};
export default async function SupportEntryPage({
  params,
}: {
  params: Promise<{ domain: string }>;
}) {
  const { domain } = await params;
  if (!/^[a-z0-9.-]+$/.test(domain)) notFound();
  const support = await readHostedSupport(
    `/support-entry/${encodeURIComponent(domain)}`,
  );
  if (support === "unavailable")
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <TemplMark className={styles.stamp} decorative />
          <h1>Support is busy</h1>
          <p>
            Try again in a minute.{" "}
            <a href={`/support-entry/${domain}`}>Reload</a>
          </p>
        </header>
      </div>
    );
  if (!support) notFound();
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <TemplMark className={styles.stamp} decorative />
        <h1>Support for {support.name}</h1>
        <Link className="button" href={support.href}>
          Open support
        </Link>
      </header>
    </div>
  );
}
