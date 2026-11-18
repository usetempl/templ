/** The room's calls into its knowledge object for managed AI: job handoff,
 * the settings page's status and the golden set. The room has already
 * checked the caller's current access. */
import { HttpError } from "../common";
import {
  KNOWLEDGE_UNAVAILABLE,
  knowledgeStub,
  type KnowledgeEnv,
} from "../support-knowledge-client";

export const MANAGED_OPS = [
  "jobs.add",
  "status",
  "golden.get",
  "golden.run",
  "grounded.verify",
] as const;
export type ManagedOp = (typeof MANAGED_OPS)[number];

export async function managedKnowledgeCall<T = Record<string, unknown>>(
  env: KnowledgeEnv,
  room: string,
  op: ManagedOp,
  args: Record<string, unknown> = {},
): Promise<T> {
  let response: Response;
  try {
    response = await knowledgeStub(env, room).fetch(
      "https://knowledge.internal/managed/op",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room, op, args }),
      },
    );
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      KNOWLEDGE_UNAVAILABLE,
      undefined,
      "knowledge-unavailable",
    );
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (response.ok) return data as T;
  if (response.status >= 500)
    throw new HttpError(
      503,
      KNOWLEDGE_UNAVAILABLE,
      undefined,
      "knowledge-unavailable",
    );
  throw new HttpError(
    response.status,
    typeof data.error === "string" ? data.error : KNOWLEDGE_UNAVAILABLE,
    undefined,
    typeof data.reason === "string" ? data.reason : undefined,
  );
}
