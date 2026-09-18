# MusicDL 重构方案

> 方案日期：2026-09-17  
> 目标版本：1.1.x（分阶段交付，不要求一次完成）  
> 适用范围：`C:\Users\admin\.zcode\workspace\default\MusicDL`  
> 当前基线：Electron 44 + Vite 5 + CommonJS 主进程，8 个音源平台，352 个测试全绿

## 1. 方案结论

**不建议重写，不建议立即迁移 React/TypeScript，也不建议重做 Electron 进程模型。**

当前项目的安全基座、换源机制、原子写、平台 v3 registry 和测试基础都已经具备。重构的核心不是换技术，而是把已经存在的正确设计继续收敛为稳定边界：

1. 主进程从“总控巨型文件”收敛为应用服务层；
2. 所有平台能力统一通过 registry 访问，消除最后的直连分派；
3. 下载、播放、搜索、歌词、历史、队列分别形成可测试的用例层；
4. 渲染层按页面/领域拆分，保留现有原生 DOM，不引入框架迁移风险；
5. 用 CI、契约测试、依赖审计和打包验证把重构变成可持续工程。

重构原则：**先建立边界，再搬迁实现；先加守卫，再改调用方；每个阶段可独立验收、独立回滚。**

---

## 2. 当前问题与目标状态

| 当前问题 | 目标状态 |
|---|---|
| `src/main/index.js` 约 900 行，承载启动、队列、下载、CORS、窗口、IPC 编排 | `index.js` 只负责启动编排和生命周期；业务逻辑进入 `services/` 与 `ipc/` |
| `app.js` 1099 行、多个 view 超过 1000 行 | 启动、平台、i18n、路由、页面状态、事件处理分离 |
| `recommendations.js` 直接 require 平台文件并按 id 分派 | 通过 registry 能力查询和统一调用协议分派 |
| 平台 manifest v3 已落地，但部分消费方仍有历史耦合 | registry 成为平台事实和路由的唯一入口 |
| API 结果形态不完全统一，错误码依赖字符串/平台差异 | 统一 `Result` / `MusicError` 边界，平台差异在 adapter 内消化 |
| 下载和播放都依赖取流，但重试、换源、缓存、健康度交织 | 独立 `ResolveTrackService`，下载/播放共享同一取流用例 |
| 无 CI、无 `npm audit`、打包验证依赖本地脚本 | push/PR 自动执行 test、lint、audit、build、asar smoke test |
| 当前工作区 33 个文件混合改动 | 先冻结基线并拆分提交，后续每阶段单一主题 |

---

## 3. 目标架构

```text
┌────────────────────────────────────────────────────────┐
│ Renderer                                               │
│  views/ · player/ · state/ · platform-client/          │
│  只处理展示、用户操作、播放状态；不直接访问平台网络      │
└───────────────────────┬────────────────────────────────┘
                        │ preload 白名单 IPC
┌───────────────────────▼────────────────────────────────┐
│ Main application boundary                              │
│  ipc/ handlers  →  application services  →  domain     │
│  参数校验          搜索/取流/下载/队列/历史用例          │
└──────────┬───────────────────────┬─────────────────────┘
           │                       │
┌──────────▼─────────┐   ┌─────────▼────────────────────┐
│ Infrastructure      │   │ Platform gateway             │
│ atomic storage      │   │ registry + adapters          │
│ downloader          │   │ netease/qq/...               │
│ updater/logger      │   │ 统一 search/getUrl/lyrics    │
└────────────────────┘   └──────────────────────────────┘
```

### 3.1 建议目录

