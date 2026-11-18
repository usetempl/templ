import { HealthDashboardPanel } from "@/components/health-dashboard";
export const metadata = {
  title: "Support health",
  robots: { index: false, follow: false },
};
export default function HealthPage() {
  return <HealthDashboardPanel />;
}
