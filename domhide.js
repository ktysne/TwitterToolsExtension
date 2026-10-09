// ワード/@id ミュートは ISOLATED world 内のルールだけで DOM 上の投稿・ユーザーを判定する。
// 新規ノードは描画前に同期判定し、全件走査で仮想スクロールの再利用も補う。
(() => {
  "use strict";

  function normalizeHandle(handle) {
    return String(handle).replace(/^@/, "").toLowerCase();
  }

  function compileMuteRules(cfg = {}) {
    const list = (value) => Array.isArray(value) ? value : [];
    return {
      words: cfg.wordMute ? list(cfg.muteWords).map((w) => String(w).toLowerCase()).filter(Boolean) : [],
      regexes: cfg.wordMute ? list(cfg.muteRegexes).map((s) => {
        try { return new RegExp(String(s), "i"); }
        catch (_) { return null; }
      }).filter(Boolean) : [],
      handles: new Set(cfg.handleMute ? list(cfg.muteHandles).map(normalizeHandle).filter(Boolean) : []),
    };
  }

  function textMatchesMute(text, rules) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return rules.words.some((w) => lower.includes(w)) || rules.regexes.some((re) => re.test(text));
  }

  function tweetTextContent(element) {
    let text = "";
    for (const node of element ? element.childNodes || [] : []) {
      if (node.nodeType === 3) {
        text += node.nodeValue || "";
      } else if (node.nodeType === 1) {
        if (node.tagName === "IMG") {
          const alt = node.getAttribute("alt");
          if (alt !== null) text += alt;
        } else {
          text += tweetTextContent(node);
        }
      }
    }
    return text;
  }

  function handleMatchesMute(handle, rules) {
    return !!handle && rules.handles.has(normalizeHandle(handle));
  }

  function xPathFromHref(href) {
    if (typeof href !== "string" || !href) return null;
    try {
      const url = new URL(href, "https://x.com/");
      if (!/^https?:$/.test(url.protocol) || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) return null;
      return url.pathname;
    } catch (_) { return null; }
  }

  const RESERVED_PATHS = new Set(["home", "explore", "search", "notifications", "messages", "settings", "i", "intent", "compose", "login", "logout", "signup", "tos", "privacy", "about", "help", "jobs", "download"]);
  // リポストのアイコンと文言は X の DOM 表現に依存する。
  const REPOST_ICON_PATH_PREFIX = "M4.75 3.79l4.603 4.3";
  const REPOST_CONTEXT_TEXT = /(リポスト|リツイート)(しました)?$|\b(reposted|retweeted)$/i;

  function handleFromHref(href, profileOnly = false) {
    const path = xPathFromHref(href);
    const match = path && path.match(profileOnly ? /^\/([a-z0-9_]{1,15})\/?$/i : /^\/([a-z0-9_]{1,15})\/status\/\d+(?:\/|$)/i);
    const handle = match ? match[1].toLowerCase() : null;
    return handle && !RESERVED_PATHS.has(handle) ? handle : null;
  }

  function postIdFromHref(href) {
    const path = xPathFromHref(href);
    const match = path && path.match(/^\/[^/]+\/status\/(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  }

  function tweetTextElement(article) {
    return [...article.querySelectorAll('[data-testid="tweetText"]')]
      .find((element) => {
        const quote = element.closest('div[role="link"]');
        return !quote || !article.contains(quote);
      }) || null;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { normalizeHandle, compileMuteRules, textMatchesMute, tweetTextContent, handleMatchesMute, handleFromHref, postIdFromHref };
  }
  if (typeof document === "undefined" || typeof chrome === "undefined") return;

  let rules = compileMuteRules();
  const removedPosts = new Set();
  const removedUsers = new Set();
  const hiddenTargets = new Set();
  let hiddenInPass = null;
  // 同じフレームの content script 間だけで共有し、件数を DOM に書き出さない。
  globalThis.__tteDomMuteCount = () => removedPosts.size + removedUsers.size;

  const style = document.createElement("style");
  style.textContent = ".tte-hidden{display:none !important;}";
  function ensureStyle() {
    if (!style.isConnected && document.documentElement) {
      (document.head || document.documentElement).appendChild(style);
    }
  }

  function statusLink(article) {
    const time = article.querySelector("time");
    const timedLink = time && time.closest('a[href*="/status/"]');
    return timedLink || article.querySelector('a[href*="/status/"]');
  }

  function repostHandles(article) {
    const handles = [];
    for (const context of article.querySelectorAll('[data-testid="socialContext"]')) {
      let hasRepostIcon = false;
      let ancestor = context;
      // article 自身は操作バーのアイコンまで含むため走査しない。
      for (let depth = 0; ancestor && depth <= 6 && !ancestor.matches("article"); depth += 1, ancestor = ancestor.parentElement) {
        if ([...ancestor.querySelectorAll("svg path[d]")].some((path) => path.getAttribute("d").startsWith(REPOST_ICON_PATH_PREFIX))) {
          hasRepostIcon = true;
          break;
        }
      }
      if (!hasRepostIcon && !REPOST_CONTEXT_TEXT.test((context.textContent || "").trim())) continue;
      const links = [...context.querySelectorAll("a[href]")];
      const enclosing = context.closest("a[href]");
      if (enclosing) links.push(enclosing);
      for (const link of links) {
        const handle = handleFromHref(link.getAttribute("href"), true);
        if (handle) handles.push(handle);
      }
    }
    return handles;
  }

  function userCellHandle(cell) {
    const name = cell.querySelector('[data-testid="User-Name"]');
    const links = name ? [...name.querySelectorAll("a[href]"), ...cell.querySelectorAll("a[href]")] : cell.querySelectorAll("a[href]");
    for (const link of links) {
      const handle = handleFromHref(link.getAttribute("href"), true);
      if (handle) return handle;
    }
    return null;
  }

  function setHidden(target, bad) {
    if (bad) {
      if (!target.classList.contains("tte-hidden")) target.classList.add("tte-hidden");
      hiddenTargets.add(target);
      if (hiddenInPass) hiddenInPass.add(target);
    } else if (hiddenTargets.delete(target)) {
      target.classList.remove("tte-hidden");
    }
  }

  function outermostArticle(article) {
    let outer = article;
    for (let ancestor = article.parentElement && article.parentElement.closest("article"); ancestor; ancestor = ancestor.parentElement && ancestor.parentElement.closest("article")) {
      outer = ancestor;
    }
    return outer;
  }

  function evaluate(node) {
    if (node.matches("article")) {
      // 引用先の代替表示などの入れ子 article が同じセルを別の判定で上書きすると、
      // 隠す・戻すが MutationObserver 経由で無限に繰り返されるため、外側の投稿だけで判定する。
      const outer = outermostArticle(node);
      if (outer !== node) {
        evaluate(outer);
        return;
      }
      const link = statusLink(node);
      const href = link && link.getAttribute("href");
      const text = tweetTextElement(node);
      const bad = handleMatchesMute(handleFromHref(href), rules) ||
        repostHandles(node).some((handle) => handleMatchesMute(handle, rules)) ||
        textMatchesMute(text ? tweetTextContent(text) : "", rules);
      setHidden(node.closest('[data-testid="cellInnerDiv"]') || node, bad);
      const id = postIdFromHref(href);
      if (bad && id) removedPosts.add(id);
    } else {
      const handle = userCellHandle(node);
      const bad = handleMatchesMute(handle, rules);
      setHidden(node, bad);
      if (bad) removedUsers.add(handle);
    }
  }

  const TARGET_SELECTOR = 'article, [data-testid="UserCell"]';
  const CELL_SELECTOR = '[data-testid="cellInnerDiv"]';

  function reevaluateHiddenCell(cell) {
    const targets = [...cell.querySelectorAll(TARGET_SELECTOR)];
    if (!targets.some((target) => target.matches("article"))) setHidden(cell, false);
    for (const target of targets) evaluate(target);
  }

  // 隠し続ける対象のクラスは付け外ししない。走査で一致しなかった対象(DOM から外れたものを含む)だけ戻す。
  function applyAll() {
    ensureStyle();
    const stillHidden = new Set();
    hiddenInPass = stillHidden;
    try {
      for (const node of document.querySelectorAll(TARGET_SELECTOR)) evaluate(node);
    } finally {
      hiddenInPass = null;
    }
    for (const target of [...hiddenTargets]) {
      if (!stillHidden.has(target)) setHidden(target, false);
    }
  }

  function loadRules() {
    chrome.storage.local.get({ wordMute: true, muteWords: [], muteRegexes: [], handleMute: true, muteHandles: [] }, (cfg) => {
      rules = compileMuteRules(cfg);
      applyAll();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && ["wordMute", "muteWords", "muteRegexes", "handleMute", "muteHandles"].some((key) => changes[key])) loadRules();
  });

  let timer = null;
  const observer = new MutationObserver((records) => {
    ensureStyle();
    const affected = new Set();
    const changedHiddenCells = new Set();
    function collect(node, includeDescendants) {
      const element = node.nodeType === 1 ? node : node.parentElement;
      if (!element) return;
      const ancestor = element.closest(TARGET_SELECTOR);
      if (ancestor) affected.add(ancestor);
      const cell = element.closest(CELL_SELECTOR);
      if (cell && hiddenTargets.has(cell)) changedHiddenCells.add(cell);
      if (includeDescendants) {
        for (const child of element.querySelectorAll(TARGET_SELECTOR)) affected.add(child);
      }
    }
    for (const record of records) {
      collect(record.target, false);
      for (const node of record.addedNodes) collect(node, true);
    }
    for (const node of affected) evaluate(node);
    for (const cell of changedHiddenCells) reevaluateHiddenCell(cell);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      applyAll();
    }, 250);
  });
  // document_start では body や html がまだ無いため、Document 自体を監視する。
  observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["href", "data-testid"] });
  ensureStyle();
  loadRules();
})();
