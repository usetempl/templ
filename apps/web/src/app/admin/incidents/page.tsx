import { AdminIncidentsPanel } from "@/components/admin-incidents";
export const metadata = {
  title: "Incident notices",
  robots: { index: false, follow: false },
};
export default function IncidentsPage() {
  return <AdminIncidentsPanel />;
}
