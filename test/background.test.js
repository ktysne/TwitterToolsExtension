"use strict";

const test = require("node:test");
const { beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  safeUrl,
  originalFileName,
  normalizeMediaMeta,
  fromTwitter,
  existsQuery,
  hasSameFile,
  makeFileExists,
  handleDownloadMessage,
  _resetPending,
} = require("../background.js");

// 予約（pending）はモジュールスコープに持つため、テスト間で持ち越さない
beforeEach(() => _resetPending());

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
  assert.equal(safeUrl("http://pbs.twimg.com/media/x"), null);
  assert.equal(safeUrl("https://evil.example/x"), null);
  assert.equal(safeUrl("https://nottwimg.com/x"), null);
  assert.equal(safeUrl("https://twimg.com.evil.com/x"), null);
  assert.equal(safeUrl("javascript:alert(1)"), null);
  assert.equal(safeUrl("not a url"), null);
  assert.equal(safeUrl(null), null);
});

// ---- originalFileName ------------------------------------------------------

test("画像URLから元の名前と format の拡張子を取り出す", () => {
  assert.deepEqual(
    originalFileName(
      "https://pbs.twimg.com/media/GXyZ1aBcDeFgHi?format=jpg&name=orig"
    ),
    { fileName: "GXyZ1aBcDeFgHi", ext: "jpg" }
  );
});

test("画像URLの名前にある拡張子を小文字化して取り出す", () => {
  assert.deepEqual(
    originalFileName("https://pbs.twimg.com/media/GXyZ1aBcDeFgHi.JPEG?name=orig"),
    { fileName: "GXyZ1aBcDeFgHi", ext: "jpeg" }
  );
});

test("画像URLではクエリの format を優先する", () => {
  assert.deepEqual(
    originalFileName(
      "https://pbs.twimg.com/media/GXyZ1aBcDeFgHi.jpg?format=PNG&name=orig"
    ),
    { fileName: "GXyZ1aBcDeFgHi", ext: "png" }
  );
});

test("originalFileName: 未知のformatでsegmentにも拡張子が無ければnullを返す", () => {
  assert.equal(
    originalFileName("https://pbs.twimg.com/media/GXyZ1aBcDeFgHi?format=svg"),
    null
  );
});

test("originalFileName: 名前に許可外の文字があればnullを返す", () => {
  assert.equal(originalFileName("https://pbs.twimg.com/media/GXyZ%1a"), null);
  assert.equal(originalFileName("https://pbs.twimg.com/media/GXyZ..jpg"), null);
});

test("クエリ付きの動画 mp4 から元の名前と拡張子を取り出す", () => {
  assert.deepEqual(
    originalFileName("https://video.twimg.com/ext_tw_video/AbCdEf.mp4?tag=12"),
    { fileName: "AbCdEf", ext: "mp4" }
  );
});

test("originalFileName: mp4以外の動画形式はnullを返す", () => {
  assert.equal(
    originalFileName("https://video.twimg.com/ext_tw_video/AbCdEf.m3u8"),
    null
  );
});

test("originalFileName: pbs.twimg.comのmedia以外のパスは画像として扱わない", () => {
  assert.equal(
    originalFileName("https://pbs.twimg.com/profile_images/GXyZ.jpg?format=jpg"),
    null
  );
});

// ---- normalizeMediaMeta ---------------------------------------------------

test("URLから元の名前と拡張子を取り出し、項目を正規化する", () => {
  assert.deepEqual(
    normalizeMediaMeta(
      { screenName: "a", postId: "1", index: 1, ext: "svg" },
      "https://pbs.twimg.com/media/GXyZ.jpg"
    ),
    { screenName: "a", postId: "1", fileName: "GXyZ", ext: "jpg" }
  );
  assert.deepEqual(
    normalizeMediaMeta(
      { screenName: "a", postId: "1", index: null, ext: "mp4" },
      "https://video.twimg.com/ext_tw_video/AbCd.mp4?tag=1"
    ),
    { screenName: "a", postId: "1", fileName: "AbCd", ext: "mp4" }
  );
  assert.equal(
    normalizeMediaMeta(
      { screenName: "a", postId: "1" },
      "https://pbs.twimg.com/media/GXyZ"
    ),
    null
  );
});

