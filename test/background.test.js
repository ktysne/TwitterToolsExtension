"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  safeUrl,
  safeFilename,
  fromTwitter,
  existsQuery,
  makeFileExists,
  handleDownloadMessage,
} = require("../background.js");

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

// ---- existsQuery -----------------------------------------------------------

test("existsQuery: 末尾一致・メタ文字エスケープ・両方の区切りを許す", () => {
  const q = existsQuery("TwitterMedia/a.jpg");
  assert.equal(q.filenameRegex, "[\\\\/]TwitterMedia[\\\\/]a\\.jpg$");
  assert.equal(q.exists, true);
  assert.equal(q.state, "complete");
  assert.equal(q.limit, 1);

  const re = new RegExp(q.filenameRegex);
  assert.equal(re.test("C:\\Users\\x\\Downloads\\TwitterMedia\\a.jpg"), true);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/a.jpg"), true);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/aXjpg"), false); // . はメタ文字でない
  assert.equal(re.test("/home/x/Downloads/Other/a.jpg"), false); // 別フォルダ
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/a.jpg.bak"), false); // 末尾一致
});

// ---- makeFileExists --------------------------------------------------------

test("makeFileExists: 検索結果があれば true、無ければ false", async () => {
  const hit = makeFileExists((q, cb) => cb([{ id: 1 }]));
  assert.equal(await hit("TwitterMedia/a.jpg"), true);

  const miss = makeFileExists((q, cb) => cb([]));
  assert.equal(await miss("TwitterMedia/a.jpg"), false);
});

test("makeFileExists: search が例外を投げたら false（DLを止めない）", async () => {
  const boom = makeFileExists(() => {
    throw new Error("boom");
  });
  assert.equal(await boom("TwitterMedia/a.jpg"), false);
});

// ---- handleDownloadMessage -------------------------------------------------

const SENDER = { url: "https://x.com/search" };

// 既定の deps。個別テストで必要な部分だけ差し替える。
function makeDeps(over) {
  const calls = [];
  return Object.assign(
    {
      calls,
      download: (opts) => calls.push(opts),
      fileExists: async () => false,
      getSkipExisting: async () => false,
    },
    over || {}
  );
}

test("handleDownloadMessage: 検証を通った項目だけダウンロードする", async () => {
  const deps = makeDeps();
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        { url: "https://pbs.twimg.com/media/a?name=orig", filename: "alice_1_1.jpg" },
        { url: "https://evil.example/x", filename: "x.jpg" }, // URL 不正 → 弾く
        { url: "https://pbs.twimg.com/media/b", filename: "../escape.jpg" }, // パス不正 → 弾く
      ],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 0 });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].filename, "TwitterMedia/alice_1_1.jpg");
  assert.equal(deps.calls[0].saveAs, false);
});

test("handleDownloadMessage: Twitter 以外の送信元は拒否", async () => {
  const deps = makeDeps();
  const resp = await handleDownloadMessage(
    { type: "tte-download-images", items: [{ url: "https://pbs.twimg.com/media/a", filename: "x.jpg" }] },
    { url: "https://evil.com/x" },
    deps
  );
  assert.deepEqual(resp, { ok: false, started: 0, skipped: 0 });
  assert.equal(deps.calls.length, 0);
});

test("handleDownloadMessage: 無関係なメッセージは null（応答しない）", () => {
  // 同期で null を返す（Promise でないこと）
  assert.equal(handleDownloadMessage({ type: "other" }, SENDER, makeDeps()), null);
  assert.equal(handleDownloadMessage(null, SENDER, makeDeps()), null);
  assert.equal(
    handleDownloadMessage({ type: "tte-download-images", items: "nope" }, SENDER, makeDeps()),
    null
  );
});

test("handleDownloadMessage: 最大件数を超える分は切り捨てる", async () => {
  const items = Array.from({ length: 50 }, (_, i) => ({
    url: "https://pbs.twimg.com/media/" + i,
    filename: "a_" + i + ".jpg",
  }));
  const deps = makeDeps();
  const resp = await handleDownloadMessage({ type: "tte-download-images", items }, SENDER, deps);
  assert.equal(resp.ok, true);
  assert.equal(resp.started, 30); // MAX_ITEMS
  assert.equal(deps.calls.length, 30);
});

test("handleDownloadMessage: 同名ファイルがある項目はスキップする", async () => {
  const deps = makeDeps({
    getSkipExisting: async () => true,
    fileExists: async (filename) => filename === "TwitterMedia/a.jpg",
  });
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        { url: "https://pbs.twimg.com/media/a", filename: "a.jpg" }, // 既にある → スキップ
        { url: "https://pbs.twimg.com/media/b", filename: "b.jpg" },
      ],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 1 });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].filename, "TwitterMedia/b.jpg");
});

test("handleDownloadMessage: 設定がオフなら同名でも全件ダウンロードする", async () => {
  let existsCalls = 0;
  const deps = makeDeps({
    getSkipExisting: async () => false,
    fileExists: async () => {
      existsCalls++;
      return true;
    },
  });
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        { url: "https://pbs.twimg.com/media/a", filename: "a.jpg" },
        { url: "https://pbs.twimg.com/media/b", filename: "b.jpg" },
      ],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 2, skipped: 0 });
  assert.equal(existsCalls, 0); // 設定オフなら存在確認そのものを行わない
});

test("handleDownloadMessage: 設定の読み出しは1メッセージにつき1回だけ", async () => {
  let getCalls = 0;
  const deps = makeDeps({
    getSkipExisting: async () => {
      getCalls++;
      return true;
    },
  });
  await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        { url: "https://pbs.twimg.com/media/a", filename: "a.jpg" },
        { url: "https://pbs.twimg.com/media/b", filename: "b.jpg" },
        { url: "https://pbs.twimg.com/media/c", filename: "c.jpg" },
      ],
    },
    SENDER,
    deps
  );
  assert.equal(getCalls, 1);
});
