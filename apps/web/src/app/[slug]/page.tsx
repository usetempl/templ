import type { Metadata, ResolvingMetadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import { namedHostedWorkspace } from "@/lib/hosted-support";
import HostedSupportPage from "../help/[workspace]/page";
import { NativeSlugPage } from "@/components/native-slug-page";
import { copy as t } from "@/lib/copy";
import { isNativeRoomSlug } from "@/lib/native-room";
import { cryptoDeskMetadata, visitorLink } from "./crypto-desk-metadata";

type SlugPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// React cache shares one name lookup between the metadata and the page in each render.
const hostedWorkspace = cache(namedHostedWorkspace);

export async function generateMetadata(
  { params, searchParams }: SlugPageProps,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  const { slug } = await params;
  const desk = await cryptoDeskMetadata(slug, await searchParams, hostedWorkspace, parent);
  return desk ?? { title: t("shell.chat.title") };
}

export default async function SlugPage({ params, searchParams }: SlugPageProps) {
  const { slug } = await params;
  if (!isNativeRoomSlug(slug.toLowerCase())) notFound();
  if (visitorLink(await searchParams)) {
    const workspace = await hostedWorkspace(slug.toLowerCase());
    if (workspace) return <HostedSupportPage params={Promise.resolve({ workspace })} />;
  }
  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <NativeSlugPage slug={slug} />
    </div>
  );
}
