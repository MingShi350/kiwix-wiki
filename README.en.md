**English** | [中文](README.md)

# kiwix-wiki — offline Wikipedia database query plugin

Adds a **fully offline encyclopedia lookup channel** to models / agents inside DSH: the `wiki_search` /
`wiki_read` / `wiki_books` tools query your own **kiwix-serve** (the official
`ghcr.io/kiwix/kiwix-serve` image) for pre-downloaded **ZIM** archives, and return article text, search
hits and catalog facts that **really exist**.

## What it is

- **Not a web search**: no search engines, no page scraping, no API key, no outbound traffic. Every
  request goes only to the `baseUrl` you configure (default `http://127.0.0.1:8090`), and the data comes
  from a ZIM snapshot already on disk.
- **Not real-time information**: the content is a **snapshot**, frozen at that ZIM's dump date (for
  example the `2026-08` Chinese Wikipedia with 3.54 million articles). Recent events are not in it; to
  update, drop in a newer ZIM — the plugin follows the newest dump by itself, with no config change.

**When to use it**: intranets / air-gapped environments / weak or missing outbound connectivity; giving a
small local model some factual grounding; answers that must be reproducible and verifiable (what comes
back is the original ZIM text, unaffected by search-ranking drift); or when your lookups should not leave
the network. When you do have internet, it is a **complement** to `web_search` / `web_fetch`, not a
replacement for them.

> **Starting from zero?** See [docs/quickstart.md](docs/quickstart.md): run `kiwix-serve` from the official
> Docker image, download a ZIM, install the plugin, **how to change `baseUrl`** (default
> `http://127.0.0.1:8090`), troubleshooting and security notes.

## Registered model tools

| Tool | What it does | Key parameters |
| --- | --- | --- |
| `wiki_search` | Full-text search (with snippet and total count) or exact title lookup (`mode=title`) | `query`, `mode`, `book`, `limit`, `offset` |
| `wiki_read` | Read a whole article by exact title (plain text, truncated automatically) | `title`, `book`, `maxChars` |
| `wiki_books` | List the local ZIM library (name / language / article count / full-text index yes-no) | `language`, `query` |

Default library: Chinese Wikipedia (the built-in default is the alias `zh`, which follows the newest ZIM
automatically; you can also pin the exact filename of a local book).
`book` accepts an exact ZIM name, an alias (`zh` / `en` / `medicine` / `simple`), a series name with the
date stripped, or a substring of the book name.

## Requirements and installation

This plugin **contains no data**; you provide two things yourself:

1. a `kiwix-serve` HTTP service — the official image `ghcr.io/kiwix/kiwix-serve` (or the official
   kiwix-tools binaries);
2. ZIM data files — download them from the official library <https://download.kiwix.org/zim/> or
   <https://library.kiwix.org>, and put them in kiwix-serve's serving directory.

Install into DSH (this repository lives at `/path/to/kiwix-wiki`):

```bash
dsh plugin --profile web add /path/to/kiwix-wiki
# or add one line by hand in the profile's package.json: "dsh-kiwix-wiki": "link:/path/to/kiwix-wiki"
dsh web        # Host plugins only take effect after a restart
```

Full steps (Docker deployment, choosing a ZIM, how to configure, troubleshooting table) are in
**[docs/quickstart.md](docs/quickstart.md)**.

## Configuration (`Config`, every key optional, defaults shown)

```yaml
config:
  baseUrl: http://127.0.0.1:8090   # kiwix-serve address, changeable at any time
  defaultBook: zh                  # prefer an alias (zh/en/medicine/simple); follows the newest ZIM
  timeoutMs: 15000
  maxTextChars: 24000
  catalogTtlMs: 60000              # catalog cache in ms; lower it to notice newly added ZIMs sooner
```

`baseUrl` defaults to **localhost** `http://127.0.0.1:8090`. To talk to a LAN / remote server, change this
one key — pick one of two ways:

- write it into the profile patch `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (highest precedence,
  recommended);
- or use an overlay file without touching the profile: `dsh web --patch examples/kiwix-wiki.patch.yml`.

Complete examples of both are in
[docs/quickstart.md section 5](docs/quickstart.md#5-配置baseurl-与默认书库随时可改) and
[examples/kiwix-wiki.patch.yml](examples/kiwix-wiki.patch.yml). When the address is unreachable, the error
names the `baseUrl` outright.

**Swapping ZIMs needs no config change**: `defaultBook` is best set to an alias (`zh`) or a date-free
series name (`wikipedia_zh_all_maxi`), either of which selects the **newest** dump in that series. If you
did pin a date-stamped exact name (such as `wikipedia_zh_all_maxi_2025-09`) while the server only has the
newer one (`…_2026-08`), the plugin falls back to the newest dump of the same series and adds a `note` to
the result; a `book` passed explicitly to a tool is **never** substituted — if it cannot be found you get
an error listing the available library.

Zero dependencies: only Node's built-in `node:http` / `node:https`, no npm dependencies, no build step
(global `fetch` is deliberately avoided — the reason is in the header comment of `lib/kiwix.js`).

## Tests

```bash
npm test                   # offline unit tests + integration tests (integration tests skip themselves when the Kiwix server is unreachable)
```

Integration tests connect to `http://127.0.0.1:8090` by default; point them at another server with the
`KIWIX_TEST_URL` environment variable.

## Deployment material

- [examples/docker-compose.yml](examples/docker-compose.yml) — official image plus a local ZIM directory,
  one command to start the service.
- [examples/kiwix-wiki.patch.yml](examples/kiwix-wiki.patch.yml) — an example plugin config overlay (used
  with `dsh web --patch`).

## License

Plugin code: MIT, see [LICENSE](LICENSE). ZIM data is not part of this repository and remains the
copyright of its respective content providers (details in
[docs/quickstart.md section 10](docs/quickstart.md#10-许可与致谢)); this project is not affiliated with the
Wikimedia Foundation or Kiwix/openZIM.
