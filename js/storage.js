const KEYS = {
  places: "okinawa-trip.places",
  settings: "okinawa-trip.settings",
  schedule: "okinawa-trip.schedule",
};

const DEFAULT_SETTINGS = {
  startDate: "",
  days: 5,
  base: { name: "", address: "", lat: null, lng: null },
  dayStart: "09:00",
  dayEnd: "19:00",
};

function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveLocal(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// サーバー(家族で共有するデータベース)とブラウザのlocalStorage(オフライン用の
// 手元コピー)の両方を持つ。読み取りは常にこのメモリ上のキャッシュから即時に
// 返すので、既存の呼び出し側(app.js/places.js)は同期APIのままで変更不要。
let cache = {
  places: loadLocal(KEYS.places, []),
  settings: loadLocal(KEYS.settings, DEFAULT_SETTINGS),
  schedule: loadLocal(KEYS.schedule, null),
};

async function pushToServer(key, value) {
  try {
    const res = await fetch(`/api/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    console.warn(`サーバーへの保存に失敗しました(${key})。ローカルには保存済みです。`, e);
  }
}

export const store = {
  getPlaces() { return cache.places; },
  setPlaces(places) { cache.places = places; saveLocal(KEYS.places, places); pushToServer("places", places); },

  getSettings() { return cache.settings; },
  setSettings(settings) { cache.settings = settings; saveLocal(KEYS.settings, settings); pushToServer("settings", settings); },

  getSchedule() { return cache.schedule; },
  setSchedule(schedule) { cache.schedule = schedule; saveLocal(KEYS.schedule, schedule); pushToServer("schedule", schedule); },
};

function applyRemote(data) {
  cache = {
    places: data.places ?? [],
    settings: data.settings ?? DEFAULT_SETTINGS,
    schedule: data.schedule ?? null,
  };
  saveLocal(KEYS.places, cache.places);
  saveLocal(KEYS.settings, cache.settings);
  saveLocal(KEYS.schedule, cache.schedule);
}

// ページ起動時に一度だけ呼び、サーバー上の最新データでローカルの手元コピーを
// 上書きする。オフライン等で失敗した場合は、localStorageの手元コピーのまま動く。
export async function initFromServer() {
  try {
    const res = await fetch("/api/data");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    applyRemote(await res.json());
  } catch (e) {
    console.warn("サーバーからの読み込みに失敗しました。ローカルのデータを使用します。", e);
  }
}

const remoteUpdateListeners = [];
export function onRemoteUpdate(cb) {
  remoteUpdateListeners.push(cb);
}

let pollTimer = null;
// 他の端末(家族)が加えた変更を定期的に取り込む。開いている画面がある間だけでよい。
export function startPolling(intervalMs = 20000) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/data");
      if (!res.ok) return;
      const data = await res.json();
      if (JSON.stringify(data) === JSON.stringify(cache)) return;
      applyRemote(data);
      remoteUpdateListeners.forEach(cb => cb());
    } catch {
      // オフライン等。次のポーリングで再試行する。
    }
  }, intervalMs);
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// このアプリのデータは家族で共有するサーバーに保存されるが、念のため手元にも
// JSONファイルとして書き出し/読み込みできるバックアップ機能を用意する。
export function exportAll() {
  return JSON.stringify({
    kind: "okinawa-trip-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    places: store.getPlaces(),
    settings: store.getSettings(),
    schedule: store.getSchedule(),
  }, null, 2);
}

export function importAll(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new Error("ファイルの形式が正しくありません（JSONとして読み込めませんでした）");
  }
  if (!data || data.kind !== "okinawa-trip-backup" || !Array.isArray(data.places)) {
    throw new Error("このアプリのバックアップファイルではないようです");
  }
  store.setPlaces(data.places);
  if (data.settings) store.setSettings(data.settings);
  if (data.schedule) store.setSchedule(data.schedule);
  return { placeCount: data.places.length };
}

// 二重登録バグで生まれた「id以外がまったく同じ」場所を1件に整理する。
// id以外の全項目が一致する場合のみ重複とみなすため、意図的に登録した
// (メモや時間帯などが異なる)同名の場所は削除されない。返り値は削除件数。
export function dedupePlaces() {
  const places = store.getPlaces();
  const seen = new Set();
  const kept = [];
  for (const p of places) {
    const { id, ...rest } = p;
    const key = JSON.stringify(rest);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(p);
  }
  if (kept.length !== places.length) {
    store.setPlaces(kept);
    // 日程側に残った、既に存在しないIDへの参照も掃除する
    const removedIds = new Set(places.map(p => p.id).filter(id => !kept.some(k => k.id === id)));
    const schedule = store.getSchedule();
    if (schedule?.days) {
      schedule.days.forEach(d => {
        if (Array.isArray(d.entries)) d.entries = d.entries.filter(e => !removedIds.has(e.placeId));
        if (Array.isArray(d.placeIds)) d.placeIds = d.placeIds.filter(id => !removedIds.has(id));
      });
      store.setSchedule(schedule);
    }
  }
  return places.length - kept.length;
}
