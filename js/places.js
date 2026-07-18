import { store, uid } from "./storage.js";
import { geocodeAddress, geocodeByName, googleMapsUrl, tabelogSearchUrl } from "./geo.js";
import { toast, confirmDialog } from "./ui-helpers.js";

export const MEAL_META = {
  breakfast: { label: "朝食", icon: "🍳" },
  lunch: { label: "ランチ", icon: "🍱" },
  dinner: { label: "ディナー", icon: "🌙" },
};

export const TIME_OF_DAY_META = {
  morning: { label: "午前", icon: "🌅" },
  afternoon: { label: "午後", icon: "☀️" },
  evening: { label: "夜", icon: "🌙" },
};

export const CATEGORY_META = {
  food: { label: "食事", icon: "🍜", defaultMinutes: 60 },
  sight: { label: "観光・景勝地", icon: "🏯", defaultMinutes: 45 },
  beach: { label: "ビーチ・海", icon: "🏖️", defaultMinutes: 90 },
  activity: { label: "アクティビティ", icon: "🤿", defaultMinutes: 90 },
  shopping: { label: "買い物", icon: "🛍️", defaultMinutes: 45 },
  other: { label: "その他", icon: "📍", defaultMinutes: 30 },
};

export const PRIORITY_META = {
  must: { label: "絶対行く" },
  want: { label: "できれば行く" },
  maybe: { label: "候補" },
};

let editingId = null;
let subLocations = [];
let isSaving = false; // 保存処理中の二重実行(=重複登録)を防ぐガード
let afterSaveOnce = null; // 新規保存後に一度だけ呼ぶコールバック(日程への手動追加用)

