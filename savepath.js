/*
 * importScripts() で background.js と同じトップレベルスコープに読み込まれるため、
 * 同名宣言との衝突で service worker 全体が停止しないよう、宣言を IIFE の中に閉じ込める。
 */
(() => {
  "use strict";

  const DEFAULT_SAVE_DIR = "TwitterMedia";
  const DEFAULT_FILENAME_FORMAT = "{screen_name}_{post_id}_{file_name}";
  const MAX_SAVE_DIR_LENGTH = 100;
  const MAX_FILENAME_FORMAT_LENGTH = 100;
  const MAX_FILENAME_LENGTH = 150;

  const FORBIDDEN_CHARACTER_RE = /["*\/:<>?\\|]/u;
  const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;
  const RESERVED_NAMES = new Set([
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
    "clock$",
  ]);

  function forbiddenLabels(value) {
    const labels = [];
    const seen = new Set();
    for (const character of value) {
      let label = null;
      if (CONTROL_OR_FORMAT_RE.test(character)) {
        label = "制御文字";
      } else if (FORBIDDEN_CHARACTER_RE.test(character)) {
        label = character;
      }
      if (label !== null && !seen.has(label)) {
        seen.add(label);
        labels.push(label);
      }
    }
    return labels;
  }

  function forbiddenMessage(value) {
    const labels = forbiddenLabels(value);
    return labels.length
      ? `使えない文字${labels.map((label) => `「${label}」`).join("")}が含まれています。`
      : null;
  }

  function hasUnsafeExtension(name) {
    const dot = name.lastIndexOf(".");
    if (dot < 0) return false;
    const extension = name.slice(dot + 1).toLowerCase();
    return (
      extension === "lnk" ||
      extension === "local" ||
      extension === "scf" ||
      extension === "url" ||
      (extension.startsWith("{") && extension.endsWith("}"))
    );
  }

  function isReservedName(name) {
    const lower = name.toLowerCase();
    if (RESERVED_NAMES.has(lower)) return true;
    for (const reserved of RESERVED_NAMES) {
      if (lower.startsWith(`${reserved}.`)) return true;
    }
    // 次の名前は RESERVED_NAMES と違い、「名前.」で始まる場合は含まず完全一致のときだけ予約名になる
    return (
      lower === "desktop.ini" ||
      lower === "thumbs.db" ||
      lower === "conin$" ||
      lower === "conout$"
    );
  }

  function hasUnsafeEdge(name) {
    return /^[\s.~]/u.test(name) || /[\s.~]$/u.test(name);
  }

  function isSafeComponent(name) {
    if (typeof name !== "string" || name.length === 0) return false;
    if (FORBIDDEN_CHARACTER_RE.test(name) || CONTROL_OR_FORMAT_RE.test(name)) {
      return false;
    }
    if (hasUnsafeEdge(name)) return false;
    if (isReservedName(name)) return false;
    if (hasUnsafeExtension(name)) return false;
    return true;
  }

  function validateSaveDir(raw) {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { ok: true, dir: DEFAULT_SAVE_DIR };
    }

    const s = raw.trim().replace(/\\/g, "/");
    if (s.length > MAX_SAVE_DIR_LENGTH) {
      return { ok: false, message: "100文字以内で指定してください。" };
    }
    if (s.startsWith("/") || /^[A-Za-z]:/u.test(s)) {
      return {
        ok: false,
        message:
          "ダウンロードフォルダからの相対パスで指定してください（先頭の / やドライブ名は使えません）。",
      };
    }

    const segments = s.split("/").filter(Boolean);
    if (segments.length === 0) {
      return { ok: true, dir: DEFAULT_SAVE_DIR };
    }

    for (const segment of segments) {
      if (segment === "." || segment === "..") {
        return { ok: false, message: "「.」「..」はフォルダ名に使えません。" };
      }
      const invalidMessage = forbiddenMessage(segment);
      if (invalidMessage) return { ok: false, message: invalidMessage };
      // Chrome は Windows で、短い名前（8.3 形式）と紛らわしい「~ を含む 12 文字以下の名前」を
      // 拒否する。フォルダ名は短くなりやすいので、位置を問わず「~」を使えなくする。
      if (segment.includes("~")) {
        return { ok: false, message: "フォルダ名に「~」は使えません。" };
      }
      if (hasUnsafeEdge(segment)) {
        return {
          ok: false,
          message: "フォルダ名の先頭と末尾に空白・「.」は使えません。",
        };
      }
      if (isReservedName(segment)) {
        return {
          ok: false,
          message: `「${segment}」は Windows で予約された名前のため使えません。`,
        };
      }
      if (hasUnsafeExtension(segment)) {
        return {
          ok: false,
          message: `「${segment}」は末尾が .lnk や .local などのため使えません。`,
        };
      }
    }
    return { ok: true, dir: segments.join("/") };
  }

  function validateFilenameFormat(raw) {
    if (typeof raw !== "string" || raw.trim() === "") {
      return { ok: true, format: DEFAULT_FILENAME_FORMAT };
    }

    const s = raw.trim();
    if (s.length > MAX_FILENAME_FORMAT_LENGTH) {
      return { ok: false, message: "100文字以内で指定してください。" };
    }
    const invalidMessage = forbiddenMessage(s);
    if (invalidMessage) return { ok: false, message: invalidMessage };
    if (/^[.~]/u.test(s)) {
      return { ok: false, message: "先頭に「.」「~」は使えません。" };
    }
    if (!s.includes("{file_name}")) {
      return {
        ok: false,
        message: "{file_name}（元のファイル名）を含めてください。",
      };
    }

    return { ok: true, format: s };
  }

  function pad(value, length) {
    return String(value).padStart(length, "0");
  }

  function postDateParts(postId) {
    if (typeof postId !== "string" || !/^\d{1,20}$/u.test(postId)) {
      return { yyyyMMdd: "", HHmmss: "" };
    }
    try {
      const ms = Number((BigInt(postId) >> 22n) + 1288834974657n);
      const date = new Date(ms);
      if (Number.isNaN(date.getTime())) {
        return { yyyyMMdd: "", HHmmss: "" };
      }
      return {
        yyyyMMdd: `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}`,
        HHmmss: `${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`,
      };
    } catch (_) {
      return { yyyyMMdd: "", HHmmss: "" };
    }
  }

  function buildFileName(format, meta) {
    const dateParts = postDateParts(meta.postId);
    const values = {
      screen_name: meta.screenName,
      yyyyMMdd: dateParts.yyyyMMdd,
      HHmmss: dateParts.HHmmss,
      post_id: meta.postId || "",
      file_name: meta.fileName,
    };
    // 拡張子を {file_name} の位置に依存せずファイル末尾へ付けることで、形式内の
    // 位置を自由に変えても保存するファイルの種類が保たれる。
    return (
      format.replace(
        /\{(screen_name|yyyyMMdd|HHmmss|post_id|file_name)\}/g,
        (_, token) => values[token]
      ) +
      "." +
      meta.ext
    );
  }

  function resolveSavePath(settings, meta) {
    const saveDirResult = validateSaveDir(settings && settings.saveDir);
    const formatResult = validateFilenameFormat(settings && settings.filenameFormat);
    const dir = saveDirResult.ok ? saveDirResult.dir : DEFAULT_SAVE_DIR;
    const format = formatResult.ok ? formatResult.format : DEFAULT_FILENAME_FORMAT;

    let name = buildFileName(format, meta);
    if (!isSafeComponent(name) || name.length > MAX_FILENAME_LENGTH) {
      name = buildFileName(DEFAULT_FILENAME_FORMAT, meta);
    }
    if (!isSafeComponent(name) || name.length > MAX_FILENAME_LENGTH) return null;
    return `${dir}/${name}`;
  }

  const api = {
    DEFAULT_SAVE_DIR,
    DEFAULT_FILENAME_FORMAT,
    MAX_SAVE_DIR_LENGTH,
    MAX_FILENAME_FORMAT_LENGTH,
    MAX_FILENAME_LENGTH,
    isSafeComponent,
    validateSaveDir,
    validateFilenameFormat,
    postDateParts,
    buildFileName,
    resolveSavePath,
  };

  globalThis.TteSavePath = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
