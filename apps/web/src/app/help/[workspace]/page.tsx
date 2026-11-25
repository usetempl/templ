import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { readHostedSupport } from "@/lib/hosted-support";
import { SUPPORT_WIDGET_LATEST } from "@/lib/support-widget-release";
import { supportPageWorkspace } from "@/lib/support-page-config";
import { TemplMark } from "@/components/brand/templ-mark";
import { HostedSupportChat } from "./help-client";
import { SupportChatThemeScope } from "./support-chat-frame";
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
      <main id="main-content" tabIndex={-1} className={styles.page}>
        <header className={styles.header}>
          <TemplMark className={styles.stamp} decorative />
          <h1>Support is busy</h1>
          <p className={styles.busy}>
            Try again in a minute. <a href={`/help/${workspace}`}>Reload</a>
          </p>
        </header>
      </main>
    );
  if (!support || support.workspace !== workspace) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const runtime = support.frameRequired ? SUPPORT_WIDGET_LATEST.chunks.framehost : SUPPORT_WIDGET_LATEST;
  return (
    <SupportChatThemeScope workspace={workspace} nonce={nonce}>
      {runtime && <link rel="modulepreload" href={runtime.path} nonce={nonce} crossOrigin="anonymous" />}
      <HostedSupportChat workspace={workspace} name={support.name}
        frameRequired={support.frameRequired} nonce={nonce} verifiedSites={support.verifiedSites} />
    </SupportChatThemeScope>
  );
}
