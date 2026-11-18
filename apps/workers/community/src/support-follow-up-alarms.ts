import { featureOn, type WorkspaceFlagEnv } from "./workspace-flags";
/** The follow-up and watch room alarm consumers, registered in room-alarm.ts
 * and channels.ts:
 * - `support-follow-ups`: reminders, overdue marks, escalations, promised
 *   updates and mention expiry (support-follow-ups.ts);
 * - `support-watches`: chain-state and time watches, then queued position
 *   reads (support-watches.ts, support-positions.ts). Chain reads run
 *   outside any storage transaction on this workspace's RPC budget.
 * With SUPPORT_FOLLOW_UPS_ENABLED off, nothing is sent and nothing read. */
import type { ChatEvent } from "@templ/chat/events";
import { siteOrigins, type Env } from "./common";
import { PRODUCT_STATE_KEY, readProductSupport } from "./product-entitlements";
import type { RoomAlarmConsumer } from "./room-alarm";
import { supportFollowUpAlarm } from "./support-follow-ups";
import { currentGroupMembers } from "./support-routing";
import { runPositionJobs } from "./support-positions";
import { supportWatchAlarm } from "./support-watches";

type Storage = DurableObjectTransaction;
async function covered(storage: Storage, now: number): Promise<boolean> {
  if (!(await storage.get(PRODUCT_STATE_KEY))) return false;
  return (await readProductSupport(storage, now)).enabled;
}
function appOrigin(env: object): string | null {
  try {
    return siteOrigins(env as Env).appOrigin;
  } catch {
    return null;
  }
}
const enabled = (env: object) =>
  featureOn(env as WorkspaceFlagEnv, undefined, "followUps");

/** `deliver` hands room events a committed run logged (a member line that
 * changed) to open sessions. */
export function followUpAlarmConsumers(
  deliver: (
    state: DurableObjectState,
    env: object,
    events: ChatEvent[],
  ) => void = () => {},
): RoomAlarmConsumer[] {
  return [
    {
      id: "support-follow-ups",
      run: ({ state, env }, now) =>
        enabled(env)
          ? supportFollowUpAlarm(state, env as never, now, {
              covered,
              appOrigin: appOrigin(env),
              groupMembers: (storage, group) => currentGroupMembers(storage, group, env as Env, now),
              afterCommit: (events) => deliver(state, env, events),
            })
          : Promise.resolve(null),
    },
    {
      id: "support-watches",
      run: async ({ state, env }, now) => {
        // Position reads ride the transaction check's switch (a read is
        // queued only for a network that is on); watches need follow-ups.
        const watches = enabled(env)
          ? await supportWatchAlarm({ state, env: env as never }, now, {
              covered,
              appOrigin: appOrigin(env),
              afterCommit: (events) => deliver(state, env, events),
            })
          : null;
        const positions = await runPositionJobs(
          { state, env: env as never },
          now,
        );
        const due = [watches, positions].filter(
          (value): value is number => value !== null,
        );
        return due.length ? Math.min(...due) : null;
      },
    },
  ];
}
