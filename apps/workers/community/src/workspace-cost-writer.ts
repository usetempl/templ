import { hostedPrepaidPrincipal } from "./product-prepaid-ai";
import { nativeRecord } from "./native-rooms";
import { requireSafetyAccess } from "./safety";
import type { Env } from "./common";
import type {
  PrepaidAiReserve,
  PrepaidAiSettlement,
} from "./product-prepaid-ai";
import { WorkerEntrypoint } from "cloudflare:workers";
import type {
  CostIngestAck,
  WorkspaceCostEvent,
} from "@templ/chat/workspace-costs";
import { COST_WORKSPACE, validCostInstance } from "./workspace-cost-store";
import { recordWorkspaceCosts } from "./workspace-cost-recording";

type WriterScope = {
  producer: "hosted-ai";
  workspace: string;
  instance: string;
};

/** The generic entrypoint accepts only exact, fixed service-binding props. */
export class WorkspaceCostWriter extends WorkerEntrypoint<
  Env & {
    COST_METRICS?: DurableObjectNamespace;
  }
> {
  override async fetch() {
    return new Response("Not found.", { status: 404 });
  }
  protected get costScope(): WriterScope | null {
    const props = this.ctx.props as Record<string, unknown>;
    if (
      !props ||
      typeof props !== "object" ||
      Array.isArray(props) ||
      Object.keys(props).sort().join() !== "instance,producer,workspace" ||
      props.producer !== "hosted-ai" ||
      typeof props.workspace !== "string" ||
      !COST_WORKSPACE.test(props.workspace) ||
      !validCostInstance(props.instance)
    )
      return null;
    return {
      producer: "hosted-ai",
      workspace: props.workspace,
      instance: props.instance,
    };
  }
  /** The same fixed service capability can reserve only its own current agent's funds. */
  private async prepaid(
    action: "reserve" | "settle",
    input: PrepaidAiReserve | PrepaidAiSettlement,
  ) {
    const scope = this.costScope;
    const principal = scope && hostedPrepaidPrincipal(scope.workspace);
    if (!scope || !principal)
      throw new Error("Prepaid service scope is unavailable.");
    const room = `room:${scope.workspace}`;
    await requireSafetyAccess(this.env, room, principal, [principal]);
    const current = await nativeRecord(this.env, scope.workspace);
    const until = String(Date.now() + 60_000);
    const response = await current.room.fetch(
      new Request(`https://internal/private/prepaid-ai/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Native-Room-Id": scope.workspace,
          "X-Verified-Manager": current.record.room.manager,
          "X-Verified-Principal": principal,
          "X-Service-Principals": JSON.stringify([principal]),
          "X-Session-Expires-At": until,
          "X-Access-Expires-At": until,
          "X-Access-Checked-At": String(Date.now()),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    return { status: response.status, body: await response.json() };
  }
  prepaidReserve(input: PrepaidAiReserve) {
    return this.prepaid("reserve", input);
  }
  prepaidSettle(input: PrepaidAiSettlement) {
    return this.prepaid("settle", input);
  }
  async append(events: WorkspaceCostEvent[]): Promise<CostIngestAck> {
    const scope = this.costScope;
    if (!scope)
      return {
        accepted: 0,
        duplicates: 0,
        rejected: Array.isArray(events) ? events.length : 0,
        unavailable: true,
      };
    return recordWorkspaceCosts(
      this.env,
      scope.workspace,
      scope.producer,
      events,
    );
  }
  async health(input: {
    at: string;
    recordingGaps: number;
    pendingAttempts: number;
  }): Promise<{ unavailable: boolean }> {
    const scope = this.costScope;
    if (!scope || !this.env.COST_METRICS) return { unavailable: true };
    try {
      const response = await this.env.COST_METRICS.get(
        this.env.COST_METRICS.idFromName(
          `workspace-costs-v1:${scope.workspace}`,
        ),
      ).fetch(
        new Request("https://internal/workspace-costs/health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...input, instance: scope.instance }),
          signal: AbortSignal.timeout(2000),
        }),
      );
      await response.body?.cancel();
      return { unavailable: !response.ok };
    } catch {
      return { unavailable: true };
    }
  }
}

/** Named capabilities do not depend on properties retained by the platform. */
export class WorkspaceCostWriterOwn extends WorkspaceCostWriter {
  protected override get costScope(): WriterScope | null {
    return null;
  }
}
export class WorkspaceCostWriterFlex extends WorkspaceCostWriter {
  protected override get costScope(): WriterScope | null {
    return null;
  }
}
export class WorkspaceCostWriterColosseum extends WorkspaceCostWriter {
  protected override get costScope(): WriterScope | null {
    return null;
  }
}
