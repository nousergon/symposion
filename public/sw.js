// Minimal service worker whose sole job is receiving Web Push events while
// the app's own tab isn't open/focused to handle them - see server/webpush.mjs
// and app.js's subscribeWebPush(). Deliberately no fetch/cache handling
// (no offline mode, no asset caching): this app is a personal always-online
// tool talking to its own always-on backend, so there's nothing to gain
// from the added complexity/staleness risk of a caching service worker.

self.addEventListener("push", (event) => {
  let data = { title: "symposion", body: "" };
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: "symposion", body: event.data.text() };
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "symposion", {
      body: data.body || "",
      tag: data.tag || "symposion",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
