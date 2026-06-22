/*
 * mutemenu.js  —  runs in the ISOLATED world（全フレーム）
 *
 * 各投稿の ⋯（[data-testid="caret"]）メニューに「この拡張機能でミュート」
 * 項目を差し込み、クリックでその投稿者の @id を muteHandles に追加/解除する。
 * @id ミュートは主に検索結果で効く（X 標準のブロック/ミュート除外が検索で
 * 漏れるのを補う）。
 *
 * 仕組み:
 *   1. ⋯ ボタンのクリックを捕捉し、対象投稿の著者ハンドルを覚えておく。
 *   2. メニュー（[role="menu"]）が開いたら、X の項目を複製して項目を注入する。
 */
(() => {
  "use strict";

  let pending = null; // { handle, at }

  // 投稿の著者ハンドル（先頭の /xxx/status/ から）
  function authorOfArticle(article) {
    if (!article) return null;
    const sa = article.querySelector('a[href*="/status/"]');
    const m = sa && (sa.getAttribute("href") || "").match(/^\/([^/]+)\/status\//);
    if (m && m[1] && m[1] !== "i") return m[1];
    return null;
  }

  // ⋯ クリックを捕捉して対象著者を記録（capture phase）
  document.addEventListener(
    "click",
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      const caret = t.closest('[data-testid="caret"]');
      if (!caret) return;
      const handle = authorOfArticle(caret.closest("article"));
      if (handle) pending = { handle, at: Date.now() };
    },
    true
  );

  function normalize(h) {
    return String(h).replace(/^@/, "").toLowerCase();
  }

  function isMuted(handle, cb) {
    chrome.storage.local.get({ muteHandles: [] }, (cfg) => {
      const low = normalize(handle);
      cb((cfg.muteHandles || []).some((h) => normalize(h) === low));
    });
  }

  // 追加/解除をトグルし、追加時は @id ミュート機能を有効化する
  function toggleMute(handle, cb) {
    chrome.storage.local.get(
      { muteHandles: [], handleMute: true },
      (cfg) => {
        const list = Array.isArray(cfg.muteHandles) ? cfg.muteHandles.slice() : [];
        const low = normalize(handle);
        const idx = list.findIndex((h) => normalize(h) === low);
        let nowMuted;
        if (idx >= 0) {
          list.splice(idx, 1);
          nowMuted = false;
        } else {
          list.push(handle);
          nowMuted = true;
        }
        const set = { muteHandles: list };
        if (nowMuted) set.handleMute = true;
        chrome.storage.local.set(set, () => cb && cb(nowMuted));
      }
    );
  }

  function closeMenu() {
    try {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
        })
      );
    } catch (_) {}
  }

  // X の既存メニュー項目を複製してアイコンとテキストだけ差し替える
  function buildItem(template, handle) {
    const item = template.cloneNode(true);
    item.removeAttribute("data-testid");
    item.setAttribute("data-tte-mute", "1");

    // テキスト要素（葉のテキストノード）を、アイコン差し替えより先に特定する
    const textEl = Array.from(item.querySelectorAll("*")).find(
      (el) => el.children.length === 0 && (el.textContent || "").trim().length
    );

    // アイコンを 🔇 に差し替える
    const svg = item.querySelector("svg");
    if (svg) {
      const span = document.createElement("span");
      span.textContent = "🔇";
      span.style.fontSize = "18px";
      span.style.lineHeight = "1";
      svg.replaceWith(span);
    }

    isMuted(handle, (muted) => {
      const label = muted
        ? "@" + handle + " の拡張ミュートを解除"
        : "@" + handle + " を拡張機能でミュート";
      if (textEl) textEl.textContent = label;
    });

    item.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMute(handle, () => {});
        closeMenu();
      },
      true
    );
    return item;
  }

  function tryInject(menu, attempt) {
    if (!menu || menu.dataset.tteInjected) return;
    if (!pending || Date.now() - pending.at > 4000) return;
    const template = menu.querySelector('[role="menuitem"]');
    if (!template) {
      // 項目がまだ描画されていなければ少し待って再試行
      if ((attempt || 0) < 5) {
        setTimeout(() => tryInject(menu, (attempt || 0) + 1), 60);
      }
      return;
    }
    menu.dataset.tteInjected = "1";
    const item = buildItem(template, pending.handle);
    menu.insertBefore(item, menu.firstChild);
  }

  const observer = new MutationObserver((muts) => {
    for (const mu of muts) {
      for (const n of mu.addedNodes) {
        if (n.nodeType !== 1) continue;
        const menu =
          n.matches && n.matches('[role="menu"]')
            ? n
            : n.querySelector && n.querySelector('[role="menu"]');
        if (menu) tryInject(menu);
      }
    }
  });

  function start() {
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
