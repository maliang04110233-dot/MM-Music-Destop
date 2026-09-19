# GitHub 热门音乐项目调研（第二轮）

> 调研日期：2026-09-18 ｜ 数据来源：GitHub API + 三个调研代理直读源码/官方文档
> 上一轮（09-14）已覆盖：cobalt / spotDL / AlgerMusicPlayer / YesPlayMusic / musicdl / streamrip / listen1。本轮补齐星数榜上未调研过的头部项目。

## 一、最新热度榜（2026-09-18，star 为当日值）

| 项目 | Stars | 技术栈 | 定位 | 上轮是否调研 |
|---|---|---|---|---|
| lyswhut/lx-music-desktop | 53.7k | Electron+TS | 音源插件化音乐软件 | ❌ 本轮重点 |
| KRTirtho/spotube | 49.2k | Flutter | 无 key  Spotify 元数据 + 多源流媒体/下载 | ❌ 本轮重点 |
| pear-devs/pear-desktop | 33.5k | Electron | 多引擎聚合播放器 | 未调研（同类可参考） |
| qier222/YesPlayMusic | 33.3k | Electron+Vue | 网易云第三方播放器 | ✅ |
| maotoumao/MusicFree(+Desktop 26.9k/8.9k) | TS | 插件化播放器 | ❌ 本轮重点 |
| spotDL | 26.1k | Python | | ✅ |
| navidrome/navidrome | 23.6k | Go | 自托管流媒体服务器（Subsonic API） | ❌ |
| putyy/res-downloader | 19.8k | | | ✅ |
| nukeop/nuclear | 18.5k | Electron | 免费源聚合播放器 | ❌ |
| koel/koel | 17.3k | PHP | 自托管流媒体 | ❌ |
| algerkong/AlgerMusicPlayer | 16.8k | | | ✅ |
| beetbox/beets | 15.7k | Python | 音乐库管理 + MusicBrainz 打标 | ❌ 本轮重点 |

注意：lx-music-desktop 星数是 AlgerMusicPlayer 的 3 倍，是同类（多源、中文、Electron）最大标杆；官方重心已转向新项目 **Any Listen**（any-listen/any-listen，新增 WebDAV 同步）。

## 二、lx-music-desktop 可借鉴架构（音源沙箱 + SQLite + 同步）

1. **音源沙箱（最值得抄）**：用户 JS 脚本跑在独立隐藏 BrowserWindow，contextBridge 只暴露 `lx` 命名空间（request/on/send + aes/rsa/md5/zlib），源 key/音质/actions 白名单取交集，URL≤2048 强校验。→ MusicDL 换源层可从"硬编码 main 进程模块"演进为事件式受限插件。
2. **音源导入协议**：本地 .js 或 http(s) URL 导入；解析脚本头部注释 `@name/@version/@author`；脚本 zlib+base64 存 electron-store，内容重复拒绝导入；`updateAlert({log,updateUrl})` 让**源自报更新**（每脚本一次、可关）。→ "源失效自报+一键更新"协议可直接照搬，配合上轮的"源可用性探针"。
3. **SQLite 数据层**（better-sqlite3 跑在 worker 线程）：`my_list` / `my_list_music_info`(UNIQUE id+listId) / 独立 `order` 排序表 / `music_info_other_source` 换源映射 / `music_url`+`lyric` 缓存 / `download_list` 下载进度持久化 / `dislike_list`；DB_VERSION + migrate + verifyDB。→ MusicDL 的 history.json 升级路径的成熟范本。
4. **同步与 OpenAPI**：局域网服务端(23332)+独立 sync-server，配对码 MD5 派生 AES key + RSA 交换；OpenAPI(23330) 提供 /status /lyric /play /seek /collect + **SSE 订阅播放状态**，带 filter 裁字段。→ 远程控制功能可用"本地 HTTP + SSE"实现，比轮询省。
5. **UX 清单**：桌面歌词（独立窗口、锁定、横/竖排、逐字 font-player、透明度微调）；"稍后播放"高优队列；下载并发上限提示（过高会被源封 IP）、按列表名分子目录、同名跳过、嵌入翻译/罗马音歌词、歌词编码 GBK/UTF-8 可选；不喜欢的歌曲按三类规则自动跳歌；Scheme URL + 油猴脚本联动。
6. **合规结构**：Apache 2.0 + 补充条款——"本项目本身没有获取音频数据的能力"（全部来自用户源）、要求 24 小时清除版权数据、不接受捐赠。→ MusicDL README 免责声明结构可复用（注意：MusicDL 内置源，法律定位与纯壳软件不同，条款只能借鉴表达方式，不能照抄免责逻辑）。

