"use strict";

// チェックボックス型のトグル
const TOGGLES = {
  enabled: true,
  disableAutoplay: true,
  imageSave: true,
  skipExisting: true,
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
const saveDirEl = document.getElementById("saveDir");
const filenameFormatEl = document.getElementById("filenameFormat");
const saveDirMsgEl = document.getElementById("saveDirMsg");
const formatMsgEl = document.getElementById("formatMsg");
const savePreviewEl = document.getElementById("savePreview");
const tokenEls = document.querySelectorAll(".token");

// popup.html で先に読み込む savepath.js。background と同じ検証とパス解決を使う
const TteSavePath = globalThis.TteSavePath;
const { DEFAULT_SAVE_DIR, DEFAULT_FILENAME_FORMAT } = TteSavePath;
const PREVIEW_META = {
  screenName: "username",
  postId: "1834567890123456789",
  fileName: "GXyZ1aBcDeFgHiJ",
  ext: "jpg",
};

let displayedSaveDirStatus = "none";
let displayedFormatStatus = "none";

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
  {
    muteWords: [],
    muteRegexes: [],
    muteHandles: [],
    saveDir: DEFAULT_SAVE_DIR,
    filenameFormat: DEFAULT_FILENAME_FORMAT,
  },
  (cfg) => {
    wordsEl.value = (cfg.muteWords || []).join("\n");
    regexEl.value = (cfg.muteRegexes || []).join("\n");
    handlesEl.value = (cfg.muteHandles || []).join("\n");
    saveDirEl.value =
      typeof cfg.saveDir === "string" ? cfg.saveDir : DEFAULT_SAVE_DIR;
    filenameFormatEl.value =
      typeof cfg.filenameFormat === "string"
        ? cfg.filenameFormat
        : DEFAULT_FILENAME_FORMAT;
    // 読み込んだ内容を保存済みの基準にする（無変更で閉じても再書き込みしない）
    lastSaved = JSON.stringify(currentValues());
    updateSavePreview();
    renderValidation();
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

// 入力欄から保存する値を組み立てる。無変更判定のスナップショットと書き込みの
// 両方にこの値を使い、比較した内容と保存する内容を一致させる。
function currentValues() {
  return {
    muteWords: parseLines(wordsEl.value),
    muteRegexes: parseLines(regexEl.value),
    muteHandles: parseLines(handlesEl.value).map((h) => h.replace(/^@/, "")),
    saveDir: saveDirEl.value.trim(),
    filenameFormat: filenameFormatEl.value.trim(),
  };
}

function clearValidationMessage(messageEl, inputEl) {
  messageEl.textContent = "";
  messageEl.classList.remove("warning");
  inputEl.removeAttribute("aria-invalid");
}

function renderValidation() {
  const dirResult = TteSavePath.validateSaveDir(saveDirEl.value);
  if (!dirResult.ok) {
    saveDirMsgEl.textContent =
      "注意: " +
      dirResult.message +
      `修正するまでは ${DEFAULT_SAVE_DIR} に保存します。`;
    saveDirMsgEl.classList.add("warning");
    saveDirEl.setAttribute("aria-invalid", "true");
    displayedSaveDirStatus = "invalid";
  } else {
    clearValidationMessage(saveDirMsgEl, saveDirEl);
    displayedSaveDirStatus = "none";
  }

  const formatResult = TteSavePath.validateFilenameFormat(
    filenameFormatEl.value
  );
  if (!formatResult.ok) {
    formatMsgEl.textContent =
      "注意: " +
      formatResult.message +
      `修正するまでは既定の形式（${DEFAULT_FILENAME_FORMAT}）で保存します。`;
    formatMsgEl.classList.add("warning");
    filenameFormatEl.setAttribute("aria-invalid", "true");
    displayedFormatStatus = "invalid";
  } else {
    clearValidationMessage(formatMsgEl, filenameFormatEl);
    displayedFormatStatus = "none";
  }
}

// 入力中は新しい不備を表示せず、表示中の不備が解消した時だけ表示を消す。
function clearResolvedValidation() {
  const dirResult = TteSavePath.validateSaveDir(saveDirEl.value);
  if (displayedSaveDirStatus === "invalid" && dirResult.ok) {
    clearValidationMessage(saveDirMsgEl, saveDirEl);
    displayedSaveDirStatus = "none";
  }

  const formatResult = TteSavePath.validateFilenameFormat(
    filenameFormatEl.value
  );
  if (displayedFormatStatus === "invalid" && formatResult.ok) {
    clearValidationMessage(formatMsgEl, filenameFormatEl);
    displayedFormatStatus = "none";
  }
}

function updateSavePreview() {
  const path = TteSavePath.resolveSavePath(
    {
      saveDir: saveDirEl.value,
      filenameFormat: filenameFormatEl.value,
    },
    PREVIEW_META
  );
  savePreviewEl.textContent =
    path === null ? "保存例: （組み立てられません）" : "保存例: " + path;
}

// 入力内容を保存する（不正な正規表現は警告だけ出し、入力自体は保存する）
let saveTimer = null;
let lastSaved = "";
// ストレージ読み込みが完了するまで保存しない。
// 読み込み前に閉じる/隠れると入力欄は空のままで、既存ルールを空配列で
// 上書きしてしまう race を防ぐ。
let loaded = false;

function doSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // まだ読み込めていない場合は何もしない（空での上書き防止）
  if (!loaded) return;
  const values = currentValues();
  const invalid = values.muteRegexes.filter((src) => {
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
  const snapshot = JSON.stringify(values);
  if (snapshot === lastSaved) return;
  lastSaved = snapshot;
  chrome.storage.local.set(values);
}

// 入力中はデバウンスして保存
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 400);
}
wordsEl.addEventListener("input", scheduleSave);
regexEl.addEventListener("input", scheduleSave);
handlesEl.addEventListener("input", scheduleSave);
saveDirEl.addEventListener("input", () => {
  scheduleSave();
  updateSavePreview();
  clearResolvedValidation();
});
filenameFormatEl.addEventListener("input", () => {
  scheduleSave();
  updateSavePreview();
  clearResolvedValidation();
});

tokenEls.forEach((tokenEl) => {
  tokenEl.addEventListener("click", () => {
    const token = tokenEl.dataset.token || "";
    const start =
      filenameFormatEl.selectionStart ?? filenameFormatEl.value.length;
    const end = filenameFormatEl.selectionEnd ?? start;
    filenameFormatEl.setRangeText(token, start, end, "end");
    filenameFormatEl.focus();
    updateSavePreview();
    scheduleSave();
    clearResolvedValidation();
  });
});

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
saveDirEl.addEventListener("change", () => {
  doSave();
  updateSavePreview();
  renderValidation();
});
filenameFormatEl.addEventListener("change", () => {
  doSave();
  updateSavePreview();
  renderValidation();
});

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
