import { store, dedupePlaces } from "./storage.js";
import { geocodeAddress, googleMapsUrl, googleMapsDirectionsUrl, driveMinutes } from "./geo.js";
import { initPlacesUI, CATEGORY_META, TRANSPORT_META } from "./places.js";
import { computeManualDay, parseHHMM, minutesToHHMM } from "./scheduler.js";
import { toast } from "./ui-helpers.js";

let placesUI = null;

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}

let activeDay = 0;
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

function getPlacesById() {
  return new Map(store.getPlaces().map(p => [p.id, p]));
}

function ensureScheduleShape(settings) {
  let schedule = store.getSchedule();
  const numDays = Math.max(1, Number(settings.days) || 1);
  if (!schedule || !Array.isArray(schedule.days)) {
    schedule = { days: [] };
  }
  while (schedule.days.length < numDays) {
    schedule.days.push({ dayIndex: schedule.days.length, placeIds: [], startTimes: {} });
  }
  schedule.days = schedule.days.slice(0, numDays);
  schedule.days.forEach(d => {
    if (d.startsAtBase === undefined) d.startsAtBase = true;
    if (d.endsAtBase === undefined) d.endsAtBase = true;
    if (!d.startTimes) d.startTimes = {};
  });
  return schedule;
}

function formatDayLabel(settings, idx) {
  if (!settings.startDate) return `Day${idx + 1}`;
  const d = new Date(settings.startDate);
  d.setDate(d.getDate() + idx);
  return `Day${idx + 1} ${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})`;
}

function switchMainTab(view) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === `view-${view}`));
}

function renderDayTabs() {
  const settings = store.getSettings();
  const schedule = ensureScheduleShape(settings);
  store.setSchedule(schedule);

  const wrap = document.getElementById("dayTabs");
  wrap.innerHTML = schedule.days.map((d, idx) =>
    `<button class="day-pill ${idx === activeDay ? "active" : ""}" data-day="${idx}">${formatDayLabel(settings, idx)}</button>`
  ).join("");
  wrap.querySelectorAll(".day-pill").forEach(btn =>
    btn.addEventListener("click", () => { activeDay = Number(btn.dataset.day); renderDayTabs(); renderTimeline(); })
  );
}

// 新しく日程に追加する予定の、開始時刻の初期値を決める。
// 固定時刻があればそれ、無ければ「前の予定の終了＋移動」または拠点発の目安。
function assignPlaceToDay(schedule, dayIdx, placeId, settings) {
  const day = schedule.days[dayIdx];
  if (day.placeIds.includes(placeId)) return;
  const placesById = getPlacesById();
  const newPlace = placesById.get(placeId);
  const route = day.placeIds.map(id => placesById.get(id)).filter(Boolean);
  const dayStartMin = toMinutes(settings.dayStart);
  const byCar = (newPlace?.arrivalMode || "car") === "car";

  let suggested;
  if (route.length === 0) {
    let travel = 0;
    if (day.startsAtBase !== false && byCar && newPlace?.lat != null && settings.base?.lat != null) {
      travel = driveMinutes(settings.base, newPlace);
    }
    suggested = dayStartMin + travel;
  } else {
    const prev = route[route.length - 1];
    const pt = day.startTimes[prev.id];
    const prevEnd = (pt ? parseHHMM(pt) : dayStartMin) + (prev.durationMin || 30);
    let travel = 0;
    if (byCar && prev.lat != null && newPlace?.lat != null) travel = driveMinutes(prev, newPlace);
    suggested = prevEnd + travel;
  }

  day.placeIds.push(placeId);
  day.startTimes[placeId] = newPlace?.fixedTime ? newPlace.fixedTime : minutesToHHMM(suggested);
}

