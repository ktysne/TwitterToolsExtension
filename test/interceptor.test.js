"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseMuteRules,
  textMatchesMute,
  isBadPerspectives,
  screenNameOf,
  authorHandlesOf,
  tweetTextOf,
  unwrapTweet,
  bestMp4Url,
  ownVideoUrls,
  quotedTweetOf,
  collectTweetVideos,
  itemContentIsBad,
  filterEntries,
  filterPayload,
  cleanShareUrl,
} = require("../interceptor.js");

// ---- フィクスチャ ----------------------------------------------------------

function userResult({ screenName, blocking = false, muting = false } = {}) {
  return {
    core: screenName ? { screen_name: screenName } : undefined,
    relationship_perspectives: { blocking, muting },
  };
}

function tweetResult({
  id = "1",
  text = "",
  screenName = "alice",
  blocking = false,
  muting = false,
  note = null,
  retweetOf = null,
} = {}) {
  const t = {
    rest_id: id,
    core: { user_results: { result: userResult({ screenName, blocking, muting }) } },
    legacy: { full_text: text },
  };
  if (note) {
    t.note_tweet = { note_tweet_results: { result: { text: note } } };
  }
  if (retweetOf) {
    t.legacy.retweeted_status_result = { result: retweetOf };
  }
  return t;
}

function tweetEntry(tr) {
  return {
    entryId: "tweet-" + (tr.rest_id || "x"),
    content: { itemContent: { tweet_results: { result: tr } } },
  };
}

function moduleEntry(items) {
  return {
    entryId: "module",
    content: {
      items: items.map((tr) => ({
        item: { itemContent: { tweet_results: { result: tr } } },
      })),
    },
  };
}

const RULES_OFF = parseMuteRules("{}");

function ctx({ relOn = false, rules = RULES_OFF } = {}) {
  return { relOn, rules };
}

// ---- parseMuteRules --------------------------------------------------------

test("parseMuteRules: 空・不正な入力は無効ルールになる", () => {
  for (const raw of ["", "{}", "not json", null, undefined]) {
    const r = parseMuteRules(raw);
    assert.equal(r.enabled, false);
    assert.deepEqual(r.words, []);
    assert.deepEqual(r.regexes, []);
    assert.equal(r.handleEnabled, false);
    assert.equal(r.handles.size, 0);
  }
});

test("parseMuteRules: ワードは小文字化し、空要素は除く", () => {
  const r = parseMuteRules(
    JSON.stringify({ enabled: true, words: ["Foo", "BAR", "", "  "] })
  );
  assert.equal(r.enabled, true);
  assert.deepEqual(r.words, ["foo", "bar", "  "]);
});

test("parseMuteRules: 不正な正規表現は捨て、有効なものだけ残す", () => {
  const r = parseMuteRules(
    JSON.stringify({ regexes: ["va(lid", "[a-z]+", "good"] })
  );
  assert.equal(r.regexes.length, 2);
  assert.ok(r.regexes[0].test("ABC")); // "i" フラグ付き
});

test("parseMuteRules: @id は先頭の @ を外して小文字化、Set にする", () => {
  const r = parseMuteRules(
    JSON.stringify({ handleEnabled: true, handles: ["@Alice", "BOB", "@@x", ""] })
  );
  assert.equal(r.handleEnabled, true);
  assert.ok(r.handles.has("alice"));
  assert.ok(r.handles.has("bob"));
  assert.ok(r.handles.has("@x")); // 先頭の1つだけ外す
  assert.ok(!r.handles.has(""));
});

// ---- 小さな純粋関数 --------------------------------------------------------

test("isBadPerspectives: blocking か muting が true のときだけ true", () => {
  assert.equal(isBadPerspectives({ blocking: true }), true);
  assert.equal(isBadPerspectives({ muting: true }), true);
  assert.equal(isBadPerspectives({ blocking: false, muting: false }), false);
  assert.equal(isBadPerspectives(null), false);
  assert.equal(isBadPerspectives(undefined), false);
});

test("screenNameOf: core 優先、なければ legacy、無ければ null（小文字化）", () => {
  assert.equal(screenNameOf({ core: { screen_name: "Alice" } }), "alice");
  assert.equal(screenNameOf({ legacy: { screen_name: "Bob" } }), "bob");
  assert.equal(
    screenNameOf({ core: { screen_name: "C" }, legacy: { screen_name: "D" } }),
    "c"
  );
  assert.equal(screenNameOf({}), null);
  assert.equal(screenNameOf(null), null);
});

test("unwrapTweet: TweetWithVisibilityResults を剥がす", () => {
  const inner = { rest_id: "9" };
  assert.equal(
    unwrapTweet({ __typename: "TweetWithVisibilityResults", tweet: inner }),
    inner
  );
  assert.equal(unwrapTweet(inner), inner);
  assert.equal(unwrapTweet(null), null);
});

