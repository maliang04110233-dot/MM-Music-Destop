# MusicDL 代码审查报告

> 审查日期：2026-09-17 ｜ 版本：1.0.19 ｜ 审查范围：`src/` 全量（133 文件 / 23,258 行 JS）
> 方法：静态阅读 + 自动化实测（测试套件、ESLint、asar 解包、依赖体积统计、源码字面量普查）
> 结论：**工程成熟度高于同类开源项目，可发布**；有 3 项需在下次发版前处理，无阻塞级缺陷。

---

## 一、审查结论摘要

| 维度 | 评级 | 说明 |
|---|---|---|
| 安全边界 | **优** | Electron 三件套正确、CORS 白名单派生 + 严格后缀、无硬编码密钥 |
| 测试覆盖 | **优** | 352 个用例全绿，含契约测试与真实 HTTP 端到端 |
| 代码健康 | **良** | ESLint 零告警；但 5 个文件超 800 行，最大 1099 行 |
| 架构一致性 | **良** | 平台 v3 单一事实来源基本落地；2 处遗留耦合点 |
| 仓库卫生 | **中** | 工作区 4.5GB 冗余产物；待提交改动 33 文件 / +2180 行 |
| 工程链路 | **中** | 无 CI 配置、无依赖漏洞扫描、安装包 123MB 偏大 |

**实测数据**

| 指标 | 实测值 |
|---|---|
| 测试用例 | 352 pass / 0 fail（19.2s） |
| ESLint | 0 error / 0 warning |
| 平台适配器 | 8 个（netease / qq / bilibili / kugou / kuwo / migu / fivesing / soda） |
| 单文件最大行数 | `src/renderer/js/app.js` 1099 行 |
| 待提交改动 | 33 文件，+2180 / −1626 行 |
| 安装包 | 123 MB（app.asar 37 MB） |
| 工作区冗余 | `.backup` 1.5G + `.preview` 1.1G + `release` 1.9G ≈ 4.5 GB |

---

## 二、值得肯定的设计（非客套，均有代码证据）

**1. 安全基座正确。** `src/main/index.js:203-205` 三件套齐备：`nodeIntegration: false`、`contextIsolation: true`、`webSecurity: true`。渲染层全仓零 `fetch` / `XMLHttpRequest` 调用，网络能力全部收归主进程 —— 这是正确的架构选择，把攻击面压到了 IPC 白名单这一层。

**2. CORS 白名单是全工程唯一安全边界，且处理得极其克制。** `src/main/index.js:563-588` 的注释明写"这是本工程唯一的安全边界"，后缀匹配坚持带前导点（`.douyinvod.com`），使 `evil-douyinvod.com` 无法通过 `endsWith` 检查 —— 这个细节很多项目会写错。且白名单由平台 manifest 派生而非手写 20 条，减少漏配风险。

**3. 已有的修复报告质量很高，且真落地了。** `MusicDL-升级方案.md` 里的换源机制、原子写、`_altSource` 记忆全部在 `src/api/index.js:188-248`、`src/utils/atomicFile.js` 中实现，不是纸上方案。换源逻辑还额外加了源健康度重排（`sourceHealth.rankByHealth`），比原方案更完整。

**4. 测试不是摆设。** `test/urlGuard.test.js` 包含 `makePinnedLookup` 的 DNS rebinding 防护测试与真实 HTTP 端到端连接测试；`test/platform-contract.test.js` 有 30 个用例专门钉住"加平台漏改"这类静默失效。这种契约测试在个人项目中非常罕见。

---

## 三、问题清单

### P1 — 建议下次发版前处理

**P1-1 · 待提交改动混杂，无独立提交边界**

工作区有 33 个文件、+2180/−1626 行未提交，涵盖平台 v3 重构、播放器 UI、i18n、CSS 全量重排（`player.css` 单文件 1177 行变更）。`docs/architecture/platform-plugin-v3.md:408` 自己把 R6"一次性改动过大 → 难以定位回归"评为 🔴 高，而当前工作区状态恰好就是这个风险本身。

建议：按 v3 的 5 阶段拆分提交（阶段 1 / 2 / 3 / 4 各一个 commit），UI 与 CSS 另起 commit。每个 commit 应能用 `git diff --stat` 自证"只改了预期文件"。

