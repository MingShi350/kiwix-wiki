/**
 * kiwix-wiki Host plugin: offline Wikipedia database query tools.
 *
 * Registers three model-facing tools backed by the local kiwix-serve ZIM
 * library (default: Chinese Wikipedia, 2.89M articles). Works without
 * internet — every query answers from the on-disk ZIM database served by
 * the Kiwix server, by default on this machine (http://127.0.0.1:8090).
 *
 * `baseUrl` is an ordinary plugin config value: point it at any other host
 * (a LAN box, a NAS, a remote server) without touching this file. See
 * docs/quickstart.md, section "配置", for the patch-layer recipes.
 */

import { KiwixClient } from "./lib/kiwix.js";

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8090",
  defaultBook: "zh",
  timeoutMs: 15000,
  maxTextChars: 24000,
  catalogTtlMs: 60000,
};

const CONFIG_SHAPE = {
  baseUrl: { type: "string", description: "Kiwix-serve base URL (scheme://host:port). Defaults to http://127.0.0.1:8090; point it at another host to use a remote/LAN server. Edit it in the plugin config (profile patch or `dsh --patch`), see docs/quickstart.md." },
  defaultBook: { type: "string", description: "ZIM book used when a tool call omits `book`: an exact ZIM file name without .zim (as listed by wiki_books), an alias (zh, en, medicine, simple), or a series name without the date. Prefer `zh` or a series name — a dated name must be edited on every ZIM refresh (the plugin then falls back to the newest dump of the same series and says so)." },
  timeoutMs: { type: "integer", description: "Per-request timeout in milliseconds." },
  maxTextChars: { type: "integer", description: "Default cap for wiki_read article text." },
  catalogTtlMs: { type: "integer", description: "How long the book catalog is cached, in ms (default 60000). Lower it to notice ZIM files added to kiwix-serve sooner; a failed book lookup always refreshes the catalog." },
};

/** Hand-rolled standard-schema Config: validates the row config and fills defaults. */
export const Config = {
  "~standard": {
    version: 1,
    vendor: "kiwix-wiki",
    validate(input) {
      const issues = [];
      const value = { ...DEFAULTS };
      if (input !== undefined && input !== null) {
        if (typeof input !== "object" || Array.isArray(input)) {
          return { issues: [{ message: "config must be an object" }] };
        }
        for (const [key, entry] of Object.entries(input)) {
          const spec = CONFIG_SHAPE[key];
          if (spec === undefined) {
            issues.push({ message: `unknown config key "${key}" (allowed: ${Object.keys(CONFIG_SHAPE).join(", ")})`, path: [key] });
            continue;
          }
          if (spec.type === "string") {
            if (typeof entry !== "string" || entry.length === 0) issues.push({ message: `${key} must be a non-empty string`, path: [key] });
            else value[key] = entry;
          } else if (spec.type === "integer") {
            if (!Number.isInteger(entry) || entry <= 0) issues.push({ message: `${key} must be a positive integer`, path: [key] });
            else value[key] = entry;
          }
        }
      }
      if (issues.length > 0) return { issues };
      return { value };
    },
  },
};

export const inject = ["tools"];

const BOOK_PARAM = {
  type: "string",
  description: "Optional ZIM book: exact name (e.g. wikipedia_zh_all_maxi_2026-08), alias (zh, en, medicine), a series name without the date, or a title substring. Defaults to the configured book (Chinese Wikipedia). An explicit name is never substituted; only the configured default falls back to the newest dump of the same series (the result then carries a `note`).",
};

function searchTool(client) {
  return {
    name: "wiki_search",
    description:
      "Search the offline Wikipedia mirror (local Kiwix ZIM database, no internet needed). "
      + "mode=fulltext returns ranked articles with snippet excerpts and result totals; mode=title returns exact/prefix article titles (use it to pin the exact title before wiki_read). "
      + "Chain: wiki_search -> take title/path -> wiki_read for the full article.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords (Chinese or English), e.g. 万里 or Qin Shi Huang." },
        mode: { type: "string", enum: ["fulltext", "title"], description: "fulltext (default): ranked search with snippets. title: exact/prefix title suggestions." },
        book: BOOK_PARAM,
        limit: { type: "integer", description: "Maximum results, 1-50. Default 10." },
        offset: { type: "integer", description: "Result offset for paging fulltext results. Default 0." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          book: { type: "string" },
          total: { type: "integer", description: "Total matching articles (fulltext; capped at 2000 by the server)." },
          mode: { type: "string", enum: ["fulltext", "title"] },
          note: { type: "string", description: "Present when the configured defaultBook was missing and the newest dump of the same series answered instead (ZIM refresh)." },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                path: { type: "string", description: "Article path — pass to wiki_read as `title`." },
                snippet: { type: "string" },
                wordCount: { type: "integer" },
              },
              additionalProperties: true,
            },
          },
        },
        required: ["book", "items"],
        additionalProperties: true,
      },
      render(_args, value) {
        return [{ type: "text", text: JSON.stringify(value, null, 2) }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(args) {
      const query = String(args?.query ?? "").trim();
      if (!query) throw new Error("wiki_search: `query` must be a non-empty string");
      const mode = args?.mode === "title" ? "title" : "fulltext";
      const limit = clampInt(args?.limit, 1, 50, 10);
      const offset = clampInt(args?.offset, 0, 1990, 0);
      if (mode === "title") {
        const { book, titles } = await client.suggest(args?.book, query, limit);
        return {
          book: book.name,
          mode,
          total: titles.length,
          items: titles.map((entry) => ({ title: entry.title, path: entry.path })),
          ...(book.note ? { note: book.note } : {}),
        };
      }
      const { book, total, items } = await client.search(args?.book, query, limit, offset);
      return {
        book: book.name,
        mode,
        total,
        items: items.map((item) => ({
          title: item.title,
          path: item.path,
          snippet: item.snippet,
          ...(item.wordCount !== undefined ? { wordCount: item.wordCount } : {}),
        })),
        ...(book.note ? { note: book.note } : {}),
      };
    },
    presentCall(args) {
      return { card: "generic", title: `wiki_search: ${String(args?.query ?? "")}`, kind: "fetch" };
    },
    presentResult(_args, result) {
      if (result.isError) return undefined;
      const value = result.value;
      const count = Array.isArray(value?.items) ? value.items.length : 0;
      return { card: "generic", title: `wiki_search — ${count} result(s)${value?.total !== undefined ? ` of ${value.total}` : ""} in ${value?.book ?? ""}` };
    },
  };
}

