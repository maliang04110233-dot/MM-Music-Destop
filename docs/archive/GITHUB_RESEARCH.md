# GitHub 热门音乐下载项目调研报告

> 调研日期：2026-09-14 ｜ 数据来源：GitHub API（star 数为当日值）

## 一、榜单总览

| 项目 | Stars | 定位 | 与 MusicDL 的关系 |
|---|---|---|---|
| imputnet/cobalt | 43.1k | 贴链接即下载的媒体保存工具（Web/API） | 交互范本：极简输入→出文件 |
| spotDL/spotify-downloader | 26.1k | Spotify 歌单→YouTube 匹配下载 CLI | 元数据/歌单同步思路 |
| putyy/res-downloader | 19.8k | 视频/音乐等网络资源嗅探下载 | 国内同类流量标杆 |
| algerkong/AlgerMusicPlayer | 16.7k | 第三方音乐播放器（Electron，同技术栈） | **最直接的参照物** |
| Shabinder/SpotiFlyer | 11.3k | 多平台音乐下载（Kotlin 多平台） | 多源架构思路 |
| CharlesPikachu/musicdl | 6.2k | 纯 Python 多源音乐下载器 | 源维护与歌词语料思路 |
| qier222/YesPlayMusic | ~30k 量级（维护模式） | 网易云第三方播放器（Electron） | 播放器功能标杆 |
| nathom/streamrip | 4.9k | Qobuz/Tidal 等无损源下载 CLI | 去重数据库/格式转换 |
| listen1/listen1_desktop | ~10k 量级 | 多源聚合播放器（Electron） | 多源聚合前辈 |

## 二、对标项目 AlgerMusicPlayer（16.7k，技术栈相同：Electron + Vue）

功能清单：音乐推荐、账号登录同步、播放历史、歌曲收藏、歌单/MV/排行榜/每日推荐、自定义快捷键（全局+应用内）、沉浸式歌词（点封面进入）、**独立桌面歌词窗口**、明暗主题、**迷你模式**、**状态栏控制**、多语言、EQ 均衡器、**定时播放**、**远程控制播放**、倍速播放、高品质音乐、音乐文件下载、搜索 MV/音乐/专辑/歌单/bilibili、**单曲单独选源解析**、本地化 API 服务（netease-cloud-music-api）+ 音源解锁（@unblockneteasemusic/server）。

## 三、按主题归纳的可借鉴功能

### A. 歌词与显示（AlgerMusicPlayer / YesPlayMusic / MusicPlayer2）
1. **桌面歌词窗口**：独立置顶小窗，滚动卡拉 OK 逐字高亮——国内播放器的刚需功能，Alger 的核心卖点之一。
2. **沉浸式歌词页**：点击封面放大进入全屏歌词视图，随播放自动滚动。
3. **歌词下载与编辑**：MusicPlayer2 支持在线歌词下载、LRC 编辑、卡拉 OK 样式。
4. **WhisperLRC 自动生成歌词**（CharlesPikachu/musicdl）：对拿不到歌词的源（B 站/有声书类），用 faster-whisper 语音识别生成 LRC，`ENABLE_WHISPERLRC=True` 一键开启。MusicDL 已有 B 站源，此功能可直接补齐 B 站歌词缺口。

### B. 播放器体验（Alger / YesPlayMusic）
5. **迷你模式**：小窗只保留封面+进度+上下曲。
6. **系统状态栏/托盘控制**：托盘菜单切歌、暂停；macOS 仿 YesPlayMusic 的 Touch Bar/Mpris。
7. **全局媒体键**：自定义全局快捷键，不聚焦窗口也能切歌。
8. **EQ 均衡器 + 倍速播放 + 定时关闭**：三件套。MusicDL 已有播放器，Web Audio 的 BiquadFilter 即可实现 EQ。
9. **远程控制**：Alger 手机扫码远程控 PC 播放（局域网 Web 面板）。
10. **明暗主题自动切换**（prefers-color-scheme）。

### C. 下载与文件质量
11. **元数据嵌入**（spotDL / cobalt）：下载后自动写 ID3 标签——标题、歌手、专辑、**封面内嵌**、歌词嵌入。cobalt 有 `disableMetadata` 开关；spotDL 默认带专辑封面。MusicDL 目前下载完基本是裸文件，这是最值得抄的一招。
12. **音质选择**（cobalt `audioBitrate` 64–320kbps）：下载前可选码率；Alger 的“高品质音乐”优先抓最高码率。
13. **格式选项**（cobalt：best/mp3/ogg/wav/opus；streamrip 自动转码）：偏好格式设置 + ffmpeg 转码。
14. **文件命名模板**（cobalt `filenameStyle` classic/pretty/basic/nerdy）：“歌手 - 歌名”、“歌名 [ bitrate ]” 等可配置模板。
15. **下载去重数据库**（streamrip）：SQLite 记已下载 ID，重复下载直接跳过。MusicDL 有 history.json，可以加“已下载检测+跳过/询问”逻辑。
16. **歌单/专辑批量下载 + 同步**（spotDL `sync`）：对比本地目录与歌单当前状态，新增下载、移除删除。MusicDL 若做歌单功能这是杀手级配套。

