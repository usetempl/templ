import type { ChatPrincipalId } from "@templ/chat/principal";
import type { NativeRoomRecord } from "./native-rooms";
import type { RoomHealth } from "./ops-health";
import { PRODUCT_STATE_KEY, readProductSupport } from "./product-entitlements";
import { supportSettings } from "./support-workflow";
import { isConversationId, memberIndexKey } from "./team-conversations";

/** Answer of the room's internal `POST /private/support/health`, which
 * `/health/support` and the staging canary read for Templ's own workspace.
 * Reads only: no write, audit entry or funnel mark. Fixed labels, plus the
 * canary's thread id, which never leaves the worker. */
type Storage = Pick<DurableObjectTransaction, "get">;
const CANARY = /^0x[0-9a-f]{40}$/;

/** `body.canary` is the canary's lowercase address; anything else is
 * ignored, so the answer then says nothing about a canary. */
export async function supportHealth(
  storage: Storage,
  body: unknown,
  now: number,
): Promise<RoomHealth> {
  const native = await storage.get<NativeRoomRecord>("native-room");
  if (!native)
    return {
      schemaVersion: 1,
      workspace: "missing",
      product: "setup",
      canAdmit: false,
      canaryListed: false,
      canaryThread: null,
    };
  let product: RoomHealth["product"] = "setup";
  let canAdmit = false;
  if (await storage.get(PRODUCT_STATE_KEY)) {
    try {
      const access = await readProductSupport(storage, now);
      product =
        access.mode === "paused" || access.mode === "suspended"
          ? access.mode
          : "active";
      canAdmit = access.canAdmit;
    } catch {
      product = "unreadable";
    }
  }
  const raw =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).canary
      : undefined;
  const canary =
    typeof raw === "string" && CANARY.test(raw)
      ? (raw as ChatPrincipalId)
      : null;
  let canaryListed = false;
  let canaryThread: RoomHealth["canaryThread"] = null;
  if (canary) {
    const settings = await supportSettings(storage);
    const member =
      Boolean(await storage.get(`room-member:${canary}`)) ||
      native.room?.manager === canary;
    canaryListed = member && settings.testAccounts.includes(canary);
    const thread = await storage.get<string>(memberIndexKey(canary));
    canaryThread = isConversationId(thread)
      ? (thread as RoomHealth["canaryThread"])
      : null;
  }
  return {
    schemaVersion: 1,
    workspace: "found",
    product,
    canAdmit,
    canaryListed,
    canaryThread,
  };
}
