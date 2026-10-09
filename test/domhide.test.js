"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeHandle, compileMuteRules, textMatchesMute, tweetTextContent, handleMatchesMute, handleFromHref, postIdFromHref } = require("../domhide.js");

test("ワードは小文字化し、空要素を除いて部分一致する", () => {
  const rules = compileMuteRules({ wordMute: true, muteWords: ["Spam", "", "  "] });
  assert.deepEqual(rules.words, ["spam", "  "]);
  assert.equal(textMatchesMute("some SPAMMER", rules), true);
  assert.equal(textMatchesMute("clean", rules), false);
  assert.equal(textMatchesMute("", rules), false);
});

test("正規表現は大小を無視し、不正な行だけを無視する", () => {
  const rules = compileMuteRules({ wordMute: true, muteRegexes: ["[", "^spam\\d+$", "\\d{4}"] });
  assert.equal(rules.regexes.length, 2);
  assert.equal(rules.regexes[0].flags, "i");
  assert.equal(textMatchesMute("SPAM42", rules), true);
  assert.equal(textMatchesMute("year 2026", rules), true);
  assert.equal(textMatchesMute("clean", rules), false);
});

test("本文のテキストノードと画像の alt を連結する", () => {
  const text = (nodeValue) => ({ nodeType: 3, nodeValue });
  const image = { nodeType: 1, tagName: "IMG", getAttribute: (name) => name === "alt" ? "😀" : null };
  const span = { nodeType: 1, tagName: "SPAN", childNodes: [text("world")] };
  assert.equal(tweetTextContent({ childNodes: [text("hello "), image, text(" "), span] }), "hello 😀 world");
});

test("@id は先頭の @ を一つだけ外し、小文字で完全一致する", () => {
  const rules = compileMuteRules({ handleMute: true, muteHandles: ["@Alice", "ALICE", "BOB", "@@x", ""] });
  assert.equal(normalizeHandle("@@X"), "@x");
  assert.deepEqual([...rules.handles], ["alice", "bob", "@x"]);
  assert.equal(handleMatchesMute("Alice", rules), true);
  assert.equal(handleMatchesMute("@BOB", rules), true);
  assert.equal(handleMatchesMute("alice2", rules), false);
  assert.equal(handleMatchesMute(null, rules), false);
});

test("オフの機能は保存済みのワード・正規表現・@id に一致しない", () => {
  const rules = compileMuteRules({ wordMute: false, handleMute: false, muteWords: ["spam"], muteRegexes: [".*"], muteHandles: ["alice"] });
  assert.equal(textMatchesMute("spam", rules), false);
  assert.equal(handleMatchesMute("alice", rules), false);
  assert.equal(textMatchesMute("spam", compileMuteRules()), false);
});

test("ワードと @id のオン・オフは独立する", () => {
  const cfg = { muteWords: ["spam"], muteHandles: ["alice"] };
  const word = compileMuteRules({ ...cfg, wordMute: true });
  const handle = compileMuteRules({ ...cfg, handleMute: true });
  assert.equal(textMatchesMute("spam", word), true);
  assert.equal(handleMatchesMute("alice", word), false);
  assert.equal(textMatchesMute("spam", handle), false);
  assert.equal(handleMatchesMute("alice", handle), true);
});

test("href から投稿者またはプロフィールの handle を抽出する", () => {
  for (const href of ["/Alice_1/status/123", "https://x.com/Alice_1/status/123?s=20", "https://twitter.com/Alice_1/status/123/photo/1"]) {
    assert.equal(handleFromHref(href), "alice_1");
    assert.equal(postIdFromHref(href), "123");
    assert.equal(handleFromHref(href, true), null);
  }
  for (const href of ["/Alice_1", "/Alice_1/?ref=home", "https://x.com/Alice_1"]) {
    assert.equal(handleFromHref(href, true), "alice_1");
    assert.equal(handleFromHref(href), null);
  }
});

