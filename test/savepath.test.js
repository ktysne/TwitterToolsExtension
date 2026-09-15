"use strict";

process.env.TZ = "Asia/Tokyo";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SAVE_DIR,
  DEFAULT_FILENAME_FORMAT,
  isSafeComponent,
  validateSaveDir,
  validateFilenameFormat,
  postDateParts,
  buildFileName,
  resolveSavePath,
} = require("../savepath.js");

test("isSafeComponent: 通常名と安全な予約語に近い名前を許可する", () => {
  assert.equal(isSafeComponent("alice_123.jpg"), true);
  assert.equal(isSafeComponent("console"), true);
  assert.equal(isSafeComponent("con_text"), true);
});

test("isSafeComponent: 禁止文字・制御文字・書式文字を拒否する", () => {
  for (const value of ['a"b', "a*b", "a/b", "a:b", "a<b", "a>b", "a?b", "a\\b", "a|b"]) {
    assert.equal(isSafeComponent(value), false, value);
  }
  assert.equal(isSafeComponent("a\u0000b"), false);
  assert.equal(isSafeComponent("a\u202Eb"), false);
});

test("isSafeComponent: 先頭末尾の空白・ドット・チルダとドット名を拒否する", () => {
  for (const value of [" alice", "alice ", ".alice", "alice.", "~alice", "alice~", ".", ".."]) {
    assert.equal(isSafeComponent(value), false, value);
  }
});

test("isSafeComponent: Windows の予約名と危険な拡張子を拒否する", () => {
  for (const value of [
    "con",
    "CON.txt",
    "com1",
    "clock$",
    "desktop.ini",
    "thumbs.db",
    "conin$",
    "CONOUT$",
  ]) {
    assert.equal(isSafeComponent(value), false, value);
  }
  for (const value of ["x.lnk", "x.LOCAL", "x.scf", "x.URL", "x.{abc}"]) {
    assert.equal(isSafeComponent(value), false, value);
  }
  assert.equal(isSafeComponent(123), false);
  assert.equal(isSafeComponent(null), false);
});

test("validateSaveDir: 空欄と非文字列は既定値に戻る", () => {
  for (const raw of ["", "   ", null, 123]) {
    assert.deepEqual(validateSaveDir(raw), { ok: true, dir: DEFAULT_SAVE_DIR });
  }
});

test("validateSaveDir: 区切りを正規化し、空の区切り要素を無視する", () => {
  assert.deepEqual(validateSaveDir("a/b"), { ok: true, dir: "a/b" });
  assert.deepEqual(validateSaveDir("a\\b"), { ok: true, dir: "a/b" });
  assert.deepEqual(validateSaveDir("a//b/"), { ok: true, dir: "a/b" });
  assert.deepEqual(validateSaveDir("a///"), { ok: true, dir: "a" });
});

test("validateSaveDir: 絶対パスとドット要素を拒否する", () => {
  const absoluteMessage =
    "ダウンロードフォルダからの相対パスで指定してください（先頭の / やドライブ名は使えません）。";
  assert.deepEqual(validateSaveDir("/x"), { ok: false, message: absoluteMessage });
  assert.deepEqual(validateSaveDir("C:\\x"), { ok: false, message: absoluteMessage });
  assert.deepEqual(validateSaveDir("a/.."), {
    ok: false,
    message: "「.」「..」はフォルダ名に使えません。",
  });
  assert.deepEqual(validateSaveDir("a/."), {
    ok: false,
    message: "「.」「..」はフォルダ名に使えません。",
  });
});

