const KEYS = {
  places: "okinawa-trip.places",
  settings: "okinawa-trip.settings",
  schedule: "okinawa-trip.schedule",
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const store = {
  getPlaces() { return load(KEYS.places, []); },
  setPlaces(places) { save(KEYS.places, places); },

  getSettings() {
    return load(KEYS.settings, {
      startDate: "",
      days: 5,
      base: { name: "", address: "", lat: null, lng: null },
      dayStart: "09:00",
      dayEnd: "19:00",
    });
  },
  setSettings(settings) { save(KEYS.settings, settings); },

  getSchedule() { return load(KEYS.schedule, null); },
  setSchedule(schedule) { save(KEYS.schedule, schedule); },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// このアプリはサーバーを持たず、データは端末のブラウザにしか保存されない。
// SafariはサイトのデータをiOSの仕様(ITP)で自動削除することがあるため、
// 手元にJSONファイルとして書き出し/読み込みできるバックアップ機能を用意する。
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