```text
src/
├── main/
│   ├── index.js                 # 仅启动编排、生命周期、依赖组装
│   ├── bootstrap/               # app ready、窗口、菜单、tray、updater
│   ├── ipc/                     # IPC 薄适配层：校验参数、调用 service、映射错误
│   ├── services/                # 应用用例
│   │   ├── searchService.js
│   │   ├── resolveTrackService.js
│   │   ├── downloadService.js
│   │   ├── playbackService.js
│   │   ├── playlistService.js
│   │   └── platformService.js
│   └── runtime/                 # context、队列调度、任务取消、健康状态
├── domain/
│   ├── music.js                 # Song、Candidate、TrackResult 规范化
│   ├── errors.js                # 错误码与可展示错误
│   ├── policies.js              # 质量、换源、重试策略
│   └── ports.js                 # 平台网关、存储、下载器接口约定
├── api/
│   ├── registry.js              # 统一导出 registry（逐步替代旧 pluginRegistry 命名）
│   ├── gateway.js               # 对外只暴露平台无关的 gateway
│   ├── platforms/               # manifest + adapter 实现
│   └── request.js
├── infra/
│   ├── storage/                 # prefs/history/queue/library 的持久化实现
│   ├── network/                 # URL guard、DNS pinning、HTTP 请求
│   └── media/                   # 下载、转码、ID3、文件名
├── renderer/js/
│   ├── app/                     # bootstrap、router、i18n、platform theme
│   ├── state/                   # 播放器/下载/设置/播放列表状态
│   ├── components/              # toast、virtualList、sourceBadge 等
│   └── views/                   # 页面模块，保持现有 DOM 方案
└── shared/                      # renderer/main 共用的常量、DTO、错误序列化
```

> 目录不要求一次创建完。迁移阶段可以先使用现有路径，通过兼容导出逐步移动，避免大规模文件重命名造成难以审查的 diff。

---

## 4. 分阶段执行路线

### 阶段 0：冻结基线与拆分当前改动

**目的：先让重构可审查、可回滚。**

动作：

1. 保存当前通过状态：`npm test`、`npm run lint`、`npm run build`；
2. 将当前 33 个混合改动按主题拆成独立提交：
   - 平台 v3 / registry；
   - IPC 与主进程安全；
   - 播放器与页面 UI；
   - i18n / CSS；
   - 测试和文档；
3. 固定基线指标：测试数量、平台顺序、候选源、CORS origins、IPC 通道、打包产物；
4. 在重构分支上执行，主分支只接收阶段性可运行提交。

验收：

- 每个提交都能单独说明目的；
- 每个提交后 `npm test`、`npm run lint` 通过；
- 建立 `docs/architecture/refactor-baseline.json` 或等价的不可执行快照；
- 不改变用户可见行为。

回滚：只需回退当前阶段提交，不需要恢复整个工作区。

---

### 阶段 1：完成平台 registry 与 Gateway 收敛

**优先级：P0。先解决平台扩展和跨源逻辑的结构性问题。**

> **实现状态（2026-09-17）：核心已完成，提交 `8012707`。**
> - 新增 `src/api/gateway.js`（22 个方法）作为平台调用唯一出口；
> - 新增 `src/api/gatewayAccess.js` 解决 api 层内部消费方的循环依赖；
> - `recommendations.js` 平台直连清零（原 4 处 require + 多路 if/else）；
> - `onlineCover.js` 平台直连清零（原 2 处）；
> - `api/index.js` 六个路由函数改走 gateway；
> - 测试 352 → **381 pass / 0 fail**，ESLint 零告警；
> - 真实链路验证：netease/kugou 搜索各 30 条、netease.hot 榜单 100 条。
>
> 遗留（见下方 1.2 注）：推荐域方法仍是「过渡字典」映射平台老式具名导出，
> 尚未正式纳入 manifest 能力推导。

#### 1.1 registry 保留为唯一事实源

完善现有 `src/api/pluginRegistry.js`，新增/固定以下接口：

```js
registry.get(id)
registry.getAll()
registry.getCapabilities(id)
registry.getProbeSources()
registry.getFallbackSources()
registry.getLinkPatterns()
registry.getAllowedOrigins()
registry.toClientPayload()
```

所有接口返回不可变数据或新数组，避免调用方修改 registry 内部状态。

#### 1.2 引入 platform gateway

新增 `src/api/gateway.js`，只暴露平台无关操作：

```js
search(source, keyword, options)
getUrl(source, songId, quality, options)
getLyrics(source, songId, options)
getSongDetail(source, songId, options)
searchAlbum(source, keyword, options)
searchSinger(source, keyword, options)
```

Gateway 负责：

- source 是否存在；
- 方法是否具备；
- 参数 DTO 转换；
- 平台异常转换为统一错误；
- 不让 `recommendations.js`、下载服务、播放服务直接 require 平台文件。

#### 1.3 消除 `recommendations.js` 直连

把 `src/api/recommendations.js` 的平台 if/else 分派迁移到 gateway/registry：

```js
const plugin = registry.get(source);
if (!plugin || !registry.getCapabilities(source).singer) {
  return { items: [], error: 'UNSUPPORTED_CAPABILITY' };
}
return gateway.searchSinger(source, keyword, options);
```

