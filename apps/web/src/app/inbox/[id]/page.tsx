import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SupportWorkspacePage } from "@/components/workspace/support-workspace";
import { INBOX_MANIFEST_PATH } from "@/lib/inbox-manifest";
import { hostedSupportUrl } from "@/lib/support-page-config";
import { SITE } from "@/lib/site-environment";
import { isNativeRoomId } from "@/lib/native-room";

export async function generateMetadata(): Promise<Metadata> {
  return { title: "Inbox", manifest: INBOX_MANIFEST_PATH };
}
export default async function WorkspaceInboxPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!isNativeRoomId(id)) notFound();
  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <SupportWorkspacePage key={id} id={id} supportUrl={hostedSupportUrl(SITE.origin, id)} />
    </div>
  );
}
