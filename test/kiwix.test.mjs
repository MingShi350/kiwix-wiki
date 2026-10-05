// Offline unit tests + integration tests against a live Kiwix server.
// Run: npm test  (equivalently: node --test)
// Integration tests auto-skip when the Kiwix server is unreachable.

import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeEntities,
  stripTags,
  parseSearchXml,
  parseCatalogXml,
  parseSuggestJson,
  pathFromContentLink,
  extractArticleText,
  describeConnectionError,
  seriesKey,
  KiwixClient,
} from "../lib/kiwix.js";
import { Config } from "../index.js";

const BASE_URL = process.env.KIWIX_TEST_URL || "http://127.0.0.1:8090";
const DEFAULT_BOOK = "wikipedia_zh_all_maxi_2025-09";

// ---------------------------------------------------------------- unit tests

test("decodeEntities handles named, decimal, and hex entities", () => {
  assert.equal(decodeEntities("&lt;b&gt;x&lt;/b&gt;"), "<b>x</b>");
  assert.equal(decodeEntities("&#8212;"), "\u2014");
  assert.equal(decodeEntities("&#x4e07;"), "万");
  assert.equal(decodeEntities("&amp;amp;"), "&amp;");
});

test("stripTags is quote-aware: '>' inside quoted attributes must not leak", () => {
  assert.equal(
    stripTags('<span data-x="公元前}-」過度轉換">周杰伦</span>'),
    "周杰伦",
  );
  assert.equal(stripTags("<a href='/x'>t</a>"), "t");
});

test("parseSearchXml extracts total, titles, paths, snippets, wordCount", () => {
  const xml = `<?xml version="1.0"?><opensearch:Query/>
<opensearch:totalResults>3360</opensearch:totalResults>
<item><title>秦始皇</title>
<link>/content/wikipedia_zh_all_maxi_2025-09/%E7%A7%A6%E5%A7%8B%E7%9A%87</link>
<description>首段<b>秦始皇</b>简介</description>
<book><title>维基百科</title></book><wordCount>8000</wordCount></item>
<item><title>秦始皇 (消歧义)</title>
<link>/content/wikipedia_zh_all_maxi_2025-09/%E7%A7%A6%E5%A7%8B%E7%9A%87_(%E6%B6%88%E6%AD%A7%E4%B9%89)</link>
<description>消歧义页</description><book><title>维基百科</title></book></item>`;
  const parsed = parseSearchXml(xml);
  assert.equal(parsed.total, 3360);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].title, "秦始皇");
  assert.equal(parsed.items[0].path, "秦始皇");
  assert.equal(parsed.items[0].snippet, "首段秦始皇简介");
  assert.equal(parsed.items[0].wordCount, 8000);
  assert.equal(parsed.items[1].wordCount, undefined);
});

test("parseCatalogXml takes the ZIM name from the text/html acquisition link", () => {
  const xml = `<entry>
<id>urn:uuid:11111111-1111-1111-1111-111111111111</id>
<title>维基百科</title><name>wikipedia_zh_all</name><language>zho</language>
<articleCount>2891589</articleCount><tags>_ftindex:yes;maxi</tags>
<link rel="http://opds-spec.org/acquisition/open-access" type="application/x-zim" href="http://192.168.1.10:8090/catalog/v2/entry/11111111"/>
<link rel="http://opds-spec.org/acquisition/open-access" type="text/html" href="http://192.168.1.10:8090/content/wikipedia_zh_all_maxi_2025-09/"/>
</entry>`;
  const books = parseCatalogXml(xml);
  assert.equal(books.length, 1);
  assert.equal(books[0].name, "wikipedia_zh_all_maxi_2025-09");
  assert.equal(books[0].catalogName, "wikipedia_zh_all");
  assert.equal(books[0].articleCount, 2891589);
  assert.equal(books[0].ftindex, true);
});

test("parseSuggestJson unescapes <b> labels and drops the pattern entry", () => {
  const json = JSON.stringify([
    { value: "万里", label: "<b>万里</b>", kind: "path", path: "万里" },
    { value: "万里 (消歧义)", label: "<b>万里</b> (消歧义)", kind: "path", path: "万里_(消歧义)" },
    { value: "万", kind: "pattern" },
  ]);
  const titles = parseSuggestJson(json);
  assert.equal(titles.length, 2);
  assert.equal(titles[0].title, "万里");
  assert.equal(titles[1].title, "万里 (消歧义)");
  assert.equal(titles[1].path, "万里_(消歧义)");
});