**P1-2 · 安装包 123MB，asar 内 37MB 有明确可削减项**

实测 asar 构成：

| 体积 | 包 | 备注 |
|---|---|---|
| 8.6 MB | NeteaseCloudMusicApi | 真依赖，但含大量非运行时文件 |
| 3.6 MB | moment | 主要通过 xml2js/jade 传递引入 |
| 3.3 MB | xml2js | 传递依赖 |
| 1.5 MB | jade | **NeteaseCloudMusicApi 的模板引擎，运行时用不到** |
| 1.5 MB | node-forge | 传递依赖 |
| 1.2 MB | qq-music-api | 真依赖 |
| 1.1 MB | assets/icon.png | **单张 PNG 1.1MB，未压缩** |

两项零风险优化：① `assets/icon.png` 压缩到 256px（可省 ~1MB）；② `build/config.cjs` 的 `files` 字段排除 `jade` / `moment` / `xml2js` 等模板与 CLI 相关目录。预期可减 6-8MB。

**P1-3 · 供应链：关键依赖陈旧且无漏洞扫描**

`NeteaseCloudMusicApi@4.32.0` 与 `qq-music-api@1.1.2` 是两大核心依赖，均为第三方非官方逆向实现，其上游协议随时可能失效或被投毒。当前 `package.json` 无 `npm audit` 脚本，仓库内无 CI 配置（无 `.github/workflows/`）。

建议：① 加 `"audit": "npm audit --audit-level=high"` 脚本；② 加一个最小 CI（push 时跑 `npm test` + `npm run lint` + `npm audit`）；③ 定期核查两个 API 依赖的更新与安全公告。

### P2 — 可排期改善

**P2-1 · 巨型文件，维护成本已显现**

| 行数 | 文件 |
|---|---|
| 1099 | `src/renderer/js/app.js` |
| 1089 | `src/renderer/js/views/local.js` |
| 1032 | `src/renderer/js/views/ai-music.js` |
| 1017 | `src/renderer/js/views/search.js` |
| 971 | `src/renderer/js/player.js` |

`app.js` 已到 1099 行且承担启动编排、i18n、路由、IPC 桥接多职责。`docs/architecture/platform-plugin-v3.md` 已成功拆分过一轮（`views/` 目录即产物），建议对 `app.js` 与 `views/local.js` 沿用同一手法继续拆。

**P2-2 · 平台 v3 两处遗留耦合点（文档已自认）**

`platform-plugin-v3.md:55-59` 与 `:338-340` 记录了：
- `src/api/recommendations.js` 仍直接 `require('./platforms/{netease,qq,kugou,bilibili}')` 并按 id if/else 分派，**完全绕过 registry**；
- `_ADAPTERS` 中 netease/qq/kugou 声明的 `searchSinger` 等能力在 registry 里**无调用方**。

二者都有契约测试钉住（不会静默失效），但属于"知道该改、尚未改"。建议排入 v3.1。

**P2-3 · 仓库卫生：工作区 4.5GB 冗余**

`.gitignore` 已正确忽略（`.backup/`、`.preview/`、`release/`），不会污染仓库 —— 这点做得对。但本地实际占用：

| 目录 | 体积 | 内容 |
|---|---|---|
| `.backup/` | 1.5 GB | 11 个历史安装包（每个 84-118MB） |
| `.preview/` | 1.1 GB | 含 `package-verify` 641MB、`package-1.0.19` 405MB |
| `release/` | 1.9 GB | 4 个 `win-unpacked-*` 历史解包目录 |

建议保留最近 2 个版本，其余清理。**这是本地磁盘占用提醒，不是仓库问题。**

（附带发现：`git log` 显示 `538542a` 已清理过一轮误提交的本机产物，`.gitignore` 也加了 `Users*AppData*` / `C:*Users*` 防护规则 —— 这个教训转化得很到位。）

**P2-4 · 平台 id 字面量仍高度分散**

实测全仓出现次数：`qq` 275、`netease` 161、`bilibili` 107、`kugou` 106、`kuwo` 65、`migu` 49、`fivesing` 29、`soda` 28。

