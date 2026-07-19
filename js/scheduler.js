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

// 車移動として現実的な直線距離の上限(km)。これを超えて「車」設定の区間は車移動とは考えにくい。
const CAR_MAX_KM = 120;
// 飛行機等(車以外)の移動として妥当な直線距離の下限(km)。これ未満で「車以外」設定の区間は、
// 近すぎて飛行機移動とは考えにくく、実際には短距離の車移動である可能性が高い。
const PLANE_MIN_KM = 120;

// その区間を車の所要時間として見積もれるか(車移動かつ両地点に座標がある)。
// 移動手段は場所ごとの設定を基本にしつつ、両地点の座標から分かる直線距離と矛盾する場合は
// 距離を優先して自動補正する。
// 例: 那覇空港に「飛行機」を設定していても、那覇空港⇔自宅(東京)のような短距離区間まで
// 「飛行機移動」と判定されるのを防ぐ(住所から見て明らかに矛盾するため)。
function carLeg(from, to) {
  const rawMode = to.arrivalMode || "car";
  if (hasCoords(from) && hasCoords(to)) {
    const distanceKm = haversineKm(from, to);
    const mode =
      rawMode !== "car" && distanceKm < PLANE_MIN_KM ? "car"
      : rawMode === "car" && distanceKm > CAR_MAX_KM ? "plane"
      : rawMode;
    if (mode === "car") {
      return { travelMin: driveMinutes(from, to), distanceKm, mode: "car", estimated: true };
    }
    return { travelMin: 0, distanceKm, mode, estimated: false };
  }
  return { travelMin: 0, distanceKm: 0, mode: rawMode, estimated: false };
}

// 手動で入力された各予定の時刻をもとに、その日のタイムラインと
// 「予定から予定の間の時間に無理がないか」だけを判定する。
// - entries: その日の予定の配列(ユーザーが並べた順)。各要素は { place, time("HH:MM") }。
//   同じ場所(ホテル等)が1日に複数回入っていてもよいよう、時刻は要素ごとに持つ。
export function computeManualDay(entries) {
  const items = entries.map((entry, i) => {
    const stop = entry.place;
    const t = entry.time;
    const startMin = (t != null && t !== "") ? parseHHMM(t) : null;
    const durationMin = stop.durationMin ?? 30;
    const endMin = startMin != null ? startMin + durationMin : null;

    // 移動区間は「予定 → 次の予定」の間だけ。最初の予定には移動区間を付けない。
    const from = i > 0 ? entries[i - 1].place : null;
    const leg = from ? carLeg(from, stop) : { travelMin: 0, distanceKm: 0, mode: stop.arrivalMode || "car", estimated: false };

    return {
      place: stop, entry, startMin, endMin, durationMin,
      travelMin: leg.travelMin, distanceKm: leg.distanceKm, mode: leg.mode, estimated: leg.estimated,
      hasLeg: i > 0,
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
    }
    // 飛行機/電車/徒歩など車で見積もれない区間は、実際の移動時間が分からないため
    // 「空き時間」としては表示しない(重なりチェックのみ上で行っている)。
  }

  return { items };
}
