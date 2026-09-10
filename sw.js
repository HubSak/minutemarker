/*
 * MinuteMarker service worker.
 *
 * Strategy: stale-while-revalidate. Every request is answered from the cache
 * immediately (so the app opens instantly and works with no signal at all),
 * while a copy is fetched in the background and stored for next time.
 *
 * The practical consequence: after you deploy an update, the next launch shows
 * the old version and the one after that shows the new one. That is the trade
 * for never having to bump a version string by hand.
 */
"use strict";

const CACHE = "minutemarker";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== location.origin) return;

  /* start the network request synchronously, before any await, so waitUntil
     can keep the worker alive while it finishes in the background */
  const network = fetch(req)
    .then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    })
    .catch(() => null);

  event.waitUntil(network);
  event.respondWith(
    caches.match(req, { ignoreSearch: true })
      .then(hit => hit || network)
      .then(res => res || new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      }))
  );
});
