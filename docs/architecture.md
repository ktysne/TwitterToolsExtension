# 全体構成

この拡張機能は、X のページ上で動くコンテンツスクリプトと、保存を担う service worker から成る。

## 2 つの実行ワールド

Chrome のコンテンツスクリプトは、既定では「ISOLATED world」で動く。
ISOLATED world はページと DOM を共有するが、JavaScript の変数や `window.fetch` などはページ本体(MAIN world)と分離されている。

この分離のため、ページが出す通信を横取りするには MAIN world で動くスクリプトが要る。
ISOLATED world で `window.fetch` を上書きしても、ページ本体の fetch には効かないからである。

そこで、役割を 2 つのスクリプトに分けている。

- **MAIN world**(`interceptor.js`)：ページと同じ世界で動き、`fetch` と `XMLHttpRequest`、`HTMLMediaElement.prototype.play` をフックする。
- **ISOLATED world**(`bridge.js`、`imagesave.js`、`mutemenu.js`、`domhide.js`)：`chrome.*` API を使い、設定の読み書き、保存依頼、メニューへの項目追加、描画済み投稿の即時非表示を行う。

`manifest.json` の `content_scripts` で、前者に `"world": "MAIN"` を指定して注入している。

## 2 つのワールドの通信

MAIN world は `chrome.storage` を読めない。
ISOLATED world はページの `fetch` をフックできない。
両者は同じ DOM を共有するので、`document.documentElement` の data 属性を通信路に使う。

- `data-tte-enabled`：ブロック/ミュート除外フィルタのオン/オフ。
- `data-tte-autoplay`：動画の自動再生停止のオン/オフ。
- `data-tte-cleanlink`：コピーするリンクの追跡パラメータ除去のオン/オフ。
- `data-tte-removed`：そのフレームで除外した投稿の累計件数。各フレームが個別に積算し、ポップアップはトップフレーム(frameId 0)の値を読む。

設定は `bridge.js` が `chrome.storage` から読み、上記の属性へ書き込む。
`interceptor.js` は通信のたびにこの属性を読んで挙動を決める。

動画の保存URLだけは件数が多いため、属性ではなく `<div id="__tteVideoMap">` の中に JSON で置く。
`interceptor.js` が書き、`imagesave.js` が読む。

ワード/@id ミュートのルール（オン/オフ、ワード、正規表現、@id）も件数が多くなりうるため、`<div id="__tteMuteRules">` に JSON で置く。
`bridge.js` が `chrome.storage` の内容を書き、`interceptor.js` がレスポンスのたびに読む。
`interceptor.js` は JSON 文字列が変わったときだけ正規表現をコンパイルして使い回す。

## 各スクリプトの責務

- `interceptor.js`：GraphQL のタイムライン系レスポンスから、ブロック/ミュート対象とワード/@id ミュートに一致する投稿を取り除く。動画のmp4 URLを集める。動画の自動再生を抑止する。コピー時に、単一の X の URL から追跡パラメータ(`s` / `t` など)を取り除く(`copy` イベントと `navigator.clipboard.writeText` のフック)。
- `bridge.js`：設定を data 属性へ、ミュートのルールを `__tteMuteRules` へ反映する。ポップアップからの件数問い合わせに答える。
- `imagesave.js`：メディア投稿に保存ボタンを設置し、保存対象のURLを集めて `background.js` へ渡す。
- `mutemenu.js`：投稿の ⋯ メニューに「拡張機能でミュート」項目を足し、クリックで著者の @id を `muteHandles` に追加/解除する。
- `domhide.js`：ワード/@id ミュートのルールが変わったとき、すでに描画済みの一致する投稿を DOM 上で即座に隠す(新規読み込み分は `interceptor.js` が処理する)。
- `background.js`：受け取ったURLを `chrome.downloads` で保存する。コンテンツスクリプトは `chrome.downloads` を直接呼べないため、ここが実行役になる。
- `popup.html` と `popup.js`：各機能のトグルと、ワード・@id ミュートの入力欄、現在のタブでのミュート件数を表示する。

## 全フレームへの適用

`content_scripts` は `"all_frames": true` で登録している。
X のページが同一オリジンの iframe の中にタイムラインを表示する場合があり、その iframe の中でも各スクリプトを動かす必要があるためである。

## レスポンスの差し替え

X は GraphQL を `fetch` と `XMLHttpRequest` の両方で呼ぶ。
タイムライン系（検索など）は XHR を使うことが多い。

`fetch` は、フック内で `await` したレスポンスを読み、フィルタ後に `new Response` を返せばよい。

XHR は注意が要る。
X はレスポンスを自前のリスナで読むため、`send` 内で後からリスナを足してインスタンスの値を書き換えても、X の読み取りの方が先に走り間に合わない。
そこで `XMLHttpRequest.prototype` の `responseText` / `response` のゲッタ自体を差し替え、X が読んだ瞬間にフィルタした値を返す。
結果はインスタンスにキャッシュし、二重処理を避ける。
`responseType` が `""` / `"text"` のときは文字列を、`"json"` のときは parse 済みオブジェクトを破壊的にフィルタして返す。

## 失敗時の方針

`interceptor.js` は、解析や書き換えに失敗したとき、必ず元のレスポンスをそのまま返す。
フックが原因で X が壊れることを避けるためである。
判定に必要なフィールドが無い投稿は「対象でない」とみなして残す(誤って消さない)。

## テスト可能性

除外判定（`filterPayload` / `itemContentIsBad` など）は、設定を `ctx = { relOn, rules }`
として引数で受け取る純粋関数にしてある。DOM(`<html data-tte-enabled>` や
`__tteMuteRules`)を読むのはレスポンスごとに 1 度だけで、その結果を `ctx` に詰めて
再帰に渡す。同様に、保存URL/パスの検証(`background.js`)や保存名の組み立て
(`imagesave.js`)も DOM やネットワークに依存しない関数に分けてある。

これらの関数は Node から `require` して `node:test` で検証している。
各スクリプトは、ブラウザ API を触る副作用を「その API があるときだけ」実行するよう
ガードし、末尾で Node のときだけ純粋関数を `module.exports` する。
ブラウザでは `module` が未定義なので公開行は何もせず、content script としての挙動は変わらない。
詳細は [testing.md](testing.md) を参照。
