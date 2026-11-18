import { AdminBillingLookup } from "@/components/admin-billing-lookup";
import { AdminBillingPanel } from "@/components/admin-billing";
export const metadata = {
  title: "Billing",
  robots: { index: false, follow: false },
};
export default function BillingAdminPage() {
  return (
    <>
      <AdminBillingLookup />
      <AdminBillingPanel />
    </>
  );
}