export function initPlacesUI({ onChange } = {}) {
  const listEl = document.getElementById("placeList");
  const emptyHint = document.getElementById("placeEmptyHint");
  const countEl = document.getElementById("placeCount");
  const modal = document.getElementById("placeModal");

  document.getElementById("addPlaceBtn").addEventListener("click", () => openPlaceModal(null));
  document.getElementById("pf-add-sub").addEventListener("click", () => {
    subLocations.push({ id: uid(), label: "", address: "", lat: null, lng: null });
    renderSubLocations();
  });
  document.getElementById("pf-geocode-main").addEventListener("click", () => geocodeMain());
  document.getElementById("pf-save").addEventListener("click", () => savePlace());
  document.getElementById("pf-delete").addEventListener("click", () => deletePlace());
  document.getElementById("pf-category").addEventListener("change", e => toggleMealFields(e.target.value));

  modal.querySelectorAll("[data-close-modal]").forEach(btn =>
    btn.addEventListener("click", () => closePlaceModal())
  );

  window.__renderPlaceList = renderPlaceList;

  function renderPlaceList() {
    const places = store.getPlaces();
    countEl.textContent = places.length ? `${places.length}件登録中` : "";
    emptyHint.classList.toggle("show", places.length === 0);
    listEl.innerHTML = places.map(placeCardHtml).join("");

    listEl.querySelectorAll("[data-edit]").forEach(btn =>
      btn.addEventListener("click", () => openPlaceModal(btn.dataset.edit))
    );
  }

  function placeCardHtml(p) {
    const cat = CATEGORY_META[p.category] || CATEGORY_META.other;
    const pr = PRIORITY_META[p.priority] || PRIORITY_META.want;
    const geoWarn = p.lat == null ? `<span class="badge warn">未検索の住所</span>` : "";
    const mealBadges = (p.mealTypes || []).map(mt => `<span class="badge">${MEAL_META[mt]?.icon || ""} ${MEAL_META[mt]?.label || mt}</span>`).join("");
    const todBadges = (p.preferredTimeOfDay || []).map(t => `<span class="badge">${TIME_OF_DAY_META[t]?.icon || ""} ${TIME_OF_DAY_META[t]?.label || t}</span>`).join("");
    const fixedBadge = p.fixedTime && p.pinnedDay
      ? `<span class="badge fixed">⏰ Day${p.pinnedDay} ${escapeHtml(p.fixedTime)}固定</span>`
      : "";
    const subHtml = (p.subLocations || []).length
      ? `<div class="sub-loc-list">${p.subLocations.map(s => `
          <div class="sub-loc-item">
            <span>📍 ${escapeHtml(s.label || "サブ地点")}: ${escapeHtml(s.address || "")}</span>
            <a href="${googleMapsUrl(s)}" target="_blank" rel="noopener">地図</a>
          </div>`).join("")}</div>`
      : "";
    const photoHtml = p.photoUrl ? `<img class="place-photo" src="${escapeAttr(p.photoUrl)}" alt="" loading="lazy">` : "";
    const links = [`<a href="${googleMapsUrl(p)}" target="_blank" rel="noopener">🗺️ Googleマップ</a>`];
    if (p.url) links.push(`<a href="${escapeAttr(p.url)}" target="_blank" rel="noopener">🔗 公式・参考サイト</a>`);
    if (p.category === "food") links.push(`<a href="${tabelogSearchUrl(p.name)}" target="_blank" rel="noopener">🍜 食べログで検索</a>`);
    return `
      <div class="place-card" data-priority="${p.priority}">
        ${photoHtml}
        <div class="place-card-top">
          <div>
            <div class="place-name">${cat.icon} ${escapeHtml(p.name)}</div>
            <div class="place-badges">
              <span class="badge">${cat.label}</span>
              <span class="badge priority-${p.priority}">${pr.label}</span>
              ${mealBadges}
              ${todBadges}
              ${fixedBadge}
              ${geoWarn}
            </div>
          </div>
          <div class="place-actions">
            <button data-edit="${p.id}" aria-label="編集">✏️</button>
          </div>
        </div>
        ${p.address ? `<p class="place-addr">${escapeHtml(p.address)}${p.hours ? " ・ " + escapeHtml(p.hours) : ""}</p>` : ""}
        ${p.note ? `<p class="place-note">${escapeHtml(p.note)}</p>` : ""}
        ${subHtml}
        <div class="map-links">${links.join("")}</div>
      </div>`;
  }

  function openPlaceModal(id, onSaved = null) {
    editingId = id;
    afterSaveOnce = onSaved;
    const p = id ? store.getPlaces().find(x => x.id === id) : null;
    document.getElementById("placeModalTitle").textContent = p ? "場所を編集" : "場所を追加";
    document.getElementById("pf-name").value = p?.name || "";
    document.getElementById("pf-category").value = p?.category || "sight";
    document.getElementById("pf-address").value = p?.address || "";
    document.getElementById("pf-url").value = p?.url || "";
    document.getElementById("pf-duration").value = p?.durationMin || CATEGORY_META[p?.category || "sight"].defaultMinutes;
    document.getElementById("pf-hours").value = p?.hours || "";
    document.getElementById("pf-priority").value = p?.priority || "want";
    document.getElementById("pf-note").value = p?.note || "";
    document.getElementById("pf-delete").hidden = !p;
    setGeoStatus("main", p?.lat != null ? `緯度経度: 取得済み` : "", p?.lat != null ? "ok" : "");
    modal.dataset.photoUrl = p?.photoUrl || "";
    const mealTypes = p?.mealTypes || [];
    document.getElementById("pf-meal-breakfast").checked = mealTypes.includes("breakfast");
    document.getElementById("pf-meal-lunch").checked = mealTypes.includes("lunch");
    document.getElementById("pf-meal-dinner").checked = mealTypes.includes("dinner");
    const tod = p?.preferredTimeOfDay || [];
    document.getElementById("pf-tod-morning").checked = tod.includes("morning");
    document.getElementById("pf-tod-afternoon").checked = tod.includes("afternoon");
    document.getElementById("pf-tod-evening").checked = tod.includes("evening");
    populatePinnedDayOptions(p?.pinnedDay || "");
    document.getElementById("pf-fixed-time").value = p?.fixedTime || "";
    toggleMealFields(p?.category || "sight");
    subLocations = p?.subLocations ? p.subLocations.map(s => ({ ...s })) : [];
    renderSubLocations();
    modal.hidden = false;
  }

  function populatePinnedDayOptions(selected) {
    const numDays = Math.max(1, Number(store.getSettings().days) || 1);
    const sel = document.getElementById("pf-pinned-day");
    const options = [`<option value="">日付を指定しない</option>`];
    for (let d = 1; d <= numDays; d++) {
      options.push(`<option value="${d}">Day${d}</option>`);
    }
    sel.innerHTML = options.join("");
    sel.value = selected || "";
  }

  function toggleMealFields(category) {
    document.getElementById("pf-mealtypes-field").hidden = category !== "food";
  }

  function closePlaceModal() {
    modal.hidden = true;
    editingId = null;
    afterSaveOnce = null;
  }

  function renderSubLocations() {
    const wrap = document.getElementById("pf-sublist");
    wrap.innerHTML = subLocations.map((s, i) => `
      <div class="sub-loc-row" data-idx="${i}">
        <div class="sub-fields">
          <input type="text" placeholder="名称（例: 第2駐車場）" data-sub-label value="${escapeAttr(s.label)}">
          <div class="addr-row">
            <input type="text" placeholder="住所" data-sub-address value="${escapeAttr(s.address)}">
            <button type="button" class="btn small" data-sub-geocode>検索</button>
          </div>
          <p class="geo-status ${s.lat != null ? "ok" : ""}" data-sub-status>${s.lat != null ? "緯度経度: 取得済み" : ""}</p>
        </div>
        <button type="button" class="remove-sub" data-sub-remove aria-label="削除">✕</button>
      </div>`).join("");

    wrap.querySelectorAll(".sub-loc-row").forEach(row => {
      const idx = Number(row.dataset.idx);
      row.querySelector("[data-sub-label]").addEventListener("input", e => {
        subLocations[idx].label = e.target.value;
      });
      row.querySelector("[data-sub-address]").addEventListener("input", e => {
        subLocations[idx].address = e.target.value;
        subLocations[idx].lat = null;
        subLocations[idx].lng = null;
      });
      row.querySelector("[data-sub-geocode]").addEventListener("click", async () => {
        const statusEl = row.querySelector("[data-sub-status]");
        const addr = subLocations[idx].address;
        statusEl.textContent = "検索中...";
        statusEl.className = "geo-status";
        try {
          const r = await geocodeAddress(addr);
          subLocations[idx].lat = r.lat;
          subLocations[idx].lng = r.lng;
          statusEl.textContent = (r.approx ? "おおよその位置（町丁目単位）: " : "見つかりました: ") + r.displayName;
          statusEl.className = "geo-status ok";
        } catch (e) {
          statusEl.textContent = e.message;
          statusEl.className = "geo-status err";
        }
      });
      row.querySelector("[data-sub-remove]").addEventListener("click", () => {
        subLocations.splice(idx, 1);
        renderSubLocations();
      });
    });
  }

  async function geocodeMain() {
    const addr = document.getElementById("pf-address").value.trim();
    const name = document.getElementById("pf-name").value.trim();
    setGeoStatus("main", "検索中...", "");
    try {
      let r;
      if (addr) {
        r = await geocodeAddress(addr);
      } else if (name) {
        r = await geocodeByName(name);
        document.getElementById("pf-address").value = r.displayName;
      } else {
        throw new Error("名前または住所を入力してください");
      }
      document.getElementById("placeModal").dataset.lat = r.lat;
      document.getElementById("placeModal").dataset.lng = r.lng;
      applyOpeningHours(r.openingHours);
      applyUrlAndPhoto(r);
      setGeoStatus("main", (r.approx ? "おおよその位置（正確な場所はGoogleマップで確認してください）: " : "見つかりました: ") + r.displayName, "ok");
    } catch (e) {
      setGeoStatus("main", e.message, "err");
    }
  }

  function applyOpeningHours(openingHours) {
    if (!openingHours) return;
    const hoursInput = document.getElementById("pf-hours");
    if (!hoursInput.value.trim()) {
      hoursInput.value = openingHours;
      toast("営業時間も見つかったので自動入力しました（要確認）");
    }
  }

  function applyUrlAndPhoto(r) {
    const urlInput = document.getElementById("pf-url");
    if (r.url && !urlInput.value.trim()) urlInput.value = r.url;
    if (r.photoUrl) modal.dataset.photoUrl = r.photoUrl;
  }

  function setGeoStatus(which, text, cls) {
    const el = document.getElementById(`pf-geo-status-${which}`);
    el.textContent = text;
    el.className = `geo-status ${cls}`;
  }

  async function savePlace() {
    if (isSaving) return; // 保存中の再クリックを無視（住所検索の待ち時間中の二重登録を防ぐ）
    const name = document.getElementById("pf-name").value.trim();
    if (!name) { toast("名前を入力してください"); return; }
    let address = document.getElementById("pf-address").value.trim();

    const saveBtn = document.getElementById("pf-save");
    isSaving = true;
    saveBtn.disabled = true;
    const savedLabel = saveBtn.textContent;
    saveBtn.textContent = "保存中...";
    try {
      await doSave(name, address);
    } finally {
      isSaving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = savedLabel;
    }
  }

  async function doSave(name, address) {
    let lat = modal.dataset.lat ? Number(modal.dataset.lat) : null;
    let lng = modal.dataset.lng ? Number(modal.dataset.lng) : null;

    const places = store.getPlaces();
    const existing = editingId ? places.find(x => x.id === editingId) : null;
    if (lat == null && existing?.address === address) {
      lat = existing.lat;
      lng = existing.lng;
    }

    if (lat == null && address) {
      setGeoStatus("main", "検索中...", "");
      try {
        const r = await geocodeAddress(address);
        lat = r.lat; lng = r.lng;
        applyOpeningHours(r.openingHours);
        applyUrlAndPhoto(r);
      } catch (e) {
        setGeoStatus("main", `${e.message}（住所は保存されますが地図上の位置が未確定です）`, "err");
      }
    } else if (lat == null && !address && name) {
      setGeoStatus("main", "検索中...", "");
      try {
        const r = await geocodeByName(name);
        lat = r.lat; lng = r.lng;
        address = r.displayName;
        document.getElementById("pf-address").value = address;
        applyOpeningHours(r.openingHours);
        applyUrlAndPhoto(r);
      } catch (e) {
        setGeoStatus("main", e.message, "err");
      }
    }

    const mealTypes = ["breakfast", "lunch", "dinner"].filter(
      mt => document.getElementById(`pf-meal-${mt}`).checked
    );
    const preferredTimeOfDay = ["morning", "afternoon", "evening"].filter(
      t => document.getElementById(`pf-tod-${t}`).checked
    );

    const pinnedDayRaw = document.getElementById("pf-pinned-day").value;
    const fixedTime = document.getElementById("pf-fixed-time").value;
    if (fixedTime && !pinnedDayRaw) {
      toast("固定時刻を使う場合は、日付（Day1など）も選択してください");
      return;
    }

    const place = {
      id: editingId || uid(),
      name,
      category: document.getElementById("pf-category").value,
      address,
      url: document.getElementById("pf-url").value.trim(),
      photoUrl: modal.dataset.photoUrl || null,
      lat, lng,
      durationMin: Number(document.getElementById("pf-duration").value) || 30,
      hours: document.getElementById("pf-hours").value.trim(),
      priority: document.getElementById("pf-priority").value,
      note: document.getElementById("pf-note").value.trim(),
      mealTypes,
      preferredTimeOfDay,
      subLocations: subLocations.filter(s => s.label || s.address),
      pinnedDay: pinnedDayRaw ? Number(pinnedDayRaw) : null,
      fixedTime: fixedTime || "",
    };

    const wasNew = !editingId;
    const next = editingId ? places.map(p => (p.id === editingId ? place : p)) : [...places, place];
    store.setPlaces(next);
    delete modal.dataset.lat;
    delete modal.dataset.lng;
    delete modal.dataset.photoUrl;
    const savedCb = afterSaveOnce; // closePlaceModalでnullになる前に退避
    closePlaceModal();
    renderPlaceList();
    onChange?.();
    if (wasNew && savedCb) savedCb(place.id);
    toast("保存しました");
  }

  async function deletePlace() {
    if (!editingId) return;
    const ok = await confirmDialog("この場所を削除しますか？", { okLabel: "削除する", danger: true });
    if (!ok) return;
    const removedId = editingId;
    store.setPlaces(store.getPlaces().filter(p => p.id !== removedId));
    // 削除した場所を日程からも取り除く
    const schedule = store.getSchedule();
    if (schedule?.days) {
      schedule.days.forEach(d => { d.placeIds = (d.placeIds || []).filter(id => id !== removedId); });
      schedule.unscheduled = (schedule.unscheduled || []).filter(u => u.placeId !== removedId);
      store.setSchedule(schedule);
    }
    closePlaceModal();
    renderPlaceList();
    onChange?.();
    toast("削除しました");
  }

  renderPlaceList();

  return { openModal: openPlaceModal, renderList: renderPlaceList };
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