## 三、MusicFree 插件体系（对"源插件化"最有价值）

1. **插件协议极简**：一个 CommonJS .js 文件，导出 `platform/version/srcUrl/primaryKey/cacheControl/userVariables/supportedSearchType` + 十余个**全可选** async 方法（search/getMediaSource/getLyric/getMusicInfo/getAlbumInfo/importMusicSheet/getTopLists/getMusicComments…）。**未实现的方法 UI 自动隐藏**——这是插件化的关键设计：能力声明驱动界面。
2. **执行方式无沙箱**：`Function(...)` 与宿主同上下文（桌面版直接跑主进程），`require` 仅白名单包（axios/cheerio/crypto-js/dayjs/qs…）；renderer 经 contextBridge 用 `call-plugin-method` IPC 代理调用，插件对象序列化成含 supportedMethod 的 delegate。→ 这套 IPC 代理模式可原样搬到 MusicDL；如需隔离再上 node:vm/isolated-vm。
3. **安装/订阅**：插件目录存 `nanoid().js`，唯一 ID=sha256(源码)，platform 同名视为同插件、semver 旧版拒装；`.json` 清单一键批量装；**订阅**=多条 {title,srcUrl}，"更新订阅"遍历拉清单。启动扫目录+懒加载（先解析方法名，用时再 mount）。→ 替换 MusicDL 硬编码源成本最低的路径：目录扫描 + manifest 订阅。
4. **统一数据模型**：`IMusicItem{platform,id,qualities:{low/standard/high/super 各带 url+size},lrc,扩展字段}`；`cacheControl` 管音源 URL 结果缓存。→ MusicDL 跨源统一结构可对齐这个形状。
5. **替代插件 + 自动换源**：A 源取不到播放 URL 时可指定 B 源兜底 `getMediaSource`；播放失败自动换源；可复制/清空的错误与 trace 日志；userVariables 面板让用户给每个插件填 Cookie/Token；WebDAV 备份；下载 webworker 支持 Range 续传/并发/音质降级。

## 四、Spotube + beets（元数据与库管理）

Spotube：
- **无 key 拿 Spotify 元数据**：`open.spotify.com/get_access_token` 换匿名 token + HMAC TOTP 鉴权，token 缓存 SQLite + 定时刷新。→ 若想补 Spotify 元数据源可用，成本中，注意合规。
- **SourcedTrack 多源抽象**：youtube/piped/invidious/jiosaavn 统一接口、按偏好选源、异常回落；`source_match` 表缓存 trackId→sourceId。→ 与 MusicDL 换源机制同构，"源解析结果落表缓存"值得抄。
- **内嵌 shelf HTTP server**：/stream/:trackId（Range 代理+缓存）+ /ws 事件总线 + mDNS 广播；仅在开远控时绑 0.0.0.0，否则 loopback；自己播放也走本机 HTTP。→ 远程控制/其他设备投音的完整方案。
- 下载同名弹窗询问覆盖、分块并发、成功后才写 metadata/封面。

beets：
- **打标置信度**：MusicBrainz Distance 加权罚分，strong_rec_thresh 高分自动接受、低分人工确认，按距离上色。→ 多源元数据冲突时可做"打分仲裁"。
- **id_extractors**：按源正则从任意分享链接抽 release/track id。→ 与上轮"粘贴链接识别"（cobalt 式）天然一对，成本低。
- **paths 规则列表**：`paths:` 是"查询条件→模板"有序列表（首个命中生效、default 兜底），`%aunique{}` 自动消歧同名专辑，legalize_path+unique_path。→ MusicDL 命名模板从单串升级为规则列表，成本低-中。
- **库 DB**：固定字段 + 柔性 KV 属性表（新增字段自动 ALTER TABLE）、migrations 表、SQLite backup API；**去重**：duplicate_keys（artist+title，建议加 mb id）+ duplicate_action skip/keep/remove/merge/upgrade/ask，路径相同不算重复。