test("pathFromContentLink decodes /content/<zim>/ paths", () => {
  assert.equal(
    pathFromContentLink("/content/wikipedia_zh_all_maxi_2025-09/%E7%A7%A6%E5%A7%8B%E7%9A%87"),
    "秦始皇",
  );
  assert.equal(pathFromContentLink("https://x/content/zim/A/%E4%B8%87%E9%87%8C"), "万里");
});

const FIXTURE = `
<div id="mw-content-text"><div class="mw-parser-output">
<table class="infobox vcard"><tbody>
<tr><th>出生</th><td>1979年1月18日</td></tr>
<tr><th>职业</th><td>歌手 &amp; 作曲家</td></tr>
</tbody></table>
<p>这是正文首段。</p>
<h2><span class="mw-headline">生平</span><span class="mw-editsection">[编辑]</span></h2>
<p>第二段内容<sup class="reference">[1]</sup>结束。</p>
<table class="nowraplinks navbox"><tbody><tr><td>导航噪声</td></tr></tbody></table>
<span data-x="公元前}-」過度轉換">周杰伦</span>
</div></div>
<div class="catlinks">分类噪声</div>`;

test("extractArticleText puts the lead first and appends the infobox at the end", () => {
  const text = extractArticleText(FIXTURE);
  assert.ok(text.startsWith("这是正文首段"), `lead must come first, got: ${text.slice(0, 80)}`);
  assert.ok(text.includes("## 信息框"));
  assert.ok(text.indexOf("出生") > text.indexOf("正文首段"), "infobox rows must trail the body");
  assert.ok(text.includes("歌手 & 作曲家"), "entities decoded in infobox");
});

test("extractArticleText drops navbox/catlinks/edit links/citations and quoted-attr junk", () => {
  const text = extractArticleText(FIXTURE);
  assert.ok(!text.includes("导航噪声"));
  assert.ok(!text.includes("分类噪声"));
  assert.ok(!text.includes("[编辑]"));
  assert.ok(!text.includes("[1]"));
  assert.ok(!text.includes("過度轉換"));
  assert.ok(text.includes("周杰伦"));
  assert.ok(text.includes("## 生平"));
  assert.ok(text.includes("第二段内容结束"));
});

// ------------------------------------------------- ZIM rotation resilience

function stubClient(books, config = {}) {
  const calls = [];
  const client = new KiwixClient({
    baseUrl: "http://127.0.0.1:9",
    defaultBook: "wikipedia_zh_all_maxi_2025-09",
    timeoutMs: 50,
    maxTextChars: 100,
    ...config,
  });
  client.catalog = async (force) => {
    calls.push(force === true);
    return calls.length === 1 ? books.first : (books.next ?? books.first);
  };
  client.calls = calls;
  return client;
}

const mkBook = (name, title, catalogName) => ({ name, catalogName: catalogName ?? name.replace(/[-_]\d{4}-\d{2}$/, ""), title, language: "zho", articleCount: 1 });

test("seriesKey strips only a trailing dump date", () => {
  assert.equal(seriesKey("wikipedia_zh_all_maxi_2026-08"), "wikipedia_zh_all_maxi");
  assert.equal(seriesKey("ted_mul_ted-conference_2026-02.zim"), "ted_mul_ted-conference");
  assert.equal(seriesKey("wikipedia_zh_all"), undefined);
});

test("alias resolves to the newest dump, not the first catalog entry", async () => {
  const client = stubClient({
    first: [mkBook("wikipedia_zh_all_maxi_2025-09", "维基百科"), mkBook("wikipedia_zh_all_maxi_2026-08", "维基百科")],
  });
  const book = await client.resolveBook("zh");
  assert.equal(book.name, "wikipedia_zh_all_maxi_2026-08");
});

test("a dated defaultBook falls back to the newest same-series dump and says so", async () => {
  const client = stubClient({
    first: [
      mkBook("wikipedia_zh_all_maxi_2026-08", "维基百科"),
      mkBook("wikipedia_zh_all_nopic_2026-09", "维基百科"),
    ],
  });
  const book = await client.resolveBook(undefined);
  assert.equal(book.name, "wikipedia_zh_all_maxi_2026-08", "must not cross flavour (maxi vs nopic)");
  assert.match(book.note, /configured defaultBook "wikipedia_zh_all_maxi_2025-09" is not in the library/);
  assert.match(book.note, /wikipedia_zh_all_maxi/);
  assert.match(client._articleResult(book, "t", "u", "text", 10).note, /newest/);
});

test("an explicit stale book name is never substituted", async () => {
  const client = stubClient({ first: [mkBook("wikipedia_zh_all_maxi_2026-08", "维基百科")] });
  await assert.rejects(
    () => client.resolveBook("wikipedia_zh_all_maxi_2025-09"),
    /unknown book "wikipedia_zh_all_maxi_2025-09"/,
  );
});

