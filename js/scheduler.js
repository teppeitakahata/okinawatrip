import { haversineKm, driveMinutes } from "./geo.js";

export function parseHHMM(str) {
  const [h, m] = (str || "09:00").split(":").map(Number);
  return h * 60 + m;
}
export function minutesToHHMM(mins) {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function hasCoords(p) {
  return p && p.lat != null && p.lng != null;
}

// その区間を車の所要時間として見積もれるか(車移動かつ両地点に座標がある)
function carLeg(from, to) {
  const byCar = (to.arrivalMode || "car") === "car";
  if (byCar && hasCoords(from) && hasCoords(to)) {
    return { travelMin: driveMinutes(from, to), distanceKm: haversineKm(from, to), mode: "car", estimated: true };
  }
  return { travelMin: 0, distanceKm: 0, mode: to.arrivalMode || "car", estimated: false };
}

// 手動で入力された各予定の時刻をもとに、その日のタイムラインと
// 「予定から予定の間の時間に無理がないか」だけを判定する。
// - route:  その日の予定(場所オブジェクト)の配列(ユーザーが並べた順)
// - base:   拠点(ホテル等)。startsAtBase/endsAtBase の時のみ使う
// - times:  { [placeId]: "HH:MM" } ユーザーが入力した開始時刻
// - opts:   { startsAtBase, endsAtBase }
export function computeManualDay(route, base, times, opts = {}) {
  const { startsAtBase = true, endsAtBase = true } = opts;
  const items = route.map((stop, i) => {
    const t = times[stop.id];
    const startMin = (t != null && t !== "") ? parseHHMM(t) : null;
    const durationMin = stop.durationMin || 30;
    const endMin = startMin != null ? startMin + durationMin : null;

    const from = i === 0 ? (startsAtBase ? base : null) : route[i - 1];
    const leg = from ? carLeg(from, stop) : { travelMin: 0, distanceKm: 0, mode: stop.arrivalMode || "car", estimated: false };

    return {
      place: stop, startMin, endMin, durationMin,
      travelMin: leg.travelMin, distanceKm: leg.distanceKm, mode: leg.mode, estimated: leg.estimated,
      hasLeg: i > 0 || startsAtBase,
      // 前の予定との時間の妥当性(下で埋める)
      warning: null,
      freeGapMin: null,
    };
  });

  // 予定と予定の間の時間チェック
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    if (cur.startMin == null || prev.startMin == null) continue; // 時刻未入力はチェック不可

    if (prev.endMin != null && cur.startMin < prev.endMin) {
      cur.warning = `前の予定(${minutesToHHMM(prev.endMin)}終了)と時間が重なっています。`;
      continue;
    }
    if (cur.estimated) {
      const needed = prev.endMin + cur.travelMin;
      if (cur.startMin < needed) {
        cur.warning = `移動が間に合いません。前の予定の終了(${minutesToHHMM(prev.endMin)})＋移動約${cur.travelMin}分で、${minutesToHHMM(needed)}以降が目安です。`;
      } else {
        cur.freeGapMin = cur.startMin - needed;
      }
    } else if (prev.endMin != null) {
      // 車で見積もれない区間(飛行機/電車/徒歩)は、重なりだけ見て空き時間を出す
      cur.freeGapMin = cur.startMin - prev.endMin;
    }
  }

  // 拠点発着の目安時刻(情報表示のみ・チェックはしない)
  let baseDepart = null, baseReturn = null;
  const first = items[0];
  const last = items[items.length - 1];
  if (startsAtBase && first && first.startMin != null && first.estimated) {
    baseDepart = first.startMin - first.travelMin;
  }
  if (endsAtBase && last && last.endMin != null && hasCoords(last.place) && hasCoords(base)) {
    baseReturn = last.endMin + driveMinutes(last.place, base);
  }

  return { items, baseDepart, baseReturn };
}

// 新しい予定を日に追加するときの初期時刻の目安(前の予定の終了＋移動、無ければ拠点発の時刻)。
export function suggestNextTime(route, base, times, dayStartMin, opts = {}) {
  const { startsAtBase = true } = opts;
  if (!route.length) {
    // 最初の予定: 拠点発なら「開始時刻＋拠点からの移動」、そうでなければ開始時刻
    return dayStartMin;
  }
  const prev = route[route.length - 1];
  const t = times[prev.id];
  if (t == null || t === "") return dayStartMin;
  const prevEnd = parseHHMM(t) + (prev.durationMin || 30);
  return prevEnd; // 移動時間は追加先の場所が決まってから加味するため、ここでは終了時刻を目安に
}
