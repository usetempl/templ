import { AdminDeletionsPanel } from "@/components/admin-deletions";
export const metadata = {
  title: "Workspace deletions",
  robots: { index: false, follow: false },
};
export default function DeletionsPage() {
  return <AdminDeletionsPanel />;
}