验收：

- `recommendations.js` 不再出现平台模块 require；
- 所有 8 个平台的能力测试通过；
- registry 契约测试覆盖“声明能力 → gateway 可调用”；
- CORS、探针、换源候选、linkParser 结果与基线逐条相等；
- 运行时日志中不出现“平台加载后静默跳过”。

回滚：保留旧 `api/index.js` 导出作为一个版本周期的兼容层，gateway 失败时不改变旧错误文案。

---

### 阶段 2：抽取核心应用服务，统一搜索与取流

**优先级：P0。解决主进程业务交织和播放/下载逻辑重复。**

#### 2.1 统一领域 DTO 与错误

新增 `src/domain/music.js`：

```js
Song = {
  id, source, title, artist, album,
  duration, quality, artwork, lyrics,
  _altSource?
}

TrackResult = {
  ok: true,
  url, ext, source, matchedSong?, matchedFrom?
}
```

新增 `src/domain/errors.js`，固定错误码：

- `INVALID_ARGS`
- `NOT_FOUND`
- `LOGIN_REQUIRED`
- `VIP_REQUIRED`
- `NO_AUDIO`
- `RATE_LIMITED`
- `NETWORK_ERROR`
- `SOURCE_UNAVAILABLE`
- `UNSUPPORTED_CAPABILITY`
- `ABORTED`

平台原始错误只在 adapter 边界转换一次，UI 不再依赖平台私有字符串。

#### 2.2 新建 ResolveTrackService

将 `getDownloadUrlSmart` 的职责迁移到 `src/main/services/resolveTrackService.js`：

```js
resolve(song, options)
  -> 取 _altSource 记忆
  -> 取本源 URL
  -> 按错误策略判断是否换源
  -> matchMusic 匹配候选
  -> 按 sourceHealth 排序并逐个取流
  -> 写回匹配结果
```

服务必须注入依赖，不直接读取全局变量：

```js
createResolveTrackService({ gateway, registry, sourceHealth, matcher, cookieStore, logger })
```

#### 2.3 下载与播放共享服务、各自处理副作用

- `downloadService`：调用 resolve → 文件流写入 → metadata → history；
- `playbackService`：调用 resolve → 返回 URL → 播放竞态守卫 → loadeddata 超时；
- 两者不再各自实现一份“重试/换源/错误判断”。

验收：

- `getDownloadUrlSmart` 变为兼容 facade，旧调用方暂时不改；
- 新服务有纯单测：本源成功、VIP 换源、登录缺失、缓存失效、候选误匹配、取消任务、429 退避；
- 播放与下载的换源结果一致；
- 所有 IPC handler 不再直接调用平台 adapter；
- 现有 352 测试保持全绿，新服务测试至少覆盖关键分支。

回滚：兼容 facade 保留；通过配置开关可将 resolve 请求回退到旧函数，但默认走新服务。

---

### 阶段 3：主进程 IPC 薄化与运行时状态隔离

**优先级：P1。降低 `src/main/index.js` 的变更风险。**

#### 3.1 IPC handler 只做四件事

每个 handler 统一为：

1. 校验并规范化入参；
2. 获取 service；
3. 调用 service；
4. 序列化成功值或错误。

示例：

```js
ipcMain.handle('download-start', async (_event, raw) => {
  const input = validateDownloadInput(raw);
  try {
    return await ctx.services.download.start(input);
  } catch (error) {
    throw serializeIpcError(error);
  }
});
```

#### 3.2 `context` 只保存依赖和运行时状态

将 `src/main/context.js` 固定为依赖容器：

- `services`；
- `stores`；
- `platformGateway`；
- `windows` getter；
- `queues`；
- `logger`。

禁止 service 反向 require `main/index.js` 读取可变全局变量。

#### 3.3 队列与任务取消

新增任务标识和取消协议：

```js
{ taskId, kind, status, abortController, createdAt }
```

下载、播放 URL 获取、批量转换都应支持 `AbortSignal`。窗口关闭时先取消可取消任务，再 flush 持久化。

验收：

- `src/main/index.js` 目标降至 300 行以内；
- IPC 白名单仍由 preload 三处契约守卫；
- 关闭窗口、取消下载、重复启动、异常退出测试通过；
- 不新增渲染层可直接调用主进程内部模块的路径。