## 五、本轮新增优先级建议

| 优先级 | 事项 | 来源范本 | 成本 |
|---|---|---|---|
| P0 | history.json → SQLite（better-sqlite3/worker），含迁移框架 DB_VERSION+migrate | lx-music-desktop / beets | 中 |
| P0 | 源解析结果落表缓存（trackId→sourceId→url 有效期），换源不再重复解析 | Spotube source_match | 低 |
| P1 | 内置源改造为"能力声明驱动"的源接口层（方法可选、UI 按 supportedMethod 隐藏），向插件化过渡 | MusicFree 协议 | 中 |
| P1 | 插件目录扫描 + manifest 订阅更新 + 源自报 updateAlert | MusicFree / lx | 中 |
| P1 | 粘贴链接→正则抽 ID→直接定位歌曲 | beets id_extractors + cobalt | 低 |
| P2 | 命名模板升级为规则列表 + %aunique 消歧 + 同名询问 | beets paths / Spotube | 低-中 |
| P2 | 本地 HTTP + SSE 远程控制（loopback 默认） | Spotube / lx OpenAPI | 中 |
| P2 | 元数据/歌词多源打分仲裁（高分自动低分确认） | beets match | 中 |
| P3 | 用户音源沙箱（隐藏窗口/contextBridge 白名单） | lx-music-desktop | 高 |
| P3 | WebDAV 备份收藏/历史 | MusicFree / lx-Any Listen | 低-中 |

## 六、结论一句话

头部项目分两类：**壳+用户源**（lx、MusicFree：合规上把"无获取能力"写进条款，架构上以插件协议+能力声明为核心）和**内置源工具**（Alger、MusicDL：靠快速修复端点续命）。MusicDL 中期最值得做的三件事：SQLite 数据层、源解析缓存表、把硬编码源重构为 MusicFree 式"全可选方法"接口——这三项都是后面插件化、远程控制、歌单同步的地基。

---

# 补录（同日第三轮）：新晋项目与剩余头部调研

> 触发：排查遗漏。新发现 2026 年立项的 omniget（13.7k）与直接竞品 go-music-dl（4.4k）；同时补查 pear-desktop / nuclear。

## 七、go-music-dl（直接竞品，Go，CLI+Web 双模式）

1. **源清单**：网易/QQ/酷狗/酷我/咪咕/千千/汽水/5sing/JOOX/B站/Apple + local（本地音乐作一等搜索源，SQLite 索引）。MusicDL 缺约 6 源。**汽水音乐最难**（单包 4437 行，AES+CENC 解密，PC 扫码依赖动态 a_bogus/msToken，作者未调通只能手填 Cookie）；咪咕/JOOX 成本较低。
2. **换源打分（最值得直接抄）**：并行搜候选源 → Levenshtein 相似度（歌名 0.7+歌手 0.3，先归一化）→ 时长容差 max(10s,15%) → 发 `Range: bytes=0-1` 探测可播并顺带算大小/码率；高置信提前返回，低分按分值排序逐个校验；支持批量换源、无效源自动换。
3. **源接口组织**：独立 music-lib 库，每源一个包，按 song/album/playlist/lyric/download/login 拆文件；统一 model.Song（含 Extra map/Bitrate/IsVIP/IsInvalid）+ 小接口组合（SongSearcher/Parser/Downloader/Lyric）；聚合=每源一协程，失败静默丢弃。
4. **CLI+Web 双模式**：`music-dl web` 起 Gin 服务，API 覆盖 search/switch_source/download/local_music/qr_login/settings/app_update；桌面内嵌只监听 127.0.0.1:37777；远程模式免登录搜索、改设置需一次性 token 管理员会话。**粘贴链接自动识别内建在 search 里**。
5. **下载细节**：无音质下拉，源内按 VIP 阶梯自动取最高；扩展名由字节魔数判定；命名模板支持 `{artist}/{name}` 建子目录+清洗路径穿越；元数据内嵌依赖 FFmpeg 且默认关闭以保流式+Range 断点；KRC/QRC/YRC 逐字歌词解密（网易/QQ 付费歌词）；**SQLite 双表分离"可见下载历史"与"去重索引"（存 RelPath，文件被删才回收）**。

