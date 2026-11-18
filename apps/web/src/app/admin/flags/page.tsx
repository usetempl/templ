import { WorkspaceFlagsPanel } from "@/components/workspace-flags-panel";
export const metadata = {
  title: "Workspace flags",
  robots: { index: false, follow: false },
};
export default function FlagsPage() {
  return <WorkspaceFlagsPanel />;
}
