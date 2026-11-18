import type { Metadata } from "next";
import { ConnectApp } from "./connect-app";

export const metadata: Metadata = {
  title: "Connect your app",
  robots: { index: false, follow: false },
};

export default async function ConnectPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <ConnectApp key={code} code={code} />;
}
