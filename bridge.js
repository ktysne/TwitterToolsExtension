/*
 * bridge.js  —  runs in the ISOLATED world (document_start)
 *
 * MAIN world の interceptor.js は chrome.* API を使えないため、
 * このスクリプトが設定の橋渡しをする（共有DOMが通信路）:
 *   - enabled         → <html data-tte-enabled>    ブロック/ミュート除外フィルタ
 *   - disableAutoplay → <html data-tte-autoplay>   動画の自動再生停止
 *   - wordMute / muteWords / muteRegexes / handleMute / muteHandles
 *                     → <div id="__tteMuteRules">  ワード・@id ミュートのルール(JSON)
 * また popup からの「このタブで何件除外した?」問い合わせに応答する。
 */
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    disableAutoplay: true,
    wordMute: true,
    muteWords: [],
    muteRegexes: [],
    handleMute: true,
    muteHandles: [],
  };

  function apply(cfg) {
    try {
      document.documentElement.setAttribute(
        "data-tte-enabled",
        cfg.enabled ? "1" : "0"
      );
      document.documentElement.setAttribute(
        "data-tte-autoplay",
        cfg.disableAutoplay ? "1" : "0"
      );
    } catch (_) {}
  }

  // ワードミュートのルールは件数が多くなりうるので属性ではなく専用ノードに置く
  function muteNode() {
    let n = document.getElementById("__tteMuteRules");
    if (!n) {
      n = document.createElement("div");
      n.id = "__tteMuteRules";
      n.style.display = "none";
      (document.documentElement || document).appendChild(n);
    }
    return n;
  }

  function applyMute(cfg) {
    try {
      muteNode().textContent = JSON.stringify({
        enabled: !!cfg.wordMute,
        words: Array.isArray(cfg.muteWords) ? cfg.muteWords : [],
        regexes: Array.isArray(cfg.muteRegexes) ? cfg.muteRegexes : [],
        handleEnabled: !!cfg.handleMute,
        handles: Array.isArray(cfg.muteHandles) ? cfg.muteHandles : [],
      });
    } catch (_) {}
  }

  // 初期状態を反映（既定: すべて有効、ワードリストは空）
  chrome.storage.local.get(DEFAULTS, (cfg) => {
    apply(cfg);
    applyMute(cfg);
  });

  // popup での変更を即反映
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.enabled) {
      document.documentElement.setAttribute(
        "data-tte-enabled",
        changes.enabled.newValue ? "1" : "0"
      );
    }
    if (changes.disableAutoplay) {
      document.documentElement.setAttribute(
        "data-tte-autoplay",
        changes.disableAutoplay.newValue ? "1" : "0"
      );
    }
    // ミュート系の項目は相互に関係するので、変化があれば一括で読み直す
    if (
      changes.wordMute ||
      changes.muteWords ||
      changes.muteRegexes ||
      changes.handleMute ||
      changes.muteHandles
    ) {
      chrome.storage.local.get(
        {
          wordMute: true,
          muteWords: [],
          muteRegexes: [],
          handleMute: true,
          muteHandles: [],
        },
        (cfg) => applyMute(cfg)
      );
    }
  });

  // popup からの「このタブで何件除外した?」問い合わせ
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "tte-get-count") {
      const v = document.documentElement.getAttribute("data-tte-removed");
      sendResponse({ total: v ? parseInt(v, 10) || 0 : 0 });
    }
    return true;
  });
})();
