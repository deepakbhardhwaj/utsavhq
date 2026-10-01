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

const CACHE_VERSION = 'v9';
const CACHE_NAME = `utsavhq-static-${CACHE_VERSION}`;

// App shell — ye files offline bhi chalti hain
const PRECACHE_URLS = [
    './',
    './index.html',
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
