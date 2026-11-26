import { WebsiteOnboarding } from "@/components/website-onboarding";
import type { Metadata } from "next";
import { NativeChatCreate } from "@/components/native-chat-create";
import { AppThemeSwitch } from "@/components/app-theme";
import { copy as t } from "@/lib/copy";
import styles from "./create.module.css";

export async function generateMetadata(): Promise<Metadata> {
  return { title: t("shell.create.title") };
}
export default async function CreatePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; manual?: string }>;
}) {
  const { next, manual } = await searchParams;
  return (
    <>
      <div className={styles.theme}><AppThemeSwitch /></div>
      {manual === "1" ? <NativeChatCreate showPlanAfterCreate={next === "plan"} /> : <WebsiteOnboarding nextPlan={next === "plan"} />}
    </>
  );
}
