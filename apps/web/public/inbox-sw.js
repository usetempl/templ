// Templ's inbox service worker: text-free push alerts for staff.
//
// Registered per workspace (scope /rooms/<id>) when a person turns on phone
// alerts. A push from Templ carries no payload; if one ever did, it would be
// ignored: the line below is fixed here, so an alert can never show message
// text, a member or a request. Opening the alert opens that workspace's
// Needs you view, where sign-in and current access decide what shows.
// There is no fetch handler: nothing is cached and every page loads from
// the network.
const TITLE = "Templ";
const BODY = "A case needs you.";
const ROOM_SCOPE =
  /^\/rooms\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function target() {
  const scope = new URL(self.registration.scope);
  if (scope.origin !== self.location.origin || !ROOM_SCOPE.test(scope.pathname))
    return "/inbox";
  return `${scope.pathname.replace("/rooms/", "/inbox/")}?team=1&view=needs-you`;
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification(TITLE, {
      body: BODY,
      tag: `templ-inbox:${self.registration.scope}`,
      renotify: true,
      icon: "/app-icon-192.png",
      badge: "/app-icon-192.png",
      data: { url: target() },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(target(), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows)
        if (client.url === url && "focus" in client) return client.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
