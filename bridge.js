// ISOLATED world から機能のオン/オフだけを MAIN world の DOM 属性へ渡す。
// ポップアップには relationship の除外累計と DOM 非表示の累計を合算して返す。
(() => {
  "use strict";

  const DEFAULTS = {
    enabled: true,
    disableAutoplay: true,
    cleanLink: true,
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
      document.documentElement.setAttribute(
        "data-tte-cleanlink",
        cfg.cleanLink ? "1" : "0"
      );
    } catch (_) {}
  }

  chrome.storage.local.get(DEFAULTS, (cfg) => {
    apply(cfg);
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
    if (changes.cleanLink) {
      document.documentElement.setAttribute(
        "data-tte-cleanlink",
        changes.cleanLink.newValue ? "1" : "0"
      );
    }
  });

  // popup からの「このタブで何件除外した?」問い合わせ
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "tte-get-count") {
      const v = document.documentElement.getAttribute("data-tte-removed");
      const domRemoved = globalThis.__tteDomMuteCount?.() || 0;
      sendResponse({ total: (v ? parseInt(v, 10) || 0 : 0) + domRemoved });
      // 同期で応答済み。チャネルを開いたままにしない。
    }
    // 無関係なメッセージはここでは応答しない（他のリスナに委ねる）
  });
})();
