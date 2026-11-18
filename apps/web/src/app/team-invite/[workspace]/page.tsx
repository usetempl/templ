import type { Metadata } from "next";
import { TeamInviteApp } from "./team-invite-app";

export const metadata: Metadata = {
  title: "Join a support team",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default async function TeamInvitePage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const { workspace } = await params;
  return <TeamInviteApp key={workspace} workspace={workspace} />;
}
