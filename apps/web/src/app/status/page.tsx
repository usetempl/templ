import { notFound } from "next/navigation";
import { StatusPage } from "@/components/status-page";
import { getRelease } from "@/lib/config";
import { staffDataFlags } from "@/lib/staff-data-release";

export const metadata = {
  title: "Status",
  description:
    "Problems with Templ that we're working on, and ones fixed in the last 14 days.",
};

export default async function Status() {
  const RELEASE = await getRelease();
  if (!staffDataFlags(RELEASE).incidentNotices) notFound();
  return <StatusPage />;
}
