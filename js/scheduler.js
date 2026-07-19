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

const PRIORITY_RANK = { must: 0, want: 1, maybe: 2 };

// 朝食・ランチ・ディナーそれぞれの目安時間帯。この帯の外に置かれるほどペナルティが増える。
const MEAL_WINDOWS = {
  breakfast: [7 * 60, 9 * 60 + 30],
  lunch: [11 * 60, 14 * 60],
  cafe: [14 * 60, 16 * 60], // ランチとディナーの間の小休憩
  dinner: [17 * 60 + 30, 20 * 60 + 30],
};

// 午前/午後/夜の目安時間帯(食事以外の「行きたい時間帯」に使う)。
const TIME_OF_DAY_WINDOWS = {
  morning: [8 * 60, 12 * 60],
  afternoon: [12 * 60, 17 * 60],
  evening: [17 * 60, 21 * 60],
};

// 到着予定時刻(分)が、指定された時間帯の帯からどれだけ外れているか(分)。
// 複数選ばれていれば最も近い帯で判定する。未設定なら0(制約なし)。
function nearestWindowPenalty(windowMap, keys, arrivalMin) {
  if (!keys?.length) return 0;
  let best = Infinity;
  for (const k of keys) {
    const w = windowMap[k];
    if (!w) continue;
    const d = arrivalMin < w[0] ? w[0] - arrivalMin : arrivalMin > w[1] ? arrivalMin - w[1] : 0;
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
}

// 移動距離(km)に、時間の希望からのズレ(分)を加味したコストを加算して比較する。
// 3分のズレ ≒ 1kmの遠回りとして重み付け(食事/時間帯は「希望」程度の強さ)。
// 固定時刻(飛行機など)はズレ1分 ≒ 20kmの遠回りとして扱い、ほぼ絶対に位置がズレないようにする。
const SOFT_PENALTY_MIN_PER_KM = 3;
const FIXED_PENALTY_MIN_PER_KM = 0.05;

function timingPenaltyKm(place, arrivalMin) {
  if (place.fixedTime) {
    const fixedMin = parseHHMM(place.fixedTime);
    return Math.abs(arrivalMin - fixedMin) / FIXED_PENALTY_MIN_PER_KM;
  }
  const mealPenalty = nearestWindowPenalty(MEAL_WINDOWS, place.mealTypes, arrivalMin);
  const todPenalty = nearestWindowPenalty(TIME_OF_DAY_WINDOWS, place.preferredTimeOfDay, arrivalMin);
  return (mealPenalty + todPenalty) / SOFT_PENALTY_MIN_PER_KM;
}

// 食事/時間帯の希望や固定時刻から、その場所を訪れたい最も早い時刻(分)を求める。
// 該当する希望が無ければnull(制約なし)。
function desiredEarliestArrival(place) {
  if (place.fixedTime) return parseHHMM(place.fixedTime);
  const windows = [
    ...(place.mealTypes || []).map(mt => MEAL_WINDOWS[mt]),
    ...(place.preferredTimeOfDay || []).map(t => TIME_OF_DAY_WINDOWS[t]),
  ].filter(Boolean);
  if (!windows.length) return null;
  return Math.min(...windows.map(w => w[0]));
}

// 食事タグの時間帯の開始時刻(分)。朝食/ランチ/カフェ/ディナーは「その時間まで待つ」対象。
// (行きたい時間帯=午前/午後/夜 は待機させず、並び順のヒントに留める)
function mealEarliestArrival(place) {
  if (place.fixedTime) return null;
  const starts = (place.mealTypes || []).map(mt => MEAL_WINDOWS[mt]).filter(Boolean).map(w => w[0]);
  return starts.length ? Math.min(...starts) : null;
}

// 地理的に近い場所同士を同じ日にまとめる簡易k-meansクラスタリング。
// 拠点(ホテル)が固定なので、日ごとに「拠点を中心にまとまったエリアを回る」形にしたい。
function clusterIntoDays(points, k) {
  if (k <= 0 || points.length === 0) return Array.from({ length: Math.max(k, 0) }, () => []);
  if (points.length <= k) {
    return points.map(p => [p]).concat(Array.from({ length: k - points.length }, () => []));
  }

  const centroids = [points[0]];
  while (centroids.length < k) {
    let best = null, bestDist = -1;
    for (const p of points) {
      const minDist = Math.min(...centroids.map(c => haversineKm(p, c)));
      if (minDist > bestDist) { bestDist = minDist; best = p; }
    }
    centroids.push(best);
  }

  let assignment = points.map(() => 0);
  for (let iter = 0; iter < 8; iter++) {
    assignment = points.map(p => {
      let best = 0, bestDist = Infinity;
      centroids.forEach((c, i) => {
        const d = haversineKm(p, c);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      return best;
    });
    for (let i = 0; i < k; i++) {
      const members = points.filter((_, idx) => assignment[idx] === i);
      if (members.length) {
        centroids[i] = {
          lat: members.reduce((s, p) => s + p.lat, 0) / members.length,
          lng: members.reduce((s, p) => s + p.lng, 0) / members.length,
        };
      }
    }
  }

  const groups = Array.from({ length: k }, () => []);
  points.forEach((p, idx) => groups[assignment[idx]].push(p));

  // 1件も入らなかった日に、最も混んでいる日から遠い1件を移して偏りを均す
  for (let i = 0; i < k; i++) {
    if (groups[i].length === 0) {
      const donorIdx = groups.reduce((maxI, g, gi) => (g.length > groups[maxI].length ? gi : maxI), 0);
      if (groups[donorIdx].length > 1) {
        groups[donorIdx].sort((a, b) => haversineKm(b, centroids[donorIdx]) - haversineKm(a, centroids[donorIdx]));
        groups[i].push(groups[donorIdx].shift());
      }
    }
  }
  return groups;
}

function hasCoords(p) {
  return p && p.lat != null && p.lng != null;
}

// opts.startsAtBase: その日、拠点(ホテル)から出発するか(初日は空港着なのでfalseにできる)
// opts.endsAtBase:   その日、拠点(ホテル)に戻るか(最終日は空港へ向かうのでfalseにできる)
export function computeDayTimeline(route, base, dayStartMin, opts = {}) {
  const { startsAtBase = true, endsAtBase = true } = opts;
  const items = [];
  let time = dayStartMin;
  let prev = startsAtBase ? base : null;
  for (const stop of route) {
    // 車以外(飛行機/電車/徒歩)の区間、拠点発でない初回、緯度経度が無い予定は
    // 車の移動距離・時間を推定しない(0扱い)。飛行機は基本的に固定時刻で到着が決まる。
    const byCar = (stop.arrivalMode || "car") === "car";
    const canMeasure = byCar && hasCoords(prev) && hasCoords(stop);
    const km = canMeasure ? haversineKm(prev, stop) : 0;
    const travelMin = canMeasure ? driveMinutes(prev, stop) : 0;
    const naturalArrival = time + travelMin;
    let arrival = naturalArrival;
    let late = false;
    let waited = false;
    if (stop.fixedTime) {
      const fixedMin = parseHHMM(stop.fixedTime);
      if (naturalArrival > fixedMin) late = true;
      else { arrival = fixedMin; waited = arrival > naturalArrival; } // 固定時刻まで待つ
    } else {
      // 食事(朝食/ランチ/カフェ/ディナー)は、早く着いてもその時間帯まで待つ
      const mealStart = mealEarliestArrival(stop);
      if (mealStart != null && naturalArrival < mealStart) { arrival = mealStart; waited = true; }
    }
    const departure = arrival + (stop.durationMin || 30);
    items.push({ place: stop, travelMin, distanceKm: km, arrival, naturalArrival, departure, late, waited });
    time = departure;
    prev = stop;
  }
  const travelBackMin = (endsAtBase && hasCoords(prev) && hasCoords(base)) ? driveMinutes(prev, base) : 0;
  const returnTime = time + travelBackMin;
  return { items, returnTime, travelBackMin };
}

function routeCost(route, base, dayStartMin) {
  const timeline = computeDayTimeline(route, base, dayStartMin);
  const last = route.length ? route[route.length - 1] : base;
  let km = timeline.items.reduce((s, it) => s + it.distanceKm, 0) + haversineKm(last, base);
  let penaltyKm = 0;
  timeline.items.forEach(it => { penaltyKm += timingPenaltyKm(it.place, it.naturalArrival); });
  return km + penaltyKm;
}

// 各ステップで「距離+時間の希望からのズレ」が最小の場所を選んでいく貪欲法。
function greedyRoute(stops, base, dayStartMin) {
  const remaining = [...stops];
  const route = [];
  let current = base;
  let time = dayStartMin;
  while (remaining.length) {
    let bestIdx = 0, bestScore = Infinity, bestArrival = time;
    remaining.forEach((s, i) => {
      const travelMin = driveMinutes(current, s);
      const arrival = time + travelMin;
      const score = haversineKm(current, s) + timingPenaltyKm(s, arrival);
      if (score < bestScore) { bestScore = score; bestIdx = i; bestArrival = arrival; }
    });
    const [next] = remaining.splice(bestIdx, 1);
    route.push(next);
    let effectiveArrival = bestArrival;
    if (next.fixedTime) {
      const fixedMin = parseHHMM(next.fixedTime);
      if (bestArrival <= fixedMin) effectiveArrival = fixedMin;
    }
    time = effectiveArrival + (next.durationMin || 30);
    current = next;
  }
  return route;
}

// その日の最初の訪問先に食事/時間帯の希望や固定時刻がある場合、素の出発時刻(dayStartMin)
// のままだと朝一で到着してしまう(=ランチの店に9時到着など)ことがある。帰着が終了時刻に
// 収まる範囲で出発を遅らせ、最初の到着が希望の時間に収まるよう調整する。
function bestStartDelay(route, base, dayStartMin, dayEndMin, currentReturnTime, opts = {}) {
  if (!route.length) return 0;
  const target = desiredEarliestArrival(route[0]);
  if (target == null) return 0;
  const startsAtBase = opts.startsAtBase !== false;
  const firstLeg = startsAtBase && hasCoords(base) && hasCoords(route[0]) ? driveMinutes(base, route[0]) : 0;
  const naiveArrival = dayStartMin + firstLeg;
  if (naiveArrival >= target) return 0;
  const needed = target - naiveArrival;
  const slack = dayEndMin + 15 - currentReturnTime;
  return Math.max(0, Math.min(needed, slack));
}

// その日の実際の出発時刻(分)を、現在の並び順から求める。手動で場所を追加/並べ替えた
// 場合でも、先頭の予定が食事・時間帯・固定時刻の希望に合うよう出発を遅らせる。
// 画面表示(app.js)はこれを使い、AIを使わず手で組んだ日程でも時間が正しく出るようにする。
export function resolveDayStartMin(route, base, dayStartMin, dayEndMin, opts = {}) {
  const returnTime = computeDayTimeline(route, base, dayStartMin, opts).returnTime;
  return dayStartMin + bestStartDelay(route, base, dayStartMin, dayEndMin, returnTime, opts);
}

// 隣接区間の入れ替え(2-opt簡易版)で、距離と食事タイミングを合わせたコストを減らす
function twoOptImprove(route, base, dayStartMin) {
  if (route.length < 3) return route;
  let improved = true;
  let best = route;
  let bestCost = routeCost(best, base, dayStartMin);
  let guard = 0;
  while (improved && guard < 50) {
    improved = false;
    guard++;
    for (let i = 0; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)];
        const cost = routeCost(candidate, base, dayStartMin);
        if (cost < bestCost - 0.01) {
          best = candidate; bestCost = cost; improved = true;
        }
      }
    }
  }
  return best;
}

