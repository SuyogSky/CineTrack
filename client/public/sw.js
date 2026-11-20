const CACHE_NAME = 'cinetrack-pwa-v2';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

const STATIC_EXTENSIONS = /\.(js|css|svg|png|jpg|jpeg|webp|ico|woff|woff2|ttf|eot)$/i;

function isCacheable(request, response) {
  if (request.method !== 'GET' || response.status !== 200) {
    return false;
  }

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/api/')) {
    return false;
  }

  // Must be same origin (avoid caching third-party responses or arbitrary origins)
  if (url.origin !== self.location.origin) {
    return false;
  }

  // Never cache no-store or private responses
  const cacheControl = response.headers.get('Cache-Control') || '';
  if (cacheControl.includes('no-store') || cacheControl.includes('private')) {
    return false;
  }

  // Only cache navigation / app shell or safe static file extensions
  if (request.mode === 'navigate' || STATIC_EXTENSIONS.test(url.pathname)) {
    return true;
  }

  return false;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key.startsWith('cinetrack-') && key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Never intercept API requests or non-GET requests
  if (
    event.request.method !== 'GET' ||
    event.request.url.includes('/api/') ||
    event.request.url.startsWith('chrome-extension://')
  ) {
    return;
  }

  // Network-first strategy with cache fallback for offline reliability
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (isCacheable(event.request, networkResponse)) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        });
      })
  );
});
