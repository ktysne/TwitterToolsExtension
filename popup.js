"use strict";

// チェックボックス型のトグル
const TOGGLES = {
  enabled: true,
  disableAutoplay: true,
  imageSave: true,
  wordMute: true,
  handleMute: true,
};

const countEl = document.getElementById("count");
const hintEl = document.getElementById("hint");
const wordsEl = document.getElementById("muteWords");
const regexEl = document.getElementById("muteRegexes");
const regexErrEl = document.getElementById("regexError");
const handlesEl = document.getElementById("muteHandles");

// 各トグルの現在値を反映＋変更を保存
chrome.storage.local.get(TOGGLES, (cfg) => {
  Object.keys(TOGGLES).forEach((key) => {
    const el = document.getElementById(key);
    if (!el) return;
    el.checked = !!cfg[key];
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [key]: el.checked });
    });
  });
});

// ワード/正規表現/@id リストの読み込み
chrome.storage.local.get(
  { muteWords: [], muteRegexes: [], muteHandles: [] },
  (cfg) => {
    wordsEl.value = (cfg.muteWords || []).join("\n");
    regexEl.value = (cfg.muteRegexes || []).join("\n");
    handlesEl.value = (cfg.muteHandles || []).join("\n");
  }
);

function parseLines(v) {
  return v
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 入力をデバウンスして保存（不正な正規表現は警告だけ出し、入力自体は保存する）
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const words = parseLines(wordsEl.value);
    const regexes = parseLines(regexEl.value);
    const handles = parseLines(handlesEl.value).map((h) => h.replace(/^@/, ""));
    const invalid = regexes.filter((src) => {
      try {
        new RegExp(src);
        return false;
      } catch (_) {
        return true;
      }
    });
    regexErrEl.textContent = invalid.length
      ? "無効な正規表現（無視されます）: " + invalid.join(" / ")
      : "";
    chrome.storage.local.set({
      muteWords: words,
      muteRegexes: regexes,
      muteHandles: handles,
    });
  }, 400);
}
wordsEl.addEventListener("input", scheduleSave);
regexEl.addEventListener("input", scheduleSave);
handlesEl.addEventListener("input", scheduleSave);

// アクティブタブでの除外件数
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs && tabs[0];
  if (!tab || !/^https?:\/\/([a-z0-9-]+\.)*(x|twitter)\.com\//.test(tab.url || "")) {
    hintEl.textContent = "x.com のタブで開くと件数が表示されます。";
    return;
  }
  // all_frames で全フレームに注入されるため、トップフレームの値だけを読む
  chrome.tabs.sendMessage(tab.id, { type: "tte-get-count" }, { frameId: 0 }, (resp) => {
    if (chrome.runtime.lastError) {
      hintEl.textContent = "ページを再読み込みすると有効になります。";
      return;
    }
    countEl.textContent = (resp && resp.total) || 0;
  });
});
