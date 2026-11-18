import { FunnelDashboardPanel } from "@/components/funnel-dashboard";
export const metadata = {
  title: "Onboarding funnel",
  robots: { index: false, follow: false },
};
export default function FunnelPage() {
  return <FunnelDashboardPanel />;
}
