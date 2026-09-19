# MusicDL 全面代码审计报告

**项目**: MusicDL Electron 音乐播放器  
**审计日期**: 2026-08-11  
**代码规模**: 50 个 JS 文件，15,246 行代码（API 层 ~2,600 LOC，Main/Utils 层 ~4,500 LOC，Renderer 层 ~8,100 LOC）  
**测试覆盖**: 44/44 测试通过  
**审计方法**: 3 个并行子代理分别审计 API / Main+Utils / Renderer 三层

---

## 📊 审计总览

| 严重度 | API 层 | Main/Utils | Renderer | **合计** |
|--------|--------|------------|----------|----------|
| 🔴 CRITICAL | 2 | 2 | 6 | **10** |
| 🟠 HIGH | 5 | 5 | 5 | **15** |
| 🟡 MEDIUM | 7 | 6 | 5 | **18** |
| 🔵 LOW | 6 | 9 | 3 | **18** |
| **合计** | **20** | **22** | **19** | **61** |

---

## 🔴 CRITICAL — 10 个（必须立即修复）

### C1. 酷狗 HTTP 明文 API 调用
- **文件**: `src/api/platforms/kugou.js:207,234,259,282,305`
- **问题**: 所有酷狗移动 CDN API 使用 `http://` 而非 `https://`
- **影响**: 搜索关键词、歌曲哈希、设备 ID 明文传输，可被中间人攻击窃取
- **修复**: 将所有 `http://` 改为 `https://`

### C2. shell.openExternal 无 URL 校验
- **文件**: `src/main/ipc/window.js:113`
- **问题**: `shell.openExternal(url)` 直接使用渲染进程传来的 URL，无协议校验
- **影响**: 攻击者可通过 XSS 构造 `file://`、`smb://`、`ms-msdt:` 等恶意 URL 执行系统命令
- **修复**: 仅允许 `http:` 和 `https:` 协议

### C3. 小播放器 nodeIntegration: true + contextIsolation: false
- **文件**: `src/main/ipc/window.js:31-34`
- **问题**: 迷你播放器 BrowserWindow 开启了 `nodeIntegration: true` 和 `contextIsolation: false`
- **影响**: 迷你播放器中任何 XSS 都可获得完整 Node.js API 访问权限（文件系统、child_process 等）
- **修复**: 改为 `contextIsolation: true` + preload 脚本，与主窗口安全模型一致

### C4. DOM XSS — playlist.js（3 处）
- **文件**: `src/renderer/js/views/playlist.js:36-52, 84-98, 258-264`
- **问题**: `pl.name`、`pl.desc`、`pl.id`、`song.title`、`song.artist`、`song.album` 全部未转义直接插入 innerHTML
- **影响**: 恶意歌单名/歌曲名（如 `<img src=x onerror=alert(1)>`）可执行任意 JS
- **修复**: 所有用户数据插入 innerHTML 前必须使用 `esc()` 转义

### C5. DOM XSS — home.js onclick 注入
- **文件**: `src/renderer/js/views/home.js:174`
- **问题**: `p.source` 和 `p.id` 未转义直接插入单引号 onclick 属性
- **影响**: 恶意 source/id 值可注入任意 HTML 属性或 JS 代码
- **修复**: 使用 `escQ()` 转义 onclick 中的单引号值

### C6. DOM XSS — download.js onclick 注入
- **文件**: `src/renderer/js/views/download.js:144,157-163`
- **问题**: `s.taskId` 未转义；即使使用 `esc()` 的地方，`esc()` 不转义单引号，无法安全用于单引号 onclick 上下文
- **影响**: 恶意 taskId 可跳出函数调用注入代码
- **修复**: 需要新的 `escAttr()` 函数或改用事件委托

### C7. DOM XSS — ai-music.js esc() 在单引号 onclick 中无效
- **文件**: `src/renderer/js/views/ai-music.js:854`（及 home.js:155, search.js:524）
- **问题**: `esc()` 转义 `& < > "` 但不转义单引号 `'`，在 `onclick='...'` 中无效
- **影响**: 含单引号的歌曲名（如 `O'Brien`）可跳出函数调用
- **修复**: 创建 `escAttr()` 函数处理 HTML 属性上下文，或移除所有内联 onclick 改用事件委托

