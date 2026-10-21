// Service worker: lets the app be installed and opened without a connection.
// App files are network-first (always fresh when online); card APIs are never cached here.
const CACHE = 'nitai-pokedex-v12';
const SHELL = ['./', 'index.html', 'card-features.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' – never fill the offline copy from a stale HTTP cache
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Network first, but on a weak connection don't wait more than 4s before using the saved copy.
  // cache: 'no-cache' – always ask the server whether there is a newer version (GitHub Pages caches for 10 min)
  const network = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    // only plain URLs are kept for offline use (version checks add ?v=..., which would pile up)
    if (res.ok && !new URL(req.url).search) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  });
  const fallback = () => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined));
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => fallback().then(finish), 4000);
    network.then((r) => { clearTimeout(timer); finish(r); })
      .catch(() => { clearTimeout(timer); fallback().then((r) => { if (r) finish(r); else network.then(finish, () => finish(Response.error())); }); });
  }));
});
