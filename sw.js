// ==========================================================
// UTSAVhq — Service Worker
// ==========================================================
// ⚡ CACHE-FIRST FOR STATIC ASSETS (v6)
//
// v5 ne caching poori tarah band kar di thi kyunki app roz deploy
// ho raha tha aur cache-first se "maine fix kiya but purana hi dikh
// raha hai" wala confusion ho raha tha.
//
// v6 mein caching SMARTLY wapas on hai — lekin sirf un cheezon ke
// liye jo genuinely static hain (app shell + icons + local JS).
// Live data (Firestore, Cloudinary, Google APIs) kabhi cache nahi
// hota, isliye real-time sync par koi asar nahi padta.
//
// STALE-WHILE-REVALIDATE: cached copy turant serve hoti hai (fast
// first paint) aur background mein network se fresh copy aakar
// cache update kar deti hai. Isliye naya deploy agle load par
// automatically dikh jaata hai — purana atka nahi rehta.
//
// 🔑 VERSION BUMP RULE: jab bhi index.html ya js/*.js badle,
// CACHE_VERSION badha do (v6 -> v7). Purana cache activate par
// automatically delete ho jaata hai.
// ==========================================================

const CACHE_VERSION = 'v30';
const CACHE_NAME = `utsavhq-static-${CACHE_VERSION}`;

// App shell — ye files offline bhi chalti hain
const PRECACHE_URLS = [
    './',
    './',
    './index.html',
    './app/',
    './app/index.html',
    './card/',
    './card/index.html',
    './privacy.html',
    './terms.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './js/boot.js',
    './js/app.js',
    './js/nexa.js',
    './js/nexa.advanced.js',
    './logo.png',
    './favicon.png'
];

// Kabhi cache nahi karna — live data aur third-party APIs
const NEVER_CACHE = [
    'firestore.googleapis.com',
    'firebaseio.com',
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'accounts.google.com',
    'apis.google.com',
    'googleapis.com',
    'api.cloudinary.com',
    'res.cloudinary.com',
    'api.whatsapp.com',
    'wa.me'
];

// ---------------------------------------------------------- INSTALL
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => Promise.all(
                // Ek file 404 ho jaaye toh poora install fail na ho —
                // baaki shell phir bhi cache ho jaaye.
                PRECACHE_URLS.map((url) =>
                    cache.add(url).catch(() => { /* skip missing file */ })
                )
            ))
            .then(() => self.skipWaiting())   // naya SW turant activate ho
    );
});

// ---------------------------------------------------------- ACTIVATE
// Purane saare cache versions (v1..v5) poori tarah saaf kar do.
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())  // already-open tabs turant control mein
    );
});

// ---------------------------------------------------------- FETCH
self.addEventListener('fetch', (event) => {
    const req = event.request;

    // Sirf GET cache hota hai; POST/PUT (Firestore writes) kabhi nahi
    if (req.method !== 'GET') return;

    const url = new URL(req.url);

    // Live data / auth / uploads -> seedha network, koi cache nahi
    if (NEVER_CACHE.some((host) => url.hostname.includes(host))) return;

    // Sirf same-origin static assets cache karo (index.html, js/, icons)
    if (url.origin !== self.location.origin) return;

    // 🐛 FIX: the app shell itself is NETWORK-FIRST. Cache-first made every
    // new deploy show up one load late ("push kiya but purana hi dikh raha
    // hai"). Offline still falls back to the cached copy.
    if (req.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html')) {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    if (res && res.status === 200 && res.type === 'basic') {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    }
                    return res;
                })
                .catch(() => caches.match(req).then((c) => c || caches.match(
                            // never fall back to the landing page for an app URL
                            url.pathname.indexOf('/app/') === 0 ? './app/index.html' : './index.html'
                        )))
        );
        return;
    }

    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req)
                .then((res) => {
                    // Sirf valid, successful, basic responses cache karo
                    if (res && res.status === 200 && res.type === 'basic') {
                        const copy = res.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                    }
                    return res;
                })
                .catch(() => cached);   // offline -> cached copy

            // Stale-while-revalidate: cache turant, network background mein
            return cached || network;
        })
    );
});

// ---------------------------------------------------------- NOTIFICATIONS
// Tapping a notification opens (or focuses) the app instead of doing nothing.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || './app/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
            for (const client of list) {
                if (client.url.indexOf('/app/') !== -1 && 'focus' in client) return client.focus();
            }
            if (self.clients.openWindow) return self.clients.openWindow(target);
        })
    );
});

// Web Push (ready for later, when a push service is wired up).
self.addEventListener('push', (event) => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = { body: event.data && event.data.text() }; }
    const title = payload.title || 'UTSAVhq';
    event.waitUntil(self.registration.showNotification(title, {
        body: payload.body || 'You have a new update.',
        icon: './icon-192.png',
        badge: './icon-badge.png',
        vibrate: [120, 60, 120],
        timestamp: Date.now(),
        data: { url: payload.url || './app/' }
    }));
});

// ---------------------------------------------------- PUSH SUBSCRIPTION ROTATION
// Browsers occasionally rotate a push endpoint. When that happens we subscribe
// again with the same VAPID key and hand the new subscription to the app, which
// saves it back to Firestore.
const VAPID_PUBLIC_KEY = 'BBv2EwIbSzys7G3eppCkiQDSDAyoCDWeHo6Qwkkutvi-PNaUdTKLFmK6Ny4AuxG3aEcQjRgVpX50NjJKAXK_THg';

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
}

self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
        try {
            const sub = await self.registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
            const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
            clients.forEach((c) => c.postMessage({ type: 'push-subscription-changed', subscription: sub.toJSON() }));
        } catch (e) {
            console.warn('Could not renew the push subscription:', e && e.message);
        }
    })());
});