test("normalizeMediaMeta: screenName を置換・切り詰めし、空なら x にする", () => {
  assert.equal(
    normalizeMediaMeta(
      { screenName: "alice/@b", postId: "1" },
      "https://pbs.twimg.com/media/a.jpg"
    ).screenName,
    "alice__b"
  );
  assert.equal(
    normalizeMediaMeta(
      { screenName: "a".repeat(60), postId: "1" },
      "https://pbs.twimg.com/media/a.jpg"
    ).screenName.length,
    50
  );
  assert.equal(
    normalizeMediaMeta(
      { screenName: "日本語/!?", postId: "1" },
      "https://pbs.twimg.com/media/a.jpg"
    ).screenName,
    "______"
  );
  assert.equal(
    normalizeMediaMeta(
      { screenName: "", postId: "1" },
      "https://pbs.twimg.com/media/a.jpg"
    ).screenName,
    "x"
  );
});

test("normalizeMediaMeta: postId の許可範囲だけ残す", () => {
  assert.deepEqual(
    normalizeMediaMeta(
      { screenName: "a", postId: "12345678901234567890", index: 99 },
      "https://pbs.twimg.com/media/a.jpg"
    ),
    { screenName: "a", postId: "12345678901234567890", fileName: "a", ext: "jpg" }
  );
  assert.deepEqual(
    normalizeMediaMeta(
      { screenName: "a", postId: 123, index: "1" },
      "https://pbs.twimg.com/media/a.jpg"
    ),
    { screenName: "a", postId: null, fileName: "a", ext: "jpg" }
  );
  for (const postId of ["", "x", "1".repeat(21)]) {
    assert.equal(
      normalizeMediaMeta(
        { screenName: "a", postId },
        "https://pbs.twimg.com/media/a.jpg"
      ).postId,
      null
    );
  }
});

test("normalizeMediaMeta: 元のファイル名を取り出せないURLは除外する", () => {
  assert.equal(
    normalizeMediaMeta({ screenName: "a", postId: "1" }, "https://pbs.twimg.com/media/a"),
    null
  );
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
  // 判定は結果側で行うため state / exists では絞らず、見落としを防ぐため件数も絞らない
  assert.deepEqual(Object.keys(q), ["filenameRegex"]);
  assert.equal("state" in q, false);
  assert.equal("exists" in q, false);
  assert.equal("limit" in q, false);

  const re = new RegExp(q.filenameRegex);
  assert.equal(re.test("C:\\Users\\x\\Downloads\\TwitterMedia\\a.jpg"), true);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/a.jpg"), true);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/aXjpg"), false);
  assert.equal(re.test("/home/x/Downloads/Other/a.jpg"), false);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/a.jpg.bak"), false);
});

// ---- hasSameFile -----------------------------------------------------------

test("hasSameFile: ダウンロード中と、完了済みで実在するものをヒットとする", () => {
  assert.equal(hasSameFile([{ state: "in_progress" }]), true);
  assert.equal(hasSameFile([{ state: "complete", exists: true }]), true);
});

test("hasSameFile: 実在を確認できない完了済み・中断・空・非配列はヒットしない", () => {
  assert.equal(hasSameFile([{ state: "complete", exists: false }]), false);
  assert.equal(hasSameFile([{ state: "complete" }]), false);
  assert.equal(hasSameFile([{ state: "interrupted" }]), false);
  assert.equal(hasSameFile([{ state: "interrupted", exists: true }]), false);
  assert.equal(hasSameFile([]), false);
  assert.equal(hasSameFile(null), false);
  assert.equal(hasSameFile(undefined), false);
  assert.equal(hasSameFile("nope"), false);
});

test("hasSameFile: 1件でもヒットすれば true", () => {
  assert.equal(
    hasSameFile([{ state: "interrupted" }, { state: "complete", exists: true }]),
    true
  );
});

// ---- makeFileExists --------------------------------------------------------

