import { notFound } from "next/navigation";
import { BitcoinPreviewPanel } from "./preview-panel";

export const metadata = {
  title: "Bitcoin sign-in preview",
  robots: { index: false, follow: false },
};

export default async function BitcoinPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, workerVersion } = await searchParams;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  if (typeof workspaceId !== "string" || !uuid.test(workspaceId) ||
      typeof workerVersion !== "string" || !uuid.test(workerVersion)) notFound();
  return <BitcoinPreviewPanel workspaceId={workspaceId} workerVersion={workerVersion} />;
}
