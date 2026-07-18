let toastTimer = null;

export function toast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// iOSのホーム画面PWA(standalone)ではブラウザ標準の confirm() が無効化され、
// ダイアログが出ずに false を返すことがある（=削除ボタンが効かない原因）。
// そこで確認ダイアログを自前のDOMで実装し、確実に動くようにする。
export function confirmDialog(message, { okLabel = "OK", cancelLabel = "キャンセル", danger = false } = {}) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "confirm-overlay";
    overlay.innerHTML = `
      <div class="confirm-box" role="dialog" aria-modal="true">
        <p class="confirm-msg"></p>
        <div class="confirm-actions">
          <button class="btn" data-cancel></button>
          <button class="btn ${danger ? "danger" : "primary"}" data-ok></button>
        </div>
      </div>`;
    overlay.querySelector(".confirm-msg").textContent = message;
    overlay.querySelector("[data-ok]").textContent = okLabel;
    overlay.querySelector("[data-cancel]").textContent = cancelLabel;

    function close(result) {
      overlay.remove();
      resolve(result);
    }
    overlay.querySelector("[data-ok]").addEventListener("click", () => close(true));
    overlay.querySelector("[data-cancel]").addEventListener("click", () => close(false));
    overlay.addEventListener("click", e => { if (e.target === overlay) close(false); });
    document.body.appendChild(overlay);
  });
}