test("makeFileExists: 保存済みと見なせる結果があれば true、無ければ false", async () => {
  const hit = makeFileExists((q, cb) => cb([{ state: "complete", exists: true }]));
  assert.equal(await hit("TwitterMedia/a.jpg"), true);

  const running = makeFileExists((q, cb) => cb([{ state: "in_progress" }]));
  assert.equal(await running("TwitterMedia/a.jpg"), true);

  const gone = makeFileExists((q, cb) => cb([{ state: "complete", exists: false }]));
  assert.equal(await gone("TwitterMedia/a.jpg"), false);

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

function item(over) {
  return Object.assign(
    {
      url: "https://pbs.twimg.com/media/a.jpg",
      screenName: "a",
      postId: "1",
    },
    over || {}
  );
}

// 既定の deps。個別テストで必要な部分だけ差し替える。
function makeDeps(over) {
  const deps = {
    calls: [],
    download: (opts) => deps.calls.push(opts),
    fileExists: async () => false,
    getSettings: async () => ({ skipExisting: false }),
  };
  return Object.assign(deps, over || {});
}

test("handleDownloadMessage: 検証を通った項目だけ設定から保存パスを作る", async () => {
  const deps = makeDeps();
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        item({ screenName: "alice", postId: "1" }),
        item({ url: "https://evil.example/x", screenName: "x", postId: "2" }),
        item({ url: "https://pbs.twimg.com/media/c.svg", screenName: "x", postId: "3" }),
        item({ url: "https://pbs.twimg.com/media/d", screenName: "alice", postId: "4" }),
      ],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 0, failed: 0 });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].filename, "TwitterMedia/alice_1_a.jpg");
  assert.equal(deps.calls[0].saveAs, false);
});

test("handleDownloadMessage: Twitter 以外の送信元は拒否", async () => {
  const deps = makeDeps();
  const resp = await handleDownloadMessage(
    { type: "tte-download-images", items: [item()] },
    { url: "https://evil.com/x" },
    deps
  );
  assert.deepEqual(resp, { ok: false, started: 0, skipped: 0, failed: 0 });
  assert.equal(deps.calls.length, 0);
});

test("handleDownloadMessage: 無関係なメッセージは null（応答しない）", () => {
  assert.equal(handleDownloadMessage({ type: "other" }, SENDER, makeDeps()), null);
  assert.equal(handleDownloadMessage(null, SENDER, makeDeps()), null);
  assert.equal(
    handleDownloadMessage({ type: "tte-download-images", items: "nope" }, SENDER, makeDeps()),
    null
  );
});

test("handleDownloadMessage: 最大件数を超える分は切り捨てる", async () => {
  const items = Array.from({ length: 50 }, (_, i) => item({ postId: String(i) }));
  const deps = makeDeps();
  const resp = await handleDownloadMessage({ type: "tte-download-images", items }, SENDER, deps);
  assert.equal(resp.ok, true);
  assert.equal(resp.started, 30);
  assert.equal(resp.failed, 0);
  assert.equal(deps.calls.length, 30);
});

test("handleDownloadMessage: 保存先と形式の設定を反映する", async () => {
  const deps = makeDeps({
    getSettings: async () => ({
      skipExisting: false,
      saveDir: "Archive/Images",
      filenameFormat: "{screen_name}-{post_id}-{file_name}",
    }),
  });
  const resp = await handleDownloadMessage(
    { type: "tte-download-images", items: [item({ screenName: "alice", postId: "123" })] },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 0, failed: 0 });
  assert.equal(deps.calls[0].filename, "Archive/Images/alice-123-a.jpg");
});

test("handleDownloadMessage: 不正な設定値は既定値にフォールバックする", async () => {
  const deps = makeDeps({
    getSettings: async () => ({
      skipExisting: false,
      saveDir: "C:\\escape",
      filenameFormat: "{screen_name}/{post_id}",
    }),
  });
  const resp = await handleDownloadMessage(
    { type: "tte-download-images", items: [item({ screenName: "alice", postId: "123" })] },
    SENDER,
    deps
  );
  assert.equal(resp.started, 1);
  assert.equal(deps.calls[0].filename, "TwitterMedia/alice_123_a.jpg");
});

test("handleDownloadMessage: 同名ファイルがある項目はスキップする", async () => {
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: true }),
    fileExists: async (filename) => filename === "TwitterMedia/a_1_a.jpg",
  });
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [item({ postId: "1" }), item({ postId: "2" })],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 1, failed: 0 });
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].filename, "TwitterMedia/a_2_a.jpg");
});

test("handleDownloadMessage: 設定がオフなら同名でも全件ダウンロードする", async () => {
  let existsCalls = 0;
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: false }),
    fileExists: async () => {
      existsCalls++;
      return true;
    },
  });
  const resp = await handleDownloadMessage(
    { type: "tte-download-images", items: [item({ postId: "1" }), item({ postId: "2" })] },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 2, skipped: 0, failed: 0 });
  assert.equal(existsCalls, 0);
});

