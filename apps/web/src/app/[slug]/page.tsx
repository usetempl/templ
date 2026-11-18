import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NativeSlugPage } from "@/components/native-slug-page";
import { copy as t } from "@/lib/copy";
import { isNativeRoomSlug } from "@/lib/native-room";

export async function generateMetadata(): Promise<Metadata> {
  return { title: t("shell.chat.title") };
}

export default async function SlugPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!isNativeRoomSlug(slug.toLowerCase())) notFound();
  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      <NativeSlugPage slug={slug} />
    </div>
  );
}