---

### 阶段 4：渲染层按领域拆分，不做框架迁移

**优先级：P1。先拆职责，暂不改技术栈。**

#### 4.1 `app.js` 拆分顺序

按低风险到高风险：

1. `app/bootstrap.js`：DOM ready、API 初始化、平台清单加载；
2. `app/i18n.js`：语言初始化、翻译、语言切换；
3. `app/platforms.js`：平台清单、名称、badge theme、source select；
4. `app/router.js`：路由注册和导航；
5. `app/windowBridge.js`：window 事件与 IPC 订阅；
6. `app.js` 只保留组装顺序。

#### 4.2 player.js 拆分

- `player/core.js`：audio 元素和播放生命周期；
- `player/resolve.js`：取流请求、竞态守卫、超时刷新；
- `player/queue.js`：队列索引、循环、随机；
- `player/lyrics.js`：歌词同步；
- `player/ui.js`：标题、进度、按钮状态。

#### 4.3 views 拆分标准

每个 view 最多保留：`render()`、`bindEvents()`、`destroy()`、少量 view state。业务规则移到 service 或纯函数。禁止 view 直接拼平台请求和持久化文件。

验收：

- app.js、player.js、local.js 目标均低于 500 行；
- 现有无头验证台、语言切换、平台下拉、badge、播放器、桌面歌词全部通过；
- 不改变 DOM id、IPC channel 和用户数据格式；
- 用模块契约测试替代“启动后看起来正常”。

回滚：每次只迁移一个模块，旧导出保留到下一阶段结束；发现回归时只恢复该模块入口。

---

### 阶段 5：基础设施工程化与可发布性

**优先级：P1。让质量不依赖个人记忆。**

#### 5.1 CI 最小闭环

新增 GitHub Actions：

- Node 22；
- `npm ci`；
- `npm test`；
- `npm run lint`；
- `npm audit --audit-level=high`；
- `npm run build`；
- 生成后运行 asar 内容 smoke test；
- PR 不自动发布，发布只由 tag 触发。

#### 5.2 依赖治理

- 依赖版本锁定并定期更新 lockfile；
- 将 `npm audit` 结果分为生产阻塞和开发依赖提示；
- 为 Netease/QQ 两个高风险第三方 API 依赖增加超时、协议变更、返回形态的适配测试；
- 不在本阶段擅自替换平台 API 实现。

#### 5.3 打包优化

先做低风险项：

1. 压缩 `assets/icon.png`；
2. 逐项验证并排除运行时不用的模板/CLI 目录；
3. 建立 app.asar 体积预算（目标 < 32MB，失败只告警，确认依赖后再阻塞）；
4. 打包后至少启动一次并验证 IPC、平台 registry、播放器和下载入口。

验收：

- PR 必须通过 test/lint/build；
- 高危审计问题阻断合并；
- 安装包体积下降且功能无回归；
- 发布产物只保留当前版本和必要校验文件。

---

## 5. 推荐提交顺序

```text
refactor/baseline-split
  01 chore: freeze baseline and split mixed changes
  02 refactor(platform): complete registry gateway
  03 refactor(service): extract track resolution
  04 refactor(main): thin ipc handlers and isolate runtime context
  05 refactor(renderer): split app bootstrap and platform client
  06 refactor(player): split playback core and queue
  07 chore(ci): add test lint audit build gates
  08 chore(package): optimize asar and release validation
```

每个提交都必须满足：

- 主题单一；
- 可以独立构建；
- `npm test` 和 `npm run lint` 通过；
- 变更说明包含“行为是否改变”；
- 不把格式化全仓、文件搬迁和业务修改混在一起。

---

## 6. 不做的事情

1. 不把 Electron 换成 Tauri；
2. 不在本轮迁移 React/Vue/TypeScript；
3. 不引入运行时第三方插件或 Lua 脚本；
4. 不重写 8 个平台的请求协议；
5. 不改变已有用户数据格式、IPC channel、下载文件命名规则；
6. 不以“删掉测试”换取重构通过；
7. 不把本地备份、预览产物、历史安装包纳入版本控制。

这些事项要么收益不足，要么会把结构性重构扩大成产品重写。

---

## 7. 第一批建议立即执行的任务

### Sprint A：基线与 registry

