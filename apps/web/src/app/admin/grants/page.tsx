import { GrantStatusPanel } from "@/components/grant-status";
export const metadata = {
  title: "Granted cases",
  robots: { index: false, follow: false },
};
export default function GrantsPage() {
  return <GrantStatusPanel />;
}
