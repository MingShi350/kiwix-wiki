# 快速开始：从零到可用的离线维基查询

这份文档带你把整条链路搭起来，全程只用官方发行的软件：

```
DSH（模型调用 wiki_search / wiki_read / wiki_books）
  │  HTTP（默认 http://127.0.0.1:8090）
  ▼
kiwix-serve（本插件不随附，用官方 Docker 镜像或官方二进制）
  │  读
  ▼
ZIM 数据文件（维基百科等离线快照，自行从官方库下载）
```

本插件本身只是一个查询客户端：**它不含任何维基数据，也不做网络抓取**。数据和 HTTP 服务都由
[Kiwix](https://kiwix.org) 官方组件提供，本项目与 Wikimedia Foundation、Kiwix/openZIM 均无隶属关系。

目录：

1. [前置条件](#1-前置条件)
2. [起 kiwix-serve 服务（官方镜像）](#2-起-kiwix-serve-服务官方镜像)
3. [下载 ZIM 数据](#3-下载-zim-数据)
4. [把插件装进 DSH](#4-把插件装进-dsh)
5. [配置：baseUrl 与默认书库（随时可改）](#5-配置baseurl-与默认书库随时可改)
6. [验证闭环](#6-验证闭环)
7. [排错](#7-排错)
8. [安全提示](#8-安全提示)
9. [卸载](#9-卸载)
10. [许可与致谢](#10-许可与致谢)

---

## 1. 前置条件

- **Docker**（本机或局域网内任意一台机器）。官方镜像支持 `linux/amd64`、`linux/arm64`、
  `linux/arm/v7`、`linux/arm/v6`、`linux/386`——树莓派、NAS、Apple Silicon 都有对应架构。
  不想用 Docker 也可以直接用官方 kiwix-tools 二进制，见 [2.4](#24-备选方案)。
- **磁盘**：`~/kiwix-zim` 存放 ZIM，按需留空间。中文维基 2026-08 快照的实际大小：

  | 版本 | 内容 | 体积 |
  | --- | --- | --- |
  | `wikipedia_zh_all_maxi_2026-08` | 全文 + 全部图片 | 约 25 GB |
  | `wikipedia_zh_all_nopic_2026-07` | 全文，无图片 | 约 14 GB |
  | `wikipedia_zh_all_mini_2026-07b` | 精简条目（导语 + 信息框） | 约 4.5 GB |

- **DSH**：插件装在某个 profile 里（下文以 `web` profile、`$DSH_HOME` 默认为 `~/.dsh` 为例）。
- **网络**：只有部署阶段需要（拉镜像、下 ZIM）；搭好之后查询完全离线。

---

## 2. 起 kiwix-serve 服务（官方镜像）

### 2.1 准备 ZIM 目录

```bash
mkdir -p "$HOME/kiwix-zim"
```

ZIM 文件必须能被容器里的 **uid 1001** 读到（镜像用非 root 用户运行）：放进去之后 `chmod 644 *.zim`。
被这个坑住时的症状很隐蔽——该书直接从书库列表里消失，其他书照常显示（详见 3.3 的说明）。
收录方式也分两种：目录模式自动收录，**库文件模式**（`--library`）必须用 `kiwix-manage add` 登记，同样见 3.3。

### 2.2 拉镜像

```bash
docker pull ghcr.io/kiwix/kiwix-serve:3.8.2
```

- 这是**官方镜像**：由官方仓库 [kiwix/kiwix-tools](https://github.com/kiwix/kiwix-tools) 的
  GitHub Actions 工作流 `.github/workflows/docker.yml` 构建并推送到 GHCR，同一个工作流也发布
  `ghcr.io/kiwix/kiwix-tools`。官方 README 的 Docker 一节原文：
  "An official Docker image of the Kiwix tools can be found on GHCR. A `kiwix-serve` dedicated Docker image exists too."
- **建议固定版本**（如 `3.8.2`）而不用 `latest`；可用版本见
  [ghcr.io/kiwix/kiwix-serve](https://ghcr.io/kiwix/kiwix-serve)。

### 2.3 启动

```bash
docker run -d --name kiwix-serve --restart unless-stopped \
  -p 127.0.0.1:8090:8080 \
  -v "$HOME/kiwix-zim:/data:ro" \
  ghcr.io/kiwix/kiwix-serve:3.8.2 \
  /data
```

逐项说明（都来自上面那个官方 Dockerfile 和它的 `start.sh`）：

| 参数 | 含义 |
| --- | --- |
| `-p 127.0.0.1:8090:8080` | 容器内默认端口 **8080**（镜像 `EXPOSE 8080`，入口脚本里 `PORT` 环境变量可改）；这里把它映射到宿主机的 8090，并**只绑回环地址** |
| `-v "$HOME/kiwix-zim:/data:ro"` | 镜像把 `/data` 声明为数据卷、并设为工作目录；只读挂载足够（插件只读） |
| `/data` | 传给 `kiwix-serve` 的**位置参数**：给目录 = 服务该目录下所有 ZIM；也可以写单个 ZIM 文件名，或传多个路径 |
| 容器用户 | 镜像以非 root 用户（uid/gid 1001）运行 |

> 想知道内部到底执行了什么：镜像入口是 `dumb-init -- /usr/local/bin/start.sh`，脚本最后是
> `kiwix-serve --port=$PORT $@`，失败时会打印 `/data` 的文件清单——所以 `docker logs kiwix-serve` 很有用。

同一个官方镜像还支持用环境变量 `DOWNLOAD=<ZIM 直链>` 在首次启动时自动下载 ZIM。它需要 `/data` 可写，
而容器是 uid 1001：要么 `sudo chown 1001:1001 "$HOME/kiwix-zim"` 并去掉 `:ro`，要么就别用它、自己拷文件进去
（更省事也更安全）。

### 2.4 备选方案

- **docker compose**：直接用仓库里的 [`examples/docker-compose.yml`](../examples/docker-compose.yml)：
  ```bash
  KIWIX_ZIM_DIR=$HOME/kiwix-zim docker compose -f examples/docker-compose.yml up -d
  ```
- **不用 Docker**：从 <https://download.kiwix.org/release/kiwix-tools/> 下载对应平台的
  `kiwix-tools_<os>-<arch>-<version>.tar.gz`（Linux/macOS/Windows 都有），解包后：
  ```bash
  kiwix-serve --port=8090 "$HOME/kiwix-zim"
  ```
- **官方工具镜像**：`ghcr.io/kiwix/kiwix-tools` 同一个镜像里除 `kiwix-serve` 外还有
  `zimdump`、`zimcheck`、`zimsearch`。排查"ZIM 是否损坏""某条目在不在里面"时很好用：
  ```bash
  docker run --rm -v "$HOME/kiwix-zim:/data:ro" ghcr.io/kiwix/kiwix-tools:3.8.2 zimcheck /data/xxx.zim
  ```

### 2.5 验证服务

```bash
curl -s "http://127.0.0.1:8090/catalog/v2/entries?count=-1" | head -20
```

能返回 Atom/OPDS 书目 XML 即服务正常（插件读的就是这个端点）。也可以直接用浏览器打开
<http://127.0.0.1:8090/#lang=zho> 看 Kiwix 自带的检索界面。

---

## 3. 下载 ZIM 数据

### 3.1 官方来源

- **图形化选库**：<https://library.kiwix.org>（背后就是 OPDS 目录
  `https://opds.library.kiwix.org/catalog/v2/entries`，和本地服务同构）。
- **直接列目录下载**：<https://download.kiwix.org/zim/>
  - 维基百科（含中文各版本）：<https://download.kiwix.org/zim/wikipedia/>
    （会 302 到 `lb.download.kiwix.org`，用 `curl -L` 或浏览器下载都行）
  - TED 演讲：<https://download.kiwix.org/zim/ted/>
- **torrent**：同一目录下同时提供 `.torrent`，几十 GB 的文件用它更稳、可续传。
- 文件名本身就是"ZIM 名"，例如：

  ```
  wikipedia_zh_all_maxi_2026-08.zim      →  ZIM 名 wikipedia_zh_all_maxi_2026-08
  wikipedia_zh_all_nopic_2026-07.zim     →  ZIM 名 wikipedia_zh_all_nopic_2026-07
  wikipedia_zh_all_mini_2026-07b.zim     →  ZIM 名 wikipedia_zh_all_mini_2026-07b
  ```

### 3.2 怎么选版本

- 只是想跑通链路、机器也不大 → 先下 `mini`（约 4.5 GB）。
- 要正常读正文、不缺章节标题 → `nopic`（约 14 GB），无图但全文都在。
- 要图片、要最全 → `maxi`（约 25 GB）。

### 3.3 放进服务目录并确认被识别

```bash
mv <下载的文件>.zim "$HOME/kiwix-zim/"
chmod 644 "$HOME/kiwix-zim/"*.zim   # ← 必做：容器内是 uid 1001，ZIM 必须"其他人可读"
docker restart kiwix-serve     # 让 kiwix-serve 重新扫描目录
curl -s "http://127.0.0.1:8090/catalog/v2/entries?count=-1" | grep -oE '<name>[^<]+' | head
```

> **两种收录方式，别搞混**：本教程第 2 节给的是**目录模式**（`kiwix-serve /data`），
> 放进目录 + 重启就会被自动收录。如果你用的是**库文件模式**（`--library /data/kiwix-library.xml`，
> project-nomad 之类的面板就是这么起的），kiwix-serve **只服务 XML 里登记过的 ZIM**，
> 往目录里拷文件是**不会**被收录的（旧条目还指向已删除的旧文件时，那本书会整本消失）：
>
> ```bash
> # 加新 ZIM / 删旧条目（ZIMID 用 `show` 查，或看 XML 里的 id="..."）
> docker exec nomad_kiwix_server kiwix-manage /data/kiwix-library.xml add /data/<新文件>.zim
> docker exec nomad_kiwix_server kiwix-manage /data/kiwix-library.xml show | grep -i zh
> docker exec nomad_kiwix_server kiwix-manage /data/kiwix-library.xml remove <旧 ZIMID>
> ```
>
> 起服务时带了 `--monitorLibrary` 的话，改完 XML 会自动生效，不用重启容器。

> **权限是最常见的坑之二**：`kiwix-serve` 专用镜像以 **uid/gid 1001** 运行（官方 `docker/server/Dockerfile` 里的 `USER user`）。
> 若 ZIM 是 `-rwx-----x`（711）或 `-rw-------`（600）且属主为 root，容器**读不到**它，
> 结果这本书同样会**从 catalog 里彻底消失**（不报错、只是不见）。
> `chmod 644` 即可；同目录里其他正常显示的书都应该是 `-rw-r--r--`。

看到新 ZIM 的名字就成功了。**记住这个名字**（去掉 `.zim`），下一步要填进插件配置。
若同名系列已有旧版本，直接留着旧文件也可以：插件按名字里的日期自动选最新的那一份。

> 旧版本 ZIM 建议删掉或挪出服务目录（同一个系列同时挂多份只会白占磁盘）；只留最新版时，
> 插件用别名（`zh`）或系列名就能一直跟住最新版，不用改配置。

---

## 4. 把插件装进 DSH

假设本仓库位于 `/path/to/kiwix-wiki`。

**方式 A（推荐）：走 DSH 的 pnpm 通道**

```bash
dsh plugin --profile web add /path/to/kiwix-wiki
```

**方式 B：手写进 profile 的 `package.json`**

在 `$DSH_HOME/profiles/web/package.json` 的 `dependencies` 里加一行（`link:` 指本地目录）：

```json
"dsh-kiwix-wiki": "link:/path/to/kiwix-wiki"
```

然后在同目录执行 `pnpm install`（或让 DSH 启动时自行安装）。

插件自带 `cordis.patch.yml`，会在 profile 里插入一条 `id: kiwix-wiki` 的条目，
所以**不需要**手工往 profile patch 里写 insert。

**改完必须重启 DSH**：

```bash
dsh web
```

Host 插件是被常驻加载的 JS 模块——只改文件不重启，工具行为不会变（这一点很容易踩坑：
"代码明明改了却没生效"基本都是忘了重启）。

装好后让模型调用 `wiki_books`，应该能列出你放进 `~/kiwix-zim` 的 ZIM。

---

## 5. 配置：baseUrl 与默认书库（随时可改）

### 5.1 默认值

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8090` | kiwix-serve 地址。指向本机；要连局域网/远端就改这里 |
| `defaultBook` | `zh` | 工具调用省略 `book` 时用哪本 ZIM。可填 ZIM 文件名去掉 `.zim`、别名（`zh`/`en`/`medicine`/`simple`）或去掉日期的系列名 |
| `timeoutMs` | `15000` | 单个 HTTP 请求超时（毫秒） |
| `maxTextChars` | `24000` | `wiki_read` 默认截断长度，工具参数 `maxChars` 可覆盖 |
| `catalogTtlMs` | `60000` | 书库目录的缓存时长（毫秒）。调小（如 `5000`）能更快看到刚加进服务目录的 ZIM |

> **推荐把 `defaultBook` 写成 `zh`**（或去掉日期的系列名 `wikipedia_zh_all_maxi`）：两者都会自动选该系列
> **最新**的那一份 dump，ZIM 换版（2026-08 → 2026-09）后无需改配置。
>
> 若确实填了带日期的精确名，而服务器上只剩新版，插件会**回退到同系列最新 dump**，并在结果里带一条
> `note`（例如 `configured defaultBook "wikipedia_zh_all_maxi_2025-09" is not in the library; answered from
> the newest "wikipedia_zh_all_maxi" dump (wikipedia_zh_all_maxi_2026-08)`）。回退不会跨 flavour：
> `_maxi` 不会掉到 `_nopic`。
>
> 模型显式传入的 `book` 参数**永不**替换：找不到就报 `unknown book "...". Available books: ...` 并列出可用书目。
> 刚放进服务目录的新 ZIM 最长需要 `catalogTtlMs` 才出现在目录里；任何一次"找不到书"的调用都会强制刷新一次目录。

### 5.2 改法一：profile patch（推荐，一直可用）

编辑 `$DSH_HOME/profiles/web/cordis.patch.yml`（默认 `~/.dsh/profiles/web/cordis.patch.yml`），
为 `kiwix-wiki` 条目加上 `config`：

```yaml
- id: kiwix-wiki
  config:
    baseUrl: http://192.168.31.12:8090      # 例：kiwix-serve 跑在局域网另一台机器上
    defaultBook: zh                         # 别名自动跟随最新版；也可写精确文件名
    timeoutMs: 15000
    maxTextChars: 24000
    catalogTtlMs: 60000
```

要点：

- profile patch 是**最后一层**，优先级高于插件自带的 `cordis.patch.yml`，所以在这里改一定会生效。
- 建议把五个键写全：这一层是**整体替换**该条目的 `config`。
- 保存后重启 `dsh web` 生效。（Web 界面里若提示"被更高优先级的配置覆盖"，说明还有一层更靠后的 patch 在起作用。）

### 5.3 改法二：不动 profile 文件，用 `--patch` 叠加

适合"临时换一台服务器试试"，或不想碰 profile 的情况：

```bash
dsh web --patch /path/to/kiwix-wiki/examples/kiwix-wiki.patch.yml
```

示例文件见 [`examples/kiwix-wiki.patch.yml`](../examples/kiwix-wiki.patch.yml)，改完重启即可。
想先确认 patch 有没有被正确组合：

```bash
dsh --profile web --patch ./kiwix-wiki.patch.yml --dump-config
```

（`--dump-config` 会写出组合后的配置树并退出，不会启动服务。）

### 5.4 改法三：改插件自带的默认值

编辑本仓库 `cordis.patch.yml` 里的 `config:`。这只对**没有**在 profile 层覆盖过的部署生效，
且要重启；好处是把默认值随插件一起带着走（比如团队内部统一指向某台内网服务器）。

### 5.5 怎么确认改了没生效

- 启动日志里有这一行，直接打印了当前生效值：
  `kiwix-wiki: offline Wikipedia tools ready (server <baseUrl>, default book <book>)`
- 或者让模型调一次 `wiki_books`，看是否连得上。
- 地址不对时的报错会明确告诉你去改哪个键：
  `cannot reach the Kiwix server at http://127.0.0.1:8090 (ECONNREFUSED) while fetching ...（见 docs/quickstart.md 的"配置"）`

---

## 6. 验证闭环

依次让模型调用三个工具：

1. `wiki_books` → 列出 ZIM（名称 / 语言 / 文章数 / 是否有全文索引）。
2. `wiki_search`，`query=秦始皇` → 返回总数与条目（标题、path、摘要片段）。
3. `wiki_read`，`title=秦始皇`，`maxChars=800` → 正文；**导语在最前面**，信息框/继任表统一挪到文末
   的 `## 信息框` 一节，页脚样板文字（zim-footer）已被剥离。

中文、英文都值得试一次，例如 `wiki_search query=Qin Shi Huang` 用在 `wikipedia_en_all_maxi_*` 上。

---

## 7. 排错

| 现象 | 原因与处理 |
| --- | --- |
| `cannot reach the Kiwix server at http://127.0.0.1:8090 (ECONNREFUSED)` | 服务没起或端口不对。`docker ps` 看容器在不在、`docker logs kiwix-serve` 看日志、`curl http://127.0.0.1:8090/catalog/v2/entries?count=1` 手工验证；确认后改 `baseUrl` |
| `(ENOTFOUND)` / `(EHOSTUNREACH)` | `baseUrl` 里的主机名/IP 不对，或防火墙拦了；局域网场景检查绑定地址（见第 8 节） |
| `unknown book "...". Available books: ...` | `defaultBook` 或 `book` 参数与 ZIM 文件名不一致，抄报错里的可用名字；或把 `defaultBook` 换成别名 `zh` 一劳永逸 |
| 换了新版 ZIM 后报 `unknown book` | 配置里写的是带日期的旧名。改用 `zh`/系列名，或让插件自动回退（结果会带 `note`，见 5.1） |
| 刚放进目录的 ZIM 没出现在 `wiki_books` 里 | 目录缓存未过期（默认 60 s，见 `catalogTtlMs`）；`docker restart kiwix-serve` 后重试，或调小 `catalogTtlMs` |
| 换上新 ZIM 后这本书**整个从书库里消失**（其他书正常）① | **库文件模式**（启动参数带 `--library …xml`）：XML 里还是旧文件名，目录里放文件不会被收录。用 `kiwix-manage … show` 查、`add` 新的、`remove` 旧的（见 3.3） |
| 换上新 ZIM 后这本书**整个从书库里消失**（其他书正常）② | **权限**：文件是 `-rwx-----x`/`-rw-------` 且属主 root，容器 uid 1001 读不到。`docker exec kiwix-serve ls -l /data` 对照其他能显示的书，然后 `chmod 644 *.zim` + `docker restart kiwix-serve` |
| 换上新 ZIM 后仍显示**旧版本**内容 | 最可能是服务端句柄常驻：旧 ZIM 已被删除但进程没重启，仍在用内存里的句柄。`docker restart` 后即按新文件服务 |
| `catalog returned no books` | 挂载目录里没有 ZIM，或启动参数没指到它。`docker exec kiwix-serve ls -l /data` 确认；注意容器用户 uid 1001 需要能读这些文件 |
| `article "…" not found in book "…": HTTP 404 …` | 标题不精确：先用 `wiki_search` 的 `mode=title` 找到确切标题再 `wiki_read`。带命名空间的标题（如 `Wikipedia:关于`）不受支持，报错里会给出相近标题 |
| `request timed out after 15000 ms` | 服务忙/磁盘慢/首次载入大 ZIM；调大 `timeoutMs` |
| 搜索结果总是空 | 看 `wiki_books` 里该书的"是否有全文索引"；没有全文索引就只能用 `mode=title` 做标题检索 |
| 改了配置但行为没变 | 忘了重启 `dsh web`；或该条目被更高优先级的 patch 覆盖（见 5.2 末） |

---

## 8. 安全提示

- kiwix-serve **没有认证、没有 HTTPS**，并且响应头带 `Access-Control-Allow-Origin: *`。
  默认写法只用 `-p 127.0.0.1:8090:8080`，只对本机开放，就是出于这个原因。
- 要给局域网其他机器共用，建议显式绑内网网卡而不是全网卡，例如 `-p 192.168.31.12:8090:8080`，
  并确认路由器上没有把该端口转发到公网。真要长期对外提供，请在前面加一层带认证的反向代理。
- 查询内容会出现在 kiwix-serve 的访问日志里；插件侧不做任何遥测，也不访问外网。
- ZIM 是只读数据，容器用只读挂载（`:ro`）即可；用 `DOWNLOAD` 自动下载时才需要可写。

---

## 9. 卸载

```bash
dsh plugin --profile web remove dsh-kiwix-wiki   # 或删掉 profile package.json 里的那一行
docker rm -f kiwix-serve
rm -rf "$HOME/kiwix-zim"                            # 确认不再需要这些 ZIM 再删
```

---

## 10. 许可与致谢

- **本插件代码**：MIT，见 [`LICENSE`](../LICENSE)。
- **ZIM 内容**：版权归各内容方。维基百科文本通常为 CC BY-SA 4.0，TED 演讲为 CC BY-NC-ND 4.0；
  以每个 ZIM 自身的元数据/随附说明为准。**本仓库不随附、也不重新分发任何 ZIM**——数据由使用者
  自行从官方库下载，因此这些内容许可不会传染到本项目的代码。
- **kiwix-serve / kiwix-tools**：GPL-3.0（见官方仓库的 `COPYING`）。本插件只在运行时通过 HTTP 与它
  通信，既不链接其代码、也不分发其二进制，因此不受 GPL 传染；你如何部署它由你自己决定。
- 本项目与 Wikimedia Foundation、Kiwix/openZIM 无隶属关系、未获其背书；名称仅用于说明用途。
  文档中的镜像与下载链接均指向官方发布。
