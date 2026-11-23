import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { namedHostedWorkspace } from "@/lib/hosted-support";
import HostedSupportPage from "../help/[workspace]/page";
import { NativeSlugPage } from "@/components/native-slug-page";
import { copy as t } from "@/lib/copy";
import { isNativeRoomSlug } from "@/lib/native-room";

export async function generateMetadata(): Promise<Metadata> {
  return { title: t("shell.chat.title") };
}

export default async function SlugPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  if (!isNativeRoomSlug(slug.toLowerCase())) notFound();
  const { tab, support, invite } = await searchParams;
  if (!tab && !support && !invite) {
    const workspace = await namedHostedWorkspace(slug.toLowerCase());
    if (workspace) return <HostedSupportPage params={Promise.resolve({ workspace })} />;
  }
  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <NativeSlugPage slug={slug} />
    </div>
  );
}
