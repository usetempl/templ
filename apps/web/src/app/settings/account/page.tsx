import type { Metadata } from "next";
import { AccountMethodsPage } from "@/components/account-methods";
import { copy as t } from "@/lib/copy";
import { DataRequest } from "./data-request";

/** The member's wallets and alert email, signed in only. */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: t("shell.account.title"),
    robots: { index: false, follow: false },
  };
}
export default function AccountSettingsPage() {
  return (
    <>
      <AccountMethodsPage />
      <DataRequest />
    </>
  );
}