test("authorHandlesOf: 本人とリツイート元の著者を小文字で返す", () => {
  const rt = tweetResult({ id: "2", screenName: "Origin" });
  const tr = tweetResult({ id: "1", screenName: "Reposter", retweetOf: rt });
  assert.deepEqual(authorHandlesOf(tr), ["reposter", "origin"]);
});

test("tweetTextOf: full_text と note_tweet を連結、無ければ text", () => {
  assert.equal(tweetTextOf(tweetResult({ text: "hello" })), "hello");
  assert.equal(
    tweetTextOf(tweetResult({ text: "head", note: "long body" })),
    "head\nlong body"
  );
  const legacyTextOnly = { legacy: { text: "fallback" } };
  assert.equal(tweetTextOf(legacyTextOnly), "fallback");
});

test("textMatchesMute: 部分一致（大小無視）と正規表現", () => {
  const rules = parseMuteRules(
    JSON.stringify({ words: ["spam"], regexes: ["\\d{4}"] })
  );
  assert.equal(textMatchesMute("this is SPAM!", rules), true);
  assert.equal(textMatchesMute("year 2026", rules), true);
  assert.equal(textMatchesMute("clean text", rules), false);
  assert.equal(textMatchesMute("", rules), false);
});

test("bestMp4Url: twimg の mp4 から最大ビットレートを選ぶ", () => {
  const variants = [
    { content_type: "video/mp4", bitrate: 320, url: "https://video.twimg.com/lo.mp4" },
    { content_type: "video/mp4", bitrate: 2176, url: "https://video.twimg.com/hi.mp4" },
    { content_type: "application/x-mpegURL", url: "https://video.twimg.com/x.m3u8" },
  ];
  assert.equal(bestMp4Url(variants), "https://video.twimg.com/hi.mp4");
});

test("bestMp4Url: twimg 以外のホストや非mp4は拾わない", () => {
  assert.equal(
    bestMp4Url([{ content_type: "video/mp4", bitrate: 9, url: "https://evil.example/x.mp4" }]),
    null
  );
  assert.equal(bestMp4Url([]), null);
  assert.equal(bestMp4Url(null), null);
});

// ---- 動画URLの収集（動画保存機能）-----------------------------------------

// 指定のmp4 URLを1本だけ持つ動画ツイートを作る
function videoTweet({ id, url, type = "video" } = {}) {
  return {
    rest_id: id,
    legacy: {
      id_str: id,
      extended_entities: {
        media: [{ type, video_info: { variants: [{ content_type: "video/mp4", bitrate: 832, url }] } }],
      },
    },
  };
}

test("ownVideoUrls: 自身の動画mp4だけを配列で返す（重複除去）", () => {
  const tw = videoTweet({ id: "1", url: "https://video.twimg.com/a.mp4" });
  // 同じURLの2本目を足しても重複は1つにまとまる
  tw.legacy.extended_entities.media.push({
    type: "video",
    video_info: { variants: [{ content_type: "video/mp4", bitrate: 500, url: "https://video.twimg.com/a.mp4" }] },
  });
  assert.deepEqual(ownVideoUrls(tw), ["https://video.twimg.com/a.mp4"]);
  // 動画を持たないツイートは空配列
  assert.deepEqual(ownVideoUrls(tweetResult({ id: "9", text: "no media" })), []);
  assert.deepEqual(ownVideoUrls(null), []);
});

test("quotedTweetOf: quoted_status_result を取り出し、可視性ラッパも剥がす", () => {
  const inner = videoTweet({ id: "q", url: "https://video.twimg.com/q.mp4" });
  const wrapped = { quoted_status_result: { result: { __typename: "TweetWithVisibilityResults", tweet: inner } } };
  assert.equal(quotedTweetOf(wrapped), inner);
  assert.equal(quotedTweetOf({ rest_id: "1" }), null);
});

test("collectTweetVideos: 通常の動画ツイートは自身のIDで引ける", () => {
  const root = { data: { tweet_results: { result: videoTweet({ id: "111", url: "https://video.twimg.com/v.mp4" }) } } };
  const map = collectTweetVideos(root);
  assert.deepEqual(Object.keys(map), ["111"]);
  assert.deepEqual(map["111"], ["https://video.twimg.com/v.mp4"]);
});

