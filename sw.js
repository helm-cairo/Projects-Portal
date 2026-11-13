/* Helm Portal service worker.
 * - Lets the portal install on the phone and open even with a weak connection.
 * - Always tries the network first, so people get the newest version when online.
 * - Caches ONLY this site's own files (pages, styles, scripts, icons).
 *   Data from Supabase (another address) is never cached here, so no case or
 *   student data is ever stored by the service worker.
 * Bump CACHE when you want every phone to drop the old copy.
 */
var CACHE = "helm-portal-v2";
var SHELL = [
  "./", "index.html", "manifest.webmanifest",
  "shared/helm.css", "shared/logo.png", "shared/config.js", "shared/helm-auth.js", "shared/helm-db.js", "shared/login.js", "shared/account.js",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
  "attendance/login.html", "cases/login.html"
];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}));
  self.skipWaiting();
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;            // never touch Supabase, fonts, CDNs
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (r) {
        if (r) return r;
        if (req.mode === "navigate") return caches.match("index.html");
        return Response.error();
      });
    })
  );
});
