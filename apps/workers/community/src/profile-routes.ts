/** The protocol profile's room routes, under `/conversations/profile`.
 *
 * | Route | Owner, Admin | Lead, support member | AI agent | Everyone else |
 * | --- | --- | --- | --- | --- |
 * | GET profile, contracts, metrics; POST lookup | 200 | 200 | Member-safe only | 404 |
 * | Any other POST | 200 | 403 | 403 | 404 |
 *
 * Writes bump the profile's revision and audit field names or counts only.
 * Import apply, the registry address and "Apply this sync" also need the
 * Admin's valid session (privileged confirmation). */
import { HttpError, json } from "./common";
import { requireWorkspaceAdminHeaders } from "./privileged-auth";
import {
  knowledgeActor,
  knowledgeCall,
  type KnowledgeEnv,
} from "./support-knowledge-client";
import type { QualityViewer } from "./support-quality";
import type { ConversationContext } from "./team-conversations";

export const PROFILE_ROUTE =
  /^\/conversations\/profile(?:\/(contracts|lookup|imports|registry|abis|metrics|settings)(?:\/(imp-[0-9a-f]{16}|sync|apply))?)?$/;
const managerOnly = () =>
  new HttpError(
    403,
    "Only workspace admins can change the protocol profile.",
    undefined,
    "manager-only",
  );

export async function profileRoute(
  env: KnowledgeEnv,
  context: ConversationContext,
  viewer: QualityViewer,
  match: RegExpExecArray,
): Promise<Response> {
  const [, section, item] = match;
  const actor = knowledgeActor(viewer);
  const call = (op: string, args: Record<string, unknown> = {}) =>
    knowledgeCall(env, context.room, op, actor, args);
  const get = context.method === "GET";
  const body = context.body;
  const audit = (op: string, after: Record<string, unknown> = {}) =>
    context.pendingAudit.push({
      actor: viewer.principal,
      action: "support.settings",
      target: "profile",
      after: { op, ...after },
    });
  if (item && section !== "imports" && section !== "registry")
    throw new HttpError(404, "Support tools not found.");
  if (get) {
    if (!section) return json(await call("profile.get"));
    if (section === "contracts") {
      const q = context.query;
      return json(
        await call("profile.list", {
          network: q.get("network") ?? undefined,
          kind: q.get("kind") ?? undefined,
          status: q.get("status") ?? undefined,
          visibility: q.get("visibility") ?? undefined,
          product: q.get("product") ?? undefined,
          q: q.get("q") ?? undefined,
          after: q.get("after") ?? undefined,
        }),
      );
    }
    if (section === "metrics") return json(await call("profile.metrics.list"));
    throw new HttpError(404, "Support tools not found.");
  }
  if (section === "lookup") return json(await call("profile.lookup", { refs: body.refs }));
  if (!viewer.admin) throw managerOnly();
  if (!viewer.manager) requireWorkspaceAdminHeaders(context.headers, false, true, context.now);
  switch (section) {
    case "settings": {
      const result = await call("profile.settings.set", {
        expectedNetworks: body.expectedNetworks,
        officialUrls: body.officialUrls,
      });
      audit("settings", {
        fields: ["expectedNetworks", "officialUrls"].filter((k) => body[k] !== undefined),
      });
      return json(result);
    }
    case "contracts": {
      if (body.action === "delete") {
        const result = await call("profile.delete", { network: body.network, address: body.address });
        audit("delete");
        return json(result);
      }
      const result = await call("profile.upsert", { contract: body.contract });
      audit("change", {
        fields: Object.keys((body.contract as object | undefined) ?? {}).slice(0, 20),
      });
      return json(result, (result as { created?: boolean }).created ? 201 : 200);
    }
    case "imports": {
      if (!item) {
        const result = await call("profile.import.start");
        return json(result, 201);
      }
      if (body.action === "rows")
        return json(await call("profile.import.rows", { importId: item, rows: body.rows, metrics: body.metrics }));
      if (body.action === "preview")
        return json(await call("profile.import.preview", { importId: item, mode: body.mode }));
      if (body.action === "apply") {
        requireWorkspaceAdminHeaders(context.headers, viewer.manager, body.confirmed, context.now);
        const result = await call("profile.import.apply", { importId: item, mode: body.mode });
        audit("import", {
          applied: (result as { applied?: number }).applied ?? 0,
          removed: (result as { removed?: number }).removed ?? 0,
        });
        return json(result);
      }
      throw new HttpError(400, "Choose rows, preview or apply.", undefined, "profile-import");
    }
    case "registry": {
      if (item === "sync") {
        const result = await call("profile.registry.sync");
        audit("registry-sync", { result: (result as { result?: { result?: string } }).result?.result ?? null });
        return json(result);
      }
      requireWorkspaceAdminHeaders(context.headers, viewer.manager, body.confirmed, context.now);
      if (item === "apply") {
        const result = await call("profile.registry.apply");
        audit("registry-apply");
        return json(result);
      }
      if (item) throw new HttpError(404, "Support tools not found.");
      const result = await call("profile.registry.set", { url: body.url, schedule: body.schedule });
      audit("registry", { schedule: body.schedule === "manual" ? "manual" : "daily" });
      return json(result);
    }
    case "abis": {
      const result = await call("profile.abi.put", {
        network: body.network,
        address: body.address,
        ...(body.part !== undefined ? { part: body.part } : { abi: body.abi }),
      });
      if ((result as { abi?: string }).abi) audit("abi");
      return json(result);
    }
    case "metrics": {
      const result = await call("profile.metrics.write", { action: body.action, metric: body.metric });
      audit("metric");
      return json(result);
    }
    default:
      throw new HttpError(404, "Support tools not found.");
  }
}
