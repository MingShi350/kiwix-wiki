/**
 * Kiwix-serve client: catalog, full-text search, title suggest, article read.
 * Zero dependencies — Node built-ins only (node:http/https). All parsing is
 * regex-based against the verified kiwix-serve response shapes.
 *
 * NOTE: deliberately NOT using global fetch/undici — undici has a crash bug
 * (uncaught `AssertionError: assert(!this.paused)` at Parser.finish on
 * socket end) observed against kiwix-serve responses, which would take down
 * the whole Host process. node:http errors are always catchable.
 *
 * Endpoints used (verified against kiwix-serve 3.8.2):
 *   GET /catalog/v2/entries?count=-1                     → Atom XML (book list)
 *   GET /search?pattern=…&books.name=<ZIM>&format=xml…   → RSS/XML (full-text)
 *   GET /suggest?term=…&count=…&content=<ZIM>            → JSON (title suggest)
 *   GET /content/<ZIM>/<title>                           → HTML (manual 3xx, ≤5 hops)
 */

import http from "node:http";
import https from "node:https";

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  hellip: "…", middot: "·", times: "×", deg: "°", prime: "′", Prime: "″",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", shy: "",
};

export function decodeEntities(text) {
  return String(text).replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (whole, entity) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
      try { return String.fromCodePoint(code); } catch { return whole; }
    }
    const named = NAMED_ENTITIES[entity];
    return named === undefined ? whole : named;
  });
}

export function stripTags(html) {
  // Quote-aware: an attribute value may legally contain '>' (e.g.
  // <span data-x="公元前}-」過度轉換">), which a naive <[^>]*> would cut
  // early and leak as body text.
  return String(html).replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, "");
}

function capture(text, re) {
  const m = re.exec(text);
  return m ? m[1] : undefined;
}

/** Parse the RSS/XML body of /search?format=xml into structured items. */
export function parseSearchXml(xml) {
  const totalRaw = capture(xml, /<opensearch:totalResults>([^<]*)<\/opensearch:totalResults>/) ?? "0";
  const total = Number.parseInt(totalRaw.replace(/[,\s]/g, ""), 10) || 0;
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const title = decodeEntities(capture(block, /<title>([\s\S]*?)<\/title>/) ?? "").trim();
    const link = (capture(block, /<link>([\s\S]*?)<\/link>/) ?? "").trim();
    const descriptionRaw = capture(block, /<description>([\s\S]*?)<\/description>/) ?? "";
    const snippet = decodeEntities(stripTags(descriptionRaw)).replace(/\s+/g, " ").trim();
    const bookTitle = decodeEntities(capture(block, /<book>\s*<title>([\s\S]*?)<\/title>/) ?? "").trim();
    const wordCountRaw = capture(block, /<wordCount>(\d+)<\/wordCount>/);
    items.push({
      title,
      url: link,
      path: pathFromContentLink(link),
      snippet,
      book: bookTitle,
      ...(wordCountRaw !== undefined ? { wordCount: Number.parseInt(wordCountRaw, 10) } : {}),
    });
  }
  return { total, items };
}

/** Turn `/content/<zim>/<encoded path>` into the decoded article path (drops the /A/ namespace prefix). */
export function pathFromContentLink(link) {
  const m = /(?:^|\/)content\/[^/]+\/(.*)$/.exec(link);
  if (!m) return link;
  let path = m[1];
  try { path = decodeURIComponent(path); } catch { /* keep raw */ }
  return path.replace(/^A\//, "");
}

/** Parse /catalog/v2/entries Atom XML. The ZIM name used in URLs comes from the text/html link. */
export function parseCatalogXml(xml) {
  const books = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const catalogName = capture(block, /<name>([^<]*)<\/name>/) ?? "";
    const href = capture(block, /<link[^>]*type="text\/html"[^>]*href="([^"]+)"/)
      ?? capture(block, /<link[^>]*href="([^"]+)"[^>]*type="text\/html"/);
    const zimName = href ? decodeEntities(href).replace(/^.*\/content\//, "").replace(/\/+$/, "") : catalogName;
    const title = decodeEntities(capture(block, /<title>([^<]*)<\/title>/) ?? "").trim();
    const language = (capture(block, /<language>([^<]*)<\/language>/) ?? "").trim();
    const flavour = (capture(block, /<flavour>([^<]*)<\/flavour>/) ?? "").trim();
    const category = (capture(block, /<category>([^<]*)<\/category>/) ?? "").trim();
    const articleCount = Number.parseInt(capture(block, /<articleCount>([^<]*)<\/articleCount>/) ?? "0", 10) || 0;
    const ftindex = /_ftindex:yes/.test(capture(block, /<tags>([^<]*)<\/tags>/) ?? "");
    if (!zimName) continue;
    books.push({ name: zimName, catalogName, title, language, flavour, category, articleCount, ftindex });
  }
  return books;
}

