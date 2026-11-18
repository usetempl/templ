import { HttpError } from "./common";
import { cardBillingEnabled } from "./stripe-billing";
import { wakeRoomAt } from "./room-alarm";
import {
  STRIPE_OUTBOX_PREFIX,
  STRIPE_OWNER_PATH,
  STRIPE_ROOM_KEY,
  type StripeRoomState,
  type StripeStoreEnv,
  type StripeUsageOutbox,
} from "./stripe-store";

export const STRIPE_DELETION_PREFIX = "native-stripe-cleanup-v1:";
export type DeletedWorkspaceStripe = {
  owner: string;
  room: string;
  usage: StripeUsageOutbox[];
};
type Storage = Pick<DurableObjectStorage, "get" | "put" | "delete" | "list">;
type CleanupJob = {
  owner: string;
  room: string;
  usage?: StripeUsageOutbox;
};

/** Keep accepted usage outside the workspace before deleting its storage. */
export async function deletedWorkspaceStripe(
  storage: Pick<Storage, "get" | "list">,
  room: string,
): Promise<DeletedWorkspaceStripe | null> {
  const state = await storage.get<StripeRoomState>(STRIPE_ROOM_KEY);
  if (!state?.customerId) return null;
  return {
    owner: state.owner,
    room,
    usage: [
      ...(
        await storage.list<StripeUsageOutbox>({ prefix: STRIPE_OUTBOX_PREFIX })
      ).values(),
    ],
  };
}

/** The catalog transaction keeps cleanup jobs with the deletion record. */
export async function queueDeletedWorkspaceStripe(
  storage: Storage & Pick<DurableObjectStorage, "getAlarm" | "setAlarm">,
  id: string,
  cleanup: DeletedWorkspaceStripe,
  now: number,
) {
  const prefix = `${STRIPE_DELETION_PREFIX}${id}:`;
  for (const usage of cleanup.usage) {
    const order = usage.kind === "report" ? "0-report" : "1-credit";
    await storage.put(`${prefix}${order}:${usage.chargeId}`, {
      owner: cleanup.owner,
      room: cleanup.room,
      usage,
    } satisfies CleanupJob);
  }
  await storage.put(`${prefix}2-close`, {
    owner: cleanup.owner,
    room: cleanup.room,
  } satisfies CleanupJob);
  await wakeRoomAt(storage, now + 1_000);
}

/** Retry billing cleanup independently of the workspace deletion job. */
export async function deliverDeletedWorkspaceStripe(
  storage: Storage,
  env: StripeStoreEnv,
  now: number,
): Promise<number | null> {
  const rows = await storage.list<CleanupJob>({
    prefix: STRIPE_DELETION_PREFIX,
    limit: 25,
  });
  if (!rows.size) return null;
  if (!cardBillingEnabled(env) || !env.ROOMS) return now + 3_600_000;
  for (const [key, job] of rows) {
    const response = await env.ROOMS.get(
      env.ROOMS.idFromName(`stripe-billing-owner:${job.owner}`),
    ).fetch(
      new Request(`https://internal${STRIPE_OWNER_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          job.usage
            ? { op: "usage", owner: job.owner, usage: job.usage }
            : { op: "close-workspace", owner: job.owner, room: job.room },
        ),
      }),
    );
    await response.body?.cancel();
    if (!response.ok) throw new HttpError(503, "Card cleanup is pending.");
    if (!job.usage) {
      const tombstoneKey = `native-deleted:${job.room.slice(5)}`;
      const tombstone =
        await storage.get<Record<string, unknown>>(tombstoneKey);
      if (tombstone)
        await storage.put(tombstoneKey, {
          ...tombstone,
          stripeCleanup: "done",
        });
    }
    await storage.delete(key);
  }
  return rows.size === 25 ? now + 1_000 : null;
}