## 八、omniget（13.7k / 7 个月，Tauri2+Rust+SvelteKit，yt-dlp 驱动）

1. **架构**：无 UI 纯 Rust 内核（omniget-core，CLI 复用同一内核）+ 壳层回调依赖注入；下载器统一 `PlatformDownloader` trait（can_handle/get_media_info/download），15+ 原生 extractor，其余回落 yt-dlp 子进程（zipapp 0.4s 启动、SHA-256 校验、自更新）。
2. **队列工程化（可抄清单）**：max_concurrent + 每 item CancellationToken；重试 3 次、指数退避 ≤30s、仅 rate_limited/unknown 类错误重试；**append-only queue.wal + 逐条 fsync 取代整写 JSON**；进度 250ms 节流但结构性事件不节流、6s 无进展判 stalled；`-N` 分片数按 host 自适应（429 计数砍半）、per-host 信号量+最小请求间隔、`--limit-rate` 限速。
3. **粘贴链接交互（cobalt 式的工程化版本）**：omnibox 状态机 idle→detecting→detected(标题/封面/清晰度预览)→preparing→batch；前台 2s 轮询剪贴板弹 toast，后台全局热键；浏览器扩展经本地 HTTP+一次性配对 token 传 cookie，App 未开退 scheme 深链。
4. **产品增长原因**：零配置（自动装并更新 yt-dlp/FFmpeg）、下载完内置播放器/阅读器/抽认卡一站式、无账号无广告无遥测。

## 九、pear-desktop / nuclear 结论（价值重估）

- **pear-desktop**：现 master 已退化为 YouTube Music 单源，"多引擎聚合"名不副实，**不再值得调研**。（教训：老榜单项目要核实当前状态。）
- **nuclear（plugin-sdk v2 值得参考）**：provider = `{id, kind: metadata|streaming|lyrics|playlists|...}` **按 kind 注册表**而非全局 rank 数组；能力显式声明（searchCapabilities + MissingCapabilityError）；**"搜候选/取流"两段式**（searchForTrack→StreamCandidate[] 带 failed/lastResolvedAt/bitrate 溯源，再 getStreamUrl(candidateId)），失败状态挂候选而非整源；`PlaylistProvider.matchesUrl` 让粘贴链接自路由。比 MusicFree 全可选方法更进一步的是候选级重试与溯源。

## 十、更新后的优先级增补

| 优先级 | 事项 | 来源范本 | 成本 |
|---|---|---|---|
| P0 | 换源打分：相似度+时长容差+Range 探测可播 | go-music-dl | 中 |
| P0 | 下载队列工程化：WAL 持久化、退避重试、stalled 检测、per-host 并发信号量 | omniget | 中 |
| P1 | 历史/去重分离双表（文件删除后索引回收）| go-music-dl | 低 |
| P1 | omnibox 粘贴检测状态机（detecting→detected 预览卡） | omniget + go-music-dl search 内识别 | 低-中 |
| P1 | 源层重构对齐 nuclear kind 注册表 + 候选/取流两段式（优于纯 MusicFree 方案） | nuclear plugin-sdk | 中 |
| P2 | KRC/QRC 逐字歌词解密（配合桌面歌词刚需） | go-music-dl | 中 |
| P2 | Web 模式：本机 HTTP 只监听 127.0.0.1，远控需显式开启 | go-music-dl / Spotube | 中 |
| P3 | 咪咕/JOOX 新源；汽水杯观其变（作者本人未调通） | go-music-dl | 咪咕低-中/汽水高 |

