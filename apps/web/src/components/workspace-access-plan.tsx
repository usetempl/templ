import { Badge, Card } from "./ui/ui";

export function WorkspaceAccessPlan({ active = true }: { active?: boolean }) {
  return (
    <Card
      title="Workspace plan"
      actions={
        <Badge tone={active ? "brand" : "neutral"}>
          {active ? "Ongoing access" : "Unavailable"}
        </Badge>
      }
    >
      <p>
        {active
          ? "Support stays active."
          : "Contact Templ about workspace access."}
      </p>
    </Card>
  );
}
