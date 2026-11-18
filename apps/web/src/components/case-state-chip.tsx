import type { SupportSummary } from "@templ/chat/support";
import { Badge } from "@/components/ui/ui";

export function caseStateLabel(
  summary: Pick<SupportSummary, "state" | "archivedAt">,
  member = false,
) {
  if (summary.archivedAt) return member ? "Closed" : "Archived";
  if (summary.state === "abandoned") return member ? "Closed" : "Abandoned";
  return {
    open: "Open",
    waiting: "Waiting on user",
    resolved: "Resolved",
    spam: "Spam",
  }[summary.state];
}

export function CaseStateChip({
  summary,
  member = false,
}: {
  summary: SupportSummary;
  member?: boolean;
}) {
  return <Badge>{caseStateLabel(summary, member)}</Badge>;
}
