import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { supportPageWorkspace } from "@/lib/support-page-config";
import { SolanaExample } from "../solana-client";

export const metadata: Metadata = {
  title: "Solana support example",
  robots: { index: false, follow: false },
};

export default async function SolanaExamplePage({
  params,
}: {
  params: Promise<{ workspace: string }>;
}) {
  const workspace = supportPageWorkspace((await params).workspace);
  if (!workspace) notFound();
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return <SolanaExample workspace={workspace} nonce={nonce} />;
}