- [x] 拆分当前 33 个混合改动 —— 已由 `7962222` / `a209e31` / `efc35ab` 等提交完成
- [ ] 给 registry 增加不可变返回与能力契约（部分完成：gateway 只读调用已就位）
- [x] 新增 `api/gateway.js` —— `8012707`
- [x] 将 `recommendations.js` 迁移到 gateway —— `8012707`
- [x] 增加“所有平台能力均可从 registry 调用”的测试 —— `8012707`
- [x] **收尾**：把推荐域方法正式纳入 manifest，使 gateway 的
      `RECOMMEND_METHODS` 过渡字典可从 registry 派生 —— **已完成**
      - registry：`CAPABILITY_METHODS` 增补 8 项（playlistSongs / topList /
        recommendPlaylists / categoryPlaylists / newSongs / radioStations /
        hotSingers / ranking），能力位由方法存在性推导；
      - manifest：netease / qq / bilibili 以**标准方法名**声明实现，
        不再依赖老式具名导出；
      - gateway：`RECOMMEND_METHODS` 字典**已删除**，`recommendCall` 直接
        `plugin[method](...)`；cookie 差异收敛为 `WITH_COOKIE_METHODS`（仅 getRanking）；
      - 契约测试：新增 2 条守卫（gateway 不得持平台→方法字典；
        registry 能力表须覆盖 gateway 全部推荐域方法）。
- [x] **连带修复**：qq-music-api 上游游离异常导致**整个进程崩溃**
      - 症状：`routes/top.js` 在上游 HTTP 400 时裸读 `result.detail.data.data.period`
        → async route 抛错逃逸成游离 rejected promise → Node unhandledRejection → 进程退出；
      - 根因：该 SDK 的 `api()` 用同步 `try/catch` 包裹 **async** route，捕不到异步抛错；
      - 修复：`qq.js` 模块级常驻 `unhandledRejection` 兜底，按消息特征识别并隔离
        （不吞其它模块的异常），计数可观测；所有 `qqMusic.api` 调用统一走 `safeQQApi`；
      - 顺带修正：此前「按调用窗口临时挂监听」的写法会让好端端的 `qq.recommend`
        被并发的 `qq.top` 异常连累成 0 条 —— 已改为常驻兜底后恢复正常（12 条）。
      - ⚠️ 遗留：`qq.top` 上游接口本身已 HTTP 400（QQ 侧变更），当前优雅退化为 0 条，
        不影响进程与其它分区；需后续跟进上游接口变更。

### Sprint B：ResolveTrackService

- [x] 抽取统一 `Song` / `TrackResult` —— `src/shared/dto.js`
      - 只定义**形状**与幂等归一化（`normalizeSong` / `normalizeTrackResult`），
        不含平台知识、不做网络请求；
      - `isSongLike()` 作为平台脏数据进入 UI 前的统一过滤器
        （历史坑：缺 id 的条目渲染出无法点击的空卡片）；
      - `normalizeTrackResult` 对失败规范为 `{ error, code, fatal }` ——
        换源流程依赖 `code`，**不能**规范掉。
- [x] 将 `getDownloadUrlSmart` 迁移到 service —— `src/api/services/resolveTrackService.js`
      - 四个依赖全部注入：`getUrl` / `searchFn` / `hasCookie` / `findCandidates`
        + `sourceHealth`；无处藏模块级单例；
      - `shouldFallbackToOtherSource()` 作为**导出的纯函数**，可独立断言
        （换源决策是历史上最容易改错的地方：多换一次白费请求，少换一次用户听不了）；
      - 构造时校验必需依赖，缺失立即抛错（早失败优于静默失效）。
- [x] 保留 facade，逐个迁移下载和播放调用方
      - `api/index.js` 的 `getDownloadUrlSmart` 缩为**薄委托**（< 12 行），
        签名与返回形状与重构前完全一致（零回归）；
      - 下载（`main/index.js processOneSong`）与播放（`renderer/player.js`）
        本就共用该入口，无需改造 —— 本次只是让「共用」有了明确边界；
      - 契约守卫：`api/index.js` 不得再自带决策函数 / 错误码集合。
