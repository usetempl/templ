import type { PriorityCaptureCapability } from "./priority-trial-capture";
import type { PriorityObservation } from "./priority-trial-observations";
import { requireRpcBudget } from "./rpc-budget";
import type { PriorityPositionDeps } from "./support-priority-positions";
export function priorityTrialObserver(
  env: object,
  capability: PriorityCaptureCapability,
  send: (observation: unknown) => Promise<boolean>,
): { deps: PriorityPositionDeps; stop: () => void } {
  const record = async (observation: unknown) => {
    try {
      if (!(await send(observation))) capability.failed = true;
    } catch {
      capability.failed = true;
    }
  };
  const stop = requireRpcBudget(env).observeRefusals(async (refusal) => {
    await record({
      kind: "room-refusal",
      at: refusal.at,
      status: refusal.status,
      request: {
        op: refusal.request.op,
        metric: refusal.request.metric,
        kind: refusal.request.kind,
        lane: refusal.request.lane,
        method: refusal.request.method,
      },
      response: refusal.response,
    });
  });
  return {
    stop,
    deps: {
      observeRpc: async (network, observation) => {
        if (observation.kind === "incomplete") {
          capability.failed = true;
          return;
        }
        if (observation.kind === "response") {
          await record({
            kind: "rpc-response",
            requestId: observation.requestId,
            at: observation.at,
            responses: observation.responses,
          });
          return;
        }
        const providerSha256 = [
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(observation.url),
            ),
          ),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        await record({
          kind: "rpc-dispatch",
          requestId: observation.requestId,
          network,
          providerSha256,
          at: observation.at,
          transport: observation.transport,
          batch: observation.batch,
        });
      },
      observePrice: async (observation) => {
        if (observation.kind === "incomplete") {
          capability.failed = true;
          return;
        }
        await record(
          observation satisfies
            | Extract<PriorityObservation, { kind: "price-quote" }>
            | {
                kind: "price-response";
                at: string;
                method: "GET";
                url: string;
                status: number;
                response: unknown;
              },
        );
      },
    },
  };
}
