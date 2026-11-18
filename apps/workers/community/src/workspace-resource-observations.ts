import type { WorkspaceResourceEvent } from "@templ/chat/workspace-costs";
import { recordWorkspaceResources } from "./workspace-cost-recording";
import type { NativeRoomRecord } from "./native-rooms";
import type { RpcBudget } from "./rpc-budget";

type ResourceEnv = { COST_METRICS?: DurableObjectNamespace };
export type ResourceObservation = Omit<WorkspaceResourceEvent, "schemaVersion" | "eventId" | "at">;
type Schedule = (work: () => Promise<unknown>) => void;
const WORKSPACE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let lastGapAt = 0;
function recordingGap() {
  const now = Date.now();
  if (now - lastGapAt < 60_000) return;
  lastGapAt = now;
  console.warn("TEMPL_RESOURCE_COST_RECORDING_GAP");
}

/** Internal observations only. The caller supplies a persisted server scope. */
export function queueWorkspaceResources(
  env: object,
  workspace: string,
  observations: ResourceObservation[],
  schedule: Schedule,
) {
  try {
    const config = env as ResourceEnv;
    if (!config?.COST_METRICS || !WORKSPACE.test(workspace)) return;
    if (observations.length > 16) recordingGap();
    const at = new Date().toISOString();
    const events = observations.slice(0, 16).map(observation => ({
      ...observation, schemaVersion: 1 as const, eventId: crypto.randomUUID(), at,
    }));
    if (!events.length) return;
    schedule(async () => {
      try {
        const ack = await recordWorkspaceResources(config, workspace, events);
        if (ack.unavailable || ack.rejected) recordingGap();
      } catch { recordingGap(); }
    });
  } catch { recordingGap(); }
}

/** The Room's own stored record supplies attribution, never the request path. */
export function queueRoomResources(
  state: DurableObjectState,
  env: object,
  observations: ResourceObservation[],
) {
  try {
    if (!(env as ResourceEnv | undefined)?.COST_METRICS || typeof state.waitUntil !== "function") return;
    state.waitUntil((async () => {
      const native = await state.storage.get<NativeRoomRecord>("native-room");
      if (!native || !WORKSPACE.test(native.room.id)) return;
      const instanceId = state.id.toString();
      queueWorkspaceResources(env, native.room.id,
        observations.map(observation => ({ ...observation, instanceId })),
        work => state.waitUntil(work()));
    })().catch(recordingGap));
  } catch { recordingGap(); }
}

/** Only uploaded text bytes are measured; this is not total physical SQL size. */
export function queueKnowledgeResources(
  state: DurableObjectState,
  env: object,
  input: { requests: number; readOps: number; writeOps: number },
) {
  try {
    if (!(env as ResourceEnv | undefined)?.COST_METRICS || typeof state.waitUntil !== "function") return;
    state.waitUntil(Promise.resolve().then(() => {
      // Use the raw SQL handle so accounting reads do not count themselves.
      const room = state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", "room").toArray()[0]?.value;
      if (typeof room !== "string" || !room.startsWith("room:") || !WORKSPACE.test(room.slice(5))) return;
      const bytes = state.storage.sql.exec<{ bytes: number }>("SELECT COALESCE(SUM(bytes), 0) AS bytes FROM kb_upload_bytes").toArray()[0]?.bytes;
      const observations: ResourceObservation[] = [];
      if (input.requests) observations.push({ kind: "requests", provider: "cloudflare", metric: "requests", quantity: String(input.requests), unit: "request" });
      if (input.readOps) observations.push({ kind: "storage", provider: "cloudflare", metric: "storage-read-ops", quantity: String(input.readOps), unit: "operation" });
      if (input.writeOps) observations.push({ kind: "storage", provider: "cloudflare", metric: "storage-write-ops", quantity: String(input.writeOps), unit: "operation" });
      if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0) observations.push({ kind: "storage", provider: "cloudflare", metric: "storage-retained-bytes", quantity: String(bytes), unit: "byte" });
      queueWorkspaceResources(env, room.slice(5), observations.map(observation => ({ ...observation, instanceId: state.id.toString() })), work => state.waitUntil(work()));
    }).catch(recordingGap));
  } catch { recordingGap(); }
}

/** Wrap the actual transport only; local admission refusals never reach here. */
export async function observedRpcFetch(
  budget: RpcBudget,
  url: string,
  init: RequestInit,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
) {
  let observe: ((outcome: "accepted" | "failed" | "unknown") => void) | undefined;
  try {
    const body = JSON.parse(String(init.body)) as { method: string } | { method: string }[];
    const methods = (Array.isArray(body) ? body : [body]).map(call => call.method);
    observe = budget.providerAttemptObserver(url, methods);
  } catch { recordingGap(); }
  let outcome: "accepted" | "failed" | "unknown" = "unknown";
  try {
    const response = await fetcher(url, init);
    outcome = response.ok ? "accepted" : "failed";
    return response;
  } finally {
    try { observe?.(outcome); } catch { recordingGap(); }
  }
}