- [x] 增加错误码、取消、429、换源和 URL 过期测试
      - 已覆盖：错误码分流（换源类 vs 网络类 vs 未知源）、换源逐候选重试、
        全失败返回本源错误、`_altSource` 记忆命中/失效/同源忽略、
        健康度重排与记账失败旁路、脏候选跳过、id 类型归一、异常收敛；
      - **已完成**：
        - 429 限流退避 —— `test/request-ratelimit.test.js`（9 例）：重试到上限、
          中途恢复、`retries=0` 不重试、错误携带 `statusCode`/`responseBody`、
          退避按 `baseDelay × 3^attempt` 增长（用真实耗时与相邻请求间隔双重验证）、
          429 与 5xx 共用同一重试通道、4xx 中非 429 者不重试、限流 body 不污染成功路径；
        - URL 过期重取 —— `test/resolveTrackService.test.js` 新增 5 例：
          无 code 的 HTTP 文本经 `normalizeTrackResult` 后**仍保留** HTTP 特征
          （若被抹掉则 `FALLBACK_HTTP_RE` 永久失效）、直链失效⇒返回**新链**不复用旧链、
          二次 `resolve` 重新取流不被缓存短路、全池失效⇒收敛为可识别错误而非空 url 静默成功、
          `matchedSong` 随过期换源一并返回（否则下游无法回写 `_altSource`）；
        - 变异验证：把 `FALLBACK_HTTP_RE` 改成永不匹配后上述 3 例如实转红，
          证明守卫不是"写了就绿"。
      - ⚠️ **请求取消（AbortSignal）在本轮确认为「缺功能」而非「缺测试」**：
        `src/api/request.js` 的 `request()` / `_followRedirects()` / `_probeAudio()`
        全部没有 `signal` 参数；全仓 `AbortController` 只出现在
        `renderer/js/views/ai-music.js`（AI 音乐生成，与本模块无关）。
        重构轮**不伪造**该测试（伪造等于用测试固化一个假象），
        另立独立特性项（见下方「后续候选」）。

### Sprint C：主进程与渲染层

- [x] 把 index.js 的业务代码逐段移动到 services/bootstrap
  - 已完成：`main/downloadQueue.js`（442 行，全依赖注入）抽出，`index.js`
    900 → 641 行。引擎在 `app.whenReady()` 内、`registerAllIpcHandlers()`
    之前装配；`dispose()` 刷出 debounce 中未落盘的写，避免退出丢队列。
  - 顺带修掉 `utils/logger.js` 缺 `info()`：`downloader.js:591` 的断点续传
    分支调用它 → TypeError，**整条断点续传路径长期被打断**（仅「传输出错 +
    已有部分落盘」时触发，故未暴露）。
  - 未做：剩余窗口/托盘/生命周期代码仍在 `index.js`。当前 641 行已低于
    当初 900 行的告警线，且这部分天然是 Electron 生命周期胶水，
    进一步拆分的收益低于「拆完多一层跳转」的成本，**有意保留**。
- [~] 拆 app.js 的 bootstrap、i18n、platforms、router
  - 已完成（等效目标）：`i18n.js` 三处缺陷修复（语言被自身覆盖、
    选择从不持久化、`textContent` 摧毁内嵌 `<code>`）；
    platforms 部分抽出 `getPlatforms/setPlatforms/platformName/fallbackPlatformIds`
    到 `utils.js`，平台事实改由主进程 IPC 驱动。
  - 已完成（本轮，commit `a00567e`）：`init()` 内 4 个闭包函数
    （`syncToTray` / `syncToMiniPlayer` / `syncToDesktopLyric` /
    `restorePlayQueueFromSaved`）外提为 `player-sync.js`，
    `app.js` 1099 → 1012 行。等价迁移，行为零改动。
  - **上一轮此处的判断过于保守，已修正**：原文写「先做闭包→显式依赖注入，
    那是独立一轮工作量」。实测：这 4 个函数**只被 `init` 调用、彼此互调**，
    对模块外零调用方；「互相闭包引用同一批模块级变量」并不成立 ——
    `_dlLastLyricSongId` / `_queueRestored` 各由唯一函数持有，
    真正跨函数的共享状态**只有 `_audio` 一项**（且它本来就在模块级，
    注释还写着「init 和 syncToMiniPlayer 都要访问」）。
    故前置条件是「加一个形参」，成本极低，本轮直接完成，**未多花一轮**。
  - 未做：`app.js` 仍有 1012 行，其余为 UI 装配（`switchTab` / 下载列表
    / 播放列表弹窗 / 队列渲染等）与 ~40 行「副作用 import」聚合入口。
    后者的存在是 Vite 打包完整的必要条件，不是可清理的冗余。
    余下函数彼此通过 `window.*` 与模块级 `api` 通信，可按功能域继续拆，
    但收益递减；**判定为可选后续项**。
