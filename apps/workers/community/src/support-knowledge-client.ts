/** The room's only way into its SupportKnowledge object. The caller has
 * already checked the viewer's current access; this passes the actor's
 * role for `updated_by` fields and maps the object's answers to the room's
 * errors: a 5xx becomes 503 "Support knowledge is unavailable", and a
 * member path never calls it. */
import { HttpError } from "./common";
import type { KnowledgeActor } from "./support-knowledge";
import type { QualityViewer } from "./support-quality";

export type KnowledgeEnv = { SUPPORT_KNOWLEDGE?: DurableObjectNamespace };
export const KNOWLEDGE_UNAVAILABLE =
  "Support knowledge is unavailable. Try again in a minute.";
const UPGRADING = "Support knowledge is being upgraded. Try again later.";

export function knowledgeActor(viewer: QualityViewer): KnowledgeActor {
  return {
    principal: viewer.principal,
    ...(viewer.admin && !viewer.manager && !viewer.bot ? { workspaceAdmin: true as const } : {}),
    role: viewer.bot
      ? "bot"
      : viewer.manager
        ? "manager"
        : viewer.lead
          ? "lead"
          : "staff",
  };
}
/** The object name for a room (`room:<workspace id>`): `knowledge:<room>`.
 * Workspace deletion addresses the same object through this name. */
export const knowledgeObjectName = (room: string) => `knowledge:${room}`;
/** The object for a workspace. */
export function knowledgeStub(env: KnowledgeEnv, room: string) {
  const namespace = env.SUPPORT_KNOWLEDGE;
  if (!namespace)
    throw new HttpError(503, KNOWLEDGE_UNAVAILABLE, undefined, "knowledge-unavailable");
  return namespace.get(namespace.idFromName(knowledgeObjectName(room)));
}
export async function knowledgeCall<T = Record<string, unknown>>(
  env: KnowledgeEnv,
  room: string,
  op: string,
  actor: KnowledgeActor,
  args: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await knowledgeStub(env, room).fetch("https://knowledge.internal/op", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, op, actor, args }),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, KNOWLEDGE_UNAVAILABLE, undefined, "knowledge-unavailable");
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (response.ok) return data as T;
  const reason = typeof data.reason === "string" ? data.reason : undefined;
  if (response.status >= 500 && response.status !== 502) {
    const upgrading =
      reason === "knowledge-schema-newer" || reason === "knowledge-migration-failed";
    throw new HttpError(
      503,
      upgrading ? UPGRADING : KNOWLEDGE_UNAVAILABLE,
      undefined,
      upgrading ? reason : "knowledge-unavailable",
    );
  }
  const error = new HttpError(
    response.status,
    typeof data.error === "string" ? data.error : KNOWLEDGE_UNAVAILABLE,
    typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : undefined,
    reason,
  );
  (error as HttpError & { details?: unknown }).details = data;
  throw error;
}

// The operator corpus route's one read and the room's check that knowledge
// objects exist.
/** Whether this worker has knowledge objects. */
export const knowledgeBound = (env: KnowledgeEnv) => Boolean(env.SUPPORT_KNOWLEDGE);
/** The operator corpus route's only call: `/corpus/read` on a workspace's
 * object answers de-identified rows without their refs and nothing else. */
export async function knowledgeCorpusRead<T>(
  env: KnowledgeEnv,
  room: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await knowledgeStub(env, room).fetch(
    "https://knowledge.internal/corpus/read",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room, ...body }),
    },
  );
  if (!response.ok)
    throw new HttpError(503, KNOWLEDGE_UNAVAILABLE, undefined, "knowledge-unavailable");
  return (await response.json()) as T;
}

