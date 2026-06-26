# 画像と動画の保存

## やりたいこと

画像を含む投稿の画像を、ボタン一発で原寸保存する(1 枚でも複数枚でも対象)。
動画を含む投稿は、その動画も保存対象にする。

## 画像のURL

投稿内の画像は次の形で並ぶ(実DOMで確認)。

```
article 内の  a[href*="/photo/"] > ... > img[src*="pbs.twimg.com/media/<ID>"]
```

表示中の `src` は縮小版で、`name` パラメータが `small` や `360x360` になっている。
これを `name=orig` に変えると原寸が得られる。

```
https://pbs.twimg.com/media/<ID>?format=<fmt>&name=orig
```

`format` は表示中のURLの値(`jpg` や `png` など既知の形式)をそのまま使う。
1 投稿の画像は X の仕様上おおむね最大 4 枚で、コードは枚数を固定せず `a[href*="/photo/"]` を全て列挙する。

## 動画のURL

動画は DOM の `<video>` が blob(MSE)になっていることが多く、URLを取り出せない。
そこで、`interceptor.js` がレスポンスから動画URLを集めておく。

各投稿のメディアは次の場所に入る。

```
tweet.legacy.extended_entities.media[]
  type: "video" | "animated_gif"
  video_info.variants[]  = { content_type, bitrate, url }
  media_url_https        = サムネイル画像（本拡張では未使用）
```

`content_type` が `video/mp4` のものから、`bitrate` が最大のものを選ぶ。
1 投稿に複数の動画/GIF があるため、`tweetId → mp4URL の配列` の形で `<div id="__tteVideoMap">` に JSON で書き出す。

動画URLの収集は、ブロック/ミュート除外フィルタのオン/オフに関係なく常に行う。
フィルタを切っていても動画を保存できるようにするためである。

### 引用ツイートの動画

引用ツイート(`quoted_status_result.result`)の動画は、引用元ツイートの ID で登録される。
一方、引用された動画プレイヤーは外側(引用した側)の `article` 内に描画され、保存ボタンは
`article` 先頭の `a[href*="/status/"]`(＝外側ツイートの ID)で動画を引く。
このままだと ID が一致せず「取得待ち」のまま保存できないため、引用ツイートの動画は
**外側ツイートの ID にも紐づけて**おく(引用元 ID への登録も残すので、引用元を単独表示しても引ける)。
この収集ロジックは `interceptor.js` の `collectTweetVideos()` にまとまっている(DOM 非依存・単体テスト済み)。

## ボタンの設置と保存

`imagesave.js` が、投稿(`article`)を監視してボタンを重ねる。

ボタンの文言は、その投稿で保存される件数を表す（先頭に `⬇` が付く）。

- 動画/GIF を含む投稿：動画が複数なら「⬇ 動画N本を保存」、1 本なら「⬇ 動画を保存」。`__tteVideoMap` からその投稿の全 mp4 URL を引く。
- 画像のみの投稿：1 枚なら「⬇ 画像を保存」、複数枚なら「⬇ 全N枚保存」。各画像を `name=orig` にして集める。
- 画像と動画が混在する投稿：「⬇ メディアN件を保存」。動画と画像を合わせて一括で保存する。

動画URLはレスポンス受信後に確定するため、件数が分かるまでは総称ラベル（「⬇ 動画を保存」「⬇ メディアを保存」）を出し、確定後にラベルを更新する。
複数の動画は `<アカウント>_<tweetId>_<番号>.mp4` の連番で保存する。

ボタンを押すと、集めたURLとファイル名を `background.js` へ渡す。
`background.js` が `chrome.downloads.download` で順に保存する。
コンテンツスクリプトは `chrome.downloads` を直接呼べないため、service worker が実行役になる。

保存名は次の形にしている。

- 画像：`TwitterMedia/<アカウント>_<tweetId>_<番号>.<拡張子>`
- 動画：`TwitterMedia/<アカウント>_<tweetId>.mp4`

アカウントと tweetId は、投稿内の `a[href*="/status/"]` のパスから取り出す。

## 既知の制約

動画URLは、その投稿を含むレスポンスを `interceptor.js` が見た後に引ける。
投稿は普通そのレスポンスから描画されるため、ボタンを押す時点では引けていることが多い。
URLが未取得のままボタンを押すと、一時的に「取得待ち」と表示して何もしない。
少しスクロールして対象の投稿を読み込み直すと引けるようになる。

動画URLのマップは直近およそ 400 件を保持し、超過分は古いものから破棄する。
長時間スクロールした後は、古い投稿の動画URLが落ちて「取得待ち」に戻ることがある。
