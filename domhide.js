/*
 * domhide.js  —  runs in the ISOLATED world（全フレーム）
 *
 * ワード/@id ミュートを、すでに描画済みの投稿にも即座に効かせる。
 * interceptor.js（MAIN world）はレスポンスの段階で新規の投稿を消すが、
 * 既に画面に出ている投稿はそのままになる。ここでは DOM を直接見て、ルールに
 * 一致する投稿をその場で隠す（ルール変更時・新規描画時に再評価する）。
 *
 * ブロック/ミュート（relationship）は DOM から判定できないため対象外。
 * その分は interceptor.js が新規レスポンスで処理する。
 */
(() => {
  "use strict";

  let words = [];
  let regexes = [];
  let handles = new Set();
  let active = false; // ワード/@id のいずれかに対象があるか

  const style = document.createElement("style");
  style.textContent = ".tte-hidden{display:none !important;}";
  (document.head || document.documentElement).appendChild(style);

  function loadRules() {
    chrome.storage.local.get(
      {
        wordMute: true,
        muteWords: [],
        muteRegexes: [],
        handleMute: true,
        muteHandles: [],
      },
      (cfg) => {
        const wordOn = !!cfg.wordMute;
        const handleOn = !!cfg.handleMute;
        words = wordOn
          ? (cfg.muteWords || [])
              .map((w) => String(w).toLowerCase())
              .filter(Boolean)
          : [];
        regexes = wordOn
          ? (cfg.muteRegexes || [])
              .map((s) => {
                try {
                  return new RegExp(String(s), "i");
                } catch (_) {
                  return null;
                }
              })
              .filter(Boolean)
          : [];
        handles = new Set(
          handleOn
            ? (cfg.muteHandles || [])
                .map((h) => String(h).replace(/^@/, "").toLowerCase())
                .filter(Boolean)
            : []
        );
        active = !!(words.length || regexes.length || handles.size);
        applyAll();
      }
    );
  }

  // 投稿の本文（最初の tweetText）。引用ツイートの本文は含めない。
  function postText(article) {
    const el = article.querySelector('[data-testid="tweetText"]');
    return el ? el.textContent || "" : "";
  }

  function authorHandle(article) {
    const a = article.querySelector('a[href*="/status/"]');
    const m = a && (a.getAttribute("href") || "").match(/^\/([^/]+)\/status\//);
    return m && m[1] ? m[1].toLowerCase() : null;
  }

  function matches(article) {
    if (handles.size) {
      const h = authorHandle(article);
      if (h && handles.has(h)) return true;
    }
    if (words.length || regexes.length) {
      const text = postText(article);
      if (text) {
        const lower = text.toLowerCase();
        for (const w of words) if (lower.includes(w)) return true;
        for (const re of regexes) {
          try {
            if (re.test(text)) return true;
          } catch (_) {}
        }
      }
    }
    return false;
  }

  // 隠す対象は、タイムラインのセル枠があればそれ（余白ごと消す）、無ければ article。
  function hideTarget(article) {
    return article.closest('[data-testid="cellInnerDiv"]') || article;
  }

  function applyAll() {
    const articles = document.querySelectorAll("article");
    for (const article of articles) {
      const target = hideTarget(article);
      const bad = active && matches(article);
      if (bad) {
        if (!target.classList.contains("tte-hidden")) {
          target.classList.add("tte-hidden");
          target.dataset.tteHidden = "1";
        }
      } else if (target.dataset.tteHidden === "1") {
        // 以前ここで隠したが、もう一致しない（ルール削除や仮想スクロールの再利用）
        target.classList.remove("tte-hidden");
        delete target.dataset.tteHidden;
      }
    }
  }

  // ルール変更（popup や ⋯ メニュー）で即再評価
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      changes.wordMute ||
      changes.muteWords ||
      changes.muteRegexes ||
      changes.handleMute ||
      changes.muteHandles
    ) {
      loadRules();
    }
  });

  // 新規描画・仮想スクロールの再利用にも追従（デバウンス）
  let timer = null;
  const observer = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      applyAll();
    }, 250);
  });

  function start() {
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
    loadRules();
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