// 1日分の順序・時間割を組む処理。全体のAI作成(buildSchedule)と、1日だけの
// 再調整(rebuildDay)の両方から使う。固定時刻の予定は優先度に関わらずトリミング対象外。
function buildOneDay(stops, base, dayStartMin, dayEndMin, opts = {}) {
  let route = twoOptImprove(greedyRoute(stops, base, dayStartMin), base, dayStartMin);
  let timeline = computeDayTimeline(route, base, dayStartMin, opts);
  const leftover = [];

  let guard = 0;
  while (timeline.returnTime > dayEndMin + 15 && guard < 20) {
    guard++;
    const removable = route
      .map((p, i) => ({ p, i }))
      .filter(x => x.p.priority !== "must" && !x.p.fixedTime)
      .sort((a, b) => PRIORITY_RANK[b.p.priority] - PRIORITY_RANK[a.p.priority]);
    if (!removable.length) break;
    const { i } = removable[0];
    leftover.push(route[i]);
    route = [...route.slice(0, i), ...route.slice(i + 1)];
    timeline = computeDayTimeline(route, base, dayStartMin, opts);
  }

  const delay = bestStartDelay(route, base, dayStartMin, dayEndMin, timeline.returnTime, opts);
  const startMin = dayStartMin + delay;
  if (delay > 0) timeline = computeDayTimeline(route, base, startMin, opts);

  return { route, timeline, leftover, startMin };
}