其中大部分是合法用法（函数名、CSS 类、测试描述）。v3 已把**清单类**字面量收敛并有守卫测试，但 `recommendations.js` 的分派仍是纯字面量。此项与 P2-2 是同一个问题的一体两面。

### P3 — 观察项，暂不建议动

**P3-1 · 渲染层 CSP 含 `'unsafe-inline'`**

`src/renderer/index.html:6`：`script-src 'self' 'unsafe-inline'`。在 `contextIsolation: true` + 零远程脚本加载的前提下，实际风险很低，且移除会牵动大量内联事件处理改写。**收益/成本比不佳，保持现状更合理。** 记录在案以便后续若引入任何远程内容时重新评估。

**P3-2 · 版权与合规**

`README.md:63` 已声明"仅供学习研究使用，请遵守各平台服务条款"，`LICENSE` 为 MIT。多平台聚合下载在多数司法辖区对 VIP/付费曲目存在授权争议（换源机制在技术上会绕开 VIP 限制）。**这是既有的产品定位问题，非代码缺陷**，但若要公开发布建议复核分发方式。

---

## 四、与开源参考项目的对比位置

参考项目 `musicdl-reference/`（Python 版多源下载器）与本项目思路不同：前者是 CLI、依赖同步阻塞、无 Electron 安全模型。

本项目的**架构分层与安全模型明显更成熟**：
- 主进程/渲染进程职责分离清晰，IPC 白名单化
- CORS 白名单派生 + 严格后缀匹配（多数同类项目直接 `webSecurity: false` 关闭）
- 单源失败自动换源 + 源健康度排序
- 原子写防数据损坏
- 352 个测试用例

**主要差距在工程链路**：无 CI、无依赖审计、安装包偏大、单文件偏大。

---

## 五、行动清单

| 优先级 | 事项 | 预期收益 |
|---|---|---|
| P1 | 按 v3 阶段拆分当前 33 文件改动为独立提交 | 可定位回归 |
| P1 | 压缩 `assets/icon.png`，`build/config.cjs` 排除 jade/moment/xml2js | 安装包 −6~8MB |
| P1 | 加 `npm audit` 脚本 + 最小 CI（test + lint + audit） | 供应链可见性 |
| P2 | 拆 `app.js`(1099) 与 `views/local.js`(1089) | 可维护性 |
| P2 | `recommendations.js` 改走 registry 分派 | 消除最后耦合点 |
| P2 | 清理 `.backup`/`.preview`/`release` 历史版本 | 释放 ~3GB 磁盘 |
| P3 | CSP `unsafe-inline` 立项观察（不建议现在改） | — |
| P3 | 公开发布前复核版权合规与分发方式 | 法务风险 |

---

## 六、复现命令

```bash
# 测试（实测 352 pass / 0 fail，19.2s）
npm test

# 静态检查（实测 0 error / 0 warning）
npm run lint

# 安装包体积分析（app.asar 37MB）
node -e "const fs=require('fs');const fd=fs.openSync('release/win-unpacked/resources/app.asar','r');const b=Buffer.alloc(16);fs.readSync(fd,b,0,16,0);const s=b.readUInt32LE(12);const jb=Buffer.alloc(s);fs.readSync(fd,jb,0,s,16);const h=JSON.parse(jb.toString('utf8').replace(/\0+$/,''));const agg={};(function w(n,p){for(const k of Object.keys(n.files||{})){const c=n.files[k];const q=p+'/'+k;c.files?w(c,q):(agg[q.split('/').filter(Boolean).slice(0,2).join('/')]=(agg[q.split('/').filter(Boolean).slice(0,2).join('/')]||0)+(c.size||0))}})(h,'');Object.entries(agg).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log((v/1048576).toFixed(1)+' MB  '+k))"

# 平台字面量分散度
for id in netease qq bilibili kugou kuwo migu fivesing soda; do
  echo "$id: $(grep -ro "\b$id\b" --include='*.js' src/ test/ | wc -l)"
done
```

---

*审查人：WorkBuddy AI ｜ 全部结论基于 2026-09-17 实测，非目测推算*