## 十一、本轮结论

调研至此基本收口：同类（下载器/聚合播放器）头部项目已全部过完，剩余未调研的（navidrome/koel/feishin 自托管服务端、Metrolist/ViMusic/SimpMusic Android 端、MuseScore/LMMS/librosa/ACE-Step 音乐创作与 AI 生成）与 MusicDL 产品形态无关或价值很低。唯一后续跟踪项：lx 官方新项目 **Any Listen** 与 CharlesPikachu/musicdl 的周更源修复。本轮最大增量认知：go-music-dl 的**换源打分**与 omniget 的**队列工程化**，两项都直接命中 MusicDL 现有短板。

---

# 补录（同日第四轮）：Any Listen / musicdl 跟踪项 + 代码现状核对

## 十二、any-listen/any-listen（lx 作者新作，3.8k，2026-09 仍活跃，AGPLv3+禁商用）

1. 定位"跨平台私人音乐播放服务"：pnpm monorepo，Svelte+Vite UI，**一套代码双形态**——桌面版 Electron+better-sqlite3，另有 web-server 版可 Docker 部署。借鉴价值：高（MusicDL 若做 Web 模式可参考此分层）。
2. 音源方案已放弃 lx 自定义源格式，改为"**扩展**"体系：VM 沙箱执行、manifest 声明权限 grants（internet/music_list…）、contributes 声明资源动作（musicUrl/musicLyric/songlist…）与设置表单、在线扩展市场+内置扩展。→ 比 MusicFree 更进一步的是**权限声明**；MusicDL 未来做插件化时应带 grants。
3. WebDAV 双角色：远程列表直接播 WebDAV 歌曲（做成内置扩展）；数据同步用**快照合并**（snapshot/mergeFromSnapshot，列表+dislike 规则）、WebDAV 锁防并发、状态机+定时+可取消。→ MusicDL cloudSync 若走 WebDAV 路线，"快照合并+锁"是现成范本。

## 十三、CharlesPikachu/musicdl 周更机制（6.2k，pushed 2026-09-12）

1. 9 月上旬密集修复 tidal/deezer/qobuz/soda/qq/kugou，模式=第三方解析端点失效换新（clashflac、dezalty 等），YouTube 原生 API 全挂后整体重构；非加密变更。→ 印证"源失效检测+快速降级"是生命线。
2. 工作流可借鉴（高）：README "What's New" 每周注明维护/弃用哪些源；每源独立 Client+utils 隔离；源内 `_parsewithXXXapi` 分层（稳定/不稳定两组）顺序回退；**AudioLinkTester 校验有效音频后才采纳**；单解析异常 suppress 不中断。
3. WhisperLRC 仍在（中）：faster-whisper 懒加载可选依赖 + ENABLE_WHISPERLRC 开关；另有 LyricSearchClient 多歌词 API（lrclib/happi/musixmatch）回退。

## 十四、代码现状核对（2026-09-18，修订前文优先级）

核对 `src/` 实际代码后，前文多处"待做"判断已过时——项目演进快于文档：