/** Parse the /suggest JSON array; drop the trailing "pattern" pseudo-entry. */
export function parseSuggestJson(body) {
  const raw = JSON.parse(body);
  const out = [];
  for (const entry of raw) {
    if (entry.kind === "pattern") continue;
    out.push({
      title: stripTags(decodeEntities(entry.label ?? entry.value ?? "")).trim(),
      path: entry.path ?? entry.value ?? "",
    });
  }
  return out;
}

/** Convert a chunk of parser-output HTML into readable plain text. */
function flowToText(html) {
  let body = String(html);
  body = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<link[^>]*>/gi, "")
    .replace(/<figure[\s\S]*?<\/figure>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<sup[^>]*class="reference[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<sup[^>]*class="noprint[^"]*"[^>]*>[\s\S]*?<\/sup>/gi, "")
    .replace(/<table[^>]*class="[^"]*navbox[^"]*"[\s\S]*?<\/table>/gi, "")
    .replace(/<table[^>]*class="[^"]*metadata[^"]*"[\s\S]*?<\/table>/gi, "")
    .replace(/<div[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/div>/gi, "")
    .replace(/<span[^>]*class="[^"]*mw-editsection[^"]*"[\s\S]*?<\/span>/gi, "");

  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level, inner) => {
    const text = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
    return text ? `\n\n${"#".repeat(Number(level))} ${text}\n` : "\n";
  });
  body = body
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "")
    .replace(/<ul[^>]*>|<\/ul>|<ol[^>]*>|<\/ol>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<blockquote[^>]*>/gi, "\n\n> ")
    .replace(/<\/blockquote>/gi, "\n")
    .replace(/<tr[^>]*>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<table[^>]*>/gi, "\n")
    .replace(/<\/table>/gi, "\n")
    .replace(/<br[^>]*\/?>/gi, "\n")
    .replace(/<div[^>]*>|<\/div>/gi, "\n");

  body = decodeEntities(stripTags(body));

  body = body
    .replace(/\[\s*(编辑|编辑源代码|修改源代码|查看源代码|添加描述|edit|edit source|change source|view source|add description)\s*\]/gi, "")
    .replace(/\[\s*\d+[a-z]?\s*\]/g, "")
    .replace(/\[citation needed\]/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\| ?\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return body;
}

/**
 * Extract readable plain text from a Wikipedia article HTML page (Vector
 * skin). The lead paragraph comes first; infobox and succession-box tables
 * are moved to a trailing "## 信息框" section so truncation never buries the
 * article body in flattened table fragments. Drops chrome, edit links,
 * citation markers, navboxes, and images.
 */
export function extractArticleText(html) {
  let body = String(html);
  const start = body.indexOf('<div id="mw-content-text"');
  if (start >= 0) body = body.slice(start);
  const end = body.indexOf('<div class="catlinks');
  if (end >= 0) body = body.slice(0, end);

  // kiwix-serve injects a license footer before </body> (same in zh/en ZIMs):
  //   <!--htdig_noindex--><div><div class="zim-footer">…</div>\n</div><!--/htdig_noindex-->
  // Remove it structurally: cut from the zim-footer opening tag through the
  // matching </div> (balanced <div> counting), then peel any now-empty
  // wrapper div left at the tail. Text-matching the license sentence would
  // break across languages/versions.
  {
    const open = /<div[^>]*class="[^"]*zim-footer[^"]*"[^>]*>/i.exec(body);
    if (open) {
      let depth = 0;
      const divTag = /<div\b[^>]*>|<\/div\s*>|<div\s*>|<\/div>/gi;
      divTag.lastIndex = open.index;
      let m;
      while ((m = divTag.exec(body)) !== null) {
        depth += m[0][1] === "/" ? -1 : 1;
        if (depth === 0) {
          body = body.slice(0, open.index) + body.slice(divTag.lastIndex);
          break;
        }
      }
      // Peel the wrapper: <div> … </div> pairs that are now empty (only
      // whitespace/comments remain between them) at the tail of the body.
      const emptyWrapper = /<div[^>]*>(?:\s|<!--[\s\S]*?-->)*<\/div>\s*$/i;
      let trimmed = body.replace(emptyWrapper, "");
      while (trimmed !== body) {
        body = trimmed;
        trimmed = body.replace(emptyWrapper, "");
      }
    }
  }

  const sidebars = [];
  body = body.replace(
    /<table[^>]*class="[^"]*(?:infobox|succession-box)[^"]*"[\s\S]*?<\/table>/gi,
    (whole) => { sidebars.push(whole); return ""; },
  );

  body = flowToText(body);
  if (sidebars.length > 0) {
    const info = flowToText(sidebars.join("\n"));
    if (info) body = body ? `${body}\n\n## 信息框\n${info}` : `## 信息框\n${info}`;
  }
  return body;
}