### C8. getAlbumSongs 无 try/catch — 未处理 Promise rejection
- **文件**: `src/api/recommendations.js:169-174`
- **问题**: 三个平台调用均无 try/catch，`qqGetAlbumSongs` (qq.js:703) 自身也无 try/catch
- **影响**: 任何平台 SDK 错误导致整个函数崩溃，传播为 unhandled rejection
- **修复**: 用 try/catch 包裹所有平台调用

### C9. IPC 路径遍历 — 任意文件系统操作
- **文件**: `src/main/ipc/library.js:24,52,61,96,105,126,155,170,187` + `checkLocal.js:50`
- **问题**: 多个 IPC 处理器接受渲染进程传来的文件路径，无沙箱校验（scan、read、write、delete、rename）
- **影响**: 攻击者可扫描/读取/写入/删除系统任意文件
- **修复**: 添加路径校验 helper，确保路径在用户配置的目录内

### C10. SSRF — proxy-play 任意 URL 抓取
- **文件**: `src/main/ipc/download.js:31` → `src/main/playCache.js:134-153`
- **问题**: 渲染进程可传递任意 URL，主进程直接 HTTP 抓取到本地缓存
- **影响**: 可探测内网服务（localhost、192.168.x.x），下载并读取响应
- **修复**: 限制 URL scheme 为 `https:`，或限制到已知 CDN 域名，阻止私有 IP

---

## 🟠 HIGH — 15 个

### H1. 错误返回类型不一致
- **文件**: `src/api/qq.js:358`, `src/api/bilibili.js:88`
- **问题**: `qqGetUrl` 和 `bilibiliGetUrl` 出错返回 `null`，而 `neteaseGetUrl` 和 `kugouGetUrl` 返回 `{error, code, fatal}`
- **修复**: 统一所有平台返回错误对象

### H2. searchSinger 无 try/catch
- **文件**: `src/api/recommendations.js:176-180`
- **问题**: 单平台分支无 try/catch，仅 `'all'` 分支使用 `Promise.allSettled`
- **修复**: 为单平台分支添加 try/catch

### H3. ai-music.js 重复 request() 无重试
- **文件**: `src/api/ai-music.js:29-66`
- **问题**: 定义了自己的 `request()` 函数，不使用共享的带重试/退避的 `request.js`
- **修复**: 复用共享 request 模块

### H4. qqGetAlbumSongs 无 try/catch
- **文件**: `src/api/qq.js:703-720`
- **问题**: 唯一没有 try/catch 包裹的 `qq*` 函数
- **修复**: 添加 try/catch

### H5. 所有搜索函数缺少 keyword 输入校验
- **文件**: `netease.js:18`, `qq.js:130`, `bilibili.js:27`, `kugou.js:44`
- **问题**: `undefined` keyword 导致搜索 "undefined" 字符串
- **修复**: 搜索前校验 keyword 类型和非空

### H6. 事件监听器泄漏 — document click
- **文件**: `src/renderer/js/views/local.js:430`
- **问题**: 每次打开编辑弹窗添加新的 document click 监听器，关闭时不移除
- **修复**: 弹窗关闭时移除监听器

### H7. 事件监听器泄漏 — drag 事件
- **文件**: `src/renderer/js/views/local.js:412-414`
- **问题**: dragover/dragleave/drop 监听器在每次编辑封面时叠加
- **修复**: 先 removeEventListener 再 addEventListener

### H8. 事件监听器泄漏 — debounce input
- **文件**: `src/renderer/js/views/converter.js:150`
- **问题**: `debounce()` 每次返回新函数，导致 removeEventListener 无法匹配
- **修复**: 保存 debounce 返回的函数引用

### H9. set-pref 允许写入任意偏好键
- **文件**: `src/main/ipc/prefs.js:14`
- **问题**: 渲染进程可设置 `cookies`、`session` 等敏感键
- **修复**: 白名单允许的键，阻止敏感键

### H10. AI 音乐保存路径无校验
- **文件**: `src/main/ipc/ai-music.js:131-136`
- **问题**: `params.saveDir` 直接用于 `path.join(saveDir, ...)`
- **修复**: 校验 saveDir 在允许的根目录内

