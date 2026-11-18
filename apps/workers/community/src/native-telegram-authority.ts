import { WorkerEntrypoint } from "cloudflare:workers";
import { nativeRoomStub } from "./native-rooms";
import type { Env } from "./common";
import { recordWorkspaceCost } from "./workspace-cost-recording";
import type { CostIngestAck, WorkspaceCostEvent } from "@templ/chat/workspace-costs";
import { appDraftBudget, appDraftConfiguration } from "./app-telegram-budget";
import type { AppDraftBudgetInput } from "@templ/chat/app-telegram-drafts";

/** Service binding only. No ticket, role or credential methods. */
export class NativeTelegramAuthority extends WorkerEntrypoint<Env & { COST_METRICS?: DurableObjectNamespace }> {
  async appAnswerFailed(input: { workspaceId: string; conversationId: string; jobId: string }) {
    if (!input || input.workspaceId !== "" || !/^tc-[0-9a-f]{32}$/.test(input.conversationId) || !/^[0-9a-f-]{36}$/.test(input.jobId)) return;
    await nativeRoomStub(this.env, input.workspaceId).fetch(new Request("https://internal/private/support/app-answer-failed", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    }));
  }
  async appAnswerAllowed(input: { workspaceId: string; conversationId: string; jobId: string }): Promise<boolean> {
    try {
      if (!input || input.workspaceId !== "" ||
        !/^tc-[0-9a-f]{32}$/.test(input.conversationId) || !/^[0-9a-f-]{36}$/.test(input.jobId)) return false;
      const response = await nativeRoomStub(this.env, input.workspaceId).fetch(new Request("https://internal/private/support/app-answer-authority", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      }));
      return response.ok && (await response.json<{ allowed?: unknown }>()).allowed === true;
    } catch { return false; }
  }
  appDraftConfiguration(workspace: string, internalTrial?: true) {
    return appDraftConfiguration(this.env, workspace, internalTrial);
  }
  appDraftBudget(input: AppDraftBudgetInput) {
    return appDraftBudget(this.env, input);
  }
  async appendCost(input: {
    grant: { workspaceId: string; approvalId: string; relayPrincipalId: string; relayNonce?: string };
    events: WorkspaceCostEvent[];
  }): Promise<CostIngestAck> {
    const rejected = { accepted: 0, duplicates: 0, rejected: input?.events?.length ?? 0, unavailable: false };
    if (!input || Object.keys(input).sort().join(",") !== "events,grant" || !Array.isArray(input.events) || input.events.length < 1 || input.events.length > 16) return rejected;
    const grant = input.grant;
    if (!grant || Object.keys(grant).some((key) => !["workspaceId", "approvalId", "relayPrincipalId", "relayNonce"].includes(key)) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(grant.workspaceId) ||
        !/^[a-f0-9]{32}$/.test(grant.approvalId) || !/^0x[a-f0-9]{40}$/.test(grant.relayPrincipalId) ||
        (grant.relayNonce !== undefined && (!/^[a-f0-9]{32}$/.test(grant.relayNonce) || /^0{32}$/.test(grant.relayNonce)))) return rejected;
    const binding = { workspaceId: grant.workspaceId, approvalId: grant.approvalId, relayPrincipalId: grant.relayPrincipalId };
    if (input.events.some((event) => event?.phase === "started") && !(await this.isApproved(binding))) return rejected;
    const bytes = new TextEncoder().encode(JSON.stringify({ ...binding, relayNonce: grant.relayNonce ?? null }));
    const scope = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const ack = { accepted: 0, duplicates: 0, rejected: 0, unavailable: false };
    for (const event of input.events) {
      const next = await recordWorkspaceCost(this.env, grant.workspaceId, "telegram-polish", event, scope);
      ack.accepted += next.accepted; ack.duplicates += next.duplicates; ack.rejected += next.rejected;
      ack.unavailable ||= next.unavailable;
    }
    return ack;
  }
  async isApproved(input: { workspaceId: string; approvalId: string; relayPrincipalId: string }): Promise<boolean> {
    try {
      if (!input || Object.keys(input).sort().join(",") !== "approvalId,relayPrincipalId,workspaceId" ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.workspaceId) ||
          !/^[a-f0-9]{32}$/.test(input.approvalId) || !/^0x[a-f0-9]{40}$/.test(input.relayPrincipalId)) return false;
      const response = await nativeRoomStub(this.env, input.workspaceId).fetch(new Request("https://internal/private/support/telegram-authority", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
      }));
      return response.ok && (await response.json<{ approved?: unknown }>()).approved === true;
    } catch { return false; }
  }
  async fetch(): Promise<Response> { return new Response("Not found.", { status: 404 }); }
}
