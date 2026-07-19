// バージョンを上げるたびに、新しいService Workerが古いキャッシュを破棄して入れ替わる。
// 更新を配信したいときはこの文字列を必ず上げること（例: v5 → v6）。
const CACHE = "okinawa-trip-v14";
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
//
// 重要: cache:"reload" はナビゲーション要求("/"へのアクセス等)では無視される
// ことがあり、ブラウザのHTTPキャッシュから古いindex.htmlが返ってしまう。
// そこでネットワーク取得だけURLにユニークなクエリ(_cb)を付け、HTTPキャッシュを
// 確実に迂回して毎回サーバーの最新を取る。保存・オフライン照合は元のURLで行う。
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  const bustUrl = url.pathname + url.search + (url.search ? "&" : "?") + "_cb=" + Date.now();
  e.respondWith(
    fetch(bustUrl, { cache: "reload" })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
