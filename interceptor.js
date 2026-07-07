/*
 * interceptor.js  —  runs in the page's MAIN world (document_start)
 *
 * Xの GraphQL タイムライン系レスポンス（SearchTimeline / HomeTimeline /
 * UserTweets / TweetDetail など）を fetch / XHR の段階で横取りし、
 * ブロック/ミュート済みの投稿、およびワードミュート・@id ミュートに
 * 一致する投稿のエントリを丸ごと削除する。
 *
 * 関係情報の場所（実レスポンスで確認済み）:
 *   ...tweet_results.result[.tweet].core.user_results.result.relationship_perspectives
 *       = { blocked_by, blocking, followed_by, following, muting }
 *
 * 設計方針:
 *   - 失敗時は必ず「素通し（fail open）」にして、Xを壊さない。
 *   - instructions を持たないレスポンスには一切手を加えない。
 *   - ブロック/ミュート除外の ON/OFF は <html data-tte-enabled> を見る。
 *   - ワード/@id ミュートのルールは <div id="__tteMuteRules"> から読む。
 *   - 除外した累計件数は <html data-tte-removed="N"> に書き出す。
 */
(() => {
  "use strict";

  const GQL_MARK = "/i/api/graphql/";
  // タイムラインを含むレスポンスだけに触るための軽量プレフィルタ
  const PAYLOAD_HINT = '"instructions"';

  let totalRemoved = 0;

  function isEnabled() {
    // ブロック/ミュート除外フィルタのON/OFF（属性未設定でも既定ON）
    return document.documentElement.getAttribute("data-tte-enabled") !== "0";
  }

  function publishRemoved(n) {
    if (n <= 0) return;
    totalRemoved += n;
    try {
      document.documentElement.setAttribute("data-tte-removed", String(totalRemoved));
    } catch (_) {}
  }

  // --- 動画URLの収集（動画保存機能のため） -------------------------------
  // レスポンス内の各投稿から、各動画の最高画質 mp4 URL を配列で集め、
  // tweetId をキーに <div id="__tteVideoMap"> へ JSON で書き出す。
  // imagesave.js（ISOLATED world）が同じDOMからこれを読み、保存に使う。
  const VIDEO_MAP_MAX = 400;
  const videoMap = new Map();

  function videoMapNode() {
    let n = document.getElementById("__tteVideoMap");
    if (!n) {
      n = document.createElement("div");
      n.id = "__tteVideoMap";
      n.style.display = "none";
      (document.documentElement || document).appendChild(n);
    }
    return n;
  }

  // 保存対象に載せる動画URLは https かつ twimg.com 系のみ許可する。
  // 改竄レスポンスが任意ホストのURLを variants に混入させても拾わない。
  function isSafeMediaUrl(url) {
    try {
      // メディアURLは絶対URLだが、相対URL混入時の基準として location を使う。
      // Node（テスト）では location が無いので固定の基準を当てる。
      const base = typeof location !== "undefined" ? location.href : "https://x.com/";
      const u = new URL(url, base);
      return (
        u.protocol === "https:" &&
        (u.hostname === "twimg.com" || u.hostname.endsWith(".twimg.com"))
      );
    } catch (_) {
      return false;
    }
  }

  function bestMp4Url(variants) {
    const mp4 = (variants || []).filter(
      (v) =>
        v && v.content_type === "video/mp4" && v.url && isSafeMediaUrl(v.url)
    );
    if (!mp4.length) return null;
    mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return mp4[0].url;
  }

  // 1ツイートが直接持つ動画/GIFの最高画質 mp4 URL を配列で返す（重複は除く）。
  function ownVideoUrls(tw) {
    const lg = tw && tw.legacy;
    if (!lg) return [];
    const media =
      (lg.extended_entities && lg.extended_entities.media) ||
      (lg.entities && lg.entities.media);
    if (!Array.isArray(media)) return [];
    const out = [];
    media.forEach((m) => {
      if (
        m &&
        (m.type === "video" || m.type === "animated_gif") &&
        m.video_info
      ) {
        const url = bestMp4Url(m.video_info.variants);
        if (url && out.indexOf(url) === -1) out.push(url);
      }
    });
    return out;
  }

  // 引用ツイート（quoted_status_result.result）を取り出す。可視性ラッパも剥がす。
  function quotedTweetOf(tw) {
    const q =
      tw && tw.quoted_status_result && tw.quoted_status_result.result;
    return unwrapTweet(q);
  }

  // レスポンスから { tweetId: [mp4url,...] } を組み立てる純粋関数（DOM非依存）。
  // 各ツイート自身の動画に加え、引用ツイートの動画も「引用した側」の tweetId に
  // 紐づける。引用された動画プレイヤーは外側 article 内に描画され、imagesave.js は
  // article 先頭の status リンク（＝外側ツイートID）で動画を引くため、外側IDでも
  // 引けるようにしておかないと「取得待ち」のまま保存できない。
  // 引用元IDへの登録（再帰 walk が行う）も残すので、引用元を単独表示しても引ける。
  function collectTweetVideos(root) {
    const out = Object.create(null);
    function add(id, urls) {
      if (!id || !urls.length) return;
      let arr = out[id];
      if (!arr) arr = out[id] = [];
      for (const u of urls) if (arr.indexOf(u) === -1) arr.push(u);
    }
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const tw = unwrapTweet(o);
      const lg = tw && tw.legacy;
      if (lg && (tw.rest_id || lg.id_str)) {
        const id = tw.rest_id || lg.id_str;
        add(id, ownVideoUrls(tw));
        const qtw = quotedTweetOf(tw);
        if (qtw) add(id, ownVideoUrls(qtw));
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === "object") walk(v);
      }
    })(root);
    return out;
  }

  function harvestMedia(root) {
    const found = collectTweetVideos(root);
    let changed = false;
    for (const id in found) {
      // 1投稿に複数の動画/GIFがあるので、tweetId ごとに配列で貯める
      let arr = videoMap.get(id);
      if (!arr) {
        arr = [];
        videoMap.set(id, arr);
        changed = true;
        if (videoMap.size > VIDEO_MAP_MAX) {
          videoMap.delete(videoMap.keys().next().value);
        }
      }
      for (const url of found[id]) {
        if (arr.indexOf(url) === -1) {
          arr.push(url);
          changed = true;
        }
      }
    }
    if (changed) {
      try {
        videoMapNode().textContent = JSON.stringify(Object.fromEntries(videoMap));
      } catch (_) {}
    }
  }

  // --- ツイートの取り出し -----------------------------------------------

  function unwrapTweet(result) {
    if (!result) return null;
    // 限定公開などは TweetWithVisibilityResults でラップされる
    if (result.__typename === "TweetWithVisibilityResults" && result.tweet) {
      return result.tweet;
    }
    return result;
  }

  // 投稿者を「ブロック中」または「ミュート中」なら除外対象
  function isBadPerspectives(rp) {
    return !!(rp && (rp.blocking === true || rp.muting === true));
  }

  // --- ワード/@id ミュート（指定の語・正規表現・@id で投稿を消す） --------
  // ルールは bridge.js（ISOLATED world）が <div id="__tteMuteRules"> に
  // JSON で書き込む：{ enabled, words[], regexes[], handleEnabled, handles[] }。
  // 部分一致・正規表現とも大文字小文字を区別しない。
  let muteCache = {
    raw: "",
    enabled: false,
    words: [],
    regexes: [],
    handleEnabled: false,
    handles: new Set(),
  };

  // JSON 文字列（bridge.js が書く __tteMuteRules の中身）を解析して
  // { raw, enabled, words[], regexes[RegExp], handleEnabled, handles:Set } にする。
  // DOM に依存しない純粋関数なので単体テストできる。
  function parseMuteRules(raw) {
    let enabled = false,
      words = [],
      regexes = [],
      handleEnabled = false,
      handles = new Set();
    try {
      const p = JSON.parse(raw || "{}");
      enabled = !!p.enabled;
      words = (p.words || [])
        .map((w) => String(w).toLowerCase())
        .filter(Boolean);
      regexes = (p.regexes || [])
        .map((s) => {
          try {
            return new RegExp(String(s), "i");
          } catch (_) {
            return null; // 不正な正規表現は無視
          }
        })
        .filter(Boolean);
      handleEnabled = !!p.handleEnabled;
      handles = new Set(
        (p.handles || [])
          .map((h) => String(h).replace(/^@/, "").toLowerCase())
          .filter(Boolean)
      );
    } catch (_) {}
    return { raw: raw || "", enabled, words, regexes, handleEnabled, handles };
  }

  function getMuteRules() {
    const node = document.getElementById("__tteMuteRules");
    const raw = (node && node.textContent) || "";
    if (raw !== muteCache.raw) {
      // JSON 文字列が変わったときだけ解析し直してキャッシュする
      muteCache = parseMuteRules(raw);
    }
    return muteCache;
  }

  // フィルタ（ブロック/ミュート・ワード・@id のいずれか）が有効か
  function filterActive() {
    const r = getMuteRules();
    return isEnabled() || r.enabled || r.handleEnabled;
  }

  // ユーザーオブジェクトから screen_name を取り出す（小文字化）。
  // X は screen_name を user.legacy から user.core に移している途中なので、
  // どちらの場所でも拾えるよう両方を見る。
  function screenNameOf(userResult) {
    if (!userResult) return null;
    const sn =
      (userResult.core && userResult.core.screen_name) ||
      (userResult.legacy && userResult.legacy.screen_name) ||
      null;
    return sn ? String(sn).toLowerCase() : null;
  }

  // ツイートの著者ハンドル（本人＋リツイート元）を小文字で返す
  function authorHandlesOf(tweetResult) {
    const out = [];
    const t = unwrapTweet(tweetResult);
    if (!t) return out;
    const a = t.core && t.core.user_results && t.core.user_results.result;
    const an = screenNameOf(a);
    if (an) out.push(an);
    // リツイートの場合は元投稿の著者も対象にする
    const rt =
      t.legacy &&
      t.legacy.retweeted_status_result &&
      t.legacy.retweeted_status_result.result;
    if (rt) {
      const rtu = unwrapTweet(rt);
      const rta =
        rtu && rtu.core && rtu.core.user_results && rtu.core.user_results.result;
      const rtn = screenNameOf(rta);
      if (rtn) out.push(rtn);
    }
    return out;
  }

  function tweetTextOf(tweetResult) {
    const t = unwrapTweet(tweetResult);
    if (!t) return "";
    let text = (t.legacy && (t.legacy.full_text || t.legacy.text)) || "";
    // 長文ツイート（note tweet）の本文も対象に含める
    const note =
      t.note_tweet &&
      t.note_tweet.note_tweet_results &&
      t.note_tweet.note_tweet_results.result;
    if (note && note.text) text += "\n" + note.text;
    return text;
  }

  function textMatchesMute(text, rules) {
    if (!text) return false;
    const r = rules;
    const lower = text.toLowerCase();
    for (const w of r.words) if (lower.includes(w)) return true;
    for (const re of r.regexes) {
      try {
        if (re.test(text)) return true;
      } catch (_) {}
    }
    return false;
  }

  // itemContent（単一エントリ or モジュール内アイテム）が除外対象か。
  // ctx = { relOn:boolean, rules:parseMuteRules の戻り値 } を受け取り、DOM に
  // 触れない純粋判定にしてある（レスポンス1件につき ctx を1度だけ作る）。
  function itemContentIsBad(ic, ctx) {
    if (!ic) return false;
    const rules = ctx.rules;
    const relOn = ctx.relOn;

    // 投稿
    const tweetResult = ic.tweet_results && ic.tweet_results.result;
    if (tweetResult) {
      if (relOn) {
        const t = unwrapTweet(tweetResult);
        const ur =
          t && t.core && t.core.user_results && t.core.user_results.result;
        if (isBadPerspectives(ur && ur.relationship_perspectives)) return true;
      }
      if (rules.enabled && textMatchesMute(tweetTextOf(tweetResult), rules))
        return true;
      if (rules.handleEnabled && rules.handles.size) {
        for (const h of authorHandlesOf(tweetResult)) {
          if (rules.handles.has(h)) return true;
        }
      }
      return false;
    }

    // ユーザー（アカウント検索・おすすめユーザー等）
    const userResult = ic.user_results && ic.user_results.result;
    if (userResult) {
      if (relOn && isBadPerspectives(userResult.relationship_perspectives)) {
        return true;
      }
      const sn = screenNameOf(userResult);
      if (rules.handleEnabled && sn && rules.handles.has(sn)) return true;
      return false;
    }

    return false;
  }

  // --- エントリ配列のフィルタ -------------------------------------------

  function filterEntries(entries, ctx) {
    let removed = 0;

    const kept = entries.filter((entry) => {
      const content = entry && entry.content;
      if (!content) return true;

      // 1) 単一アイテム（1ツイート / 1ユーザー）
      if (content.itemContent) {
        if (itemContentIsBad(content.itemContent, ctx)) {
          removed++;
          return false;
        }
        return true;
      }

      // 2) モジュール（会話スレッド・おすすめ等の items[]）
      if (Array.isArray(content.items)) {
        const before = content.items.length;
        content.items = content.items.filter((it) => {
          const ic = it && it.item && it.item.itemContent;
          if (itemContentIsBad(ic, ctx)) return false;
          return true;
        });
        removed += before - content.items.length;

        // 中身が全部消えたモジュールは、エントリごと落とす
        if (content.items.length === 0) return false;
      }

      return true;
    });

    return { kept, removed };
  }

  // instructions を持つオブジェクトを再帰的に探して各 entries をフィルタ。
  // ctx を省略した場合は現在の DOM 設定から組み立てる（実行時の呼び出し用）。
  function filterPayload(root, ctx) {
    let removed = 0;
    if (!ctx) ctx = { relOn: isEnabled(), rules: getMuteRules() };

    function walk(node) {
      if (!node || typeof node !== "object") return;

      if (Array.isArray(node.instructions)) {
        for (const ins of node.instructions) {
          if (Array.isArray(ins.entries)) {
            const res = filterEntries(ins.entries, ctx);
            ins.entries = res.kept;
            removed += res.removed;
          }
          // TimelineAddToModule（既存モジュールへの追記）にも対応
          if (Array.isArray(ins.moduleItems)) {
            const before = ins.moduleItems.length;
            ins.moduleItems = ins.moduleItems.filter((it) => {
              const ic = it && it.item && it.item.itemContent;
              return !itemContentIsBad(ic, ctx);
            });
            removed += before - ins.moduleItems.length;
          }
        }
      }

      for (const k in node) {
        const v = node[k];
        if (v && typeof v === "object") walk(v);
      }
    }

    walk(root);
    return removed;
  }

  // --- fetch フック ------------------------------------------------------

  const origFetch = typeof window !== "undefined" ? window.fetch : undefined;
  if (typeof origFetch === "function") {
    window.fetch = async function (input, init) {
      const res = await origFetch.apply(this, arguments);
      try {
        const url =
          typeof input === "string"
            ? input
            : (input && input.url) || (res && res.url) || "";
        if (!url.includes(GQL_MARK)) return res;

        const clone = res.clone();
        const text = await clone.text();
        if (!text || text.indexOf(PAYLOAD_HINT) === -1) return res;

        let data;
        try {
          data = JSON.parse(text);
        } catch (_) {
          return res; // JSON でなければ素通し
        }

        // 動画URLの収集は除外フィルタのON/OFFに関わらず常に行う（動画保存用）
        try {
          harvestMedia(data);
        } catch (_) {}

        // ワード・@id のどれも無効なら書き換えない
        if (!filterActive()) return res;
        const removed = filterPayload(data);
        if (removed <= 0) return res;

        publishRemoved(removed);

        const headers = new Headers(res.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(JSON.stringify(data), {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      } catch (_) {
        return res; // 何が起きても元レスポンスを返す
      }
    };
  }

  // --- XHR フック（X は SearchTimeline 等を XHR で取得する） --------------
  // X はレスポンスを自前のリスナで読むため、send 内で後からリスナを足して
  // ゲッタを差し替えても間に合わない（X の読み取りが先に走る）。そこで
  // responseText / response のゲッタ自体をプロトタイプで差し替え、読まれた
  // 瞬間にフィルタして返す。結果はインスタンスにキャッシュする。
  try {
    const proto = XMLHttpRequest.prototype;
    const origOpen = proto.open;
    proto.open = function (method, url) {
      this.__tteUrl = url;
      return origOpen.apply(this, arguments);
    };

    function tteTargetXhr(xhr) {
      return (
        xhr.readyState === 4 &&
        typeof xhr.__tteUrl === "string" &&
        xhr.__tteUrl.includes(GQL_MARK)
      );
    }

    // テキスト系レスポンスをフィルタした文字列を返す（インスタンスにキャッシュ）
    function tteFilterText(xhr, raw) {
      if (xhr.__tteText !== undefined) return xhr.__tteText;
      let out = raw;
      try {
        if (raw && raw.indexOf(PAYLOAD_HINT) !== -1) {
          const d = JSON.parse(raw);
          try {
            harvestMedia(d);
          } catch (_) {}
          if (filterActive()) {
            const removed = filterPayload(d);
            if (removed > 0) {
              publishRemoved(removed);
              out = JSON.stringify(d);
            }
          }
        }
      } catch (_) {}
      xhr.__tteText = out;
      return out;
    }

    const textDesc = Object.getOwnPropertyDescriptor(proto, "responseText");
    if (textDesc && textDesc.get) {
      Object.defineProperty(proto, "responseText", {
        configurable: true,
        enumerable: textDesc.enumerable,
        get() {
          const rt = this.responseType;
          // テキスト系以外は素のゲッタに委ねる（json は仕様どおり例外になる）
          if (rt !== "" && rt !== "text") return textDesc.get.call(this);
          const raw = textDesc.get.call(this);
          if (!tteTargetXhr(this)) return raw;
          return tteFilterText(this, raw);
        },
      });
    }

    const respDesc = Object.getOwnPropertyDescriptor(proto, "response");
    if (respDesc && respDesc.get) {
      Object.defineProperty(proto, "response", {
        configurable: true,
        enumerable: respDesc.enumerable,
        get() {
          const raw = respDesc.get.call(this);
          if (!tteTargetXhr(this)) return raw;
          const rt = this.responseType;
          if (rt === "" || rt === "text") {
            // response はテキスト系では responseText と同じ文字列
            return tteFilterText(this, typeof raw === "string" ? raw : "");
          }
          if (rt === "json" && raw && typeof raw === "object") {
            // json 型は parse 済みオブジェクト。破壊的にフィルタして返す。
            if (!this.__tteJson) {
              this.__tteJson = true;
              try {
                harvestMedia(raw);
                if (filterActive()) {
                  const removed = filterPayload(raw);
                  if (removed > 0) publishRemoved(removed);
                }
              } catch (_) {}
            }
            return raw;
          }
          return raw;
        },
      });
    }
  } catch (_) {}

  // --- 動画の自動再生ブロッカー -----------------------------------------
  // X はタイムライン動画を JS の play() で再生する（autoplay属性ではない）。
  // ここで play() をフックし、「ユーザー操作に紐づかない再生」だけを弾く。
  // ユーザーがクリックした再生（navigator.userActivation.isActive===true）は
  // そのまま通すので、手動再生は普通に動く。
  // ON/OFF は <html data-tte-autoplay="1|0"> を参照（属性未設定時は無効＝素通し）。
  try {
    const mediaProto = HTMLMediaElement.prototype;
    const origMediaPlay = mediaProto.play;

    function autoplayDisabled() {
      return document.documentElement.getAttribute("data-tte-autoplay") === "1";
    }
    function userInitiated() {
      try {
        return !!(navigator.userActivation && navigator.userActivation.isActive);
      } catch (_) {
        return false;
      }
    }

    mediaProto.play = function () {
      try {
        if (autoplayDisabled() && !userInitiated()) {
          // 自動再生とみなして停止状態を維持。
          // ここで解決済み Promise を返すと、X のプレイヤーは「再生成功」と判断し、
          // 実際にはデータが進まないためバッファリング扱いとなり、
          // ローディングスピナー(progressbar)が回り続けてしまう。
          // そこでブラウザ標準の自動再生ブロックと同じ NotAllowedError で reject する。
          // X はこの拒否を「自動再生不可」として正しく処理し、スピナーを出さずに
          // 再生オーバーレイ表示の停止状態にしてくれる(実機検証済み)。
          try {
            this.pause();
          } catch (_) {}
          return Promise.reject(
            new DOMException(
              "play() blocked: autoplay suppressed by TwitterToolsExtension",
              "NotAllowedError"
            )
          );
        }
      } catch (_) {}
      return origMediaPlay.apply(this, arguments);
    };
  } catch (_) {}

  // --- コピーするリンクの整形（追跡パラメータの除去） ---------------------
  // X の「リンクをコピー」は隠し要素の URL を選択して document.execCommand("copy")
  // でクリップボードへ書き込む（実機で確認）。コピーされる URL は
  //   https://x.com/<user>/status/<id>?s=20
  // のように共有元を示す追跡パラメータ（s / t など）が付く。
  // ここで copy イベントを捕捉し、コピー対象が「単一の X の URL」なら、その追跡
  // パラメータだけを取り除いてから書き込む（clipboardData を上書きする）。
  // 併せて、将来 X が Async Clipboard API に移った場合に備えて
  // navigator.clipboard.writeText もフックし、同じ整形を通す。
  // ON/OFF は <html data-tte-cleanlink="1|0"> を見る（属性未設定でも既定ON）。

  // X が共有リンクに付ける追跡用のクエリパラメータ。
  const SHARE_PARAMS = ["s", "t", "ref_src", "ref_url", "cn", "refsrc"];

  // クリップボードへ入る文字列が「単一の X の URL」のときだけ追跡パラメータを
  // 取り除いて返す。本文・非 X の URL・空白を含む文字列・URL でないものは
  // そのまま返す（fail open）。DOM に依存しない純粋関数なので単体テストできる。
  function cleanShareUrl(text) {
    if (typeof text !== "string") return text;
    const trimmed = text.trim();
    // 単一の URL のときだけ触る。本文中に URL を含むコピーを壊さないため、
    // 空白を含む（＝複数トークン）文字列には手を付けない。
    if (!trimmed || /\s/.test(trimmed)) return text;
    let u;
    try {
      u = new URL(trimmed);
    } catch (_) {
      return text; // URL として解釈できなければそのまま
    }
    const host = u.hostname.toLowerCase();
    const isX =
      host === "x.com" ||
      host.endsWith(".x.com") ||
      host === "twitter.com" ||
      host.endsWith(".twitter.com");
    if (!isX) return text;
    let changed = false;
    for (const p of SHARE_PARAMS) {
      if (u.searchParams.has(p)) {
        u.searchParams.delete(p);
        changed = true;
      }
    }
    if (!changed) return text; // 除去対象が無ければ原文のまま（余計な正規化を避ける）
    // searchParams が空になれば search も空になり、末尾に "?" は残らない。
    return u.toString();
  }

  // ブラウザ実行時だけ動く副作用（copy フックと writeText フック）は、
  // document / Clipboard が無い Node では実行しない。
  if (typeof document !== "undefined") {
    function cleanLinkEnabled() {
      return document.documentElement.getAttribute("data-tte-cleanlink") !== "0";
    }

    // copy イベント時にコピー元の文字列を取り出す。
    // X は隠し要素を選択して execCommand("copy") するため、コピー元は選択文字列に
    // 現れる（実機で確認）。入力欄(input/textarea)からのコピーにも対応する。
    function copySourceText() {
      const ae = document.activeElement;
      if (
        ae &&
        (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT") &&
        typeof ae.value === "string"
      ) {
        const s = ae.selectionStart;
        const e = ae.selectionEnd;
        // 選択があるときだけ選択範囲を返す。未選択（カーソルのみ）や選択位置を
        // 取れない入力欄では、コピー対象は無いとみなして空文字を返す（素通し）。
        // ここで全文を返すと、単一 URL が入った入力欄でカーソルを置いて Ctrl+C
        // しただけで、本来コピーされない全文を拡張が書き込んでしまう。
        if (s != null && e != null && e > s) return ae.value.slice(s, e);
        return "";
      }
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel) return String(sel.toString());
      } catch (_) {}
      return "";
    }

    try {
      // capture フェーズで document 全体の copy を拾い、X の読み取りより先に
      // clipboardData を差し替える。整形不要ならイベントに一切触れない。
      document.addEventListener(
        "copy",
        (e) => {
          try {
            if (!cleanLinkEnabled()) return;
            if (!e.clipboardData) return;
            const src = copySourceText();
            const cleaned = cleanShareUrl(src);
            if (typeof cleaned === "string" && cleaned !== src) {
              e.clipboardData.setData("text/plain", cleaned);
              e.preventDefault();
            }
          } catch (_) {}
        },
        true
      );
    } catch (_) {}

    // Async Clipboard API 経由（navigator.clipboard.writeText）のコピーにも
    // 同じ整形を適用する。writeText は Clipboard.prototype 上にあるので、
    // ページ本体の呼び出しごと差し替える。
    try {
      const ClipboardProto =
        typeof Clipboard !== "undefined" ? Clipboard.prototype : null;
      if (ClipboardProto && typeof ClipboardProto.writeText === "function") {
        const origWriteText = ClipboardProto.writeText;
        ClipboardProto.writeText = function (text) {
          try {
            if (cleanLinkEnabled() && typeof text === "string") {
              return origWriteText.call(this, cleanShareUrl(text));
            }
          } catch (_) {}
          return origWriteText.apply(this, arguments);
        };
      }
    } catch (_) {}
  }

  // Node（単体テスト）でのみ純粋関数を公開する。ブラウザでは module が
  // 未定義なので何もしない（content script の挙動は変わらない）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
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
    };
  }
})();
