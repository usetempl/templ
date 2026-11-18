/** Sends the billing alerts product-alerts.ts queued: an email to each
 * billing manager, and a `capacity` event with the code only to the team
 * channels that asked for it. Runs in the room alarm. */
import { customerBillingManagedByTempl } from "./customer-debt-access";
import { alertsEnabled, emitAlert, type AlertEnv } from "./alert-outbox";
import { billingAlertEmail } from "./product-alert-email";
import { queueFinanceEmail } from "./product-finance-email";
import { PENDING_PREFIX, type BalanceAlertFacts } from "./product-alerts";
import { roomPermissionHolders } from "./support-alert-emit";
import { queueStaffNotification } from "./support-notifications";

type Storage = Pick<
  DurableObjectTransaction,
  "get" | "put" | "delete" | "list" | "getAlarm" | "setAlarm"
>;

/** Sends queued billing alerts: an email to each billing manager and to
 * the proven finance address, and a `capacity` event to team channels.
 * Returns when to run again, or null. */
export async function deliverBalanceAlerts(
  storage: Storage,
  env: AlertEnv,
  now: number,
): Promise<number | null> {
  const rows = await storage.list<BalanceAlertFacts>({
    prefix: PENDING_PREFIX,
    limit: 20,
  });
  if (!rows.size) return null;
  const native = await storage.get<{ room?: { id?: string } }>("native-room");
  const batchFull = rows.size === 20;
  if (customerBillingManagedByTempl(native?.room?.id ?? "")) {
    for (const [key, facts] of rows) {
      if (facts.alert === "suspended") continue;
      await storage.delete(key);
      rows.delete(key);
    }
    if (!rows.size) return batchFull ? now + 1_000 : null;
  }
  const room = native?.room?.id ? `room:${native.room.id}` : null;
  const holders = await roomPermissionHolders(storage as never, "manageBilling", env, now);
  const recipients = [
    ...new Set([...(holders.manager ? [holders.manager] : []), ...holders.handlers]),
  ];
  const appOrigin = env.APP_ORIGIN ?? "https://templ.vip";
  let offset = 0;
  for (const [key, facts] of rows) {
    await storage.delete(key);
    offset++;
    if (native?.room?.id)
      await queueFinanceEmail(storage, now, {
        id: key.slice(PENDING_PREFIX.length),
        ...billingAlertEmail(facts, `${appOrigin}/inbox/${native.room.id}?team=1`),
      });
    if (alertsEnabled(env))
      await emitAlert(
        storage,
        env,
        { type: "capacity", at: now, capacity: { alert: facts.alert } },
        now,
      );
    if (room)
      for (const recipient of recipients)
        await queueStaffNotification(storage, {
          // One email per alert: each takes its own one-millisecond bucket.
          now: now + offset,
          room,
          appOrigin,
          recipient,
          kind: "workspace",
          conversation: null,
          bucketMs: 1,
          balance: facts,
        }, env);
  }
  return batchFull ? now + 1_000 : null;
}
