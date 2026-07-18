export function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

// 沖縄の道路事情(短距離=生活道路・信号多め、長距離=国道/高速中心)を踏まえた速度感で
// 直線距離から車移動時間を見積もる。あくまで参考値。
export function estimateDriveMinutes(km) {
  if (km <= 0.25) return 5;
  const overhead = 6; // 乗車・駐車のロス時間
  let speedKmh;
  if (km < 3) speedKmh = 20;
  else if (km < 8) speedKmh = 30;
  else if (km < 20) speedKmh = 42;
  else speedKmh = 55;
  const minutes = overhead + (km / speedKmh) * 60;
  return Math.max(5, Math.round(minutes / 5) * 5);
}

export function driveMinutes(a, b) {
  return estimateDriveMinutes(haversineKm(a, b));
}

let geocodeCache = null;
function getCache() {
  if (!geocodeCache) {
    try {
      geocodeCache = JSON.parse(localStorage.getItem("okinawa-trip.geocache") || "{}");
    } catch {
      geocodeCache = {};
    }
  }
  return geocodeCache;
}

function persistCache() {
  localStorage.setItem("okinawa-trip.geocache", JSON.stringify(geocodeCache));
}

// Nominatim(住所データの元がOSM)は「潮崎町3-2-2」のような番地付きの日本の住所を
// ほぼ検索できない一方、「潮崎町3丁目」のような丁目表記や市区町村単位なら見つかる。
// そこで番地を丁目単位→町名単位→市区町村単位の順に丸めたクエリを順に試す。
function buildFallbackQueries(address) {
  const queries = [address];
  const m = address.match(/^(.*?[都道府県].*?[市区町村])(.*)$/) || address.match(/^(.*?[市区町村])(.*)$/);
  if (m) {
    const prefix = m[1];
    const rest = m[2];
    const townMatch = rest.match(/^([^\d０-９]+)[\s　]*([0-9０-９]+)/);
    if (townMatch) {
      const townName = townMatch[1].trim();
      const chome = townMatch[2].replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
      if (townName) {
        queries.push(`${prefix}${townName}${chome}丁目`);
        queries.push(`${prefix}${townName}`);
      }
    }
    queries.push(prefix);
  }
  return [...new Set(queries.map(q => q.trim()).filter(Boolean))];
}

// extratags=1を付けると、OSMに opening_hours タグが登録されている場所だけ営業時間も返ってくる。
// 個人商店の多くはOSM側にタグが無く取得できないため、あくまで「取れたら使う」の位置づけ。
async function nominatimSearch(query) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jp&extratags=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("検索に失敗しました");
  return res.json();
}

function toResult(hit, approx) {
  return {
    lat: parseFloat(hit.lat),
    lng: parseFloat(hit.lon),
    displayName: hit.display_name,
    openingHours: hit.extratags?.opening_hours || null,
    approx,
  };
}

// OpenStreetMap Nominatimで住所→緯度経度を取得(無料・APIキー不要)。
// 結果はローカルキャッシュして同一住所の再検索を避ける(利用規約上の負荷配慮)。
export async function geocodeAddress(address) {
  const key = address.trim();
  if (!key) throw new Error("住所を入力してください");
  const cache = getCache();
  if (cache[key]) return cache[key];

  const candidates = buildFallbackQueries(key);
  for (let i = 0; i < candidates.length; i++) {
    const data = await nominatimSearch(candidates[i]);
    if (data.length) {
      const result = toResult(data[0], i > 0);
      cache[key] = result;
      persistCache();
      return result;
    }
  }
  throw new Error("住所が見つかりませんでした。番地を省略して町名までで試すか、Googleマップで確認してください");
}

// 住所が分からない/未入力のときに、店名だけでOSM上の登録があるか探す。
// OSMは全国の商店網羅DBではないため、有名スポットや観光地以外は見つからないことが多い。
export async function geocodeByName(name) {
  const key = name.trim();
  if (!key) throw new Error("名前を入力してください");
  const cacheKey = `name:${key}`;
  const cache = getCache();
  if (cache[cacheKey]) return cache[cacheKey];

  const candidates = [key, `${key} 沖縄`, `${key} 沖縄県`];
  for (const q of candidates) {
    const data = await nominatimSearch(q);
    if (data.length) {
      const result = toResult(data[0], true);
      cache[cacheKey] = result;
      persistCache();
      return result;
    }
  }
  throw new Error("名前だけでは見つかりませんでした。住所を入力してください");
}

// GoogleマップはNominatimより日本の番地表記の解析が格段に強いため、
// 住所テキストがある場合は緯度経度(丁目単位までの近似値の場合がある)より住所を優先する。
// 緯度経度はAIスケジューラの距離計算専用の内部近似値として使う。
function mapsQueryFor(place) {
  const address = (place.address || place.label || "").trim();
  if (address) return encodeURIComponent(address);
  if (place.lat != null && place.lng != null) return `${place.lat},${place.lng}`;
  return "";
}

export function googleMapsUrl(place) {
  return `https://www.google.com/maps/search/?api=1&query=${mapsQueryFor(place)}`;
}

export function googleMapsDirectionsUrl(from, to) {
  return `https://www.google.com/maps/dir/?api=1&origin=${mapsQueryFor(from)}&destination=${mapsQueryFor(to)}&travelmode=driving`;
}
