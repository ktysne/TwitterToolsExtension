/*
 * background.js  —  MV3 service worker
 *
 * content script (imagesave.js) は chrome.downloads を直接使えないため、
 * ここでダウンロードを実行する。
 *
 * chrome.downloads はダウンロード先URLに対する host_permissions を必要と
 * しないが、改竄されたレスポンスや DOM 由来の値が紛れ込んでも被害が出ない
 * よう、実行前に URL（https かつ twimg.com 系のみ）と保存パス
 * （TwitterMedia 配下に強制し、.. や絶対パスを排除）を検証する。
 */
"use strict";

const FOLDER = "TwitterMedia";
const MAX_ITEMS = 30; // 1投稿の画像は最大4枚程度。改竄レスポンスでの大量DLを防ぐ上限。

// https かつ Twitter のメディアCDN(*.twimg.com)のURLだけ通す
function safeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    if (u.hostname === "twimg.com" || u.hostname.endsWith(".twimg.com")) {
      return u.href;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// 保存パスを TwitterMedia/ 配下に強制し、.. や絶対パス・制御文字を弾く
function safeFilename(name) {
  if (typeof name !== "string") return null;
  const parts = name.split("/").filter(Boolean);
  if (!parts.length) return null;
  for (const seg of parts) {
    if (seg === "." || seg === ".." || /[\\:*?"<>|\x00-\x1f]/.test(seg)) {
      return null;
    }
  }
  if (parts[0] !== FOLDER) parts.unshift(FOLDER);
  return parts.join("/");
}

// 送信元が x.com / twitter.com のコンテンツスクリプトか
function fromTwitter(sender) {
  try {
    const h = new URL((sender && sender.url) || "").hostname;
    return (
      h === "x.com" ||
      h === "twitter.com" ||
      h.endsWith(".x.com") ||
      h.endsWith(".twitter.com")
    );
  } catch (_) {
    return false;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!(msg && msg.type === "tte-download-images" && Array.isArray(msg.items))) {
    return; // 関係ないメッセージは無視
  }
  if (!fromTwitter(sender)) {
    sendResponse({ ok: false, started: 0 });
    return; // 応答は同期で返している
  }

  let started = 0;
  msg.items.slice(0, MAX_ITEMS).forEach((item) => {
    if (!item) return;
    const url = safeUrl(item.url);
    const filename = safeFilename(item.filename);
    if (!url || !filename) return;
    try {
      chrome.downloads.download({ url, filename, saveAs: false });
      started++;
    } catch (_) {}
  });
  sendResponse({ ok: true, started });
  return true; // 非同期応答の余地を残す
});