**已实现（从优先级表移除）**：
- 换源打分核心：`utils/matchMusic.js`（规范化+版本尾剥离+歌名/歌手/时长打分、LRU+in-flight 去重、付费候选降权、每源 top5）
- 源健康度+自动降级：`utils/sourceHealth.js` + resolveTrackService 的 rankByHealth、`_altSource` 记忆
- 源插件注册表：`api/pluginRegistry.js`，8 源（netease/qq/kugou/kuwo/bilibili/**migu/soda/fivesing**——上轮建议"新增咪咕/汽水"实际已接入）
- 粘贴链接识别：`utils/linkParser.js`
- 取流/换源服务化：`api/services/resolveTrackService.js`（DI 注入、职责边界清晰，见 docs/REFACTOR_PLAN_2026-09-17.md）
- 云同步/订阅/音乐库 IPC：cloudSync.js / subscriptions.js / library.js / libraryIndex.js
- 退避重试原语：`utils/retry.js`（withRetry，目前主要给 updater 用）

**确认仍缺（修订后的真 P0/P1）**：

| 优先级 | 事项 | 范本 | 现状 |
|---|---|---|---|
| P0 | 候选可播性探测：换源前对 top 候选发 `Range: bytes=0-1` 预检，避免逐个试错整条取流链 | go-music-dl / musicdl AudioLinkTester | ✅ **已实施（2026-09-18）**：核对时发现 request.js 已有 testAudioLink（HEAD→Range GET、SSRF 校验、跟 302、判 text/plain），但换源环未消费。本轮接入：resolveTrackService 新增可选 probeUrl 依赖 + isDecisivelyDeadProbe 保守判定（仅 not-audio / 404 / 410 否决候选，不定证据一律接受，探测抛错不阻断）；探测只挂候选（本源/_alt 成功路径零新增延迟）；判死候选记健康度失败供 rankByHealth；api/index.js 注入 testAudioLink(6s)。8 条行为测试 RED→GREEN，全量 773/773 过，lint 干净 |
| P0 | 队列持久化升级：persistQueue 现为整写 JSON（atomicFile），改 append-only WAL + 逐条 fsync；补 stalled 检测（6s 无进展）、per-host 并发信号量 | omniget | ✅ **已实施·范围修正（2026-09-18）**：逐项核对后只落地两项真缺口——① **分平台并发钳制**（getPerSourceCap/activeCountBySource/pickSchedulable，prefs.perSourceConcurrency 默认 2、越界回落、且不超全局 concurrency），对应 lx「并发过高会被源封 IP」的真实风控缺口；② **终态立即落盘**（done/error 后 notifyQueueChanged(true) 绕过 500ms 防抖直接原子写，关掉「下完即退出丢任务」窗口）。**WAL 与独立 stalled 检测经论证排除**：队列 ≤400 条整写原子文件 + dispose 兜底已覆盖断电/半写场景，append-only 只增复杂度；真 stalled 已由 downloader 60s socket 空闲超时兜住。6 条行为测试 RED→GREEN，downloadQueue 35/35、全量 785/785 过，lint 干净 |
| P1 ✅已实施 | history.json → SQLite（含 DB_VERSION+migrate；历史/去重索引分离双表，文件删除才回收索引） | lx / go-music-dl / beets | **已落地**：用 `node:sqlite` DatabaseSync 替代 better-sqlite3（Electron 44 内嵌 Node 24.21 零警告支持，零原生依赖、零打包改动、测试与运行时同 ABI；better-sqlite3 曾在 scratch 验证可用但会引入 node-ABI vs electron-ABI 测试冲突，弃用）。`PRAGMA user_version` 迁移框架；双表 `history`（展示，上限 5000，JSON data 列保扩展字段）+ `assets`（去重索引，不随上限淘汰，文件删除才回收）；add() 即时落盘消灭旧 2s 防抖丢数据窗口；一次性迁移 history.json→`.imported`；损坏 db→`.bak` 重建+内存兜底。公开 API 逐字节不变，6 个调用方与 8 条旧契约测试零改动。新增 7 条 SQLite 测试，全库 837/837，lint/build/smoke:asar 12/12 全绿 |
| P1 | KRC/QRC/YRC 逐字歌词解密（QQ/酷狗付费逐字歌词，配合桌面歌词规划） | go-music-dl | ✅ **部分实施（2026-09-18）**：实测后范围收敛为**酷狗 KRC**（链路全程验证可用：`lyrics.kugou.com/search?hash=&lrctxt=1` → `download?fmt=krc` → base64+跳4字节魔数+16字节XOR+zlib → 私有标记文本，新增 utils/krcCodec 解码为逐字结构 {meta,lines[].words[].startMs/durMs}，并合成 LRC 供既有落盘/UI 兼容；gateway 歌词返回值扩展为 {lrc, karaoke?}）。顺带修复实测证实的旧 bug：酷狗歌词 search 不带 hash 必 0 命中、把 encodeKugouId 编码 id 当 keyword、accesskey 误写成 accessToken —— 此前酷狗歌词实际完全取不到。**QRC 暂缓**：解密是腾讯自研非标 DES（3 个固定 key 的类 DES 位运算，非 AES）且取词需登录 ticket；**YRC 暂缓**：`api/karaoke/lyric/download` 已 404，现行入口走 eapi 需签名。两者待有登录态需求时再立项。测试 16 条新增（codec 10 + kugou/gateway 6，含真实抓包 fixture 与线上冒烟），全量 815/815 过，lint 干净 |
| P2 ✅已评审·排除 | 插件化若推进，协议对齐 any-listen 扩展体系（manifest grants 权限声明）+ nuclear kind 注册表 | any-listen / nuclear | **不立项（2026-09-19 核对）**：grants/kind 体系服务于「加载外部不可信插件」；MusicDL 平台文件全部随包内置、启动即经 `validate()` 强校验（含 CORS 主机白名单这一实际安全边界），能力表由**方法存在性推导**而非声明——比声明式 grants 更强（不可能声明与实现漂移）。无外部插件装载需求前，加权限声明层是为假想敌设防（YAGNI）。pluginRegistry v3 维持现状 |
| P2 ✅已实施 | WebDAV 快照合并同步（snapshot/mergeFromSnapshot+锁） | any-listen / lx | **已落地（2026-09-19）**：三层新增——`utils/syncMerge`（纯函数合并规则：歌单按 id 并集+updatedAt LWW 基底+歌曲按 songKey 并集；模板按 id updatedAt 胜；历史按 id+source finishedAt 胜，无墓碑删除不跨端传播与 lx 同取舍）、`utils/webdav`（GET 404→不存在/ETag 捕获；PUT If-Match 乐观锁，412→conflict，transport 注入可测；替代 WebDAV LOCK 的轻量方案）、`utils/cloudSyncCore.syncOnce`（编排：拉→并→推→**推成功后才回写本地**，412 重拉重并再推一次）。IPC 三通道 `cloud-sync-config-get/set` + `cloud-sync-now`（密码走 secretStore 加密、不进导出备份、不参与同步的是 saveDir 等机器相关键），设置页新增 WebDAV 区块（中英双语）。契约通道数 94→97。测试 23 条新增（merge 8 + webdav 8 + core 7），全量 870/870，lint/build/smoke:asar 12/12 全绿 |

**维护性启示（musicdl）**：README 加 "What's New / 源状态" 周更栏目；源内解析分层（稳定端点组/实验端点组顺序回退）——MusicDL 的 8 源模块可各加此结构。
> **处置（2026-09-19）**：① 已落地——README 新增 What's New 与源状态栏目（顺带修正全文过时项：5 源→8 源、目录结构、依赖表含剔除已不存在的 crypto-js）；栏目周更是流程约定，非代码。② **不立项**——逐源核对后确认各源对内均单端点（soda 的双 host 是检索/分享两个不同职责，非冗余回退），不存在「实验端点组」可分层；容错已由跨源换源 + 源健康度排序覆盖，为不存在的结构预搭框架即 YAGNI。

## 十五、四轮调研总收口

同类项目全部过完，跟踪项（Any Listen、musicdl）也已核完。MusicDL 与头部项目的差距已不在"功能有无"（换源打分、健康度、链接识别、插件注册表都在），而在三处工程深度：**队列持久化强度（WAL）、数据层（SQLite）、歌词格式覆盖（KRC/QRC）**。建议下一实施顺序：Range 预检（小、独立、立竿见影）→ 队列 WAL+stalled → SQLite 迁移 → KRC/QRC。

> **收口（2026-09-19）**：上述建议顺序连同两条 P2 已全部处置完毕——Range 预检 ✅、队列升级 ✅（分平台并发+终态即时落盘；WAL/stalled 论证排除）、SQLite 迁移 ✅（node:sqlite 双表+迁移框架）、KRC ✅（QRC/YRC 证据化暂缓）、插件协议 ✅（评审排除）、WebDAV 同步 ✅；维护性启示两项各自落地/排除。四轮调研无未结项，回归基线 870/870。后续若立项需新触发条件：QRC/YRC 待有登录态需求；插件 grants 待有外部装载需求。
