import type { StateLineValue } from "@/lib/inbox-turn";
import { Badge } from "./ui/ui";

export function StateLine({
  value: { state, detail },
  className,
}: {
  value: StateLineValue;
  className?: string;
}) {
  return (
    <span className={className} title={detail ? `${state} (${detail})` : state}>
      <Badge>{state}</Badge>
      {detail && <> {detail}</>}
    </span>
  );
}