function renderTimeline() {
  const settings = store.getSettings();
  const schedule = ensureScheduleShape(settings);
  const placesById = getPlacesById();
  const dayEndMin = toMinutes(settings.dayEnd);
  const timelineEl = document.getElementById("dayTimeline");
  const warnEl = document.getElementById("dayWarning");

  const day = schedule.days[activeDay] || { placeIds: [], startTimes: {} };
  const route = day.placeIds.map(id => placesById.get(id)).filter(Boolean);
  const hasBase = settings.base?.lat != null;
  const dayOpts = { startsAtBase: day.startsAtBase !== false, endsAtBase: day.endsAtBase !== false };
  const baseName = escapeHtml(settings.base?.name || "拠点");

  const { items, baseDepart, baseReturn } = computeManualDay(route, settings.base, day.startTimes || {}, dayOpts);

  let html = `
    <div class="day-base-toggles">
      <label><input type="checkbox" id="startsAtBaseChk" ${dayOpts.startsAtBase ? "checked" : ""}> 朝、${baseName}から出発する</label>
      <label><input type="checkbox" id="endsAtBaseChk" ${dayOpts.endsAtBase ? "checked" : ""}> 夜、${baseName}に戻る</label>
      <p class="hint">初日（空港着）や最終日（空港発）など、ホテル発着でない日はチェックを外してください。各予定の時刻は自分で入力できます。アプリは予定どうしの間隔に無理がないかだけを確認します。</p>
    </div>`;

  if (dayOpts.startsAtBase && hasBase) {
    html += `
      <div class="tl-item">
        <div class="tl-time">${baseDepart != null ? minutesToHHMM(baseDepart) : "—"}</div>
        <div class="tl-line"><div class="tl-dot"></div><div class="tl-connector"></div></div>
        <div class="tl-card tl-base-card">
          <div class="tl-card-title">🏨 ${baseName} 出発</div>
          ${baseDepart != null ? `<div class="tl-card-sub">最初の予定に間に合う出発の目安: ${minutesToHHMM(baseDepart)}頃</div>` : ""}
        </div>
      </div>`;
  }

  items.forEach((it, idx) => {
    const p = it.place;
    const cat = CATEGORY_META[p.category] || CATEGORY_META.other;
    const hasCoords = p.lat != null && p.lng != null;

    if (it.hasLeg) {
      if (it.mode === "car") {
        if (it.estimated) {
          html += `<div class="tl-travel">🚗 車で約${it.travelMin}分（約${Math.round(it.distanceKm * 10) / 10}km・推定）</div>`;
        } else {
          html += `<div class="tl-travel">🚗 車で移動（距離を計算できません）</div>`;
        }
      } else {
        const tm = TRANSPORT_META[it.mode] || TRANSPORT_META.other;
        html += `<div class="tl-travel">${tm.icon} ${tm.label}で移動</div>`;
      }
    }

    const gapNote = it.warning
      ? `<div class="tl-card-note warn">⚠ ${escapeHtml(it.warning)}</div>`
      : (it.freeGapMin != null && it.freeGapMin >= 30
          ? `<div class="tl-card-note">🕒 前の予定から約${it.freeGapMin}分の空き時間があります。</div>`
          : "");

    const endLabel = it.endMin != null ? `〜 ${minutesToHHMM(it.endMin)}` : "";
    const mapLinks = [];
    if (hasCoords) {
      mapLinks.push(`<a href="${googleMapsUrl(p)}" target="_blank" rel="noopener">🗺️ 地図</a>`);
      if (it.mode === "car" && it.hasLeg) {
        const from = idx === 0 ? settings.base : items[idx - 1].place;
        mapLinks.push(`<a href="${googleMapsDirectionsUrl(from, p)}" target="_blank" rel="noopener">🚗 ここまでのルート</a>`);
      }
    }

    html += `
      <div class="tl-item ${it.warning ? "tl-item-warn" : ""}" data-place-id="${p.id}">
        <div class="tl-time">
          <input type="time" class="tl-time-input" data-time="${p.id}" value="${escapeAttr(day.startTimes[p.id] || "")}">
        </div>
        <div class="tl-line"><div class="tl-dot"></div><div class="tl-connector"></div></div>
        <div class="tl-card">
          <div class="tl-card-top">
            <div>
              <div class="tl-card-title">${cat.icon} ${escapeHtml(p.name)}</div>
              <div class="tl-card-sub">滞在${p.durationMin}分 ${endLabel}${p.hours ? " ・ " + escapeHtml(p.hours) : ""}</div>
            </div>
            <div class="tl-controls">
              <button data-act="up" data-idx="${idx}" aria-label="上へ">▲</button>
              <button data-act="down" data-idx="${idx}" aria-label="下へ">▼</button>
              <button data-act="remove" data-idx="${idx}" aria-label="外す">✕</button>
            </div>
          </div>
          ${gapNote}
          ${p.note ? `<div class="tl-card-note">💡 ${escapeHtml(p.note)}</div>` : ""}
          ${subLocsHtml(p)}
          ${mapLinks.length ? `<div class="map-links">${mapLinks.join("")}</div>` : ""}
          <select class="tl-move-select" data-move="${idx}">
            ${schedule.days.map((_, di) => `<option value="${di}" ${di === activeDay ? "selected" : ""}>${formatDayLabel(settings, di)}へ移動</option>`).join("")}
          </select>
        </div>
      </div>`;
  });

  if (dayOpts.endsAtBase && hasBase) {
    html += `
      <div class="tl-item">
        <div class="tl-time">${baseReturn != null ? minutesToHHMM(baseReturn) : "—"}</div>
        <div class="tl-line"><div class="tl-dot"></div></div>
        <div class="tl-card tl-base-card">
          <div class="tl-card-title">🏨 ${baseName} 帰着</div>
          ${baseReturn != null ? `<div class="tl-card-sub">最後の予定からの帰着目安: ${minutesToHHMM(baseReturn)}頃</div>` : ""}
        </div>
      </div>`;
  }

  html += `<div class="section-toolbar" style="margin-top:22px">
    <button id="manualAddBtn" class="btn primary">＋ この日に予定を手動で追加</button>
  </div>`;

  const unassigned = store.getPlaces().filter(p => !schedule.days.some(d => d.placeIds.includes(p.id)));
  if (unassigned.length) {
    html += `<div class="section-toolbar"><span class="muted">登録済みで、この日程にまだ入っていない場所（タップで追加）</span></div>`;
    html += unassigned.map(p => {
      const cat = CATEGORY_META[p.category] || CATEGORY_META.other;
      return `<div class="place-card" data-priority="${p.priority}">
        <div class="place-card-top">
          <div class="place-name">${cat.icon} ${escapeHtml(p.name)}</div>
          <div class="place-actions"><button data-add-to-day="${p.id}" class="btn small">＋ この日に追加</button></div>
        </div>
      </div>`;
    }).join("");
  }

  timelineEl.innerHTML = html;

  // 全体の注意サマリー
  const conflictCount = items.filter(it => it.warning).length;
  const missingTime = items.filter(it => it.startMin == null).length;
  const overEnd = baseReturn != null && baseReturn > dayEndMin + 15;
  const notes = [];
  if (conflictCount) notes.push(`時間に無理がある区間が${conflictCount}件あります（赤い注意を確認）`);
  if (missingTime) notes.push(`時刻が未入力の予定が${missingTime}件あります`);
  if (overEnd) notes.push(`帰着が終了時刻(${settings.dayEnd})を超える見込みです`);
  if (notes.length) {
    warnEl.hidden = false;
    warnEl.textContent = "⚠ " + notes.join(" / ");
  } else {
    warnEl.hidden = true;
  }

  wireTimelineEvents(schedule, settings);
}

