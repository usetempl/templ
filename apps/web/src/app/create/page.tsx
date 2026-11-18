import type { Metadata } from "next";
import { NativeChatCreate } from "@/components/native-chat-create";
import { copy as t } from "@/lib/copy";

export async function generateMetadata(): Promise<Metadata> {
  return { title: t("shell.create.title") };
}
export default function CreatePage() {
  return <NativeChatCreate />;
}
