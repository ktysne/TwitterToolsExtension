/*
 * background.js  —  MV3 service worker
 *
 * content script (imagesave.js) は chrome.downloads を直接使えないため、
 * ここでダウンロードを実行する。
 *
 * chrome.downloads はダウンロード先URLに対する host_permissions を必要と
 * しないが、改竄されたレスポンスや DOM 由来の値が紛れ込んでも被害が出ない
 * よう、実行前に URL（https かつ twimg.com 系のみ）と、URL から取り出した
 * 元の名前と拡張子、設定から組み立てる保存パス（相対フォルダ・ファイル名の各規則）
 * を検証する。
 *
 * 設定 skipExisting（既定オン）がオンのときは、保存先に同名ファイルが既に
 * ある項目のダウンロードを発行しない。chrome.downloads にはスキップ用の
 * conflictAction が無いため、chrome.downloads.search でダウンロード履歴を
 * 引き、ダウンロード中または完了済みで実在する同名ファイルがあるかで判定する。
 * 履歴に載る前の重複は、発行予定の保存パスをメモリ上に予約して防ぐ。
 * 応答には開始成功・同名スキップ・開始失敗の件数を返す。
 */
"use strict";

const SavePath =
  typeof module !== "undefined" && module.exports
    ? require("./savepath.js")
    : (importScripts("savepath.js"), globalThis.TteSavePath);
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

// 安全な URL のパスから、保存ファイル名に使う元の名前と拡張子を取り出す。
// パスはデコードせず、許可した文字と拡張子だけを採用する。
function originalFileName(url) {
  try {
    const u = new URL(url);
    const segment = u.pathname.split("/").pop() || "";
    if (u.hostname === "pbs.twimg.com" && u.pathname.startsWith("/media/")) {
      const match = segment.match(
        /^([A-Za-z0-9_-]{1,64})(?:\.(jpg|jpeg|png|webp|gif))?$/i
      );
      if (!match) return null;
      const format = u.searchParams.get("format");
      const extension = /^(jpg|jpeg|png|webp|gif)$/i.test(format || "")
        ? format.toLowerCase()
        : match[2]
          ? match[2].toLowerCase()
          : null;
      return extension ? { fileName: match[1], ext: extension } : null;
    }
    const match = segment.match(/^([A-Za-z0-9_-]{1,64})\.mp4$/i);
    return match ? { fileName: match[1], ext: "mp4" } : null;
  } catch (_) {
    return null;
  }
}

// メッセージの値は DOM 由来で信用せず、保存名に使うメタデータを正規化する。
// 元の名前と拡張子を取り出せない項目は、保存パスを安全に組み立てられないため除外する。
function normalizeMediaMeta(item, url) {
  if (!item || (typeof item !== "object" && typeof item !== "function")) {
    return null;
  }
  const originalMeta = originalFileName(url);
  if (originalMeta === null) return null;

  const rawScreenName = String(item.screenName ?? "");
  const screenName =
    rawScreenName.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 50) || "x";
  const postId =
    typeof item.postId === "string" && /^\d{1,20}$/.test(item.postId)
      ? item.postId
      : null;
  return {
    screenName,
    postId,
    fileName: originalMeta.fileName,
    ext: originalMeta.ext,
  };
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

