"use strict";

// チェックボックス型のトグル
const TOGGLES = {
  enabled: true,
  disableAutoplay: true,
  imageSave: true,
  cleanLink: true,
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
    // 読み込んだ内容を保存済みの基準にする（無変更で閉じても再書き込みしない）
    lastSaved = JSON.stringify([
      parseLines(wordsEl.value),
      parseLines(regexEl.value),
      parseLines(handlesEl.value).map((h) => h.replace(/^@/, "")),
    ]);
    // 読み込み完了。これ以降のみ保存を許可する（空での上書きを防ぐ）
    loaded = true;
  }
);

function parseLines(v) {
  return v
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

// 入力内容を保存する（不正な正規表現は警告だけ出し、入力自体は保存する）
let saveTimer = null;
let lastSaved = "";
// ストレージ読み込みが完了するまで保存しない。
// 読み込み前に閉じる/隠れると textarea は空のままで、既存ルールを空配列で
// 上書きしてしまう race を防ぐ。
let loaded = false;

function doSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // まだ読み込めていない場合は何もしない（空での上書き防止）
  if (!loaded) return;
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
  // 変化が無ければ書き込まない（閉じる時の多重発火対策）
  const snapshot = JSON.stringify([words, regexes, handles]);
  if (snapshot === lastSaved) return;
  lastSaved = snapshot;
  chrome.storage.local.set({
    muteWords: words,
    muteRegexes: regexes,
    muteHandles: handles,
  });
}

// 入力中はデバウンスして保存
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}
wordsEl.addEventListener("input", scheduleSave);
regexEl.addEventListener("input", scheduleSave);
handlesEl.addEventListener("input", scheduleSave);

// ポップアップが閉じる/隠れる/フォーカスを失う直前に確実に保存する。
// （デバウンスのタイマーが発火する前に閉じると保存が失われるため）
document.addEventListener("visibilitychange", () => {
  if (document.hidden) doSave();
});
window.addEventListener("pagehide", doSave);
window.addEventListener("blur", doSave);
// 入力欄からフォーカスが外れた時点でも保存（貼り付け→別操作で確実に）
wordsEl.addEventListener("change", doSave);
regexEl.addEventListener("change", doSave);
handlesEl.addEventListener("change", doSave);

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
