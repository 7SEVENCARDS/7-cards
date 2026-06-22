const CACHE_VERSION = "7seven-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const PRECACHE_ASSETS = [
  "/offline.html",
  "/logo-badge.png",
  "/logo-full.png",
  "/favicon.png",
  "/apple-touch-icon.png",
  "/mascot.png",
];

// ── Install: precache critical assets ─────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      cache.addAll(PRECACHE_ASSETS).catch(() => {})
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: purge old caches ─────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== STATIC_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: strategy routing ────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, cross-origin, and API/server-function requests
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_server/") ||
    url.pathname.startsWith("/__") ||
    url.pathname.startsWith("/supabase")
  ) {
    return; // let the browser handle it normally
  }

  // Static assets (images, fonts bundled assets) — cache-first
  if (
    /\.(png|jpg|jpeg|webp|svg|ico|woff2?|ttf|otf)$/.test(url.pathname) ||
    url.pathname === "/site.webmanifest"
  ) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              caches.open(STATIC_CACHE).then((cache) => cache.put(request, response.clone()));
            }
            return response;
          })
          .catch(() => caches.match("/offline.html"));
      })
    );
    return;
  }

  // JS/CSS bundles — stale-while-revalidate (fast load + background update)
  if (/\.(js|css|mjs)$/.test(url.pathname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const networkFetch = fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // HTML navigation — network-first, offline fallback
  if (request.mode === "navigate" || request.headers.get("accept")?.includes("text/html")) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match("/offline.html"))
        )
    );
  }
});
