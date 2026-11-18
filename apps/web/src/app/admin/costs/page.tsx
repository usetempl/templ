import { CostDashboardPanel } from "@/components/cost-dashboard";
export const metadata = {
  title: "Operating costs",
  robots: { index: false, follow: false },
};
export default function CostsPage() {
  return <CostDashboardPanel />;
}
