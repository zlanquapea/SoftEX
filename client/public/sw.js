/* SoftEX service worker: installable app, fast reloads and read-only offline access.
 *
 * - App shell (index.html, hashed assets, icons) is cached so SoftEX opens without a network.
 * - Workspace data (GET /api/...) is fetched network-first; the last good copy is used only
 *   when the network is unavailable, so people on poor connections can still read their
 *   tasks, channels and knowledge. Writes are never cached or replayed.
 * - Cached workspace data is deleted on sign-out and whenever the server says the session
 *   is gone, so the next person on a shared device cannot read it.
 * - Push notifications are shown while SoftEX is closed; tapping one opens the item.
 */
const VERSION = 'v1';
const SHELL = `softex-shell-${VERSION}`;
const DATA = `softex-api-${VERSION}`;
const SHELL_URLS = ['/', '/manifest.webmanifest', '/favicon.svg'];
// Never keep copies of these: credentials, downloads, exports and AI output.
const NO_CACHE = [
  /^\/api\/auth\//,
  /^\/api\/export/,
  /^\/api\/files\/[^/]+\/download/,
  /^\/api\/ai\//,
  /^\/api\/admin\//,
  /^\/api\/operator\//,
  /^\/api\/calendar\//,
  /^\/api\/me\/(tokens|sessions|calendar-feed|push)/,
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('softex-') && k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  // Only pages from this origin may control the cache.
  if (event.origin !== self.location.origin) return;
  if (event.data && event.data.type === 'clear-data') event.waitUntil(caches.delete(DATA));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    // Hashed file names never change, so cache-first is safe.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (NO_CACHE.some((re) => re.test(url.pathname))) return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.status === 401) {
            caches.delete(DATA);
          } else if (res.ok && (res.headers.get('content-type') || '').includes('application/json')) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches.open(DATA).then((c) =>
            c.match(req).then((hit) => {
              if (!hit) return new Response(JSON.stringify({ error: 'You are offline and this has not been loaded before.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
              const headers = new Headers(hit.headers);
              headers.set('X-SoftEX-Offline', '1');
              return hit.blob().then((body) => new Response(body, { status: hit.status, headers }));
            }),
          ),
        ),
    );
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: event.data ? event.data.text() : 'SoftEX' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'SoftEX', {
      body: data.body || '',
      tag: data.tag,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      // Only paths inside SoftEX ("//host" would leave the site).
      data: { url: typeof data.url === 'string' && /^\/(?![/\\])/.test(data.url) ? data.url : '/inbox' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let url = new URL(event.notification.data?.url || '/inbox', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/inbox', self.location.origin);
  url = url.href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(url);
      // navigate() only works on windows this worker controls; otherwise open a new one.
      return open
        .focus()
        .then((w) => w.navigate(url))
        .catch(() => self.clients.openWindow(url));
    }),
  );
});
