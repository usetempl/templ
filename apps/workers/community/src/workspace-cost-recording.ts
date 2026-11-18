import type {
  CostIngestAck,
  CostProducer,
  WorkspaceCostEvent,
  WorkspaceResourceEvent,
} from "@templ/chat/workspace-costs";
import {
  COST_WORKSPACE,
  checkedCostEvent,
  checkedResourceEvent,
} from "./workspace-cost-store";

type CostEnv = { COST_METRICS?: DurableObjectNamespace };
const unavailable = (): CostIngestAck => ({
  accepted: 0,
  duplicates: 0,
  rejected: 0,
  unavailable: true,
});
/** Call only from trusted server scope, then await in background work or waitUntil. */
async function record(
  env: CostEnv,
  workspace: string,
  producer: CostProducer | "resource",
  events: (WorkspaceCostEvent | WorkspaceResourceEvent)[],
  scopeDigest?: string,
) {
  if (
    !env.COST_METRICS ||
    !COST_WORKSPACE.test(workspace) ||
    !events.length ||
    events.length > 16
  )
    return unavailable();
  try {
    for (const event of events)
      producer === "resource"
        ? checkedResourceEvent(event)
        : checkedCostEvent(event);
    const response = await env.COST_METRICS.get(
      env.COST_METRICS.idFromName(`workspace-costs-v1:${workspace}`),
    ).fetch(
      new Request(
        `https://internal/workspace-costs/${producer === "resource" ? "resource" : "ingest"}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            workspace,
            producer,
            events,
            ...(scopeDigest ? { scopeDigest } : {}),
          }),
          signal: AbortSignal.timeout(2000),
        },
      ),
    );
    if (!response.ok) {
      await response.body?.cancel();
      return unavailable();
    }
    const result = await response.json<CostIngestAck>();
    // Directory registration is best effort and never grants workspace authority.
    const directory = await env.COST_METRICS.get(
      env.COST_METRICS.idFromName("workspace-cost-directory-v1"),
    ).fetch(
      new Request("https://internal/workspace-costs/directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace }),
        signal: AbortSignal.timeout(2000),
      }),
    );
    await directory.body?.cancel();
    return result;
  } catch {
    return unavailable();
  }
}
export function recordWorkspaceCost(
  env: CostEnv,
  workspace: string,
  producer: CostProducer,
  event: WorkspaceCostEvent,
  scopeDigest?: string,
): Promise<CostIngestAck> {
  return record(env, workspace, producer, [event], scopeDigest);
}
export function recordWorkspaceCosts(
  env: CostEnv,
  workspace: string,
  producer: CostProducer,
  events: WorkspaceCostEvent[],
  scopeDigest?: string,
): Promise<CostIngestAck> {
  return record(env, workspace, producer, events, scopeDigest);
}
export function recordWorkspaceResources(
  env: CostEnv,
  workspace: string,
  events: WorkspaceResourceEvent[],
): Promise<CostIngestAck> {
  return record(env, workspace, "resource", events);
}
