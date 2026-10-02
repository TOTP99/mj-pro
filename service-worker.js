// TP制作麻将 PWA service worker
// 缓存策略：HTML 走网络优先（保证更新能生效），静态资源走缓存优先（离线可玩）
// 发新版时把 VERSION +1，旧缓存自动清理
const VERSION = 'v1';
const CACHE = 'tp-mahjong-' + VERSION;
const CORE = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png'
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

function isHtml(req) {
    return req.mode === 'navigate' ||
        (req.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    if (new URL(req.url).origin !== location.origin) return;

    if (isHtml(req)) {
        // HTML：网络优先，失败回缓存
        e.respondWith(
            fetch(req).then(res => {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(req, copy));
                return res;
            }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
        );
        return;
    }
    // 静态资源：缓存优先，命中直接用；未命中走网络并写入缓存
    e.respondWith(
        caches.match(req).then(hit => {
            if (hit) return hit;
            return fetch(req).then(res => {
                if (res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE).then(c => c.put(req, copy));
                }
                return res;
            });
        })
    );
});
