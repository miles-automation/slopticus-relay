self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    self.registration.pushManager
      .getSubscription()
      .then((subscription) => subscription?.unsubscribe())
      .catch(() => {})
      .then(() => self.registration.unregister()),
  );
});
