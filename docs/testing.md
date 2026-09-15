# テスト

ロジックの中核（レスポンスのフィルタ、ダウンロードURL/パスの検証、保存名の組み立て）は、DOM やブラウザ API に依存しない純粋関数に切り出してある。
これらを Node 標準のテストランナー（`node:test`）で検証する。外部依存はない。

## 実行

```
npm test        # = node --test
```

Node 18 以降であれば追加インストール不要で動く（開発時の確認は Node 22 で実施）。

## 仕組み

各コンテンツスクリプトは、ブラウザでは即時実行関数として動き、`window` / `document` /
`chrome` などのブラウザ API を使う。
テストのために、次の 2 点だけ手を入れてある。

1. ブラウザ API を触る副作用（`fetch` フックの設置、`MutationObserver` の起動、
   `chrome.*` の呼び出しなど）は、その API が存在するときだけ実行するようにガードしてある。
   このため Node から `require` してもエラーにならない。
2. 末尾で、Node のとき（`module.exports` があるとき）だけ純粋関数を公開する。
   ブラウザでは `module` が未定義なので、この行は何もしない。content script としての挙動は変わらない。

```js
if (typeof module !== "undefined" && module.exports) {
  module.exports = { /* 純粋関数 */ };
}
```

## カバーしている範囲

| テスト | 対象 | 主な内容 |
| --- | --- | --- |
| `test/interceptor.test.js` | `interceptor.js` | ミュートルールの解析、関係情報/ワード/@id の判定、`filterEntries` / `filterPayload` のエントリ除外と件数、動画 mp4 URL の選別、`cleanShareUrl`(コピーするリンクの追跡パラメータ除去) |
| `test/background.test.js` | `background.js` | ダウンロードURL（https + twimg のみ）の検証、送信元オリジンの検証、件数上限、URL からの元のファイル名と拡張子の取り出し、メタデータの正規化、設定の読み出しと保存パスへの反映、`chrome.downloads.search` の結果からの保存済み判定（ダウンロード中の検出、実在しない完了済みや中断の除外）と例外時のフォールバック、設定 `skipExisting` によるスキップ件数、予約による重複発行の防止（同一メッセージ内・メッセージ間、存在確認の待ち時間に並行するメッセージ間、設定オフ時は予約を見ない）、発行に失敗したときの予約解除と、古い発行の失敗が新しい予約を消さないこと、`started` / `skipped` / `failed` を含む応答 |
| `test/savepath.test.js` | `savepath.js` | `isSafeComponent` の禁止規則、保存先とファイル名形式の検証（`{file_name}` の必須を含む）およびフォールバック、投稿日時の算出、ファイル名の組み立て、`resolveSavePath` の回帰テスト |
| `test/imagesave.test.js` | `imagesave.js` | 画像IDの抽出、format の選別、原寸URLの組み立て、保存結果のボタン文言（`resultLabel`。保存済み件数と失敗件数の反映） |

DOM 操作・実際のネットワーク・`chrome.downloads` の発火など、ブラウザ実機でしか確認できない部分はテスト対象外。
これらは README の「動作確認の状況」に実環境での確認結果を記している。