- [~] 拆 player.js 的 resolve、queue、lyrics、ui
  - 已完成：lyrics → `player/lyrics.js`、stats → `player/stats.js`
    （上一轮完成）；本轮修复顶栏状态文案错乱的单一判据问题
    （新增 `refreshPlayerState()`）。
  - 已完成（本轮，commit `4cfa017`）：EQ 簇 → `player/eq.js`（141 行），
    `player.js` 971 → 884 行。等价迁移，公开面逐字不变；两轴验证：
    对 HEAD 与当前各构建一次 bundle，window 公开面 266 条 diff 逐字一致、
    6 个 EQ 函数实现片段逐字一致。
    先决条件 `test/renderer-contract.test.js`（上一轮 `ac5307e`）已就位。
    **上一轮此处的依赖分析有误**：原文写「对外仅依赖 `audio` 与 `logger`」，
    实际 EQ 簇不依赖 `audio`，真实依赖是隐式全局 `api`（由 `app.js` 的
    `Object.defineProperty(window,'api',{get})` 提供）与 `document`。
  - 拆的过程中查明 EQ 两条**既有**缺陷（非本次引入，见下），
    以 `test/eq-behaviour.test.js`（11 条）"现状钉住"式守卫：
    - A. `eqFilters` 恒为空数组（全仓无 `createBiquadFilter` /
      `createMediaElementSource` / `createGain`，`git log -S` 亦为空），
      所有 `if (eqFilters[i]) ...gain.value =` 永不进入 → 对声音零影响。
      `index.html` 已有用户可见警告，行为如实保留。
    - B. 偏好只写不读：`saveEqSettings` 写 `prefs.eqGains`，但
      `restoreEqPresetSetting` 只读 `eqPreset`/`eqBypass`，从不回读
      `eqGains` → 手调单段增益重启后丢失（滑块回到最后一次预设曲线）；
      且 `getEqGains()` 在 `eqFilters` 为空时返回 `[]`，等于每次存盘写空数组。
      这条连 `index.html` 的"仅保存偏好"文案也只说对一半。
    修 A 需真正接上音频图、修 B 需补 `eqGains` 回读 —— 均属独立功能轮次，
    且会按设计转红对应测试，强制显式决策。
  - 未做：`player.js` 仍有 resolve/queue/ui 三类簇未拆（播放列表、
    进度记忆、音量/倍速、队列控制等），884 行。
- [x] 补 CI 与 asar smoke test
  - `.github/workflows/ci.yml`：两层闸门 —— lint-test（ubuntu，秒级）
    → build-smoke（windows，真实打包 + asar 解包校验）。
    `npm ci` 而非 `install`：lock 与 package.json 不一致时直接失败。
  - `scripts/smoke-asar.js`：把原先 `.preview/assert-asar-<ver>.cjs`
    的一次性脚本产品化为可复用工具，断言清单**从 src 目录派生**
    （写死清单的话新增平台时永远「通过」，等于没测）。
    本轮新增第 8 条：eq.js 的 export 面 → 断言打包后 bundle 里 6 个
    `window.*` 全在。这是「拆分真出事」的唯一兜底 —— eq.js 若被
    tree-shake 或 re-export 断链，HTML 里 8 个 `onclick`/`oninput`
    会静默失效，而 `vite build` 照样成功。已实测：注释掉
    `window.resetEq` 后重新打包，断言 FAIL「缺: resetEq」。
    注意断言前必须 `stripJsComments`：压缩产物里被注释掉的挂载会被
    裸正则误判为「已挂载」，守卫等于白设（实测踩过）。
  - `npm run verify`：lint + test + build + smoke:asar 一条命令。
  - 实测收获：该脚本一上线就抓出 `release/` 里的包是 13 小时前的旧产物
    （缺 `downloadQueue.js`、`gateway.js`、`shared/dto.js`），
    以及 `build/config.cjs` 的 `files` 清单漏了 `package-lock.json`
    —— 后者已修（依赖树的唯一事实来源，只打 package.json 会丢传递依赖版本）。
  - 本轮再次验证「打包成功 ≠ 内容正确」：`npm run build` 只更新 `dist/`，
    不重打包 asar。用旧 asar 跑 smoke 会拿到旧结论（实测曾因此误判
    「守卫没生效」）。**凡改了渲染层源码要跑 smoke，必须先重新 package。**

