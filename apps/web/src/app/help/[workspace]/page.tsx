import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readHostedSupport } from "@/lib/hosted-support";
import { supportPageWorkspace } from "@/lib/support-page-config";
import { TemplMark } from "@/components/brand/templ-mark";
import { HostedSupportChat } from "./help-client";
import styles from "./help.module.css";
export const metadata: Metadata = {
  title: "Support",
  robots: { index: false, follow: false },
};
export default async function HostedSupportPage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  if (!supportPageWorkspace(workspace)) notFound();
  const support = await readHostedSupport(`/widget/${workspace}/hosted`);
  if (support === "unavailable")
    return (
      <div className={styles.page}>
        <header className={styles.header}>
          <TemplMark className={styles.stamp} decorative />
          <h1>Support is busy</h1>
          <p className={styles.busy}>
            Try again in a minute. <a href={`/help/${workspace}`}>Reload</a>
          </p>
        </header>
      </div>
    );
  if (!support || support.workspace !== workspace) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <HostedSupportChat workspace={workspace} name={support.name}
    frameRequired={support.frameRequired} nonce={nonce} verifiedSites={support.verifiedSites} />;
}
