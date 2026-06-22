# ブロック/ミュート投稿の非表示

## やりたいこと

X の検索設定「ブロックしているアカウントとミュートしているアカウントを除外する」が効かず、ブロックやミュートをした相手の投稿が検索結果に出てしまう。
これを、レスポンスの段階で投稿ごと取り除く。

## 判定

各投稿の投稿者の関係情報を見る。
場所は次のとおりで、`blocking` か `muting` が `true` なら除外する。

```
...tweet_results.result[.tweet].core.user_results.result.relationship_perspectives
    = { blocked_by, blocking, followed_by, following, muting }
```

アカウント検索などのユーザー単体エントリも、同じ `relationship_perspectives` で判定する。

オン/オフは `<html data-tte-enabled>` 属性で切り替える(既定: オン)。
このフィールドはレスポンスに正しく入っているため、ブロック/ミュートした相手は手動登録なしで自動的に消える。

## XHR とタイミング（重要）

X は検索タイムラインを `XMLHttpRequest`(`responseType=""`)で取得し、X 自身のリスナがレスポンスを先に読む。
そのため、`send` 内で後からリスナを足してインスタンスの値を書き換えても、X の読み取りに間に合わない。
件数(`data-tte-removed`)は数えられても、画面には反映されない。

これを避けるため、`XMLHttpRequest.prototype` の `responseText` / `response` のゲッタ自体を差し替え、X が読んだ瞬間にフィルタした値を返す。
詳細は [architecture.md](architecture.md) の「レスポンスの差し替え」を参照。

## 除外の機構

除外そのものは、ワード/@id ミュートと共通の `itemContentIsBad` / `filterPayload` で行う([word-mute.md](word-mute.md) を参照)。
ブロック/ミュート・ワード・@id は独立してオン/オフでき、いずれかに該当した投稿を消す。
除外した件数は、すべて合わせて `data-tte-removed` に積算する。

## 失敗時の方針

判定に必要な `relationship_perspectives` が無い投稿は「対象でない」とみなして残す(誤って消さない)。
解析や書き換えに失敗したときは、必ず元のレスポンスをそのまま返す。