// dayOptions: 各日の { startsAtBase, endsAtBase } の配列(任意)。初日=空港着、最終日=空港発
// のように拠点発着を外した設定を、AI再作成でも引き継ぐために使う。
export function buildSchedule({ places, settings, dayOptions = [] }) {
  const numDays = Math.max(1, Number(settings.days) || 1);
  const base = settings.base;
  const dayStartMin = parseHHMM(settings.dayStart);
  const dayEndMin = parseHHMM(settings.dayEnd);
  const optsFor = idx => dayOptions[idx] || {};

  const unscheduled = [];
  const geocoded = places.filter(p => p.lat != null && p.lng != null);
  places.filter(p => p.lat == null || p.lng == null).forEach(p =>
    unscheduled.push({ place: p, reason: "住所の位置情報が未取得です（場所編集画面で「住所を検索」を押してください）" })
  );

  const pinned = geocoded.filter(p => p.pinnedDay && p.pinnedDay >= 1 && p.pinnedDay <= numDays);
  const unpinned = geocoded.filter(p => !(p.pinnedDay && p.pinnedDay >= 1 && p.pinnedDay <= numDays));

  const dayBuckets = clusterIntoDays(unpinned, numDays);
  pinned.forEach(p => dayBuckets[p.pinnedDay - 1].push(p));

  const days = dayBuckets.map((stops, idx) => {
    const { route, timeline, leftover, startMin } = buildOneDay(stops, base, dayStartMin, dayEndMin, optsFor(idx));
    return { dayIndex: idx, route, timeline, leftover, startMin };
  });

  // あふれた場所を、時間に余裕がある他の日へ挿入できないか試す
  const stillUnscheduled = [];
  days.forEach(day => {
    day.leftover.forEach(place => {
      let placed = false;
      for (const target of days) {
        if (target === day) continue;
        const testRoute = [...target.route, place];
        const testTimeline = computeDayTimeline(testRoute, base, target.startMin, optsFor(target.dayIndex));
        if (testTimeline.returnTime <= dayEndMin + 15) {
          target.route = testRoute;
          target.timeline = testTimeline;
          placed = true;
          break;
        }
      }
      if (!placed) stillUnscheduled.push({ place, reason: "時間の都合で今回の日程には組み込めませんでした" });
    });
  });

  stillUnscheduled.forEach(u => unscheduled.push(u));

  return {
    generatedAt: Date.now(),
    days: days.map(d => ({
      dayIndex: d.dayIndex,
      placeIds: d.route.map(p => p.id),
      startMin: d.startMin,
      startsAtBase: optsFor(d.dayIndex).startsAtBase !== false,
      endsAtBase: optsFor(d.dayIndex).endsAtBase !== false,
    })),
    unscheduled: unscheduled.map(u => ({ placeId: u.place.id, reason: u.reason })),
  };
}

