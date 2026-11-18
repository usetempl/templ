import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import {
  readServingReleaseIdentity,
  type ServingReleaseIdentity,
} from "@templ/chat/support-install-fixture";
import { getRelease } from "@/lib/config";
import { supportPageWorkspace } from "@/lib/support-page-config";
import { APP_ENVIRONMENT } from "@/lib/site-environment";
import { ExampleVault } from "./vault-client";
export const metadata: Metadata = {
  title: "Example Vault",
  robots: { index: false, follow: false },
};
/** Published once the operator provisions the Example Vault workspace and
 * records its id in the release manifest. */
export default async function ExampleVaultPage() {
  const RELEASE = await getRelease();
  const workspace = supportPageWorkspace(RELEASE.exampleVault?.workspaceId);
  if (!workspace) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  let pageIdentity: ServingReleaseIdentity | undefined;
  if (APP_ENVIRONMENT === "production") {
    try {
      const { env } = await getCloudflareContext({ async: true });
      const bindings = env as unknown as {
        RELEASE_IDENTITY?: string;
        CF_VERSION_METADATA?: { id?: string };
      };
      pageIdentity = readServingReleaseIdentity(
        {
          ...JSON.parse(bindings.RELEASE_IDENTITY ?? "null"),
          service: "web",
          versionId: bindings.CF_VERSION_METADATA?.id,
        },
        "web",
      );
    } catch {
      pageIdentity = undefined;
    }
  }
  return (
    <ExampleVault
      workspace={workspace}
      nonce={nonce}
      pageIdentity={pageIdentity}
    />
  );
}
