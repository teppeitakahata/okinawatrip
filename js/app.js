import { store, dedupePlaces } from "./storage.js";
import { geocodeAddress, googleMapsUrl, googleMapsDirectionsUrl } from "./geo.js";
import { initPlacesUI, CATEGORY_META } from "./places.js";
import { buildSchedule, rebuildDay, computeDayTimeline, resolveDayStartMin, minutesToHHMM } from "./scheduler.js";
import { toast, confirmDialog } from "./ui-helpers.js";

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
    schedule = { days: [], unscheduled: [] };
  }
  while (schedule.days.length < numDays) {
    schedule.days.push({ dayIndex: schedule.days.length, placeIds: [], startMin: toMinutes(settings.dayStart) });
  }
  schedule.days = schedule.days.slice(0, numDays);
  // 拠点発着フラグの既定値(未設定=true)を補う
  schedule.days.forEach(d => {
    if (d.startsAtBase === undefined) d.startsAtBase = true;
    if (d.endsAtBase === undefined) d.endsAtBase = true;
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

function renderTimeline() {
  const settings = store.getSettings();
  const schedule = ensureScheduleShape(settings);
  const placesById = getPlacesById();
  const dayStartMin = toMinutes(settings.dayStart);
  const dayEndMin = toMinutes(settings.dayEnd);
  const timelineEl = document.getElementById("dayTimeline");
  const warnEl = document.getElementById("dayWarning");
  const unschedEl = document.getElementById("unscheduledBanner");

  const day = schedule.days[activeDay] || { placeIds: [] };
  const route = day.placeIds.map(id => placesById.get(id)).filter(Boolean);
  const hasBase = settings.base?.lat != null;
  const dayOpts = { startsAtBase: day.startsAtBase !== false, endsAtBase: day.endsAtBase !== false };

  if (!hasBase) {
    timelineEl.innerHTML = `<p class="empty-hint show">まず右上の⚙️「旅の設定」で拠点（ホテル）の住所を登録してください。</p>`;
    warnEl.hidden = true;
    unschedEl.hidden = true;
    return;
  }

  // 手動追加/並べ替え後でも先頭の予定が希望の時間帯に入るよう、毎回出発時刻を計算し直す
  const effectiveStartMin = resolveDayStartMin(route, settings.base, dayStartMin, dayEndMin, dayOpts);
  const timeline = computeDayTimeline(route, settings.base, effectiveStartMin, dayOpts);
  const baseName = escapeHtml(settings.base.name || "拠点");

  let html = `
    <div class="day-base-toggles">
      <label><input type="checkbox" id="startsAtBaseChk" ${dayOpts.startsAtBase ? "checked" : ""}> 朝、${baseName}から出発する</label>
      <label><input type="checkbox" id="endsAtBaseChk" ${dayOpts.endsAtBase ? "checked" : ""}> 夜、${baseName}に戻る</label>
      <p class="hint">初日（空港着）や最終日（空港発）など、ホテル発着でない日はチェックを外してください。</p>
    </div>`;

  if (dayOpts.startsAtBase) {
    html += `
      <div class="tl-item">
        <div class="tl-time">${minutesToHHMM(effectiveStartMin)}</div>
        <div class="tl-line"><div class="tl-dot"></div><div class="tl-connector"></div></div>
        <div class="tl-card tl-base-card">
          <div class="tl-card-title">🏨 ${baseName} 出発</div>
        </div>
      </div>`;
  }

  timeline.items.forEach((it, idx) => {
    const p = it.place;
    const cat = CATEGORY_META[p.category] || CATEGORY_META.other;
    const fixedNote = p.fixedTime
      ? it.late
        ? `<div class="tl-card-note warn">⚠ この予定は${p.fixedTime}固定ですが、前の予定からだと到着が遅れる見込みです。順番を調整してください。</div>`
        : `<div class="tl-card-note">⏰ ${p.fixedTime}に固定（早く着く場合は時間まで待機）</div>`
      : "";
    const hasCoords = p.lat != null && p.lng != null;
    if (it.travelMin > 0) {
      html += `<div class="tl-travel">🚗 車で約${it.travelMin}分（約${Math.round(it.distanceKm * 10) / 10}km・推定）</div>`;
    }
    const mapLinks = [];
    if (hasCoords) {
      mapLinks.push(`<a href="${googleMapsUrl(p)}" target="_blank" rel="noopener">🗺️ 地図</a>`);
      mapLinks.push(`<a href="${googleMapsDirectionsUrl(idx === 0 ? settings.base : timeline.items[idx - 1].place, p)}" target="_blank" rel="noopener">🚗 ここまでのルート</a>`);
    }
    html += `
      <div class="tl-item" data-place-id="${p.id}">
        <div class="tl-time">${minutesToHHMM(it.arrival)}</div>
        <div class="tl-line"><div class="tl-dot"></div><div class="tl-connector"></div></div>
        <div class="tl-card">
          <div class="tl-card-top">
            <div>
              <div class="tl-card-title">${cat.icon} ${escapeHtml(p.name)}</div>
              <div class="tl-card-sub">${minutesToHHMM(it.arrival)} 〜 ${minutesToHHMM(it.departure)}（滞在${p.durationMin}分）${p.hours ? " ・ " + escapeHtml(p.hours) : ""}</div>
            </div>
            <div class="tl-controls">
              <button data-act="up" data-idx="${idx}" aria-label="上へ">▲</button>
              <button data-act="down" data-idx="${idx}" aria-label="下へ">▼</button>
              <button data-act="remove" data-idx="${idx}" aria-label="外す">✕</button>
            </div>
          </div>
          ${fixedNote}
          ${p.note ? `<div class="tl-card-note">💡 ${escapeHtml(p.note)}</div>` : ""}
          ${subLocsHtml(p)}
          ${mapLinks.length ? `<div class="map-links">${mapLinks.join("")}</div>` : ""}
          <select class="tl-move-select" data-move="${idx}">
            ${schedule.days.map((_, di) => `<option value="${di}" ${di === activeDay ? "selected" : ""}>${formatDayLabel(settings, di)}へ移動</option>`).join("")}
          </select>
        </div>
      </div>`;
  });

  if (dayOpts.endsAtBase) {
    if (timeline.travelBackMin > 0) {
      html += `<div class="tl-travel">🚗 車で約${timeline.travelBackMin}分で${baseName}へ</div>`;
    }
    html += `
      <div class="tl-item">
        <div class="tl-time">${minutesToHHMM(timeline.returnTime)}</div>
        <div class="tl-line"><div class="tl-dot"></div></div>
        <div class="tl-card tl-base-card">
          <div class="tl-card-title">🏨 ${baseName} 帰着</div>
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

  if (timeline.returnTime > dayEndMin + 15) {
    warnEl.hidden = false;
    const tail = dayOpts.endsAtBase ? `${baseName}帰着` : "最後の予定終了";
    warnEl.textContent = `⚠ ${tail}が${minutesToHHMM(timeline.returnTime)}頃になり、設定した終了時刻(${settings.dayEnd})を超える見込みです。予定を減らすか、AIで再作成してください。`;
  } else {
    warnEl.hidden = true;
  }

  const lastUnscheduled = schedule.unscheduled || [];
  if (lastUnscheduled.length) {
    unschedEl.hidden = false;
    unschedEl.innerHTML = "⚠ 組み込めなかった場所:<br>" + lastUnscheduled.map(u => {
      const p = placesById.get(u.placeId);
      return `・${escapeHtml(p?.name || "?")} — ${escapeHtml(u.reason)}`;
    }).join("<br>");
  } else {
    unschedEl.hidden = true;
  }

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

  timelineEl.querySelectorAll("[data-act]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.idx);
      const act = btn.dataset.act;
      const ids = schedule.days[activeDay].placeIds;
      if (act === "up" && idx > 0) [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
      if (act === "down" && idx < ids.length - 1) [ids[idx + 1], ids[idx]] = [ids[idx], ids[idx + 1]];
      if (act === "remove") ids.splice(idx, 1);
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
      schedule.days[targetDay].placeIds.push(placeId);
      store.setSchedule(schedule);
      renderTimeline();
      toast(`${formatDayLabel(settings, targetDay)}に移動しました`);
    });
  });

  timelineEl.querySelectorAll("[data-add-to-day]").forEach(btn => {
    btn.addEventListener("click", () => {
      schedule.days[activeDay].placeIds.push(btn.dataset.addToDay);
      schedule.unscheduled = (schedule.unscheduled || []).filter(u => u.placeId !== btn.dataset.addToDay);
      store.setSchedule(schedule);
      renderTimeline();
    });
  });

  const manualBtn = document.getElementById("manualAddBtn");
  if (manualBtn) {
    manualBtn.addEventListener("click", () => {
      if (settings.base?.lat == null) {
        toast("先に「旅の設定」で拠点の住所を保存してください");
        return;
      }
      const targetDay = activeDay;
      // 場所の追加モーダルを開き、保存されたらその新規予定をこの日に割り当てる
      placesUI.openModal(null, savedId => {
        const sch = ensureScheduleShape(store.getSettings());
        if (!sch.days[targetDay].placeIds.includes(savedId)) {
          sch.days[targetDay].placeIds.push(savedId);
        }
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

async function runAiBuild() {
  const settings = store.getSettings();
  if (settings.base?.lat == null) {
    toast("先に「旅の設定」で拠点の住所を検索・保存してください");
    openSettingsModal();
    return;
  }
  const places = store.getPlaces();
  if (!places.length) {
    toast("行きたい場所をまず登録してください");
    return;
  }
  const existing = store.getSchedule();
  const hasContent = existing?.days?.some(d => d.placeIds?.length);
  if (hasContent) {
    const ok = await confirmDialog("既存の日程を上書きしてAIで再作成します。よろしいですか？", { okLabel: "再作成する" });
    if (!ok) return;
  }

  // 各日の「拠点発着」設定はAI再作成でも維持する
  const shaped = ensureScheduleShape(settings);
  const dayOptions = shaped.days.map(d => ({ startsAtBase: d.startsAtBase !== false, endsAtBase: d.endsAtBase !== false }));

  const result = buildSchedule({ places, settings, dayOptions });
  store.setSchedule(result);
  activeDay = 0;
  renderDayTabs();
  renderTimeline();
  toast("日程を作成しました");
}

function runRebuildDay() {
  const settings = store.getSettings();
  if (settings.base?.lat == null) {
    toast("先に「旅の設定」で拠点の住所を検索・保存してください");
    return;
  }
  const schedule = ensureScheduleShape(settings);
  const places = store.getPlaces();

  const result = rebuildDay({ dayIndex: activeDay, places, schedule, settings });
  schedule.days[activeDay] = {
    dayIndex: result.dayIndex, placeIds: result.placeIds, startMin: result.startMin,
    startsAtBase: result.startsAtBase, endsAtBase: result.endsAtBase,
  };

  const allPlacedIds = new Set(schedule.days.flatMap(d => d.placeIds));
  const otherUnscheduled = (schedule.unscheduled || []).filter(u => !allPlacedIds.has(u.placeId));
  result.unscheduled.forEach(u => {
    if (!otherUnscheduled.some(x => x.placeId === u.placeId)) otherUnscheduled.push(u);
  });
  schedule.unscheduled = otherUnscheduled;

  store.setSchedule(schedule);
  renderTimeline();
  toast("この日をAIで再調整しました");
}

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
  document.getElementById("aiBuildBtn").addEventListener("click", runAiBuild);
  document.getElementById("rebuildDayBtn").addEventListener("click", runRebuildDay);

  // 過去の二重登録バグで残った完全重複を起動時に一度だけ整理する
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
