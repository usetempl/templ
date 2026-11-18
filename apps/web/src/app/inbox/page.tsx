import type { Metadata } from "next";
import { SupportWorkspaceList } from "@/components/support-workspace-list";
import { INBOX_MANIFEST_PATH } from "@/lib/inbox-manifest";
export const metadata: Metadata = {
  title: "Workspaces",
  manifest: INBOX_MANIFEST_PATH,
};
export default function InboxPage() {
  return <SupportWorkspaceList />;
}