// 「気に入らない場所を手動で外す/移動してから、この日だけAIに再調整させる」ための関数。
// 対象日に残っている場所(手動編集後の状態)＋まだどの日にも入っていない候補だけを使って、
// その日単体を再構成する。他の日の内容には触れない。
export function rebuildDay({ dayIndex, places, schedule, settings }) {
  const base = settings.base;
  const dayStartMin = parseHHMM(settings.dayStart);
  const dayEndMin = parseHHMM(settings.dayEnd);
  const placesById = new Map(places.map(p => [p.id, p]));

  const assignedElsewhere = new Set();
  schedule.days.forEach((d, i) => {
    if (i !== dayIndex) d.placeIds.forEach(id => assignedElsewhere.add(id));
  });

  const keepIds = schedule.days[dayIndex]?.placeIds || [];
  const keepPlaces = keepIds.map(id => placesById.get(id)).filter(p => p && p.lat != null);

  const unassigned = places.filter(p =>
    p.lat != null &&
    !assignedElsewhere.has(p.id) &&
    !keepIds.includes(p.id) &&
    (!p.pinnedDay || p.pinnedDay === dayIndex + 1)
  );

  const dayOpts = {
    startsAtBase: schedule.days[dayIndex]?.startsAtBase !== false,
    endsAtBase: schedule.days[dayIndex]?.endsAtBase !== false,
  };
  const { route, leftover, startMin } = buildOneDay([...keepPlaces, ...unassigned], base, dayStartMin, dayEndMin, dayOpts);

  return {
    dayIndex,
    placeIds: route.map(p => p.id),
    startMin,
    ...dayOpts,
    unscheduled: leftover.map(p => ({ placeId: p.id, reason: "時間の都合で今回の日程には組み込めませんでした" })),
  };
}