function wireTimelineEvents(schedule, settings) {
  const timelineEl = document.getElementById("dayTimeline");

  const startsChk = document.getElementById("startsAtBaseChk");
  const endsChk = document.getElementById("endsAtBaseChk");
  if (startsChk) startsChk.addEventListener("change", () => {
    schedule.days[activeDay].startsAtBase = startsChk.checked;
    store.setSchedule(schedule);
    renderTimeline();
  });
  if (endsChk) endsChk.addEventListener("change", () => {
    schedule.days[activeDay].endsAtBase = endsChk.checked;
    store.setSchedule(schedule);
    renderTimeline();
  });

  timelineEl.querySelectorAll("[data-time]").forEach(inp => {
    inp.addEventListener("change", () => {
      schedule.days[activeDay].startTimes[inp.dataset.time] = inp.value;
      store.setSchedule(schedule);
      renderTimeline();
    });
  });

  timelineEl.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const act = btn.dataset.act;
      const ids = schedule.days[activeDay].placeIds;
      if (act === "up" && idx > 0) [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
      if (act === "down" && idx < ids.length - 1) [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]];
      if (act === "remove") {
        const [removed] = ids.splice(idx, 1);
        delete schedule.days[activeDay].startTimes[removed];
      }
      store.setSchedule(schedule);
      renderTimeline();
    });
  });

  timelineEl.querySelectorAll("[data-move]").forEach(sel => {
    sel.addEventListener("change", () => {
      const idx = Number(sel.dataset.move);
      const targetDay = Number(sel.value);
      if (targetDay === activeDay) return;
      const [placeId] = schedule.days[activeDay].placeIds.splice(idx, 1);
      const time = schedule.days[activeDay].startTimes[placeId];
      delete schedule.days[activeDay].startTimes[placeId];
      schedule.days[targetDay].placeIds.push(placeId);
      if (time) schedule.days[targetDay].startTimes[placeId] = time;
      store.setSchedule(schedule);
      renderTimeline();
      toast(`${formatDayLabel(settings, targetDay)}に移動しました`);
    });
  });

  timelineEl.querySelectorAll("[data-add-to-day]").forEach(btn => {
    btn.addEventListener("click", () => {
      assignPlaceToDay(schedule, activeDay, btn.dataset.addToDay, settings);
      store.setSchedule(schedule);
      renderTimeline();
    });
  });

  const manualBtn = document.getElementById("manualAddBtn");
  if (manualBtn) {
    manualBtn.addEventListener("click", () => {
      const targetDay = activeDay;
      placesUI.openModal(null, savedId => {
        const sch = ensureScheduleShape(store.getSettings());
        assignPlaceToDay(sch, targetDay, savedId, store.getSettings());
        store.setSchedule(sch);
        switchMainTab("schedule");
        activeDay = targetDay;
        renderDayTabs();
        renderTimeline();
        toast("この日に追加しました");
      });
    });
  }
}

