// Service worker: lets the site be installed and keeps working with a weak or missing connection.
// __BUILD__ is replaced with the commit id by the publishing workflow, so every deploy starts a fresh cache.
const VERSION = "__BUILD__";
const SHELL_CACHE = `mugello-shell-${VERSION}`;
const DATA_CACHE = `mugello-data-${VERSION}`;

const SHELL = [
  "./", "index.html", "privacy.html", "manifest.webmanifest",
  "css/style.css",
  "js/config.js", "js/app.js", "js/schools.js", "js/delays.js", "js/meteo.js", "js/counter.js", "js/analytics.js", "js/pwa.js",
  "fonts/bricolage-grotesque-800.woff2", "fonts/ibm-plex-mono-500.woff2",
  "img/favicon.svg", "img/icon-192.png",
  "data/routes_index.json", "data/stops.json", "data/schools.json", "data/meta.json",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css",
  "https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js",
];
const CDN_HOSTS = ["unpkg.com"];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // one missing file must not abort the whole installation
    await Promise.allSettled(SHELL.map(url => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE];
    for (const name of await caches.keys()) if (!keep.includes(name)) await caches.delete(name);
    await self.clients.claim();
  })());
});

async function networkFirst(request, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (err) {
    const hit = await caches.match(request, { ignoreSearch: true }); // any cache: the shell one also holds the data indexes
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request);
  const refresh = fetch(request).then(response => {
    if (response.ok || response.type === "opaque") cache.put(request, response.clone());
    return response;
  }).catch(() => null);
  return hit || (await refresh) || Response.error();
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // live services (map tiles, train delays, analytics, weather, counters) always go straight to the network
  if (url.origin !== self.location.origin && !CDN_HOSTS.includes(url.hostname)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, 4000).catch(async () => {
      const cache = await caches.open(SHELL_CACHE);
      return (await cache.match("index.html")) || Response.error();
    }));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(request, DATA_CACHE, 5000));
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});