---

## 8. 最终验收门槛

重构完成不以“目录看起来漂亮”为标准，而以以下门槛为准：

- 测试：所有旧测试通过，新核心服务分支覆盖率不低于当前水平；
- 安全：Electron 安全三件套、CORS 逐条基线、preload 白名单契约全部通过；
- 架构：平台业务代码只能通过 registry/gateway 进入；IPC handler 不包含平台分派和文件写入细节；
- 数据：旧版 queue/history/prefs/library 可以无迁移读取；
- 行为：搜索、播放、下载、换源、歌词、历史、队列、更新器和桌面歌词无回归；
- 工程：CI 能在干净环境完成 test/lint/build/audit；
- 发布：安装包可启动，asar 内容不含本机临时路径、备份文件和开发验证产物；
- 回滚：任一阶段可以独立回退，且不会破坏上一阶段的用户数据和接口兼容性。

## 9. 一句话排序

**先拆提交边界 → 再收敛 registry/gateway → 再抽取取流服务 → 再薄化 IPC → 再拆 renderer → 最后补 CI、依赖治理和打包优化。**

---

## 10. 重构中发现的「缺功能」（非缺陷，需独立立项）

以下问题不是重构引入的，也不是「少写了测试」，而是**能力本身不存在**。
重构轮坚持「提交不顺手改行为」，故一律只记录、不实现 —— 实现属产品决策。

### 10.1 请求取消（AbortSignal）——`src/api/request.js`

- **现状**：`request()` / `_followRedirects()` / `_probeAudio()` 均无 `signal` 参数；
  全仓 `AbortController` 只出现在 `renderer/js/views/ai-music.js`（AI 音乐生成，无关）。
- **影响**：切歌/关窗/取消下载时，已在飞的 HTTP 请求无法中断。
  最坏情况是 15s 超时（`request`）或 8s（`testAudioLink`）内仍占着连接与句柄，
  下载队列批量换源时表现为「点了取消但进程还在跑」。
- **成本**：`request.js` 内部改造 + 三条调用链（下载队列、播放取流、AI 音乐）接上
  生命周期取消点；约 1 个独立轮次。
- **决策前需明确**：取消语义是「放弃结果」还是「中断传输」；后者需处理
  `aborted` 被 `isRetriableError` 判为可重试的问题（当前 `aborted` 在正则里，
  取消会被误当成网络抖动而重试 —— 这是接 signal 时必须同时处理的）。

### 10.2 EQ 均衡器实际不生效 ——`src/renderer/js/player/eq.js`

- **现状**（已由 `test/eq-behaviour.test.js` 以「现状钉住」方式守卫）：
  1. `eqFilters` 在仓库内**不存在任何填充点**（无 `createBiquadFilter` /
     `createMediaElementSource`），故恒为空数组，所有 `if (eqFilters[i])`
     分支永不进入 ⇒ 对声音零影响。UI 已如实标注「均衡器暂不生效」。
  2. `saveEqSettings` 会写 `prefs.eqGains`，但 `restoreEqPresetSetting` 只读
     `eqPreset` / `eqBypass`，**从不回读** `eqGains` ⇒ 手调单段增益重启后丢失。
- **影响**：设置页的 EQ 是「看起来能用、实际无关」的功能。
- **成本**：需接 `AudioContext` + `createMediaElementSource` + 滤波链
  （注意与已有 `proxyPlay` 的 `file://` 源、以及桌面歌词/迷你播放器共用 audio 元素的冲突）。
- **若修，须同批改四处**（漏一处即产生新的不一致）：
  `player/eq.js` 实现、`index.html` 的 `eqNotEffective` 警告文案、
  i18n 词条、`test/eq-behaviour.test.js` 的钉住断言。

### 10.3 `request.js` 头部注释与实现不符（文档级）

- 注释写「指数退避 200ms → 600ms → 1800ms」，但默认 `retries = 2` 意味着
  总共只发 3 次请求、只经历 **200ms + 600ms** 两次退避；1800ms 仅在
  `retries >= 3` 时出现。已在 `test/request-ratelimit.test.js` 中用真实耗时
  钉住实际行为（不退避即转红），此处仅备注文档待订正。