test("a lookup miss refreshes the cached catalog once", async () => {
  const client = stubClient({
    first: [mkBook("wikipedia_en_all_maxi_2026-02", "Wikipedia")],
    next: [mkBook("wikipedia_en_all_maxi_2026-02", "Wikipedia"), mkBook("wikipedia_zh_all_maxi_2026-08", "维基百科")],
  });
  const book = await client.resolveBook("zh");
  assert.equal(book.name, "wikipedia_zh_all_maxi_2026-08");
  assert.deepEqual(client.calls, [false, true], "a miss must force one catalog refresh");
});

// ----------------------------------------------------------- integration tests

const client = new KiwixClient({
  baseUrl: BASE_URL,
  defaultBook: DEFAULT_BOOK,
  timeoutMs: 15000,
  maxTextChars: 24000,
});

let online = true;
try {
  await client.catalog();
} catch {
  online = false;
}

test("integration: catalog lists books and alias 'zh' resolves to the zh Wikipedia ZIM", async (t) => {
  if (!online) return t.skip();
  const book = await client.resolveBook("zh");
  assert.ok(book.name.startsWith("wikipedia_zh_all"), `alias zh must land on a zh dump, got ${book.name}`);
  assert.ok(book.articleCount > 100000);
});

test("integration: the dated defaultBook falls back to the newest same-series dump", async (t) => {
  if (!online) return t.skip();
  const dated = (await client.catalog(true)).find((book) => book.name === DEFAULT_BOOK);
  const book = await client.resolveBook(undefined);
  assert.ok(book.name.startsWith("wikipedia_zh_all"), book.name);
  if (dated) {
    assert.equal(book.name, DEFAULT_BOOK);
    assert.equal(book.note, undefined, "an exact match needs no note");
  } else {
    assert.notEqual(book.name, DEFAULT_BOOK);
    assert.match(book.note, /configured defaultBook .* is not in the library/);
  }
});

test("integration: an explicit unknown book name is never substituted", async (t) => {
  if (!online) return t.skip();
  await assert.rejects(() => client.resolveBook("wikipedia_zh_all_maxi_2099-01"), /unknown book/);
});

test("integration: fulltext search returns ranked items with paths", async (t) => {
  if (!online) return t.skip();
  const result = await client.search(undefined, "秦始皇", 5);
  assert.ok(result.total > 0);
  assert.ok(result.items.length > 0);
  assert.ok(result.items[0].title.includes("秦始皇"));
  assert.ok(result.items[0].path);
});

test("integration: read keeps the lead first; infobox moved to a trailing section", async (t) => {
  if (!online) return t.skip();
  const result = await client.read(undefined, "万里", 90000);
  assert.ok(result.text.includes("## 信息框"));
  assert.ok(
    result.text.indexOf("中国共产党") < result.text.indexOf("## 信息框"),
    `lead must precede the infobox section, got: ${result.text.slice(0, 200)}`,
  );
  const head = result.text.slice(0, 400);
  assert.ok(!head.includes("任期"), "first 400 chars must not be flattened infobox rows");
  // A small maxChars keeps the lead and simply drops the trailing infobox.
  const short = await client.read(undefined, "万里", 600);
  assert.ok(short.truncated);
  assert.ok(!short.text.slice(0, 400).includes("任期"));
});

test("integration: near-miss titles are hinted, never silently fetched", async (t) => {
  if (!online) return t.skip();
  // "关于" is not an article itself; suggestions like 17.3关于性 must not be fetched.
  let outcome;
  try {
    outcome = { ok: true, result: await client.read(undefined, "关于", 2000) };
  } catch (error) {
    outcome = { ok: false, message: String(error.message) };
  }
  if (outcome.ok) {
    assert.equal(outcome.result.title, "关于", "only the exact title may be auto-fetched");
  } else {
    assert.match(outcome.message, /Close titles|Related articles/);
  }
});

test("integration: namespace titles fail with an explanatory note", async (t) => {
  if (!online) return t.skip();
  await assert.rejects(
    () => client.read(undefined, "Wikipedia:关于", 2000),
    /namespaces/,
  );
});

