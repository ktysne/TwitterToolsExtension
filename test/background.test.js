"use strict";

const test = require("node:test");
const { beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  safeUrl,
  safeFilename,
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
  // 判定は結果側で行うため state / exists では絞らず、見落としを防ぐため件数も絞らない
  assert.deepEqual(Object.keys(q), ["filenameRegex"]);
  assert.equal("state" in q, false);
  assert.equal("exists" in q, false);
  assert.equal("limit" in q, false);

  const re = new RegExp(q.filenameRegex);
  assert.equal(re.test("C:\\Users\\x\\Downloads\\TwitterMedia\\a.jpg"), true);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/a.jpg"), true);
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/aXjpg"), false); // . はメタ文字でない
  assert.equal(re.test("/home/x/Downloads/Other/a.jpg"), false); // 別フォルダ
  assert.equal(re.test("/home/x/Downloads/TwitterMedia/a.jpg.bak"), false); // 末尾一致
});

// ---- hasSameFile -----------------------------------------------------------

test("hasSameFile: ダウンロード中と、完了済みで実在するものをヒットとする", () => {
  assert.equal(hasSameFile([{ state: "in_progress" }]), true); // 完了前でもヒット
  assert.equal(hasSameFile([{ state: "complete", exists: true }]), true);
});

test("hasSameFile: 実在を確認できない完了済み・中断・空・非配列はヒットしない", () => {
  assert.equal(hasSameFile([{ state: "complete", exists: false }]), false);
  assert.equal(hasSameFile([{ state: "complete" }]), false); // exists 不明はヒットしない
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

test("handleDownloadMessage: 予約済みのファイル名は履歴に無くてもスキップする", async () => {
  const msg = {
    type: "tte-download-images",
    items: [{ url: "https://pbs.twimg.com/media/a", filename: "a.jpg" }],
  };
  // 履歴には出ない（＝発行直後で検索に載らない）状況を模す
  const deps = makeDeps({
    getSkipExisting: async () => true,
    fileExists: async () => false,
  });

  const first = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(first, { ok: true, started: 1, skipped: 0 });

  const second = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(second, { ok: true, started: 0, skipped: 1 });
  assert.equal(deps.calls.length, 1); // 2通目は発行しない
});

test("handleDownloadMessage: 同一メッセージ内の同名ファイルは1件だけ発行する", async () => {
  const deps = makeDeps({
    getSkipExisting: async () => true,
    fileExists: async () => false,
  });
  const resp = await handleDownloadMessage(
    {
      type: "tte-download-images",
      items: [
        { url: "https://pbs.twimg.com/media/a", filename: "a.jpg" },
        { url: "https://pbs.twimg.com/media/a2", filename: "a.jpg" },
      ],
    },
    SENDER,
    deps
  );
  assert.deepEqual(resp, { ok: true, started: 1, skipped: 1 });
  assert.equal(deps.calls.length, 1);
});

test("handleDownloadMessage: 並行するメッセージでも同名は1件だけ発行する", async () => {
  // 存在確認の解決を後から行えるようにして、await の待ち時間に別のメッセージが
  // 同じ判定を通る状況を作る
  let resolveExists;
  const gate = new Promise((resolve) => {
    resolveExists = resolve;
  });
  const deps = makeDeps({
    getSkipExisting: async () => true,
    fileExists: () => gate.then(() => false),
  });
  const msg = {
    type: "tte-download-images",
    items: [{ url: "https://pbs.twimg.com/media/a", filename: "a.jpg" }],
  };

  const first = handleDownloadMessage(msg, SENDER, deps);
  const second = handleDownloadMessage(msg, SENDER, deps);
  resolveExists();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(deps.calls.length, 1); // 発行は1件だけ
  assert.equal(a.started + b.started, 1);
  assert.equal(a.skipped + b.skipped, 1);
});

test("handleDownloadMessage: 発行に失敗したら予約を外して再試行できる", async () => {
  const deps = makeDeps({
    getSkipExisting: async () => true,
    fileExists: async () => false,
    download: (opts) => {
      deps.calls.push(opts);
      // 1回目だけ開始に失敗する（MV3 の download() は reject する Promise を返す）
      return deps.calls.length === 1
        ? Promise.reject(new Error("start failed"))
        : Promise.resolve(1);
    },
  });
  const msg = {
    type: "tte-download-images",
    items: [{ url: "https://pbs.twimg.com/media/a", filename: "a.jpg" }],
  };

  const first = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(first, { ok: true, started: 1, skipped: 0 });

  // .catch はマイクロタスクで走るため、予約が外れるまで少し待つ
  for (let i = 0; i < 5; i++) await Promise.resolve();

  const second = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(second, { ok: true, started: 1, skipped: 0 }); // スキップされない
  assert.equal(deps.calls.length, 2);
});

test("handleDownloadMessage: 古い発行の失敗は新しい予約を消さない", async () => {
  // 設定オフのときは同名でも続けて発行するため、同じファイル名の予約が二度起きる。
  // 1件目の開始失敗による解除が2件目の予約まで消してしまうと、設定をオンに
  // 戻した直後（履歴がまだ追いつかない間）に重複が発行されてしまう。
  const deps = makeDeps({
    getSkipExisting: async () => false,
    download: (opts) => {
      deps.calls.push(opts);
      return deps.calls.length === 1
        ? Promise.reject(new Error("start failed"))
        : Promise.resolve(1);
    },
  });
  const item = { url: "https://pbs.twimg.com/media/a", filename: "a.jpg" };
  await handleDownloadMessage(
    { type: "tte-download-images", items: [item, item] },
    SENDER,
    deps
  );
  assert.equal(deps.calls.length, 2); // 設定オフなので2件とも発行される

  // 1件目の reject の .catch が走るのを待つ
  for (let i = 0; i < 5; i++) await Promise.resolve();

  // 設定をオンに戻す。履歴はまだ追いついていない想定
  const third = await handleDownloadMessage(
    { type: "tte-download-images", items: [item] },
    SENDER,
    makeDeps({
      calls: deps.calls,
      download: (opts) => deps.calls.push(opts),
      getSkipExisting: async () => true,
      fileExists: async () => false,
    })
  );
  // 2件目の予約が生きているのでスキップされる
  assert.deepEqual(third, { ok: true, started: 0, skipped: 1 });
  assert.equal(deps.calls.length, 2);
});

test("handleDownloadMessage: 設定がオフなら予約があっても全件ダウンロードする", async () => {
  const msg = {
    type: "tte-download-images",
    items: [{ url: "https://pbs.twimg.com/media/a", filename: "a.jpg" }],
  };
  const deps = makeDeps({ getSkipExisting: async () => false });

  await handleDownloadMessage(msg, SENDER, deps); // 1通目で予約される
  const second = await handleDownloadMessage(msg, SENDER, deps);
  assert.deepEqual(second, { ok: true, started: 1, skipped: 0 });
  assert.equal(deps.calls.length, 2);
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