### H11. open-folder 无路径校验
- **文件**: `src/main/ipc/window.js:107-112`
- **问题**: `shell.showItemInFolder(folder)` 接受任意路径
- **修复**: 校验路径在用户音乐/下载目录内

### H12. 状态数组直接变更绕过 setState
- **文件**: `src/renderer/js/views/local.js:515,610,954`, `playlist.js:131,297`
- **问题**: 直接修改 `getState()` 返回的数组/对象
- **修复**: 先复制再修改，或改为不可变更新模式

### H13. Set 在 state 中绕过变更检测
- **文件**: `src/renderer/js/views/search.js:551-554`
- **问题**: `Set.add()`/`.delete()` 就地变更，`setState` 不一定触发更新
- **修复**: 复制 Set 后再修改

### H14. ai-music.js 中 getAlbumSongs 也无 try/catch
- **文件**: `src/api/ai-music.js`（AI 歌曲生成路径）
- **问题**: AI 生成流程中的专辑歌曲获取也未受保护
- **修复**: 与 C8 一起修复

### H15. downloadBuffer 无 Content-Length 限制
- **文件**: `src/utils/downloader.js:234-236`, `src/utils/onlineCover.js:27-29`
- **问题**: HTTP 响应无大小限制地累积到内存
- **修复**: 添加 Content-Length 检查或字节计数器

---

## 🟡 MEDIUM — 18 个

| # | 文件 | 问题 | 修复建议 |
|---|------|------|----------|
| M1 | `qq.js:127-129` | JSDoc 注释与函数名不匹配（复制粘贴残留） | 更正注释 |
| M2 | `qq.js:361-362` | 重复空 JSDoc 块 | 删除多余的 JSDoc |
| M3 | `api/index.js:245-247` | 同一模块 4 次 `require('../utils/cookie')` | 顶部解构一次 |
| M4 | `ai-music.js:461` | 内联 `require('fs')` 但顶部已导入 | 使用已有的 `fs` |
| M5 | `ai-music.js:477` | `readFileSync` 阻塞主进程 | 改用 `await fsp.readFile` |
| M6 | `qq.js:281-285` | QUALITY_MAP 键名与 UI 传入值不匹配 | 统一键名 |
| M7 | `ai-music.js:20-24,484-491` | history 读-改-写无锁，竞态条件 | 添加锁或原子操作 |
| M8 | `prefs.js:100` | 缺少 `getAll()` 导出，cloudSync 用 fallback | 导出 `getAll()` |
| M9 | `library.js:170-183` | `rename-file` TOCTOU 竞态 | 直接 catch ENOENT |
| M10 | `downloadTemplates.js:71-85` | 模板 path 字段可遍历 | 解析后验证在下载目录内 |
| M11 | `loginWindow.js:149-157` | 5 分钟超时计时器从不清除 | 在 closed/success 时 clearTimeout |
| M12 | `downloader.js:229-237` | `downloadBuffer` 无 `res.on('error')` | 添加 error handler |
| M13 | 动态 overlay 多处 | `local.js:766,893,994` + `ai-music.js:771,911` 的 overlay 不清理 | 页面切换时移除 |
| M14 | 模块级状态多处 | `_selectedLocal`、`_dupState`、`aiState.historyCache` 永不重置 | 切换视图时重置 |
| M15 | CSS z-index | `.overlay` (1000) = `.playlist-modal` (1000) 依赖 DOM 顺序 | 明确分层 |
| M16 | CSS z-index | `.stats-overlay` 无 z-index 定义 | 添加 `z-index: 105` |
| M17 | CSS z-index | `.toast-container` 在 base.css 和 overlays.css 重复定义 | 移除重复 |
| M18 | `api/index.js` 错误分类 | 各平台错误处理逻辑重复但不一致 | 提取共享 `classifyError()` |

---

## 🔵 LOW — 18 个