test("extractArticleText removes the zim-footer block structurally, keeps infobox", () => {
  const html = `<div id="mw-content-text"><div class="mw-parser-output"><p>正文内容。</p><table class="infobox"><tr><td>任期</td><td>1988</td></tr></table></div></div>
<!--htdig_noindex--><div><div class="zim-footer">This article is issued from <a href="https://wikipedia.org">Wikipedia</a>. The text is available under <a href="https://creativecommons.org/licenses/by-sa/4.0/">Creative Commons Attribution-Share Alike 4.0</a> unless otherwise noted. Additional terms may apply for the media files.</div>
</div><!--/htdig_noindex--><div class="catlinks">cats</div></body>`;
  const text = extractArticleText(html);
  assert.ok(!/issued from Wikipedia|media files/.test(text), "zim-footer boilerplate must be removed");
  assert.ok(!text.includes("cats"), "catlinks must stay removed");
  assert.ok(text.includes("正文内容。"), "body text must survive");
  assert.ok(text.includes("## 信息框"), "trailing infobox section must be preserved");
  // class with extra tokens must still match
  const multi = html.replace('class="zim-footer"', 'class="zim-footer css"');
  assert.ok(!/issued from Wikipedia/.test(extractArticleText(multi)));
  // a page without the footer must be untouched
  assert.equal(extractArticleText('<div id="mw-content-text"><p>干净正文</p></div>'), "干净正文");
});

test("integration: real articles carry no zim-footer boilerplate", async (t) => {
  if (!online) return t.skip();
  for (const title of ["微软", "万里"]) {
    const result = await client.read(undefined, title, 90000);
    assert.ok(!/issued from Wikipedia|media files/.test(result.text), `${title}: footer boilerplate leaked`);
    assert.ok(result.text.includes("## 信息框"), `${title}: infobox section must remain`);
  }
});

// ------------------------------------------------------------------ config

test("Config defaults to a local kiwix-serve on 127.0.0.1:8090", () => {
  const result = Config["~standard"].validate(undefined);
  assert.equal(result.issues, undefined);
  assert.equal(result.value.baseUrl, "http://127.0.0.1:8090");
  assert.equal(result.value.timeoutMs, 15000);
  assert.equal(result.value.maxTextChars, 24000);
  assert.equal(result.value.catalogTtlMs, 60000);
  assert.equal(result.value.defaultBook, "zh");
});

test("integration: the shipped defaultBook resolves against a live server", async (t) => {
  if (!online) return t.skip();
  const fresh = new KiwixClient({ ...Config["~standard"].validate(undefined).value, baseUrl: BASE_URL });
  const book = await fresh.resolveBook(undefined);
  assert.ok(book.name.startsWith("wikipedia_zh_all"), `default alias must land on a zh dump, got ${book.name}`);
});

test("Config accepts any baseUrl override and rejects unknown keys", () => {
  const remote = Config["~standard"].validate({ baseUrl: "http://192.168.1.10:8090/" });
  assert.equal(remote.issues, undefined);
  assert.equal(remote.value.baseUrl, "http://192.168.1.10:8090/");
  const ttl = Config["~standard"].validate({ catalogTtlMs: 5000 });
  assert.equal(ttl.issues, undefined);
  assert.equal(ttl.value.catalogTtlMs, 5000);
  const bad = Config["~standard"].validate({ baseUrl: "http://x:1", nope: 1 });
  assert.ok(bad.issues?.some((issue) => issue.message.includes("unknown config key")));
});

// ------------------------------------------------- unreachable-server errors

test("describeConnectionError names the baseUrl and the config key to fix", () => {
  const original = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8090"), { code: "ECONNREFUSED" });
  const wrapped = describeConnectionError(original, "http://127.0.0.1:8090", "http://127.0.0.1:8090/catalog/v2/entries");
  assert.match(wrapped.message, /cannot reach the Kiwix server at http:\/\/127\.0\.0\.1:8090 \(ECONNREFUSED\)/);
  assert.match(wrapped.message, /baseUrl/);
  assert.match(wrapped.message, /connect ECONNREFUSED 127\.0\.0\.1:8090/);
  assert.equal(wrapped.cause, original);
  // non-socket errors must pass through untouched
  const httpish = Object.assign(new Error("HTTP 404 from http://x/y"), { code: undefined });
  assert.equal(describeConnectionError(httpish, "http://x", "http://x/y"), httpish);
});

test("a dead baseUrl fails with an actionable message, not a raw socket error", async () => {
  const dead = new KiwixClient({
    baseUrl: "http://127.0.0.1:1",
    defaultBook: DEFAULT_BOOK,
    timeoutMs: 3000,
    maxTextChars: 24000,
  });
  await assert.rejects(
    () => dead.catalog(),
    (error) => {
      assert.match(error.message, /cannot reach the Kiwix server at http:\/\/127\.0\.0\.1:1/);
      assert.match(error.message, /docs\/quickstart\.md/);
      return true;
    },
  );
});