### D. 搜索与源管理
17. **聚合搜索 + 按源筛选**（listen1 / CharlesPikachu）：全网搜完统一列表，支持只搜选定源（musicdl `-m NeteaseMusicClient,QQMusicClient`）。MusicDL 已是多源，可补“源筛选器”和“各源结果数徽标”。
18. **搜索结果交互选择**（musicdl 交互模式）：↑↓ 移动、Space 多选、a 全选、i 反选、Enter 确认——桌面端映射为复选框批量下载。
19. **代理支持**（musicdl `auto_set_proxies`）：自动拉取免费代理池。海外源（如 SoundCloud）在国内环境可能需要。
20. **音源健康度维护**：CharlesPikachu 每周发版修 API 端点（2026-09-02 YouTube 重构、09-08 酷狗/网易/QQ 端点修复）。启示：源失效检测 + 快速降级是这类项目的生命线，MusicDL 的换源机制方向正确，可再加“源可用性探针+自动禁用”。
21. **账号登录（扫码/手机/邮箱）+ 云端歌单同步**（YesPlayMusic / Alger）：登录后拉取收藏歌单、每日推荐。注意合规边界，仅同步公开数据。

### E. 交互设计（cobalt 的产品哲学）
22. **粘贴即下载**：cobalt “paste the link, get the file, move on”——支持粘贴歌曲/歌单分享链接直接解析。MusicDL 可加“粘贴网易云/QQ/B 站链接→自动识别源并搜索”。
23. **无打扰设计**：零广告、零弹窗、失败静默重试。cobalt 43k star 证明了“不烦人”本身就是卖点。

## 四、优先级建议（结合 MusicDL 现状）

| 优先级 | 功能 | 理由 | 状态（2026-09-14 核实） |
|---|---|---|---|
| ~~P0~~ | ~~下载文件元数据嵌入~~（ID3 标签+封面+歌词） | spotDL/cobalt 共同标配 | ✅ **调研后发现已实现**：processOneSong 已调 embedId3Tags（标题/歌手/专辑/封面/歌词 MP3 用 node-id3，M4A/FLAC 用 Python mutagen）+ 独立 .lrc 文件 + 命名模板 {artist} - {title} |
| P0 | **下载去重**（基于现有 history.json） | streamrip 验证过的需求，数据已有只差逻辑 | ✅ **已实施（2026-09-14）**：history.findDownloaded（done+文件在盘才算重）+ add-to-queue 单曲弹「仍要下载」/批量静默跳过 + forceRedownload 直通；104 tests + CDP E2E 全过 |
| P1 | **桌面歌词窗口 + 沉浸式歌词** | 同技术栈 Alger 的第一卖点，Electron 侧边窗实现成熟 | 待做 |
| P1 | 音质选择 | 设置页下拉框量级 | 部分已有（qualitySelect） |
| P1 | 文件命名模板 | cobalt filenameStyle | 部分已有（namingTemplate pref，可扩更多变量） |
| P1 | **粘贴链接智能识别** | cobalt 的核心交互，与 MusicDL“搜索”入口天然融合 | 待做 |
| P2 | 迷你模式、托盘控制、全局快捷键 | 播放器成熟度补全 | 迷你模式已有（mini-player）；托盘/全局键待做 |
| P2 | EQ 均衡器、倍速、定时关闭 | Web Audio 就地实现 | 倍速待确认；EQ/定时待做 |
| P2 | 源可用性探针 + 自动降级 | 已有换源机制的自然延伸 | 待做 |
| P3 | 歌单批量下载 + sync、账号登录、远程控制 | 体量大，依赖前期功能 | 待做 |

### P0 下载去重实施记录（2026-09-14）
- `src/utils/history.js`：新增 `findDownloaded(id, source)`——status=done 且 savePath 文件仍在磁盘才算重复；id 数字/字符串统一 String 比较
- `src/main/ipc/download.js`：`add-to-queue` 命中历史时返回 `{alreadyDownloaded, savePath, finishedAt}` 不入队；`add-playlist-to-queue` 批量静默跳过并返回 `skippedDownloaded` 计数；`forceRedownload: true` 跳过查重直通
- 渲染层（search/home/history/app 5 个调用点）：单曲弹 `showRedownloadToast`（「已下载过」+「仍要下载」按钮，6s 自动消失）；批量 toast 显示「跳过 N 首已下载过」
- i18n：zh/en 各加 5 个 toast.* key；CSS：toast-redownload 样式
- 测试：test/history.test.js 新增 findDownloaded 用例（8 断言：命中/数字id/error/文件已删/无路径/跨源/空参），全量 104 tests 全过；CDP E2E 探针实测单曲拦截/按钮回调/force 直通/批量计数四场景通过

## 五、风险与合规提示

- 参考项目普遍标注“仅学习交流、禁止商业用途”（Alger、CharlesPikachu 均有声明，后者用 PolyForm-Noncommercial 许可证）。cobalt 明确声明“只下载公开免费内容、不缓存、如同浏览器开发者工具”。
- 账号登录类功能（登录网易云同步歌单）法律与技术风险最高，建议保持“匿名+公开接口”边界，与现状一致。
- 转码（ffmpeg 打包）会显著增大安装包体积，建议作为可选下载组件而非内置依赖（musicdl 的做法）。