function subLocsHtml(p) {
  if (!p.subLocations?.length) return "";
  return `<div class="sub-loc-list">${p.subLocations.map(s => `
    <div class="sub-loc-item">
      <span>📍 ${escapeHtml(s.label || "サブ地点")}: ${escapeHtml(s.address || "")}</span>
      <a href="${googleMapsUrl(s)}" target="_blank" rel="noopener">地図</a>
    </div>`).join("")}</div>`;
}

function toMinutes(hhmm) {
  const [h, m] = (hhmm || "09:00").split(":").map(Number);
  return h * 60 + m;
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) { return escapeHtml(str); }

function openSettingsModal() {
  const s = store.getSettings();
  document.getElementById("st-start-date").value = s.startDate || "";
  document.getElementById("st-days").value = s.days || 5;
  document.getElementById("st-base-address").value = s.base?.address || "";
  document.getElementById("st-base-name").value = s.base?.name || "";
  document.getElementById("st-day-start").value = s.dayStart || "09:00";
  document.getElementById("st-day-end").value = s.dayEnd || "19:00";
  const modal = document.getElementById("settingsModal");
  modal.dataset.lat = s.base?.lat ?? "";
  modal.dataset.lng = s.base?.lng ?? "";
  document.getElementById("st-geo-status").textContent = s.base?.lat != null ? "緯度経度: 取得済み" : "";
  document.getElementById("st-geo-status").className = s.base?.lat != null ? "geo-status ok" : "geo-status";
  modal.hidden = false;
}

function initSettingsUI() {
  document.getElementById("settingsBtn").addEventListener("click", openSettingsModal);
  document.getElementById("settingsModal").querySelectorAll("[data-close-modal]").forEach(btn =>
    btn.addEventListener("click", () => { document.getElementById("settingsModal").hidden = true; })
  );

  document.getElementById("st-geocode-base").addEventListener("click", async () => {
    const addr = document.getElementById("st-base-address").value;
    const statusEl = document.getElementById("st-geo-status");
    statusEl.textContent = "検索中...";
    statusEl.className = "geo-status";
    try {
      const r = await geocodeAddress(addr);
      const modal = document.getElementById("settingsModal");
      modal.dataset.lat = r.lat;
      modal.dataset.lng = r.lng;
      statusEl.textContent = (r.approx ? "おおよその位置（町丁目単位）: " : "見つかりました: ") + r.displayName;
      statusEl.className = "geo-status ok";
    } catch (e) {
      statusEl.textContent = e.message;
      statusEl.className = "geo-status err";
    }
  });

  document.getElementById("st-save").addEventListener("click", async () => {
    const modal = document.getElementById("settingsModal");
    const address = document.getElementById("st-base-address").value.trim();
    let lat = modal.dataset.lat ? Number(modal.dataset.lat) : null;
    let lng = modal.dataset.lng ? Number(modal.dataset.lng) : null;
    if ((lat == null || Number.isNaN(lat)) && address) {
      try {
        const r = await geocodeAddress(address);
        lat = r.lat; lng = r.lng;
      } catch (e) {
        toast(`住所検索に失敗しました: ${e.message}`);
      }
    }
    const settings = {
      startDate: document.getElementById("st-start-date").value,
      days: Math.min(14, Math.max(1, Number(document.getElementById("st-days").value) || 5)),
      base: { name: document.getElementById("st-base-name").value.trim(), address, lat, lng },
      dayStart: document.getElementById("st-day-start").value || "09:00",
      dayEnd: document.getElementById("st-day-end").value || "19:00",
    };
    store.setSettings(settings);
    document.getElementById("settingsModal").hidden = true;
    activeDay = 0;
    renderDayTabs();
    renderTimeline();
    toast("設定を保存しました");
  });
}

function init() {
  document.getElementById("mainTabs").querySelectorAll(".tab-btn").forEach(btn =>
    btn.addEventListener("click", () => switchMainTab(btn.dataset.view))
  );

  const removed = dedupePlaces();
  if (removed > 0) toast(`重複していた${removed}件を自動で整理しました`);

  initSettingsUI();
  placesUI = initPlacesUI({ onChange: () => renderTimeline() });
  renderDayTabs();
  renderTimeline();

  if (!store.getSettings().base?.address) {
    switchMainTab("wishlist");
  }
}

init();
