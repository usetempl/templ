/** The room's calls into its knowledge object for managed AI: job handoff,
 * the settings page's status and the golden set. The room has already
 * checked the caller's current access. */
import { HttpError, json } from "../common";
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
  "trial.practice",
] as const;
export type ManagedOp = (typeof MANAGED_OPS)[number];

/** A practice question's delivery receipt: a 200 that starts with one space
 * once the attempt is reserved and ends with the JSON answer, or with
 * `{ error, status }` when the answer fails after that. */
export const TRIAL_RECEIPT_TYPE = "application/vnd.templ.received+json";
/** `no-transform` keeps the first byte from waiting in a compressor. */
export const TRIAL_RECEIPT_HEADERS = {
  "Content-Type": TRIAL_RECEIPT_TYPE,
  "Cache-Control": "no-store, no-transform",
  "X-Content-Type-Options": "nosniff",
};

async function managedKnowledgeSend(
  env: KnowledgeEnv,
  room: string,
  op: ManagedOp,
  args: Record<string, unknown>,
): Promise<Response> {
  try {
    return await knowledgeStub(env, room).fetch(
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
}

async function managedKnowledgeResult<T>(response: Response): Promise<T> {
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

export async function managedKnowledgeCall<T = Record<string, unknown>>(
  env: KnowledgeEnv,
  room: string,
  op: ManagedOp,
  args: Record<string, unknown> = {},
): Promise<T> {
  return managedKnowledgeResult<T>(
    await managedKnowledgeSend(env, room, op, args),
  );
}

/** A practice question whose caller asked for a delivery receipt. The
 * object's receipt passes through as it arrives. A refusal before the
 * reservation, or an object that answers without a receipt, maps as it does
 * in `managedKnowledgeCall`. */
export async function managedKnowledgeReceipt(
  env: KnowledgeEnv,
  room: string,
  args: Record<string, unknown>,
): Promise<Response> {
  const response = await managedKnowledgeSend(env, room, "trial.practice", {
    ...args,
    receipt: true,
  });
  if (
    response.ok &&
    response.body &&
    response.headers.get("Content-Type") === TRIAL_RECEIPT_TYPE
  )
    return new Response(response.body, { headers: TRIAL_RECEIPT_HEADERS });
  return json(await managedKnowledgeResult(response));
}