// 設定は service worker の再起動後も反映するためキャッシュせず、メッセージごとに読む。
// 保存先と形式は入力値を保持し、実際の検証とフォールバックは SavePath に任せる。
function currentSettings() {
  const defaults = {
    skipExisting: true,
    saveDir: SavePath.DEFAULT_SAVE_DIR,
    filenameFormat: SavePath.DEFAULT_FILENAME_FORMAT,
  };
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(defaults, (cfg) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(defaults);
          return;
        }
        resolve({
          skipExisting: cfg ? cfg.skipExisting !== false : true,
          saveDir:
            cfg && cfg.saveDir !== undefined ? cfg.saveDir : defaults.saveDir,
          filenameFormat:
            cfg && cfg.filenameFormat !== undefined
              ? cfg.filenameFormat
              : defaults.filenameFormat,
        });
      });
    } catch (_) {
      resolve(defaults);
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
// 依存（download / fileExists / getSettings）は呼び出し側から差し込める
// ようにして、ロジックを単体テストできるようにしてある。
// 無関係なメッセージだけは同期で null を返す（応答しないため）。
function handleDownloadMessage(msg, sender, deps) {
  if (!(msg && msg.type === "tte-download-images" && Array.isArray(msg.items))) {
    return null; // 関係ないメッセージは無視（応答しない）
  }
  if (!fromTwitter(sender)) {
    return Promise.resolve({ ok: false, started: 0, skipped: 0, failed: 0 });
  }
  return runDownload(msg, deps);
}

async function runDownload(msg, deps) {
  const { download, fileExists, getSettings } = deps || {};

  // 検証を通った項目だけを先に取り出す
  const targets = [];
  msg.items.slice(0, MAX_ITEMS).forEach((item) => {
    if (!item) return;
    const url = safeUrl(item.url);
    if (!url) return;
    const meta = normalizeMediaMeta(item, url);
    if (!meta) return;
    targets.push({ url, meta });
  });

  // 設定の読み出しは1メッセージにつき1回だけ
  let settings = {};
  if (targets.length && typeof getSettings === "function") {
    settings = (await getSettings()) || {};
  }
  const skipExisting = settings.skipExisting === true;

  // 設定から解決できないパスは保存候補から外し、件数にも数えない。
  const resolvedTargets = [];
  for (const target of targets) {
    const filename = SavePath.resolveSavePath(settings, target.meta);
    if (filename !== null) resolvedTargets.push({ ...target, filename });
  }

  let started = 0;
  let skipped = 0;
  let failed = 0;
  const startPromises = [];
  for (const t of resolvedTargets) {
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
      // MV3 の chrome.downloads.download() はコールバック無しで呼ぶと Promise を
      // 返し、開始に失敗すると reject する。ループ内では await せず（予約までの
      // 同期区間を保つため）、開始結果はループの後でまとめて待って数える。
      if (ret && typeof ret.then === "function") {
        startPromises.push(
          Promise.resolve(ret).then(
            () => {
              started++;
            },
            () => {
              // 予約を残すと、TTL が切れるまで再試行が無言でスキップされる
              release(t.filename, token);
              failed++;
            }
          )
        );
      } else {
        started++;
      }
    } catch (_) {
      failed++;
    }
  }
  // download() の Promise は開始の時点で解決するので、待っても応答はほとんど遅れない。
  // 開始の失敗を started に数えると、保存されていないのにボタンが成功を表示する。
  await Promise.all(startPromises);
  return { ok: true, started, skipped, failed };
}

// service worker 実行時のみリスナを張る（Node でのテスト読み込み時は張らない）
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const resp = handleDownloadMessage(msg, sender, {
      download: (opts) => chrome.downloads.download(opts),
      fileExists: makeFileExists((q, cb) => chrome.downloads.search(q, cb)),
      getSettings: currentSettings,
    });
    if (resp === null) return; // 無関係なメッセージ
    // 応答を返さないままだとボタンが「保存中…」から戻らないため、
    // 想定外の失敗でも必ず何かを返す
    resp.then(
      sendResponse,
      () => sendResponse({ ok: false, started: 0, skipped: 0, failed: 0 })
    );
    return true; // 応答は非同期で返す
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    safeUrl,
    originalFileName,
    normalizeMediaMeta,
    fromTwitter,
    escapeRegExp,
    existsQuery,
    hasSameFile,
    makeFileExists,
    handleDownloadMessage,
    _resetPending: () => pending.clear(), // テストで予約状態を初期化するため
  };
}
