**中文** | [English](README.en.md)

# kiwix-wiki — 离线维基百科数据库查询插件

给 DSH 里的模型 / Agent 加一条**完全离线的百科查询通道**：`wiki_search` / `wiki_read` / `wiki_books`
三个工具向你自己的 **kiwix-serve**（官方 `ghcr.io/kiwix/kiwix-serve`）查询预先下载好的 **ZIM** 数据包，
返回**真实存在**的条目正文、搜索命中与书目信息。

## 它是什么

- **不是网页搜索**：不碰搜索引擎、不抓网页、不需要 API key、不产生任何外网流量。所有请求只发往
  你配置的 `baseUrl`（默认本机 `http://127.0.0.1:8090`），数据来自已经落盘的 ZIM 快照。
- **不是实时资讯**：内容是**快照**，截止到该 ZIM 的 dump 日期（例如 `2026-08` 的中文维基 354 万条）。
  新近事件查不到；要更新就换新版 ZIM，插件会自动跟到最新一份 dump，不用改配置。

**什么时候用**：内网 / 隔离环境 / 弱网或没有外网出口；给本地小模型补事实能力；
需要可复现、可验证的答案（返回的是 ZIM 里的原文，不受搜索结果排序漂移影响）；
不希望检索内容出网。有网时它是 `web_search` / `web_fetch` 的**补充**，而不是替代。

> **从零开始？** 看 [docs/quickstart.md](docs/quickstart.md)：用官方 Docker 镜像起 `kiwix-serve`、
> 下载 ZIM、装插件、**怎么改 `baseUrl`**（默认 `http://127.0.0.1:8090`）、排错与安全提示。

## 注册的模型工具

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `wiki_search` | 全文搜索（带摘要片段与总数）或精确标题检索（`mode=title`） | `query`, `mode`, `book`, `limit`, `offset` |
| `wiki_read` | 按精确标题读取整篇文章（纯文本，自动截断） | `title`, `book`, `maxChars` |
| `wiki_books` | 列出本地 ZIM 书库（名称/语言/文章数/是否有全文索引） | `language`, `query` |

默认书库：中文维基百科（内置默认值是别名 `zh`，自动跟随最新版 ZIM；也可改成本地某本的精确文件名）。
`book` 支持精确 ZIM 名、别名（`zh` / `en` / `medicine` / `simple`）、去掉日期的系列名，或书名子串。

## 前置条件与安装

本插件**不含数据**，需要自己准备两样东西：

1. `kiwix-serve` HTTP 服务 —— 官方镜像 `ghcr.io/kiwix/kiwix-serve`（或官方 kiwix-tools 二进制）；
2. ZIM 数据文件 —— 从官方库 <https://download.kiwix.org/zim/> 或 <https://library.kiwix.org> 下载，
   放进 kiwix-serve 的服务目录。

装进 DSH（本仓库位于 `/path/to/kiwix-wiki`）：

```bash
dsh plugin --profile web add /path/to/kiwix-wiki
# 或手工在 profile 的 package.json 里加一行："@local/kiwix-wiki": "link:/path/to/kiwix-wiki"
dsh web        # Host 插件改完必须重启才生效
```

完整步骤（Docker 部署、ZIM 选型、配置改法、排错表）见 **[docs/quickstart.md](docs/quickstart.md)**。

## 配置（`Config`，均可省略取默认值）

```yaml
config:
  baseUrl: http://127.0.0.1:8090   # kiwix-serve 地址，随时可改
  defaultBook: zh                  # 建议填别名（zh/en/medicine/simple），自动跟随最新版 ZIM
  timeoutMs: 15000
  maxTextChars: 24000
  catalogTtlMs: 60000              # 书库目录缓存毫秒数；调小可更快发现新加入的 ZIM
```

`baseUrl` 默认指向**本机** `http://127.0.0.1:8090`。要连局域网/远端服务器只改这一个键，二选一：

- 写进 profile patch `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（优先级最高，推荐）；
- 或用叠加文件、不动 profile：`dsh web --patch examples/kiwix-wiki.patch.yml`。

两种写法的完整示例见 [docs/quickstart.md 第 5 节](docs/quickstart.md#5-配置baseurl-与默认书库随时可改)
与 [examples/kiwix-wiki.patch.yml](examples/kiwix-wiki.patch.yml)。地址不可达时，报错会直接点名 `baseUrl`。

**ZIM 换版不用改配置**：`defaultBook` 推荐写别名（`zh`）或去掉日期的系列名（`wikipedia_zh_all_maxi`），
两者都自动选中该系列**最新**的那一份 dump。若确实填了带日期的精确名（如 `wikipedia_zh_all_maxi_2025-09`），
而服务器上只剩新版（`…_2026-08`），插件会回退到同系列最新 dump，并在结果里带一条 `note` 说明；
显式传给工具的 `book` 参数**永不**替换，找不到就报错并列出可用书库。

零依赖：仅使用 Node 内置 `node:http` / `node:https`，无 npm 依赖、无构建步骤
（刻意不用 global `fetch`，原因见 `lib/kiwix.js` 头部注释）。

## 测试

```bash
npm test                   # 离线单元测试 + 集成测试（Kiwix 服务器不可达时集成测试自动跳过）
```

集成测试默认连 `http://127.0.0.1:8090`，可用环境变量 `KIWIX_TEST_URL` 指向别的服务器。

## 部署素材

- [examples/docker-compose.yml](examples/docker-compose.yml) — 官方镜像 + 本地 ZIM 目录，一条命令起服务。
- [examples/kiwix-wiki.patch.yml](examples/kiwix-wiki.patch.yml) — 插件配置叠加层示例（配合 `dsh web --patch`）。

## 许可

本插件代码：MIT，见 [LICENSE](LICENSE)。ZIM 数据不在本仓库内，版权归各内容来源方
（详见 [docs/quickstart.md 第 10 节](docs/quickstart.md#10-许可与致谢)）；
本项目与 Wikimedia Foundation、Kiwix/openZIM 无隶属关系。
