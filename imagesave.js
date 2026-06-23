/*
 * imagesave.js  —  runs in the ISOLATED world（全フレーム）
 *
 * メディアを含む投稿に保存ボタンを重ねて表示する。
 *   - 画像の投稿: 「画像を保存」(1枚) / 「全N枚保存」(複数枚) ボタン（原寸 name=orig）
 *   - 動画/GIFの投稿: 「動画を保存」ボタン（最高画質 mp4。複数本も一括）
 *   - 画像と動画が混在する投稿: 「メディアを保存」ボタン（全部まとめて）
 * 実ダウンロードは background.js（chrome.downloads）に依頼する。
 *
 * 画像の場所（実DOMで確認済み）:
 *   article 内の  a[href*="/photo/N"] > ... > img[src*="pbs.twimg.com/media/<ID>"]
 *   原寸URL: https://pbs.twimg.com/media/<ID>?format=<fmt>&name=orig
 * 動画のURLは DOM が blob(MSE) で取れないため、interceptor.js が
 * レスポンスから集めて <div id="__tteVideoMap"> に置いたものを使う。
 */
(() => {
  "use strict";

  const PHOTO_LINK = 'a[href*="/photo/"]';
  const MEDIA_IMG = 'img[src*="pbs.twimg.com/media/"]';
  const VIDEO_BOX = '[data-testid="videoPlayer"], [data-testid="videoComponent"]';
  const MIN_IMAGES = 1; // 1枚でも対象にする
  const FOLDER = "TwitterMedia";

  let enabled = true;

  const STYLE_TEXT = `
    .tte-saveall-wrap{position:absolute;top:8px;right:8px;z-index:50;}
    .tte-saveall{
      font:600 12px/1 -apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;
      color:#fff;background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.35);
      border-radius:9999px;padding:6px 10px;cursor:pointer;backdrop-filter:blur(2px);
      transition:background .12s,opacity .12s;opacity:.92;white-space:nowrap;
    }
    .tte-saveall:hover{background:#1d9bf0;border-color:#1d9bf0;opacity:1;}
    .tte-saveall[disabled]{cursor:default;opacity:.8;}
  `;

  function injectStyle() {
    const style = document.createElement("style");
    style.textContent = STYLE_TEXT;
    (document.head || document.documentElement).appendChild(style);
  }

  // ---- ヘルパ ----
  function sanitize(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
  }

  function mediaIdOf(img) {
    const m = img && img.src && img.src.match(/\/media\/([^?\/]+)/);
    return m ? m[1] : null;
  }

  // 表示中の画像URLから format を取り出す（既知の画像形式のみ採用）。
  // 不明・未指定なら jpg にフォールバック。ファイル名の拡張子に使う。
  function pickFormat(src) {
    try {
      const f = new URL(src, "https://pbs.twimg.com/").searchParams.get("format");
      if (f && /^(jpg|jpeg|png|webp|gif)$/i.test(f)) return f.toLowerCase();
    } catch (_) {}
    return "jpg";
  }

  // メディアIDと format から原寸（name=orig）の画像URLを組み立てる
  function origImageUrl(id, fmt) {
    return `https://pbs.twimg.com/media/${id}?format=${fmt}&name=orig`;
  }

  function tweetMetaOf(article) {
    const statusA = article.querySelector('a[href*="/status/"]');
    let handle = "x",
      tweetId = null;
    if (statusA) {
      const m = (statusA.getAttribute("href") || "").match(
        /^\/([^/]+)\/status\/(\d+)/
      );
      if (m) {
        handle = m[1];
        tweetId = m[2];
      }
    }
    return { handle, tweetId };
  }

  // __tteVideoMap は内容が変わったときだけ parse（スキャン毎の再 parse を避ける）
  let _vmRaw = null;
  let _vmVal = {};
  function readVideoMap() {
    try {
      const n = document.getElementById("__tteVideoMap");
      const raw = (n && n.textContent) || "";
      if (raw !== _vmRaw) {
        _vmRaw = raw;
        _vmVal = raw ? JSON.parse(raw) : {};
      }
      return _vmVal;
    } catch (_) {
      return {};
    }
  }

  // 投稿の全画像（原寸URL＋保存名）
  function collectImages(article) {
    const { handle, tweetId } = tweetMetaOf(article);
    const seen = new Set();
    const out = [];
    Array.from(article.querySelectorAll(PHOTO_LINK)).forEach((a) => {
      const img = a.querySelector(MEDIA_IMG);
      const id = mediaIdOf(img);
      if (!id || seen.has(id)) return;
      seen.add(id);
      const fmt = pickFormat(img.src);
      const photoM = (a.getAttribute("href") || "").match(/\/photo\/(\d+)/);
      const n = photoM ? photoM[1] : out.length + 1;
      out.push({
        url: origImageUrl(id, fmt),
        filename: `${FOLDER}/${sanitize(handle)}_${tweetId || "img"}_${n}.${fmt}`,
      });
    });
    return out;
  }

  // 投稿の全動画（最高画質mp4＋保存名）。未取得なら空配列。
  function collectVideos(article) {
    const { handle, tweetId } = tweetMetaOf(article);
    if (!tweetId) return [];
    let urls = readVideoMap()[tweetId];
    if (typeof urls === "string") urls = [urls]; // 旧形式（単一URL）との後方互換
    if (!Array.isArray(urls) || !urls.length) return [];
    const multi = urls.length > 1;
    return urls.map((url, i) => ({
      url,
      filename: `${FOLDER}/${sanitize(handle)}_${tweetId}${
        multi ? "_" + (i + 1) : ""
      }.mp4`,
    }));
  }

  function imageCount(article) {
    const ids = new Set();
    article.querySelectorAll(PHOTO_LINK).forEach((a) => {
      const id = mediaIdOf(a.querySelector(MEDIA_IMG));
      if (id) ids.add(id);
    });
    return ids.size;
  }

  // 全画像リンクを含む最小の祖先（＝画像グリッドの枠）
  function mediaContainer(article, links) {
    let node = links[0];
    while (node && node !== article) {
      if (links.every((l) => node.contains(l))) return node;
      node = node.parentElement;
    }
    return links[0].parentElement;
  }

  function makeButton(label, getItems, missText) {
    const btn = document.createElement("button");
    btn.className = "tte-saveall";
    btn.type = "button";
    btn.dataset.tteLabel = label;
    btn.textContent = label;
    const stop = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    btn.addEventListener("mousedown", stop, true);
    btn.addEventListener("pointerdown", stop, true);
    btn.addEventListener("click", (e) => {
      stop(e);
      const items = getItems();
      const restore = (txt) => {
        btn.textContent = txt;
        setTimeout(() => {
          btn.textContent = btn.dataset.tteLabel;
          btn.disabled = false;
        }, 1600);
      };
      if (!items || !items.length) {
        btn.disabled = true;
        restore(missText || "取得できません");
        return;
      }
      btn.disabled = true;
      btn.textContent = "保存中…";
      chrome.runtime.sendMessage(
        { type: "tte-download-images", items },
        (resp) => {
          restore(resp && resp.ok ? `✓ ${resp.started}件` : "保存失敗");
        }
      );
    });
    return btn;
  }

  function mount(container, button) {
    if (!container || container.querySelector(":scope > .tte-saveall-wrap")) {
      return;
    }
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    const wrap = document.createElement("div");
    wrap.className = "tte-saveall-wrap";
    wrap.appendChild(button);
    container.appendChild(wrap);
  }

  function injectInto(article) {
    if (!enabled) return;

    const videoBox = article.querySelector(VIDEO_BOX);
    const links = Array.from(article.querySelectorAll(PHOTO_LINK));
    const imgCount = imageCount(article);

    // メディアが無い（動画も無く、画像も下限未満）なら何もしない
    if (!videoBox && imgCount < MIN_IMAGES) return;

    // クリック時に動画と画像をまとめて集める（複数動画・混在投稿も一括保存）
    const getItems = () => [...collectVideos(article), ...collectImages(article)];

    // 保存される件数をラベルに出す。動画URLはレスポンス受信後に埋まるので、
    // その時点で分かる数を反映する（未取得なら総称ラベル）。
    function labelFor() {
      if (videoBox) {
        const vids = collectVideos(article).length;
        if (vids && imgCount) return `⬇ メディア${vids + imgCount}件を保存`;
        if (vids > 1) return `⬇ 動画${vids}本を保存`;
        if (vids === 1) return "⬇ 動画を保存";
        return links.length ? "⬇ メディアを保存" : "⬇ 動画を保存";
      }
      return imgCount === 1 ? "⬇ 画像を保存" : `⬇ 全${imgCount}枚保存`;
    }

    const container = videoBox || mediaContainer(article, links);
    if (!container || (!videoBox && !links.length)) return;

    // 既存ボタンがあれば、件数が確定した時点でラベルだけ更新する
    const existing = container.querySelector(
      ":scope > .tte-saveall-wrap .tte-saveall"
    );
    if (existing) {
      const lbl = labelFor();
      existing.dataset.tteLabel = lbl;
      if (!existing.disabled) existing.textContent = lbl;
      return;
    }

    mount(
      container,
      makeButton(labelFor(), getItems, videoBox ? "取得待ち" : undefined)
    );
  }

  function scan() {
    if (!enabled) return;
    document.querySelectorAll("article").forEach(injectInto);
  }

  function removeAll() {
    document.querySelectorAll(".tte-saveall-wrap").forEach((el) => el.remove());
  }

  // ---- 起動（ブラウザの content script としてのみ動かす） ----
  // Node（単体テスト）では document / chrome が無いので何もせず、純粋関数だけ
  // を公開する。ブラウザでの挙動はこれまでと変わらない。
  if (typeof document !== "undefined" && typeof chrome !== "undefined") {
    injectStyle();

    // ---- 設定 ----
    chrome.storage.local.get({ imageSave: true }, (cfg) => {
      enabled = cfg.imageSave;
      if (enabled) scan();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.imageSave) {
        enabled = changes.imageSave.newValue;
        if (enabled) scan();
        else removeAll();
      }
    });

    // ---- 監視（XはSPAで遅延描画・仮想スクロールするため） ----
    let timer = null;
    const observer = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        scan();
      }, 250);
    });
    const startObserving = () => {
      observer.observe(document.body, { childList: true, subtree: true });
      scan();
    };
    if (document.body) startObserving();
    else {
      document.addEventListener("DOMContentLoaded", startObserving, { once: true });
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { sanitize, mediaIdOf, pickFormat, origImageUrl };
  }
})();
