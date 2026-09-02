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
 * 引き、ダウンロード中または完了済みで実在する同名ファイルがあるかで判定する。
 * 履歴に載る前の重複は、発行予定のファイル名をメモリ上に予約して防ぐ。
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
// state や exists でクエリを絞らないのは、ダウンロード中（in_progress）の記録も
// 拾って完了前の再クリックによる重複保存を防ぐためで、判定は結果側で行う。
// 件数の上限も設けない。上限を設けると、新しい順に並べた分がすべて中断・削除済みで、
// それより古い記録に完了済みのものがある場合を見落とす。filenameRegex は絶対パスの
// 末尾一致なので結果集合はもともと小さく、上限を設ける必要が無い。
function existsQuery(filename) {
  const pattern =
    String(filename)
      .split("/")
      .filter(Boolean)
      .map((seg) => "[\\\\/]" + escapeRegExp(seg))
      .join("") + "$";
  return { filenameRegex: pattern };
}

// 検索結果に「保存済みと見なせる同名ファイル」があるか判定する。
// ダウンロード中のものは exists を見ない（まだファイルが揃っていないため）。
// 完了済みのものは、実在すると分かっているもの（exists === true）だけをヒットとする。
// 実在を確認できないものを「あり」と扱うと、ファイルが無いのに保存されず、利用者から
// 見れば黙って失敗したことになる。「無し」と扱えば重複ファイルができるだけなので、
// こちらのほうが害が小さい。
function hasSameFile(items) {
  if (!Array.isArray(items)) return false;
  return items.some((item) => {
    if (!item) return false;
    if (item.state === "in_progress") return true;
    return item.state === "complete" && item.exists === true;
  });
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
          resolve(hasSameFile(items));
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

// 発行済み（発行直前を含む）のファイル名の予約。
// 存在確認は非同期なので、その待ち時間に別のメッセージが同じファイル名の
// ダウンロードを発行し得る。また履歴に載るまでの間も検索では拾えない。
// 予約は service worker の再起動で消えるが、その場合は履歴による判定に戻る
// だけなので実害は無い。
// 値はその予約を識別するトークン。同じファイル名で二度予約が起きたとき
// （設定オフで同名を続けて発行した場合など）に、古い予約の解除や TTL が
// 新しい予約まで消してしまわないよう、トークンが一致するときだけ外す。
const pending = new Map();
const PENDING_TTL_MS = 60000; // 予約が残り続けないようにする保持時間

// ファイル名を予約し、一定時間で自動的に外す。返したトークンは release に渡す。
function reserve(filename) {
  const token = {};
  pending.set(filename, token);
  const timer = setTimeout(() => release(filename, token), PENDING_TTL_MS);
  // Node でのテスト時にタイマーがプロセスを引き止めないようにする
  if (timer && typeof timer.unref === "function") timer.unref();
  return token;
}

// 予約を外す。ダウンロードの開始に失敗したときと、TTL が切れたときに使う。
// 予約を残したままにすると、TTL が切れるまで再試行が無言でスキップされる。
function release(filename, token) {
  if (pending.get(filename) === token) pending.delete(filename);
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
    if (skipExisting) {
      // 予約済みなら検索を待たずにスキップする（同一メッセージ内・メッセージ間の重複発行を防ぐ）
      if (pending.has(t.filename)) {
        skipped++;
        continue;
      }
      if (typeof fileExists === "function" && (await fileExists(t.filename))) {
        skipped++;
        continue;
      }
      // 予約は2回確認する。1回目（上）は無駄な検索を省くため、2回目（ここ）は
      // 存在確認の await を待つ間に別のメッセージが同じファイル名を予約した場合を
      // 拾うため。この再確認から download() と reserve() までは await を挟まないので、
      // 同じファイル名の発行は1件に収まる。
      if (pending.has(t.filename)) {
        skipped++;
        continue;
      }
    }
    try {
      const ret = download({ url: t.url, filename: t.filename, saveAs: false });
      // 発行できたものだけ予約する。download() は同期で戻り、ここまでに
      // await を挟まないため、この順でも他のメッセージは割り込めない。
      const token = reserve(t.filename);
      started++;
      // MV3 の chrome.downloads.download() はコールバック無しで呼ぶと Promise を
      // 返し、開始に失敗すると reject する。await はしない（応答を遅らせず、
      // reserve() との間に await を挟まないため）。
      if (ret && typeof ret.then === "function") {
        ret.catch(() => release(t.filename, token));
      }
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
    hasSameFile,
    makeFileExists,
    handleDownloadMessage,
    _resetPending: () => pending.clear(), // テストで予約状態を初期化するため
  };
}
