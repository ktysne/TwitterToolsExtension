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
 *
 * 設定 skipExisting（既定オン）がオンのときは、保存先に同名ファイルが既に
 * ある項目のダウンロードを発行しない。chrome.downloads にはスキップ用の
 * conflictAction が無いため、chrome.downloads.search でダウンロード履歴を
 * 引き、完了済みかつ実在する同名ファイルがあるかで判定する。
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

// 正規表現のメタ文字をエスケープする
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 同名ファイルの有無を調べる chrome.downloads.search 用のクエリを組み立てる。
// filenameRegex は絶対パス全体に対する部分一致なので末尾一致で判定する。
// 区切りは Windows の "\" と他OSの "/" の両方を許す。
function existsQuery(filename) {
  const pattern =
    String(filename)
      .split("/")
      .filter(Boolean)
      .map((seg) => "[\\\\/]" + escapeRegExp(seg))
      .join("") + "$";
  return { filenameRegex: pattern, exists: true, state: "complete", limit: 1 };
}

// chrome.downloads.search 相当の関数から、同名ファイルの有無を返す関数を作る。
// 失敗時は「無い」扱いにしてダウンロードを止めない。
function makeFileExists(search) {
  return (filename) =>
    new Promise((resolve) => {
      try {
        search(existsQuery(filename), (items) => {
          if (
            typeof chrome !== "undefined" &&
            chrome.runtime &&
            chrome.runtime.lastError
          ) {
            resolve(false);
            return;
          }
          resolve(Array.isArray(items) && items.length > 0);
        });
      } catch (_) {
        resolve(false);
      }
    });
}

// 設定 skipExisting の現在値を読む。service worker はいつでも停止・再起動
// するため値はキャッシュせず、メッセージごとに読む。失敗時は既定のオン。
function currentSkipExisting() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get({ skipExisting: true }, (cfg) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(true);
          return;
        }
        resolve(cfg ? cfg.skipExisting !== false : true);
      });
    } catch (_) {
      resolve(true);
    }
  });
}

// メッセージを受けて検証済みのダウンロードを開始する。
// 依存（download / fileExists / getSkipExisting）は呼び出し側から差し込める
// ようにして、ロジックを単体テストできるようにしてある。
// 無関係なメッセージだけは同期で null を返す（応答しないため）。
function handleDownloadMessage(msg, sender, deps) {
  if (!(msg && msg.type === "tte-download-images" && Array.isArray(msg.items))) {
    return null; // 関係ないメッセージは無視（応答しない）
  }
  if (!fromTwitter(sender)) {
    return Promise.resolve({ ok: false, started: 0, skipped: 0 });
  }
  return runDownload(msg, deps);
}

async function runDownload(msg, deps) {
  const { download, fileExists, getSkipExisting } = deps || {};

  // 検証を通った項目だけを先に取り出す
  const targets = [];
  msg.items.slice(0, MAX_ITEMS).forEach((item) => {
    if (!item) return;
    const url = safeUrl(item.url);
    const filename = safeFilename(item.filename);
    if (!url || !filename) return;
    targets.push({ url, filename });
  });

  // 設定の読み出しは1メッセージにつき1回だけ
  let skipExisting = false;
  if (targets.length && typeof getSkipExisting === "function") {
    skipExisting = !!(await getSkipExisting());
  }

  let started = 0;
  let skipped = 0;
  for (const t of targets) {
    if (skipExisting && typeof fileExists === "function") {
      if (await fileExists(t.filename)) {
        skipped++;
        continue;
      }
    }
    try {
      download({ url: t.url, filename: t.filename, saveAs: false });
      started++;
    } catch (_) {}
  }
  return { ok: true, started, skipped };
}

// service worker 実行時のみリスナを張る（Node でのテスト読み込み時は張らない）
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const resp = handleDownloadMessage(msg, sender, {
      download: (opts) => chrome.downloads.download(opts),
      fileExists: makeFileExists((q, cb) => chrome.downloads.search(q, cb)),
      getSkipExisting: currentSkipExisting,
    });
    if (resp === null) return; // 無関係なメッセージ
    // 応答を返さないままだとボタンが「保存中…」から戻らないため、
    // 想定外の失敗でも必ず何かを返す
    resp.then(sendResponse, () => sendResponse({ ok: false, started: 0, skipped: 0 }));
    return true; // 応答は非同期で返す
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    safeUrl,
    safeFilename,
    fromTwitter,
    escapeRegExp,
    existsQuery,
    makeFileExists,
    handleDownloadMessage,
  };
}