test("validateSaveDir: 最初に見つかった禁止規則の文言を返す", () => {
  assert.deepEqual(validateSaveDir('folder:b*?'), {
    ok: false,
    message: '使えない文字「:」「*」「?」が含まれています。',
  });
  assert.deepEqual(validateSaveDir("a\u202Eb"), {
    ok: false,
    message: '使えない文字「制御文字」が含まれています。',
  });
  for (const raw of ["a/ folder", "a/folder /b", "a/.folder", "a/folder."]) {
    assert.deepEqual(validateSaveDir(raw), {
      ok: false,
      message: "フォルダ名の先頭と末尾に空白・「.」は使えません。",
    });
  }
  // Windows の短い名前と紛らわしい名前を Chrome が拒否するため、「~」は位置を問わず使えない
  for (const raw of ["my~pics", "a/~folder", "a/folder~"]) {
    assert.deepEqual(validateSaveDir(raw), {
      ok: false,
      message: "フォルダ名に「~」は使えません。",
    });
  }
  assert.deepEqual(validateSaveDir("con"), {
    ok: false,
    message: "「con」は Windows で予約された名前のため使えません。",
  });
  assert.deepEqual(validateSaveDir("x.lnk"), {
    ok: false,
    message: "「x.lnk」は末尾が .lnk や .local などのため使えません。",
  });
  assert.deepEqual(validateSaveDir("archive.url"), {
    ok: false,
    message: "「archive.url」は末尾が .lnk や .local などのため使えません。",
  });
  assert.deepEqual(validateSaveDir("conin$"), {
    ok: false,
    message: "「conin$」は Windows で予約された名前のため使えません。",
  });
  assert.deepEqual(validateSaveDir("x".repeat(101)), {
    ok: false,
    message: "100文字以内で指定してください。",
  });
});

test("ファイル名形式の空欄と空白だけの入力は既定形式として受け入れる", () => {
  for (const raw of ["", "   "]) {
    assert.deepEqual(validateFilenameFormat(raw), {
      ok: true,
      format: DEFAULT_FILENAME_FORMAT,
    });
  }
  assert.deepEqual(validateFilenameFormat(DEFAULT_FILENAME_FORMAT), {
    ok: true,
    format: DEFAULT_FILENAME_FORMAT,
  });
});

test("ファイル名形式は長さ・禁止文字・先頭文字を検証する", () => {
  assert.deepEqual(validateFilenameFormat("{screen_name}/{post_id}"), {
    ok: false,
    message: '使えない文字「/」が含まれています。',
  });
  assert.deepEqual(validateFilenameFormat("a:b"), {
    ok: false,
    message: '使えない文字「:」が含まれています。',
  });
  assert.deepEqual(validateFilenameFormat(".name"), {
    ok: false,
    message: "先頭に「.」「~」は使えません。",
  });
  assert.deepEqual(validateFilenameFormat("~name"), {
    ok: false,
    message: "先頭に「.」「~」は使えません。",
  });
  assert.deepEqual(validateFilenameFormat("x".repeat(101)), {
    ok: false,
    message: "100文字以内で指定してください。",
  });
});

test("ファイル名形式は {file_name} を必須とする", () => {
  assert.deepEqual(validateFilenameFormat("{screen_name}_{yyyyMMdd}"), {
    ok: false,
    message: "{file_name}（元のファイル名）を含めてください。",
  });
  assert.deepEqual(validateFilenameFormat("{post_id}-{Post_id}-{x}"), {
    ok: false,
    message: "{file_name}（元のファイル名）を含めてください。",
  });
  assert.deepEqual(validateFilenameFormat("{post_id}-{Post_id}-{x}-{file_name}"), {
    ok: true,
    format: "{post_id}-{Post_id}-{x}-{file_name}",
  });
});

test("postDateParts: Snowflake の投稿日時をローカル時刻で整形する", () => {
  // 2024-01-02T03:04:05Z に対応する既知の ID。期待値は日時を直接記載して実装と分離する。
  assert.deepEqual(postDateParts("1742018897638326272"), {
    yyyyMMdd: "20240102",
    HHmmss: "120405",
  });
});

test("postDateParts: 数字以外・空・非文字列・21桁は空文字を返す", () => {
  for (const postId of ["abc", "", null, 123, "1".repeat(21)]) {
    assert.deepEqual(postDateParts(postId), { yyyyMMdd: "", HHmmss: "" });
  }
});

