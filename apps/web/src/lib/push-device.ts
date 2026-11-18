/** The service worker scope of a workspace's phone alerts. */
const PUSH_SCOPE =
  /^\/rooms\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/?$/;

/** Stops phone alerts on this device for every workspace: unsubscribes
 * each workspace's push address and removes its service worker. Runs at
 * sign-out, so a shared or handed-back device stops getting alerts; the
 * service drops the address at its next push. Never throws. */
export async function dropDevicePushAlerts(
  container: ServiceWorkerContainer | undefined = typeof navigator ===
  "undefined"
    ? undefined
    : navigator.serviceWorker,
) {
  try {
    const registrations = (await container?.getRegistrations()) ?? [];
    await Promise.all(
      registrations
        .filter((registration) =>
          PUSH_SCOPE.test(new URL(registration.scope).pathname),
        )
        .map(async (registration) => {
          await (await registration.pushManager.getSubscription())
            ?.unsubscribe()
            .catch(() => false);
          await registration.unregister().catch(() => false);
        }),
    );
  } catch {
    // No service workers here: nothing to stop.
  }
}