test("href の外部 URL・予約パス・不正な handle・非プロフィールを除外する", () => {
  for (const href of [null, "", "/home", "/i", "/search?q=alice", "/Alice/followers", "/invalid-name", "/abcdefghijklmnop", "https://evil.example/Alice", "//evil.example/Alice", "javascript:alert(1)"]) {
    assert.equal(handleFromHref(href, true), null);
  }
  assert.equal(handleFromHref("/Alice/status/not-a-number"), null);
  assert.equal(postIdFromHref("/Alice/status/not-a-number"), null);
});

test("配列でない保存値でもルールの読み込みを継続する", () => {
  const rules = compileMuteRules({ wordMute: true, handleMute: true, muteWords: {}, muteRegexes: null, muteHandles: "alice" });
  assert.deepEqual(rules.words, []);
  assert.deepEqual(rules.regexes, []);
  assert.equal(rules.handles.size, 0);
});

function browserFixture(cfg) {
  const vm = require("node:vm");
  const fs = require("node:fs");
  const path = require("node:path");
  class TextNode {
    constructor(text) { this.nodeType = 3; this.nodeValue = String(text); }
    get textContent() { return this.nodeValue; }
    set textContent(value) { this.nodeValue = String(value); }
  }
  class Element {
    constructor(tag, attrs = {}, text = "") {
      this.tag = tag.toLowerCase();
      this.tagName = this.tag.toUpperCase();
      this.attrs = { ...attrs };
      this.children = [];
      this.childNodes = [];
      this.nodeType = 1;
      const classes = new Set();
      this.classList = { add: (s) => classes.add(s), remove: (s) => classes.delete(s), contains: (s) => classes.has(s) };
      this.textContent = text;
    }
    appendChild(child) {
      child.parentElement = this;
      this.childNodes.push(child);
      if (child.nodeType === 1) this.children.push(child);
      return child;
    }
    removeChild(child) {
      this.childNodes = this.childNodes.filter((node) => node !== child);
      this.children = this.children.filter((node) => node !== child);
      child.parentElement = null;
      return child;
    }
    get isConnected() { return this.tag === "html" || !!this.parentElement?.isConnected; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    setAttribute(name, value) { this.attrs[name] = value; }
    get textContent() { return this.childNodes.map((node) => node.textContent || "").join(""); }
    set textContent(value) {
      for (const child of this.childNodes) child.parentElement = null;
      this.children = [];
      this.childNodes = [];
      if (String(value)) this.appendChild(new TextNode(value));
    }
    matches(selector) {
      return selector.split(",").map((part) => part.trim()).some((part) => {
        if (part === "svg path[d]") return this.tag === "path" && this.attrs.d != null && !!this.parentElement?.closest("svg");
        if (part === "a[href]") return this.tag === "a" && this.attrs.href != null;
        if (part === 'a[href*="/status/"]') return this.tag === "a" && (this.attrs.href || "").includes("/status/");
        if (part === 'div[role="link"]') return this.tag === "div" && this.attrs.role === "link";
        if (part === "img[alt]") return this.tag === "img" && this.attrs.alt != null;
        const match = part.match(/^\[data-testid="(.+)"\]$/);
        return match ? this.attrs["data-testid"] === match[1] : this.tag === part;
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
    querySelectorAll(selector) {
      return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const changes = [];
  let observer;
  let message;
  let timer;
  let observeTarget;
  const root = new Element("html");
  const document = {
    nodeType: 9,
    documentElement: root,
    createElement: (tag) => new Element(tag),
    querySelectorAll: (selector) => document.documentElement?.querySelectorAll(selector) || [],
  };
  const context = vm.createContext({
    document, URL,
    chrome: {
      storage: {
        local: { get: (defaults, cb) => cb({ ...defaults, ...cfg }) },
        onChanged: { addListener: (cb) => changes.push(cb) },
      },
      runtime: { onMessage: { addListener: (cb) => { message = cb; } } },
    },
    MutationObserver: class {
      constructor(cb) { observer = cb; }
      observe(target) { observeTarget = target; }
    },
    setTimeout: (cb) => { timer = cb; return 1; },
  });
  for (const file of ["bridge.js", "domhide.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  assert.equal(observeTarget, document);
  function article(id, text, author = "author") {
    const cell = new Element("div", { "data-testid": "cellInnerDiv" });
    const post = cell.appendChild(new Element("article"));
    const link = post.appendChild(new Element("a", { href: `/${author}/status/${id}` }));
    link.appendChild(new Element("time"));
    const body = post.appendChild(new Element("div", { "data-testid": "tweetText" }, text));
    return { cell, post, body, link };
  }
  return {
    Element, TextNode, root, article, context,
    mutate: (target, addedNodes = []) => observer([{ target, addedNodes }]),
    scan: () => { const cb = timer; timer = null; cb(); },
    update: (newCfg) => {
      Object.assign(cfg, newCfg);
      for (const cb of changes) cb(Object.fromEntries(Object.entries(newCfg).map(([key, newValue]) => [key, { newValue }])), "local");
    },
    count: () => { let total; message({ type: "tte-get-count" }, null, (response) => { total = response.total; }); return total; },
  };
}

test("body が無くても監視し、追加ノードの子孫をタイマー前に隠して件数を合算する", () => {
  const f = browserFixture({ wordMute: true, muteWords: ["spam"] });
  const wrapper = f.root.appendChild(new f.Element("div"));
  const first = f.article("123", "SPAM");
  wrapper.appendChild(first.cell);
  f.root.setAttribute("data-tte-removed", "3");
  f.mutate(f.root, [wrapper]);
  assert.equal(first.cell.classList.contains("tte-hidden"), true);
  assert.equal(f.count(), 4);
  const duplicate = f.article("123", "spam");
  wrapper.appendChild(duplicate.cell);
  f.mutate(wrapper, [duplicate.cell]);
  f.scan();
  assert.equal(f.count(), 4);
  assert.equal(f.root.getAttribute("data-tte-dom-removed"), null);
  f.update({ wordMute: false });
  assert.equal(first.cell.classList.contains("tte-hidden"), false);
  assert.equal(duplicate.cell.classList.contains("tte-hidden"), false);
  assert.equal(f.count(), 4);
});

test("追加ノードの祖先と本文・href の再利用を同期判定する", () => {
  const f = browserFixture({ wordMute: true, muteWords: ["spam"] });
  const first = f.article("100", "clean");
  f.root.appendChild(first.cell);
  f.mutate(f.root, [first.cell]);
  assert.equal(first.cell.classList.contains("tte-hidden"), false);
  first.body.textContent = "spam";
  const text = { nodeType: 3, parentElement: first.body };
  f.mutate(first.body, [text]);
  assert.equal(first.cell.classList.contains("tte-hidden"), true);
  first.link.setAttribute("href", "/author/status/200");
  f.mutate(first.link);
  assert.equal(f.count(), 2);
  first.body.textContent = "clean";
  f.mutate(text);
  assert.equal(first.cell.classList.contains("tte-hidden"), false);
  assert.equal(f.count(), 2);
});

test("本文の絵文字 alt がワードに一致すると投稿を隠す", () => {
  const f = browserFixture({ wordMute: true, muteWords: ["😀"] });
  const post = f.article("201", "plain text");
  post.body.appendChild(new f.Element("img", { alt: "😀" }));
  f.root.appendChild(post.cell);
  f.mutate(f.root, [post.cell]);
  assert.equal(post.body.textContent, "plain text");
  assert.equal(post.cell.classList.contains("tte-hidden"), true);
});

test("引用カード内の本文だけがワードに一致しても投稿を隠さない", () => {
  const f = browserFixture({ wordMute: true, muteWords: ["quotedword"] });
  const post = f.article("202", "outer text");
  post.post.removeChild(post.body);
  const quote = post.post.appendChild(new f.Element("div", { role: "link" }));
  quote.appendChild(new f.Element("div", { "data-testid": "tweetText" }, "quotedword"));
  f.root.appendChild(post.cell);
  f.mutate(f.root, [post.cell]);
  assert.equal(post.cell.classList.contains("tte-hidden"), false);
});

test("リポストと判別した文脈の handle だけを @id で隠す", () => {
  const f = browserFixture({ handleMute: true, muteHandles: ["@iconposter", "@textposter", "@likedposter", "@origin", "@user"] });
  function addContext(post, handle, text, iconPath) {
    const wrapper = post.post.appendChild(new f.Element("div"));
    const contextLink = wrapper.appendChild(new f.Element("a", { href: `/${handle}` }));
    contextLink.appendChild(new f.Element("span", { "data-testid": "socialContext" }, text));
    if (iconPath) {
      const svg = wrapper.appendChild(new f.Element("svg"));
      svg.appendChild(new f.Element("path", { d: iconPath }));
    }
  }
  const iconRepost = f.article("101", "clean");
  addContext(iconRepost, "IconPoster", "IconPosterさん", "M4.75 3.79l4.603 4.3 rest-of-path");
  const textRepost = f.article("102", "clean");
  addContext(textRepost, "TextPoster", "TextPosterさんがリポスト");
  const like = f.article("103", "clean");
  addContext(like, "LikedPoster", "LikedPosterさんがいいねしました");
  const original = f.article("104", "clean", "Origin");
  const user = new f.Element("div", { "data-testid": "UserCell" });
  user.appendChild(new f.Element("a", { href: "/search?q=user" }));
  user.appendChild(new f.Element("a", { href: "https://x.com/User" }));
  for (const node of [iconRepost.cell, textRepost.cell, like.cell, original.cell, user]) f.root.appendChild(node);
  f.mutate(f.root, [iconRepost.cell, textRepost.cell, like.cell, original.cell, user]);
  for (const node of [iconRepost.cell, textRepost.cell, original.cell, user]) assert.equal(node.classList.contains("tte-hidden"), true);
  assert.equal(like.cell.classList.contains("tte-hidden"), false);
  assert.equal(f.count(), 4);
  f.scan();
  assert.equal(f.count(), 4);
  user.children[1].setAttribute("href", "/other");
  f.mutate(user.children[1]);
  assert.equal(user.classList.contains("tte-hidden"), false);
  f.update({ handleMute: false });
  assert.equal(iconRepost.cell.classList.contains("tte-hidden"), false);
  assert.equal(textRepost.cell.classList.contains("tte-hidden"), false);
  assert.equal(like.cell.classList.contains("tte-hidden"), false);
  assert.equal(original.cell.classList.contains("tte-hidden"), false);
});

test("ミュート設定を読み込んでもワード・正規表現・@id を DOM に書かない", () => {
  const f = browserFixture({
    wordMute: true,
    muteWords: ["targetbody", "neverleakword"],
    muteRegexes: ["privatepattern\\d{3}"],
    handleMute: true,
    muteHandles: ["@privateconfighandle"],
  });
  const post = f.article("301", "targetbody");
  f.root.appendChild(post.cell);
  f.mutate(f.root, [post.cell]);
  assert.equal(post.cell.classList.contains("tte-hidden"), true);

  const rendered = [];
  function collect(element) {
    rendered.push(...Object.values(element.attrs), element.textContent);
    for (const child of element.children) collect(child);
  }
  collect(f.root);
  for (const rule of ["neverleakword", "privatepattern\\d{3}", "@privateconfighandle"]) {
    assert.equal(rendered.some((value) => String(value).includes(rule)), false, `DOM に ${rule} が含まれない`);
  }
});

test("非表示セルから article が取り除かれたら同期で非表示を解除する", () => {
  const f = browserFixture({ wordMute: true, muteWords: ["hiddenword"] });
  const post = f.article("401", "hiddenword");
  f.root.appendChild(post.cell);
  f.mutate(f.root, [post.cell]);
  assert.equal(post.cell.classList.contains("tte-hidden"), true);

  post.cell.removeChild(post.post);
  post.cell.appendChild(new f.Element("div", {}, "replacement"));
  f.mutate(post.cell);
  assert.equal(post.cell.classList.contains("tte-hidden"), false);
});