/** Human byte-ish size for logs. */
export function textLength(text) {
  return [...String(text)].length;
}

/** Socket-level failures that mean "nothing answered at baseUrl", not "bad request". */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN",
  "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE",
]);

/**
 * Rewrite a socket error into one that names the configured baseUrl and the
 * config key to fix. Other errors pass through untouched.
 * @param {any} error
 * @param {string} baseUrl
 * @param {string} url
 * @returns {any}
 */
export function describeConnectionError(error, baseUrl, url) {
  if (!UNREACHABLE_CODES.has(error?.code)) return error;
  return new Error(
    `cannot reach the Kiwix server at ${baseUrl} (${error.code}) while fetching ${url}. `
    + "Start kiwix-serve, or point the plugin's baseUrl config at the machine that runs it "
    + '(see docs/quickstart.md, section "配置"). '
    + `Original error: ${error.message}`,
    { cause: error },
  );
}

/**
 * Strip the dump date from a ZIM name: wikipedia_zh_all_maxi_2026-08 →
 * wikipedia_zh_all_maxi. Returns undefined when the name carries no date.
 * @param {string} name
 * @returns {string|undefined}
 */
export function seriesKey(name) {
  const base = String(name).replace(/\.zim$/, "");
  const stripped = base.replace(/[-_]\d{4}-\d{2}$/, "");
  return stripped === base ? undefined : stripped;
}

export class KiwixClient {
  /** @param {{baseUrl: string, defaultBook: string, timeoutMs: number, maxTextChars: number, catalogTtlMs?: number}} config */
  constructor(config) {
    this.config = config;
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this._catalog = null;
    this._catalogAt = 0;
    this._catalogTtlMs = config.catalogTtlMs ?? 60_000;
  }

  /**
   * GET a URL as UTF-8 text via node:http(s). Follows redirects manually
   * (max 5). Throws on non-2xx or timeout. Never uses undici (crash bug).
   * @returns {Promise<string>}
   */
  fetchText(url) {
    return new Promise((resolve, reject) => this._fetchOnce(url, 0, url, resolve, reject));
  }