| # | 文件 | 问题 |
|---|------|------|
| L1 | `netease.js:163` | 残留 `console.log` 调试日志 |
| L2 | `request.js:56` | 硬编码 Chrome 124 User-Agent，会过期 |
| L3 | `recommendations.js:43` | `.then()` 在 `await` 后冗余 |
| L4 | `kugou.js:102` | 硬编码哈希盐值 `'kugou2015'` |
| L5 | `bilibili.js:33` | 回退 cookie `buvid3=anon` 脆弱 |
| L6 | `ai-music.js:534` | 歌词注入 LLM prompt 无清洗（prompt injection） |
| L7 | `main/index.js:393` | `loadPersistedQueue()` 未 await |
| L8 | `localLibrary.js:65` | `fs.statSync` 无 try-catch |
| L9 | `onlineLrc.js:97` | async 函数中用 `writeFileSync` |
| L10 | `downloader.js:345` | 内部 helper 不必要导出 |
| L11 | `downloadTemplates.js:80` | `song.source` 未 sanitize |
| L12 | `checkLocal.js:50-55` | items 参数未深度校验 |
| L13 | `main/index.js:565-568` | `song.saveDir` 无路径校验 |
| L14 | `download.js:236` | `Math.random()` 用于 taskId（非安全场景可接受） |
| L15 | `cookieStore.js:127` | `saveAll` 定义但未导出 |
| L16 | 全局 | 双导出模式（ESM + window 全局）造成命名空间污染 |
| L17 | `init.js` | 模块初始化顺序依赖 import 图遍历 |
| L18 | `state.js` | 全局单例无订阅/通知机制 |

---

## 🎯 Top 10 修复优先级

| # | ID | 问题 | 修复难度 | 工作量 | 影响 |
|---|----|------|----------|--------|------|
| 1 | C1 | 酷狗 HTTP → HTTPS | ⭐ | 10 分钟 | 安全 |
| 2 | C2 | shell.openExternal 校验 | ⭐ | 10 分钟 | 安全 |
| 3 | C3 | 迷你播放器 nodeIntegration | ⭐⭐ | 30 分钟 | 安全 |
| 4 | C4-C7 | DOM XSS（innerHTML + onclick） | ⭐⭐⭐ | 2 小时 | 安全 |
| 5 | C8 | getAlbumSongs try/catch | ⭐ | 10 分钟 | 稳定性 |
| 6 | C9 | IPC 路径沙箱 | ⭐⭐⭐ | 2 小时 | 安全 |
| 7 | C10 | proxy-play SSRF 防护 | ⭐⭐ | 20 分钟 | 安全 |
| 8 | H1 | 错误返回类型统一 | ⭐⭐ | 30 分钟 | 可维护性 |
| 9 | H6-H8 | 事件监听器泄漏 | ⭐⭐ | 40 分钟 | 稳定性 |
| 10 | H9 | set-pref 白名单 | ⭐ | 15 分钟 | 安全 |

---

## 📝 总结

**整体评价**: 项目功能丰富、架构清晰，但安全审计发现了多个严重漏洞。

### 问题分布
- **安全性（主要风险）**: 10 个 CRITICAL + 8 个 HIGH = 18 个安全问题
  - DOM XSS（6 处）：playlist.js、home.js、download.js、ai-music.js
  - 路径遍历（IPC 层）：library.js、ai-music.js、downloadTemplates.js
  - SSRF：proxy-play
  - 网络安全：HTTP 明文、nodeIntegration
- **稳定性**: 未处理 Promise rejection、事件监听器泄漏、竞态条件
- **可维护性**: 重复代码、错误处理不一致、命名不匹配

### 建议修复节奏
1. **立即（今天）**: C1-C3, C8, H9 — 安全基础修复
2. **本周**: C4-C7, C10, H1-H5 — XSS 防护 + 核心功能
3. **下周**: C9, H6-H15 — 路径沙箱 + 资源泄漏
4. **持续**: M1-M18, L1-L18 — 代码质量改进

### 安全改进路线图
1. 创建 `escAttr()` 函数，或改用事件委托消除内联 onclick
2. 添加 `validatePath()` helper 用于所有 IPC 文件操作
3. 统一错误对象格式 `{error, code, fatal}`
4. 迷你播放器迁移到 preload 脚本模式

---

*审计完成时间: 2026-08-11 21:50*  
*审计工具: 3 × Hermes Agent 并行子代理*
