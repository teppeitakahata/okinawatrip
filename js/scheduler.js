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
  dinner: [17 * 60 + 30, 20 * 60 + 30],
};

// 到着予定時刻(分)が、その場所に設定された食事タイミングの帯からどれだけ外れているか(分)。
// 複数タイミングが選ばれていれば最も近い帯で判定する。タイミング未設定なら0(制約なし)。
function mealWindowPenaltyMinutes(mealTypes, arrivalMin) {
  if (!mealTypes?.length) return 0;
  let best = Infinity;
  for (const mt of mealTypes) {
    const w = MEAL_WINDOWS[mt];
    if (!w) continue;
    const d = arrivalMin < w[0] ? w[0] - arrivalMin : arrivalMin > w[1] ? arrivalMin - w[1] : 0;
    if (d < best) best = d;
  }
  return best === Infinity ? 0 : best;
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

export function computeDayTimeline(route, base, dayStartMin) {
  const items = [];
  let time = dayStartMin;
  let prev = base;
  for (const stop of route) {
    const km = haversineKm(prev, stop);
    const travelMin = driveMinutes(prev, stop);
    const arrival = time + travelMin;
    const departure = arrival + (stop.durationMin || 30);
    items.push({ place: stop, travelMin, distanceKm: km, arrival, departure });
    time = departure;
    prev = stop;
  }
  const travelBackMin = driveMinutes(prev, base);
  const returnTime = time + travelBackMin;
  return { items, returnTime, travelBackMin };
}

// 移動距離(km)に、食事タイミングのズレ(分)を加味したコストを加算して比較する。
// 3分のズレ ≒ 1kmの遠回りとして重み付け(数時間ズレたら大きな遠回りと同等に扱われ、
// 食事の場所は自然と朝食/ランチ/ディナーの時間帯に収まるよう並び替えられる)。
const MEAL_PENALTY_MIN_PER_KM = 3;

function routeCost(route, base, dayStartMin) {
  const timeline = computeDayTimeline(route, base, dayStartMin);
  const last = route.length ? route[route.length - 1] : base;
  let km = timeline.items.reduce((s, it) => s + it.distanceKm, 0) + haversineKm(last, base);
  let penaltyMin = 0;
  timeline.items.forEach(it => { penaltyMin += mealWindowPenaltyMinutes(it.place.mealTypes, it.arrival); });
  return km + penaltyMin / MEAL_PENALTY_MIN_PER_KM;
}

// 各ステップで「距離+食事タイミングのズレ」が最小の場所を選んでいく貪欲法。
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
      const score = haversineKm(current, s) + mealWindowPenaltyMinutes(s.mealTypes, arrival) / MEAL_PENALTY_MIN_PER_KM;
      if (score < bestScore) { bestScore = score; bestIdx = i; bestArrival = arrival; }
    });
    const [next] = remaining.splice(bestIdx, 1);
    route.push(next);
    time = bestArrival + (next.durationMin || 30);
    current = next;
  }
  return route;
}

// その日の最初の訪問先が食事場所の場合、素の出発時刻(dayStartMin)のままだと
// 朝一で到着してしまう(=ランチの店に9時到着など)ことがある。帰着が終了時刻に収まる
// 範囲で出発を遅らせ、最初の到着が食事の時間帯に収まるよう調整する。
function bestStartDelay(route, base, dayStartMin, dayEndMin, currentReturnTime) {
  if (!route.length) return 0;
  const first = route[0];
  if (!first.mealTypes?.length) return 0;
  const naiveArrival = dayStartMin + driveMinutes(base, first);

  let neededDelay = 0;
  for (const mt of first.mealTypes) {
    const w = MEAL_WINDOWS[mt];
    if (!w) continue;
    if (naiveArrival >= w[0] && naiveArrival <= w[1]) return 0;
    if (naiveArrival < w[0]) {
      const d = w[0] - naiveArrival;
      if (neededDelay === 0 || d < neededDelay) neededDelay = d;
    }
  }
  if (neededDelay === 0) return 0;
  const slack = dayEndMin + 15 - currentReturnTime;
  return Math.max(0, Math.min(neededDelay, slack));
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

export function buildSchedule({ places, settings }) {
  const numDays = Math.max(1, Number(settings.days) || 1);
  const base = settings.base;
  const dayStartMin = parseHHMM(settings.dayStart);
  const dayEndMin = parseHHMM(settings.dayEnd);

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
    let route = twoOptImprove(greedyRoute(stops, base, dayStartMin), base, dayStartMin);
    let timeline = computeDayTimeline(route, base, dayStartMin);
    const dayLeftover = [];

    let guard = 0;
    while (timeline.returnTime > dayEndMin + 15 && guard < 20) {
      guard++;
      const removable = route
        .map((p, i) => ({ p, i }))
        .filter(x => x.p.priority !== "must")
        .sort((a, b) => PRIORITY_RANK[b.p.priority] - PRIORITY_RANK[a.p.priority]);
      if (!removable.length) break;
      const { i } = removable[0];
      dayLeftover.push(route[i]);
      route = [...route.slice(0, i), ...route.slice(i + 1)];
      timeline = computeDayTimeline(route, base, dayStartMin);
    }

    const delay = bestStartDelay(route, base, dayStartMin, dayEndMin, timeline.returnTime);
    const startMin = dayStartMin + delay;
    if (delay > 0) timeline = computeDayTimeline(route, base, startMin);

    return { dayIndex: idx, route, timeline, leftover: dayLeftover, startMin };
  });

  // あふれた場所を、時間に余裕がある他の日へ挿入できないか試す
  const stillUnscheduled = [];
  days.forEach(day => {
    day.leftover.forEach(place => {
      let placed = false;
      for (const target of days) {
        if (target === day) continue;
        const testRoute = [...target.route, place];
        const testTimeline = computeDayTimeline(testRoute, base, target.startMin);
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
    })),
    unscheduled: unscheduled.map(u => ({ placeId: u.place.id, reason: u.reason })),
  };
}
