/** The runner's calls into its workspace's room, as the managed account.
 *
 * The room object trusts identity headers only from inside this Worker (a
 * public room URL never reaches it with them). The runner sets them the way
 * the Worker's edge sets them for a signed-in account, with a one-minute
 * session, and the room then applies every check it applies to any
 * registered AI agent: current team access, AI mode, handoff, the reply
 * checks and the message budget. The account has no session anywhere else
 * and cannot sign in. */
import type { ChatPrincipalId } from "@templ/chat/principal";
import type { Env } from "../common";
import {
  requireSafetyAccess,
  attachMessageHold,
  type SafetyEnv,
} from "../safety";
import { DIAGNOSIS_NETWORKS_HEADER } from "../support-diagnosis";
import {
  diagnosisNetworksHeader,
  type DiagnosisEnv,
} from "../tx-diagnosis/chains";
import {
  MESSAGE_BUDGET_AVAILABLE_HEADER,
  withMessageBudget,
} from "../message-budget";

/** The longest pace wait the runner sits out before a write. */
const PACE_WAIT_SECONDS = 5;
export type RoomAnswer = { status: number; body: Record<string, unknown> };
export type RoomClient = {
  get(path: string): Promise<RoomAnswer>;
  post(path: string, body: Record<string, unknown>): Promise<RoomAnswer>;
};
export type RoomClientEnv = Pick<Env, "ROOMS"> &
  Pick<SafetyEnv, "SAFETY_ENABLED" | "SAFETY_STORE" | "SAFETY_ADMIN_TOKEN"> & {
    CONVERSATIONS_ENABLED?: string;
    SUPPORT_WORKFLOW_ENABLED?: string;
  };

/** `room` is `room:<uuid>`; `manager` the manager the room last reported
 * (the room reads the current one itself). */
export function roomClient(
  env: RoomClientEnv,
  input: { room: string; manager: string; principal: ChatPrincipalId },
): RoomClient {
  const id = input.room.slice("room:".length);
  const stub = env.ROOMS.get(env.ROOMS.idFromName(`native-room:${id}`));
  const headers = () => {
    const expires = String(Date.now() + 60_000);
    return new Headers({
      "Content-Type": "application/json",
      "X-Native-Room-Id": id,
      "X-Verified-Manager": input.manager,
      "X-Verified-Principal": input.principal,
      "X-Service-Principals": JSON.stringify([input.principal]),
      "X-Session-Expires-At": expires,
      "X-Access-Checked-At": String(Date.now()),
      "X-Access-Expires-At": expires,
      // The edge's runtime gates, read from the same vars.
      "X-Conversations": String(env.CONVERSATIONS_ENABLED === "true"),
      "X-Support-Workflow": String(env.SUPPORT_WORKFLOW_ENABLED === "true"),
      [DIAGNOSIS_NETWORKS_HEADER]: diagnosisNetworksHeader(env as DiagnosisEnv),
    });
  };
  const answer = async (response: Response): Promise<RoomAnswer> => {
    let body: Record<string, unknown> = {};
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return { status: response.status, body };
  };
  return {
    async get(path) {
      await requireSafetyAccess(env as SafetyEnv, input.room, input.principal, [
        input.principal,
      ]);
      return answer(
        await stub.fetch(
          new Request(`https://internal${path}`, {
            method: "GET",
            headers: headers(),
          }),
        ),
      );
    },
    async post(path, body) {
      const once = async () => {
        await requireSafetyAccess(
          env as SafetyEnv,
          input.room,
          input.principal,
          [input.principal],
        );
        const sent = headers();
        await attachMessageHold(
          env as SafetyEnv,
          sent,
          input.room,
          "POST",
          path,
        );
        return withMessageBudget(
          env as unknown as Env,
          {
            scope: id,
            path,
            method: "POST",
            body,
            principal: input.principal,
            aliases: [input.principal],
          },
          (available) => {
            if (available !== undefined)
              sent.set(MESSAGE_BUDGET_AVAILABLE_HEADER, String(available));
            return stub.fetch(
              new Request(`https://internal${path}`, {
                method: "POST",
                headers: sent,
                body: JSON.stringify(body),
              }),
            );
          },
        );
      };
      let response = await once();
      // The account's message pace: a write right after another waits the
      // few seconds the room names, once.
      const wait = Number(response.headers.get("Retry-After"));
      if (response.status === 429 && wait > 0 && wait <= PACE_WAIT_SECONDS) {
        await response.body?.cancel();
        await new Promise((done) => setTimeout(done, wait * 1_000 + 50));
        response = await once();
      }
      return answer(response);
    },
  };
}
