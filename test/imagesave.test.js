"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { sanitize, mediaIdOf, pickFormat, origImageUrl } = require("../imagesave.js");

test("sanitize: ファイル名に使えない文字を _ に置き換え、60文字に切る", () => {
  assert.equal(sanitize("alice"), "alice");
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(sanitize("x".repeat(100)).length, 60);
});

test("mediaIdOf: pbs.twimg.com/media のIDを取り出す", () => {
  assert.equal(
    mediaIdOf({ src: "https://pbs.twimg.com/media/AbC123?format=jpg&name=small" }),
    "AbC123"
  );
  assert.equal(mediaIdOf({ src: "https://pbs.twimg.com/media/XyZ" }), "XyZ");
  assert.equal(mediaIdOf({ src: "https://example.com/notmedia" }), null);
  assert.equal(mediaIdOf({}), null);
  assert.equal(mediaIdOf(null), null);
});

test("pickFormat: 既知の画像形式だけ採用し、なければ jpg", () => {
  assert.equal(pickFormat("https://pbs.twimg.com/media/x?format=png&name=small"), "png");
  assert.equal(pickFormat("https://pbs.twimg.com/media/x?format=JPG"), "jpg"); // 小文字化
  assert.equal(pickFormat("https://pbs.twimg.com/media/x?format=webp"), "webp");
  assert.equal(pickFormat("https://pbs.twimg.com/media/x"), "jpg"); // 未指定
  assert.equal(pickFormat("https://pbs.twimg.com/media/x?format=svg"), "jpg"); // 未知形式
  assert.equal(pickFormat("garbage"), "jpg");
});

test("origImageUrl: name=orig の原寸URLを組み立てる", () => {
  assert.equal(
    origImageUrl("AbC123", "png"),
    "https://pbs.twimg.com/media/AbC123?format=png&name=orig"
  );
});