test("ファイル名組み立ては全項目を展開して拡張子を末尾に付ける", () => {
  assert.equal(
    buildFileName("{screen_name}_{yyyyMMdd}_{HHmmss}_{post_id}_{file_name}", {
      screenName: "alice",
      postId: "1742018897638326272",
      fileName: "GXyZ",
      ext: "jpg",
    }),
    "alice_20240102_120405_1742018897638326272_GXyZ.jpg"
  );
});

test("ファイル名組み立ては {file_name} の位置を変えても拡張子を末尾に付ける", () => {
  assert.equal(
    buildFileName("{file_name}_{screen_name}", {
      screenName: "alice",
      postId: "123",
      fileName: "GXyZ",
      ext: "jpg",
    }),
    "GXyZ_alice.jpg"
  );
});

test("ファイル名組み立ては展開結果を再展開せず、欠けた投稿情報を空文字にする", () => {
  assert.equal(
    buildFileName("{screen_name}_{post_id}_{yyyyMMdd}_{HHmmss}_{file_name}", {
      screenName: "alice",
      postId: null,
      fileName: "GXyZ",
      ext: "jpg",
    }),
    "alice____GXyZ.jpg"
  );
  assert.equal(
    buildFileName("{screen_name}_{file_name}", {
      screenName: "{post_id}",
      postId: "123",
      fileName: "GXyZ",
      ext: "jpg",
    }),
    "{post_id}_GXyZ.jpg"
  );
});

test("保存パスは既定形式で画像・動画の元の名前を含める", () => {
  assert.equal(
    resolveSavePath(undefined, {
      screenName: "alice",
      postId: "123",
      fileName: "GXyZ",
      ext: "jpg",
    }),
    "TwitterMedia/alice_123_GXyZ.jpg"
  );
  assert.equal(
    resolveSavePath({}, {
      screenName: "alice",
      postId: null,
      fileName: "GXyZ",
      ext: "jpg",
    }),
    "TwitterMedia/alice__GXyZ.jpg"
  );
  assert.equal(
    resolveSavePath({}, {
      screenName: "alice",
      postId: "123",
      fileName: "AbCd",
      ext: "mp4",
    }),
    "TwitterMedia/alice_123_AbCd.mp4"
  );
});

test("保存パスは設定した保存先と日時を含む形式を反映する", () => {
  assert.equal(
    resolveSavePath(
      {
        saveDir: "Archive\\X",
        filenameFormat: "{yyyyMMdd}_{screen_name}_{post_id}_{file_name}",
      },
      {
        screenName: "alice",
        postId: "1742018897638326272",
        fileName: "GXyZ",
        ext: "png",
      }
    ),
    "Archive/X/20240102_alice_1742018897638326272_GXyZ.png"
  );
});

test("保存パスは保存先と形式の不正値を既定値へフォールバックする", () => {
  assert.equal(
    resolveSavePath(
      {
        saveDir: "C:\\x",
        filenameFormat: "{screen_name}/{post_id}/{file_name}",
      },
      { screenName: "alice", postId: "123", fileName: "GXyZ", ext: "jpg" }
    ),
    "TwitterMedia/alice_123_GXyZ.jpg"
  );
});

test("保存パスは予約名になる形式と長すぎる結果を既定形式で組み直す", () => {
  assert.equal(
    resolveSavePath(
      { filenameFormat: "{file_name}" },
      { screenName: "alice", postId: "123", fileName: "con", ext: "mp4" }
    ),
    "TwitterMedia/alice_123_con.mp4"
  );
  assert.equal(
    resolveSavePath(
      { filenameFormat: "{screen_name}{screen_name}_{file_name}" },
      {
        screenName: "a".repeat(80),
        postId: "123",
        fileName: "GXyZ",
        ext: "jpg",
      }
    ),
    `TwitterMedia/${"a".repeat(80)}_123_GXyZ.jpg`
  );
});

test("保存パスは {file_name} を含まない形式を既定形式へフォールバックする", () => {
  assert.equal(
    resolveSavePath(
      { filenameFormat: "{screen_name}_{post_id}" },
      { screenName: "alice", postId: "123", fileName: "GXyZ", ext: "jpg" }
    ),
    "TwitterMedia/alice_123_GXyZ.jpg"
  );
});
