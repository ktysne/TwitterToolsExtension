"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { safeUrl, safeFilename, fromTwitter, handleDownloadMessage } = require("../background.js");

// ---- safeUrl ---------------------------------------------------------------

test("safeUrl: https の twimg.com 系だけ通す", () => {
  assert.equal(
    safeUrl("https://pbs.twimg.com/media/AbC?format=jpg&name=orig"),
    "https://pbs.twimg.com/media/AbC?format=jpg&name=orig"
  );
  assert.equal(safeUrl("https://video.twimg.com/x.mp4"), "https://video.twimg.com/x.mp4");
  assert.equal(safeUrl("https://twimg.com/x"), "https://twimg.com/x");
});

test("safeUrl: http・別ホスト・不正値は弾く", () => {
  assert.equal(safeUrl("http://pbs.twimg.com/media/x"), null); // http
  assert.equal(safeUrl("https://evil.example/x"), null); // 別ホスト
  assert.equal(safeUrl("https://nottwimg.com/x"), null);
  assert.equal(safeUrl("https://twimg.com.evil.com/x"), null); // サフィックス偽装
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("not a url"), null);
  assert.equal(safeUrl(null), null);
});

// ---- safeFilename ----------------------------------------------------------

test("safeFilename: TwitterMedia 配下に強制する", () => {
  assert.equal(safeFilename("alice_123_1.jpg"), "TwitterMedia/alice_123_1.jpg");
  assert.equal(
    safeFilename("TwitterMedia/alice_123_1.jpg"),
    "TwitterMedia/alice_123_1.jpg"
  );
});

test("safeFilename: パストラバーサル・絶対パス・制御文字を弾く", () => {
  assert.equal(safeFilename("../etc/passwd"), null);
  assert.equal(safeFilename("TwitterMedia/../../secret"), null);
  assert.equal(safeFilename("a/./b.jpg"), null);
  assert.equal(safeFilename("a\\b.jpg"), null); // バックスラッシュ
  assert.equal(safeFilename("a\x00b.jpg"), null); // 制御文字
  assert.equal(safeFilename("a:b.jpg"), null);
  assert.equal(safeFilename(""), null);
  assert.equal(safeFilename(null), null);
  assert.equal(safeFilename(123), null);
});

test("safeFilename: 先頭スラッシュは空要素として除かれ、配下に収まる", () => {
  // "/abs/path.jpg" → ["abs","path.jpg"] になり、危険文字も無いので配下に収まる
  assert.equal(safeFilename("/foo/bar.jpg"), "TwitterMedia/foo/bar.jpg");
});

// ---- fromTwitter -----------------------------------------------------------

test("fromTwitter: x.com / twitter.com とそのサブドメインを許可", () => {
  assert.equal(fromTwitter({ url: "https://x.com/home" }), true);
  assert.equal(fromTwitter({ url: "https://twitter.com/x" }), true);
  assert.equal(fromTwitter({ url: "https://mobile.twitter.com/x" }), true);
  assert.equal(fromTwitter({ url: "https://sub.x.com/x" }), true);
});

test("fromTwitter: 別オリジンや不正値は拒否", () => {
  assert.equal(fromTwitter({ url: "https://evil.com/x" }), false);
  assert.equal(fromTwitter({ url: "https://x.com.evil.com/x" }), false);
  assert.equal(fromTwitter({ url: "" }), false);
  assert.equal(fromTwitter(null), false);
  assert.equal(fromTwitter({}), false);
});

// ---- handleDownloadMessage -------------------------------------------------

const SENDER = { url: "https://x.com/search" };

test("handleDownloadMessage: 検証を通った項目だけダウンロードする", () => {
  const calls = [];
  const resp = handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        { url: "https://pbs.twimg.com/media/a?name=orig", filename: "alice_1_1.jpg" },
        { url: "https://evil.example/x", filename: "x.jpg" }, // URL 不正 → 弾く
        { url: "https://pbs.twimg.com/media/b", filename: "../escape.jpg" }, // パス不正 → 弾く
      ],
    },
    SENDER,
    (opts) => calls.push(opts)
  );
  assert.deepEqual(resp, { ok: true, started: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filename, "TwitterMedia/alice_1_1.jpg");
  assert.equal(calls[0].saveAs, false);
});

test("handleDownloadMessage: Twitter 以外の送信元は拒否", () => {
  const calls = [];
  const resp = handleDownloadMessage(
    { type: "tte-download-images", items: [{ url: "https://pbs.twimg.com/media/a", filename: "x.jpg" }] },
    { url: "https://evil.com/x" },
    (opts) => calls.push(opts)
  );
  assert.deepEqual(resp, { ok: false, started: 0 });
  assert.equal(calls.length, 0);
});

test("handleDownloadMessage: 無関係なメッセージは null（応答しない）", () => {
  assert.equal(handleDownloadMessage({ type: "other" }, SENDER, () => {}), null);
  assert.equal(handleDownloadMessage(null, SENDER, () => {}), null);
  assert.equal(
    handleDownloadMessage({ type: "tte-download-images", items: "nope" }, SENDER, () => {}),
    null
  );
});

test("handleDownloadMessage: 最大件数を超える分は切り捨てる", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    url: "https://pbs.twimg.com/media/" + i,
    filename: "a_" + i + ".jpg",
  }));
  const calls = [];
  const resp = handleDownloadMessage(
    { type: "tte-download-images", items },
    SENDER,
    (opts) => calls.push(opts)
  );
  assert.equal(resp.ok, true);
  assert.equal(resp.started, 30); // MAX_ITEMS
  assert.equal(calls.length, 30);
});