test("collectTweetVideos: 引用ツイートの動画は外側IDと引用元IDの両方で引ける", () => {
  // 外側ツイート(200)は動画を持たず、引用元(300)が動画を持つ（報告された不具合の構造）
  const outer = {
    rest_id: "200",
    legacy: { id_str: "200", full_text: "見て" },
    quoted_status_result: { result: videoTweet({ id: "300", url: "https://video.twimg.com/quoted.mp4" }) },
  };
  const root = { data: { tweet_results: { result: outer } } };
  const map = collectTweetVideos(root);
  // 外側ID(200)で引ける = imagesave.js が article 先頭の status リンクで引ける
  assert.deepEqual(map["200"], ["https://video.twimg.com/quoted.mp4"]);
  // 引用元ID(300)でも従来通り引ける（引用元を単独表示したとき用）
  assert.deepEqual(map["300"], ["https://video.twimg.com/quoted.mp4"]);
});

test("collectTweetVideos: 外側にも引用元にも動画があれば外側IDに両方まとまる", () => {
  const outer = videoTweet({ id: "200", url: "https://video.twimg.com/outer.mp4" });
  outer.quoted_status_result = { result: videoTweet({ id: "300", url: "https://video.twimg.com/quoted.mp4" }) };
  const map = collectTweetVideos({ tweet_results: { result: outer } });
  assert.deepEqual(map["200"], [
    "https://video.twimg.com/outer.mp4",
    "https://video.twimg.com/quoted.mp4",
  ]);
  assert.deepEqual(map["300"], ["https://video.twimg.com/quoted.mp4"]);
});

// ---- itemContentIsBad ------------------------------------------------------

test("itemContentIsBad: relOn のときブロック/ミュート投稿を除外", () => {
  const ic = { tweet_results: { result: tweetResult({ blocking: true }) } };
  assert.equal(itemContentIsBad(ic, ctx({ relOn: true })), true);
  // relOn が false なら関係情報では消さない
  assert.equal(itemContentIsBad(ic, ctx({ relOn: false })), false);
});

test("itemContentIsBad: ワードミュート（有効時のみ）", () => {
  const ic = { tweet_results: { result: tweetResult({ text: "buy crypto now" }) } };
  const rules = parseMuteRules(JSON.stringify({ enabled: true, words: ["crypto"] }));
  assert.equal(itemContentIsBad(ic, ctx({ rules })), true);
  // wordMute 無効なら消さない
  const off = parseMuteRules(JSON.stringify({ enabled: false, words: ["crypto"] }));
  assert.equal(itemContentIsBad(ic, ctx({ rules: off })), false);
});

test("itemContentIsBad: @id ミュート（本人とリツイート元）", () => {
  const rt = tweetResult({ id: "2", screenName: "badguy" });
  const ic = {
    tweet_results: { result: tweetResult({ id: "1", screenName: "ok", retweetOf: rt }) },
  };
  const rules = parseMuteRules(
    JSON.stringify({ handleEnabled: true, handles: ["@BadGuy"] })
  );
  assert.equal(itemContentIsBad(ic, ctx({ rules })), true);
});

test("itemContentIsBad: ユーザー単体エントリ（関係情報と @id）", () => {
  const ic = { user_results: { result: userResult({ screenName: "alice", blocking: true }) } };
  assert.equal(itemContentIsBad(ic, ctx({ relOn: true })), true);

  const ic2 = { user_results: { result: userResult({ screenName: "spammer" }) } };
  const rules = parseMuteRules(JSON.stringify({ handleEnabled: true, handles: ["spammer"] }));
  assert.equal(itemContentIsBad(ic2, ctx({ rules })), true);
});

test("itemContentIsBad: 判定材料が無ければ残す（誤って消さない）", () => {
  assert.equal(itemContentIsBad(null, ctx({ relOn: true })), false);
  assert.equal(itemContentIsBad({}, ctx({ relOn: true })), false);
  const clean = { tweet_results: { result: tweetResult({ text: "hi" }) } };
  assert.equal(itemContentIsBad(clean, ctx({ relOn: true })), false);
});

// ---- filterEntries / filterPayload ----------------------------------------

test("filterEntries: 単一エントリの除外と件数", () => {
  const entries = [
    tweetEntry(tweetResult({ id: "1", text: "keep me" })),
    tweetEntry(tweetResult({ id: "2", blocking: true })),
    tweetEntry(tweetResult({ id: "3", text: "keep me too" })),
  ];
  const res = filterEntries(entries, ctx({ relOn: true }));
  assert.equal(res.removed, 1);
  assert.equal(res.kept.length, 2);
  assert.deepEqual(res.kept.map((e) => e.entryId), ["tweet-1", "tweet-3"]);
});

test("filterEntries: モジュール内のアイテムを間引き、空になったら落とす", () => {
  const mod = moduleEntry([
    tweetResult({ id: "1", muting: true }),
    tweetResult({ id: "2", blocking: true }),
  ]);
  const res = filterEntries([mod], ctx({ relOn: true }));
  assert.equal(res.removed, 2);
  assert.equal(res.kept.length, 0); // 全部消えたモジュールはエントリごと落ちる

  const mod2 = moduleEntry([
    tweetResult({ id: "1", muting: true }),
    tweetResult({ id: "2", text: "survivor" }),
  ]);
  const res2 = filterEntries([mod2], ctx({ relOn: true }));
  assert.equal(res2.removed, 1);
  assert.equal(res2.kept.length, 1);
  assert.equal(res2.kept[0].content.items.length, 1);
});