  _fetchOnce(current, hop, origin, resolve, reject) {
    if (hop > 5) {
      reject(new Error(`too many redirects starting from ${origin}`));
      return;
    }
    let target;
    try {
      target = new URL(current);
    } catch {
      reject(new Error(`invalid URL: ${current}`));
      return;
    }
    const lib = target.protocol === "https:" ? https : http;
    const request = lib.get(target, { timeout: this.config.timeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.resume(); // drain the redirect body so the socket closes cleanly
        if (!location) {
          reject(new Error(`HTTP ${status} redirect without Location from ${current}`));
          return;
        }
        let next;
        try {
          next = new URL(location, target).toString();
        } catch {
          reject(new Error(`bad redirect Location "${location}" from ${current}`));
          return;
        }
        this._fetchOnce(next, hop + 1, origin, resolve, reject);
        return;
      }
      if (status >= 400) {
        response.resume();
        reject(new Error(`HTTP ${status} from ${current}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("timeout", () => {
      request.destroy(new Error(`request timed out after ${this.config.timeoutMs} ms: ${current} (is the Kiwix server reachable?)`));
    });
    request.on("error", (error) => {
      reject(describeConnectionError(error, this.baseUrl, current));
    });
  }

  /** Cached book catalog from /catalog/v2/entries. */
  async catalog(force = false) {
    if (!force && this._catalog && Date.now() - this._catalogAt < this._catalogTtlMs) return this._catalog;
    const xml = await this.fetchText(`${this.baseUrl}/catalog/v2/entries?count=-1`);
    const books = parseCatalogXml(xml);
    if (books.length === 0) throw new Error("catalog returned no books — unexpected response from the Kiwix server");
    this._catalog = books;
    this._catalogAt = Date.now();
    return books;
  }

  /** ZIM names embed their dump date (…_2026-08): newest first, stable otherwise. */
  _newestFirst(books) {
    return [...books].sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  }

  /**
   * Match `wanted` against the catalog.
   * Order: exact ZIM/catalog name → alias prefix (newest dump wins) → a dated
   * defaultBook that has been superseded by a newer dump of the same flavour
   * (only for the configured default, never for an explicit `book` argument) →
   * case-insensitive substring (newest wins).
   * @returns {object|undefined} book, possibly carrying a `note` about the match
   */
  _matchBook(books, wanted, explicit) {
    const exact = books.find((book) => book.name === wanted || book.catalogName === wanted);
    if (exact) return exact;

    const lowered = String(wanted).toLowerCase();
    const aliases = {
      zh: "wikipedia_zh_all", zhwiki: "wikipedia_zh_all", "zh-cn": "wikipedia_zh_all",
      en: "wikipedia_en_all", enwiki: "wikipedia_en_all",
      medicine: "wikipedia_en_medicine", simple: "wikipedia_en_simple",
    };
    const aliasPrefix = aliases[lowered];
    if (aliasPrefix) {
      const aliased = this._newestFirst(books.filter((book) => book.name.startsWith(aliasPrefix)))[0];
      if (aliased) return aliased;
    }

    // A dated defaultBook breaks every time the ZIM is refreshed: fall back to
    // the newest dump of the same series+flavour (wikipedia_zh_all_maxi_*),
    // and say so in the result. An explicit `book` argument never substitutes.
    if (!explicit) {
      const series = seriesKey(wanted);
      if (series !== undefined) {
        const newest = this._newestFirst(books.filter((book) => seriesKey(book.name) === series))[0];
        if (newest) {
          return { ...newest, note: `configured defaultBook "${wanted}" is not in the library; answered from the newest "${series}" dump (${newest.name})` };
        }
      }
    }

    const fuzzy = this._newestFirst(books.filter((book) => (
      book.title.toLowerCase().includes(lowered) || book.name.toLowerCase().includes(lowered)
    )))[0];
    if (fuzzy) return fuzzy;
    return undefined;
  }

  /**
   * Resolve a book selector: exact ZIM name, catalog name, alias (zh/en/…),
   * a superseded dated default, or a case-insensitive title/name substring.
   * A miss refreshes the cached catalog once (a ZIM may have just been added)
   * before throwing with the book list.
   */
  async resolveBook(input) {
    const explicit = input !== undefined && input !== null && String(input).trim() !== "";
    const wanted = explicit ? String(input).trim() : String(this.config.defaultBook);
    const wantedLower = wanted.toLowerCase();
    let books = await this.catalog();
    let match = this._matchBook(books, wanted, explicit);
    if (!match) {
      books = await this.catalog(true).catch(() => books);
      match = this._matchBook(books, wanted, explicit);
    }
    if (match) return match;

    const listing = books.map((book) => `${book.name} (${book.title}, ${book.language})`).join("; ");
    const tip = explicit
      ? ""
      : " Hint: an alias such as \"zh\" (or a series name without the date) follows the newest dump automatically after a ZIM refresh.";
    throw new Error(`unknown book "${wanted}". Available books: ${listing}.${tip}`);
  }

  /** Full-text search via /search?format=xml. */
  async search(bookInput, pattern, limit = 10, offset = 0) {
    const book = await this.resolveBook(bookInput);
    const params = new URLSearchParams({
      pattern,
      "books.name": book.name,
      format: "xml",
      pageLength: String(Math.min(Math.max(limit, 1), 140)),
      start: String(Math.max(offset, 0)),
    });
    const xml = await this.fetchText(`${this.baseUrl}/search?${params}`);
    const parsed = parseSearchXml(xml);
    return { book, total: parsed.total, items: parsed.items };
  }

  /** Title suggestions via /suggest. */
  async suggest(bookInput, term, count = 10) {
    const book = await this.resolveBook(bookInput);
    const params = new URLSearchParams({
      term,
      count: String(Math.min(Math.max(count, 1), 100)),
      content: book.name,
    });
    const body = await this.fetchText(`${this.baseUrl}/suggest?${params}`);
    return { book, titles: parseSuggestJson(body) };
  }

  /**
   * Read an article. Tries the direct content path, then the /A/ prefix,
   * then title suggestions — but only auto-fetches a suggestion that is a
   * true match; near misses are reported as hints, never fetched silently.
   * @returns {{book, title, path, url, text, totalChars, truncated}}
   */
  async read(bookInput, title, maxChars) {
    const book = await this.resolveBook(bookInput);
    const cleanTitle = String(title).trim();
    // ZIM article paths may use underscores where the display title has spaces.
    const variants = [cleanTitle, cleanTitle.replace(/ /g, "_")];
    const candidates = [];
    for (const variant of variants) {
      const encoded = encodeURIComponent(variant);
      candidates.push(`${this.baseUrl}/content/${book.name}/${encoded}`);
      candidates.push(`${this.baseUrl}/content/${book.name}/A/${encoded}`);
    }
    let lastError;
    for (const url of candidates) {
      try {
        const html = await this.fetchText(url);
        const text = extractArticleText(html);
        if (textLength(text) < 40) {
          lastError = new Error(`article "${cleanTitle}" in book "${book.name}" returned no readable text`);
          continue;
        }
        return this._articleResult(book, cleanTitle, url, text, maxChars);
      } catch (error) {
        lastError = error;
      }
    }
    // Fallback: title suggestions. Only auto-fetch a suggestion when it is a
    // true match (exact case-insensitive, or a clear prefix relationship);
    // never silently fetch an unrelated article — surface it as a hint instead.
    let suggestions = await this.suggest(book.name, cleanTitle, 8).catch(() => undefined);
    if ((!suggestions || suggestions.titles.length === 0) && cleanTitle.includes(":")) {
      const bare = cleanTitle.slice(cleanTitle.lastIndexOf(":") + 1).trim();
      if (bare) suggestions = await this.suggest(book.name, bare, 8).catch(() => undefined);
    }
    const titles = suggestions?.titles ?? [];
    const wanted = cleanTitle.toLowerCase();
    // Only an exact (case-insensitive) title may be auto-fetched; prefix
    // suggestions like 关于 → 关于施密特 are different articles and must
    // stay hints.
    const strong = titles.find((entry) => entry.title.toLowerCase() === wanted);
    if (strong) {
      const path = String(strong.path ?? strong.title).replace(/^\/?A\//, "");
      try {
        const html = await this.fetchText(`${this.baseUrl}/content/${book.name}/${encodeURIComponent(path)}`);
        const text = extractArticleText(html);
        if (textLength(text) >= 40) {
          return this._articleResult(book, strong.title, `${this.baseUrl}/content/${book.name}/${encodeURIComponent(path)}`, text, maxChars);
        }
      } catch (error) {
        lastError = error;
      }
    }
    let hint = titles.length > 0
      ? ` Close titles: ${titles.map((entry) => entry.title).join(", ")}.`
      : "";
    if (!hint) {
      const related = await this.search(book.name, cleanTitle, 5).catch(() => undefined);
      if (related && related.items.length > 0) {
        hint = ` Related articles: ${related.items.map((item) => item.title).join(", ")}.`;
      }
    }
    if (/^(?:Wikipedia|Help|Portal|File|Category|Talk|User|Special|Template|Module|MediaWiki)[:：]/i.test(cleanTitle)) {
      hint += " Note: pages in Wikipedia namespaces (Wikipedia:, Help:, File:, …) are usually not included in ZIM files.";
    }
    throw new Error(`article "${cleanTitle}" not found in book "${book.name}": ${lastError?.message ?? "unknown error"}.${hint}`);
  }

  _articleResult(book, title, url, text, maxChars) {
    const cap = maxChars ?? this.config.maxTextChars;
    const chars = [...text];
    const truncated = chars.length > cap;
    return {
      book: book.name,
      title,
      path: title,
      url,
      text: truncated ? chars.slice(0, cap).join("") : text,
      totalChars: chars.length,
      truncated,
      ...(book.note ? { note: book.note } : {}),
    };
  }
}