function readTool(client) {
  return {
    name: "wiki_read",
    description:
      "Read a full Wikipedia article from the offline Kiwix ZIM database (no internet needed). "
      + "Pass the exact article `title` (or the `path` returned by wiki_search). Returns clean plain text with the lead paragraph first and section headings; infobox/succession tables are appended at the end under '## 信息框'. Long articles are truncated at maxChars (default from plugin config). "
      + "If the title is not found, the error lists close titles or related articles instead of fetching a wrong article.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Exact article title or search-result path, e.g. 中华人民共和国." },
        book: BOOK_PARAM,
        maxChars: { type: "integer", description: "Optional cap for the returned text (characters). Overrides the configured default." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          book: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          text: { type: "string" },
          totalChars: { type: "integer" },
          truncated: { type: "boolean" },
          note: { type: "string", description: "Present when the configured defaultBook was missing and the newest dump of the same series answered instead (ZIM refresh)." },
        },
        required: ["book", "title", "text"],
        additionalProperties: true,
      },
      render(_args, value) {
        const header = `# ${value.title}\n(book: ${value.book}${value.truncated ? `, truncated at ${value.text?.length ?? 0}/${value.totalChars} chars` : ""})`
          + `${value.note ? `\n(note: ${value.note})` : ""}\n\n`;
        return [{ type: "text", text: header + String(value.text ?? "") }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 45000,
    async execute(args) {
      const title = String(args?.title ?? "").trim();
      if (!title) throw new Error("wiki_read: `title` must be a non-empty string");
      const maxChars = args?.maxChars !== undefined ? clampInt(args.maxChars, 500, 200000, DEFAULTS.maxTextChars) : undefined;
      return client.read(args?.book, title, maxChars);
    },
    presentCall(args) {
      return { card: "generic", title: `wiki_read: ${String(args?.title ?? "")}`, kind: "fetch" };
    },
    presentResult(_args, result) {
      if (result.isError) return undefined;
      const value = result.value;
      return { card: "generic", title: `wiki_read — ${value?.title ?? ""} (${value?.totalChars ?? 0} chars)` };
    },
  };
}

function booksTool(client) {
  return {
    name: "wiki_books",
    description:
      "List the ZIM books available in the local offline Kiwix library (names, titles, languages, article counts). "
      + "Use this to pick the `book` parameter for wiki_search/wiki_read. Optionally filter by language code or a title/name keyword.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", description: "Filter by language code, e.g. zh, en, mul." },
        query: { type: "string", description: "Filter by case-insensitive substring of book title or name." },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          count: { type: "integer" },
          books: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "ZIM name to pass as `book`." },
                title: { type: "string" },
                language: { type: "string" },
                articleCount: { type: "integer" },
                ftindex: { type: "boolean", description: "Full-text index available." },
              },
              additionalProperties: true,
            },
          },
        },
        required: ["count", "books"],
        additionalProperties: true,
      },
      render(_args, value) {
        const lines = (value.books ?? []).map((book) =>
          `${book.name} — ${book.title} [${book.language}] ${book.articleCount.toLocaleString()} articles${book.ftindex ? " (full-text)" : ""}`);
        return [{ type: "text", text: `${value.count} book(s):\n${lines.join("\n")}` }];
      },
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30000,
    async execute(args) {
      const books = await client.catalog();
      let filtered = books;
      if (args?.language) {
        const language = String(args.language).toLowerCase();
        filtered = filtered.filter((book) => book.language.toLowerCase().includes(language));
      }
      if (args?.query) {
        const query = String(args.query).toLowerCase();
        filtered = filtered.filter((book) => book.title.toLowerCase().includes(query) || book.name.toLowerCase().includes(query));
      }
      return {
        count: filtered.length,
        books: filtered.map((book) => ({
          name: book.name, title: book.title, language: book.language,
          articleCount: book.articleCount, ftindex: book.ftindex,
        })),
      };
    },
    presentCall() {
      return { card: "generic", title: "wiki_books", kind: "fetch" };
    },
    presentResult(_args, result) {
      if (result.isError) return undefined;
      return { card: "generic", title: `wiki_books — ${result.value?.count ?? 0} book(s)` };
    },
  };
}

function clampInt(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function apply(ctx, config) {
  const client = new KiwixClient(config);
  ctx.effect(() => {
    const disposers = [
      ctx.tools.register(searchTool(client)),
      ctx.tools.register(readTool(client)),
      ctx.tools.register(booksTool(client)),
    ];
    ctx.logger.info(`kiwix-wiki: offline Wikipedia tools ready (server ${client.baseUrl}, default book ${config.defaultBook})`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  });
}