test("filterPayload: instructions を辿って除外し、件数を返す", () => {
  const payload = {
    data: {
      search: {
        timeline: {
          instructions: [
            {
              type: "TimelineAddEntries",
              entries: [
                tweetEntry(tweetResult({ id: "1", text: "ok" })),
                tweetEntry(tweetResult({ id: "2", blocking: true })),
              ],
            },
          ],
        },
      },
    },
  };
  const removed = filterPayload(payload, ctx({ relOn: true }));
  assert.equal(removed, 1);
  const kept = payload.data.search.timeline.instructions[0].entries;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].entryId, "tweet-1");
});

test("filterPayload: TimelineAddToModule の moduleItems も対象", () => {
  const payload = {
    instructions: [
      {
        type: "TimelineAddToModule",
        moduleItems: [
          { item: { itemContent: { tweet_results: { result: tweetResult({ id: "1", muting: true }) } } } },
          { item: { itemContent: { tweet_results: { result: tweetResult({ id: "2", text: "ok" }) } } } },
        ],
      },
    ],
  };
  const removed = filterPayload(payload, ctx({ relOn: true }));
  assert.equal(removed, 1);
  assert.equal(payload.instructions[0].moduleItems.length, 1);
});

test("filterPayload: 何も有効でないコンテキストなら除外しない", () => {
  const payload = {
    instructions: [
      { entries: [tweetEntry(tweetResult({ id: "1", blocking: true, text: "crypto" }))] },
    ],
  };
  const removed = filterPayload(payload, ctx({ relOn: false, rules: RULES_OFF }));
  assert.equal(removed, 0);
  assert.equal(payload.instructions[0].entries.length, 1);
});

// ---- cleanShareUrl（コピーするリンクの追跡パラメータ除去） -----------------

test("cleanShareUrl: X の共有 URL から s / t などの追跡パラメータを取り除く", () => {
  assert.equal(
    cleanShareUrl("https://x.com/KAGAYA_11949/status/2074491512004763714?s=20"),
    "https://x.com/KAGAYA_11949/status/2074491512004763714"
  );
  // t（トークン）と s の併用
  assert.equal(
    cleanShareUrl("https://x.com/u/status/123?t=abcDEF&s=20"),
    "https://x.com/u/status/123"
  );
  // ref_src / ref_url（埋め込み由来の追跡）も対象
  assert.equal(
    cleanShareUrl("https://twitter.com/u/status/123?ref_src=twsrc%5Etfw"),
    "https://twitter.com/u/status/123"
  );
  // twitter.com / サブドメインも対象
  assert.equal(
    cleanShareUrl("https://mobile.twitter.com/u/status/9?s=09"),
    "https://mobile.twitter.com/u/status/9"
  );
});

test("cleanShareUrl: 追跡パラメータ以外は保持する", () => {
  assert.equal(
    cleanShareUrl("https://x.com/u/status/123?s=20&lang=ja"),
    "https://x.com/u/status/123?lang=ja"
  );
  // 検索 URL の q / f は追跡パラメータではないので残す
  assert.equal(
    cleanShareUrl("https://x.com/search?q=cat&s=20&f=live"),
    "https://x.com/search?q=cat&f=live"
  );
  // パスやフラグメントは保持する
  assert.equal(
    cleanShareUrl("https://x.com/u/status/123/photo/1?s=20"),
    "https://x.com/u/status/123/photo/1"
  );
});

test("cleanShareUrl: 対象外の入力は原文のまま返す（fail open）", () => {
  const base = "https://x.com/u/status/123";
  // 除去対象が無ければ原文そのまま（末尾に ? を足さない・正規化しない）
  assert.equal(cleanShareUrl(base), base);
  // 空白を含む（＝本文中の URL）は触らない
  assert.equal(cleanShareUrl("見て " + base + "?s=20 これ"), "見て " + base + "?s=20 これ");
  // X 以外のホストは触らない
  assert.equal(cleanShareUrl("https://example.com/x?s=20"), "https://example.com/x?s=20");
  // 紛らわしいホスト（notx.com）は対象にしない
  assert.equal(cleanShareUrl("https://notx.com/u/status/1?s=20"), "https://notx.com/u/status/1?s=20");
  // URL でない文字列・空・非文字列
  assert.equal(cleanShareUrl("ただのテキスト"), "ただのテキスト");
  assert.equal(cleanShareUrl(""), "");
  assert.equal(cleanShareUrl(null), null);
  assert.equal(cleanShareUrl(undefined), undefined);
});