test("handleDownloadMessage: 予約済みの保存パスは履歴に無くてもスキップする", async () => {
  const msg = { type: "tte-download-images", items: [item()] };
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: true }),
    fileExists: async () => false,
  });

  const first = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(first, { ok: true, started: 1, skipped: 0, failed: 0 });

  const second = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(second, { ok: true, started: 0, skipped: 1, failed: 0 });
  assert.equal(deps.calls.length, 1);
});

test("handleDownloadMessage: 同一メッセージ内の同名ファイルは1件だけ発行する", async () => {
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: true }),
    fileExists: async () => false,
  });
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        item(),
        item(),
      ],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 1, failed: 0 });
  assert.equal(deps.calls.length, 1);
});

test("handleDownloadMessage: 並行するメッセージでも同名は1件だけ発行する", async () => {
  let resolveExists;
  const gate = new Promise((resolve) => {
    resolveExists = resolve;
  });
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: true }),
    fileExists: () => gate.then(() => false),
  });
  const msg = { type: "tte-download-images", items: [item()] };

  const first = handleDownloadMessage(msg, SENDER, deps);
  const second = handleDownloadMessage(msg, SENDER, deps);
  resolveExists();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(deps.calls.length, 1);
  assert.equal(a.started + b.started, 1);
  assert.equal(a.skipped + b.skipped, 1);
  assert.equal(a.failed + b.failed, 0);
});

test("handleDownloadMessage: download の拒否は failed に数え、予約を外す", async () => {
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: true }),
    fileExists: async () => false,
    download: (opts) => {
      deps.calls.push(opts);
      return Promise.reject(new Error("start failed"));
    },
  });
  const msg = { type: "tte-download-images", items: [item()] };

  const first = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(first, { ok: true, started: 0, skipped: 0, failed: 1 });

  const second = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(second, { ok: true, started: 0, skipped: 0, failed: 1 });
  assert.equal(deps.calls.length, 2);
});

test("handleDownloadMessage: download の同期例外は failed に数え、予約しない", async () => {
  let attempts = 0;
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: true }),
    fileExists: async () => false,
    download: (opts) => {
      deps.calls.push(opts);
      attempts++;
      if (attempts === 1) throw new Error("sync failure");
      return undefined;
    },
  });
  const msg = { type: "tte-download-images", items: [item()] };

  assert.deepEqual(await handleDownloadMessage(msg, SENDER, deps), {
    ok: true,
    started: 0,
    skipped: 0,
    failed: 1,
  });
  assert.deepEqual(await handleDownloadMessage(msg, SENDER, deps), {
    ok: true,
    started: 1,
    skipped: 0,
    failed: 0,
  });
});

test("handleDownloadMessage: 古い発行の失敗は新しい予約を消さない", async () => {
  const deps = makeDeps({
    getSettings: async () => ({ skipExisting: false }),
    download: (opts) => {
      deps.calls.push(opts);
      return deps.calls.length === 1
        ? Promise.reject(new Error("start failed"))
        : Promise.resolve(1);
    },
  });
  const same = item();
  const first = await handleDownloadMessage(
    { type: "tte-download-images", items: [same, same] },
    SENDER,
    deps
  );
  assert.deepEqual(first, { ok: true, started: 1, skipped: 0, failed: 1 });
  assert.equal(deps.calls.length, 2);

  const third = await handleDownloadMessage(
    { type: "tte-download-images", items: [same] },
    SENDER,
    makeDeps({
      calls: deps.calls,
      download: (opts) => deps.calls.push(opts),
      getSettings: async () => ({ skipExisting: true }),
      fileExists: async () => false,
    })
  );
  assert.deepEqual(third, { ok: true, started: 0, skipped: 1, failed: 0 });
  assert.equal(deps.calls.length, 2);
});

test("handleDownloadMessage: 設定がオフなら予約があっても全件ダウンロードする", async () => {
  const msg = { type: "tte-download-images", items: [item()] };
  const deps = makeDeps({ getSettings: async () => ({ skipExisting: false }) });

  await handleDownloadMessage(msg, SENDER, deps);
  const second = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(second, { ok: true, started: 1, skipped: 0, failed: 0 });
  assert.equal(deps.calls.length, 2);
});

test("handleDownloadMessage: 設定の読み出しは1メッセージにつき1回だけ", async () => {
  let getCalls = 0;
  const deps = makeDeps({
    getSettings: async () => {
      getCalls++;
      return { skipExisting: true };
    },
  });
  await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [item({ postId: "1" }), item({ postId: "2" }), item({ postId: "3" })],
    },
    SENDER,
    deps
  );
  assert.equal(getCalls, 1);
});
