# コピーするリンクの整形

## やりたいこと

投稿の共有メニューの「リンクをコピー」でコピーされる URL には、共有元を示す追跡用のパラメータが付く。
例: `https://x.com/<user>/status/<id>?s=20`。
これを取り除き、`https://x.com/<user>/status/<id>` の素のリンクをコピーさせる。

## X のコピーのしくみ

実機で調べたところ、X の「リンクをコピー」は次のように動く。

- 隠し要素に URL を入れて選択し、`document.execCommand("copy")` でクリップボードへ書き込む(Async Clipboard API の `navigator.clipboard.writeText` ではない)。
- コピー時点で、コピー対象の URL は `window.getSelection().toString()` に現れる。
- URL には共有元を示す `s`(および場合により `t`)などのパラメータが付く。

## 整形の方法

`interceptor.js` は MAIN world で `copy` イベントを capture フェーズで捕捉する。
X(やページ本体)がクリップボードを読むより先に、コピー対象を判定して差し替えるためである。

1. コピー元の文字列を取り出す。多くは選択文字列(`window.getSelection()`)から取れる。入力欄(`input` / `textarea`)からのコピーにも対応する。
2. その文字列が「単一の X の URL」なら、追跡用の既知パラメータだけを取り除く。
3. 変化があれば `clipboardData.setData("text/plain", ...)` で差し替え、`preventDefault()` で既定のコピーを上書きする。

将来 X が Async Clipboard API に移った場合に備えて、`navigator.clipboard.writeText`(`Clipboard.prototype.writeText`)も同じ整形を通すようフックする。

取り除くパラメータは `s` / `t` / `ref_src` / `ref_url` / `cn` / `refsrc` に限る。
対象を「単一の URL(前後に空白を含まない)」かつ「ホストが x.com / twitter.com(サブドメイン含む)」に絞ることで、本文中の URL・X 以外の URL・検索の `q` などその他のパラメータには手を付けない。
判定や解析に失敗したときは原文のまま返す(fail open)。

判定の中核(`cleanShareUrl`)は DOM に依存しない純粋関数に切り出し、単体テストしている。

オン/オフは `data-tte-cleanlink` 属性で切り替える。
属性が未設定のときは整形する(既定オン)。

## 検証結果

Chrome 上の実環境(`x.com`)で確認した。

- 「リンクをコピー」が `document.execCommand("copy")` を呼び、選択文字列に `?s=20` 付きの URL(58 文字)が入ることを確認した。
- `copy` フックを入れて実際に Ctrl+C→Ctrl+V すると、クリップボードの中身が `?s=20` を除いた素のリンク(53 文字)になった。
- `data-tte-cleanlink="0"`(トグル OFF)にすると差し替えは起きず、原文がそのままコピーされることを確認した。
