// バージョンを上げるたびに、新しいService Workerが古いキャッシュを破棄して入れ替わる。
// 更新を配信したいときはこの文字列を必ず上げること（例: v5 → v6）。
const CACHE = "okinawa-trip-v9";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/app.js",
  "./js/storage.js",
  "./js/geo.js",
  "./js/places.js",
  "./js/scheduler.js",
  "./js/ui-helpers.js",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先(network-first): オンライン時は常に最新を取得し、取得できたら
// キャッシュも更新する。オフライン時のみキャッシュ済みのコピーを返す。
// これにより、キャッシュ版が古いまま固定されて更新が届かない問題を防ぐ。
//
// 重要: fetch(e.request) をそのまま呼ぶと、ブラウザのHTTPキャッシュ
// (GitHub Pagesは max-age=600 を返す)から古い応答が返り、実質ネットワークに
// 到達しないことがある。cache:"reload" でHTTPキャッシュを必ずバイパスし、
// 毎回サーバーの最新を取得する。
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "reload" })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
