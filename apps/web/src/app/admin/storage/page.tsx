import { StorageInventoryPanel } from "@/components/storage-inventory";
export const metadata = {
  title: "Stored group files",
  robots: { index: false, follow: false },
};
export default function StoragePage() {
  return <StorageInventoryPanel />;
}
