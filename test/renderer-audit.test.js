/**
 * 渲染层审计回归（2026-09 全方位审查的高危功能 bug）
 *
 * 渲染层模块顶层碰 document，node:test 无法真跑 ——
 * 沿用 renderer-contract.test.js 的静态源码断言约定，
 * 每条断言都对应一个「修好前必然失败」的真实缺陷。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

test('search.js: doSearch 必须 await handleLinkInput 并以返回值为准（返回值即「已接管」信号）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /async function doSearch\(/, 'doSearch 需为 async');
  // 识别首个语句就是网络请求 → 必须 await；接管与否以返回值为准。
  // 早前用模块级 _linkHandled 传递，被剪贴板识别条留在 true 后会把下一次搜索静默吞掉。
  assert.match(src, /if \(await handleLinkInput\(/, '必须先 await 链接识别并消费返回值');
});

test('app.js: mockApi 只允许在浏览器预览(http)上下文兜底，打包 file:// 环境禁止假成功', () => {
  const src = read('js', 'app.js');
  assert.match(src, /allowMock\s*=\s*location\.protocol\.startsWith\('http'\)/,
    'buildApi 需按协议门禁 mock');
  assert.match(src, /allowMock \? Object\.assign\(\{\}, mockApi/,
    'mockApi 合并必须以 allowMock 为条件');
});

test('updater.js: downloadUpdate 必须真正 invoke download-update 通道（否则是 0% 假进度条）', () => {
  const src = read('js', 'updater.js');
  assert.match(src, /invoke\('download-update'\)/, '需要调用主进程 download-update handler');
});

test('settings.js: 下载模板 id 进 innerHTML 必须过 escQ/escAttr（外部快照可控 id 的 XSS 注入面）', () => {
  const src = read('js', 'views', 'settings.js');
  assert.doesNotMatch(src, /="\$\{tpl\.id\}"/, 'data-id 不得裸插 tpl.id');
  assert.doesNotMatch(src, /'\$\{tpl\.id\}'\)/, 'onclick 实参不得裸插 tpl.id');
  assert.match(src, /escQ\(tpl\.id\)/, 'onclick 实参应走 escQ');
  assert.match(src, /escAttr\(tpl\.id\)/, 'data-id 应走 escAttr');
});

// ── 中危批次：竞态范式 / referer 单源 / reset 派生 ──────────────

test('search.js: doSearchByType 必须有请求序号守卫（旧结果晚到不得覆盖新列表）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /let _typeSearchReqId = 0;/);
  assert.match(src, /if \(reqId !== _typeSearchReqId\) return/, 'await 后必须校验序号再写状态');
});

test('local.js: scanLocalDir 必须加重入锁（连点/fs.watch 推送并发只允许一次扫描）', () => {
  const src = read('js', 'views', 'local.js');
  assert.match(src, /let _scanRunning = false;/);
  assert.match(src, /if \(_scanRunning\) return;/);
});

test('取流 referer 单源：utils.js 提供 playReferer，5 处调用点不得再各写三元链', () => {
  const utils = read('js', 'utils.js');
  assert.match(utils, /function playReferer\(/, 'utils.js 需有唯一 referer 判定入口');
  assert.match(utils, /window\.playReferer = playReferer;/);
  const files = [
    ['js', 'app.js'],
    ['js', 'player.js'],
    ['js', 'views', 'home.js'],
    ['js', 'views', 'playlist.js'],
    ['js', 'views', 'search.js'],
  ];
  for (const f of files) {
    const src = read(...f);
    assert.match(src, /playReferer\(/, `${f.join('/')} 必须改走 playReferer`);
    assert.doesNotMatch(src, /=== 'bilibili' \? 'https:\/\/www\.bilibili\.com\//,
      `${f.join('/')} 不应再复制 referer 三元链`);
  }
});

test('settings.js: resetAllSettings 必须由 GENERAL_PREFS 表派生默认值（手抄必漏）', () => {
  const src = read('js', 'views', 'settings.js');
  assert.match(src, /Object\.values\(GENERAL_PREFS\)/, '恢复默认需遍历派生自表');
  assert.doesNotMatch(src, /const defaults = \{\n\s*quality:/, '不得再手写 defaults 清单');
});

test('settings.js: WebDAV 保存时非本机 http 地址必须提示明文风险（不阻断）', () => {
  const src = read('js', 'views', 'settings.js');
  assert.match(src, /startsWith\('http:\/\/'\)/, '以 http:// 前缀判定明文传输');
  assert.match(src, /localhost/, '本机地址（localhost/127.x/[::1]）应豁免提示');
  assert.match(src, /showToast\([^\n]*明文[^\n]*'warn'/,
    '非本机 http:// 保存时应给 warn 级 toast 提示，而不是静默保存');
});

test('settings.js: filenameTmpl 默认值必须与 naming.js DEFAULT_TEMPLATE 等值（渲染层无法 import，用等值钉）', () => {
  const { DEFAULT_TEMPLATE } = require('../src/utils/naming');
  const src = read('js', 'views', 'settings.js');
  const m = src.match(/filenameTmpl:\s*\{[^}]*default:\s*'([^']*)'/);
  assert.ok(m, 'GENERAL_PREFS 应含 filenameTmpl 默认值');
  assert.strictEqual(m[1], DEFAULT_TEMPLATE,
    '设置页手抄的模板默认值已与主进程命名模块漂移');
});

// ── 批②：渲染层死功能（2026-09 第二轮审计 H3/H4/H5/H6a/H6b/M13/local转换）──

test('local.js: 批量重命名的 path.* 必须来自 pathLite（渲染层无裸 path 全局，import node:path 会变裸 require 崩溃）', () => {
  const src = read('js', 'views', 'local.js');
  assert.match(src, /import \* as path from ['"]\.\.\/pathLite\.js['"]/,
    'nodeIntegration:false 下裸 path 是 undefined；node:path 经插件会变成裸 require，加载即崩');
  assert.doesNotMatch(src, /from ['"]node:path['"]/,
    'vite-plugin-electron-renderer 不 polyfill node 内建模块（bundle 实测 require("node:path")）');
});

test('download.js: 导出歌单必须接受 savePath（主进程终态写 savePath，filter s.filePath 恒空）', () => {
  const src = read('js', 'views', 'download.js');
  assert.match(src, /status === 'done' && \(s\.filePath \|\| s\.savePath\)/,
    '完成的队列项只有 savePath，按 filePath 筛永远导出为空');
  assert.match(src, /filePath: s\.filePath \|\| s\.savePath/,
    '导出条目同样需要回落 savePath');
});

test('local-stats.js: toggleDupSelect 实参必须走 escQ（esc 不转义反斜杠，Windows 路径在 onclick JS 字符串里被吃）', () => {
  const src = read('js', 'views', 'local-stats.js');
  assert.doesNotMatch(src, /toggleDupSelect\('\$\{esc\(/,
    'esc 输出进的是 JS 字符串字面量上下文，必须用 escQ');
  assert.match(src, /toggleDupSelect\('\$\{escQ\(/);
});

test('player.js: _playQueueIdx 链路必须经 playSongByIdx 取流播放（队列行永不携带 url，旧判断恒假）', () => {
  const player = read('js', 'player.js');
  assert.match(player, /export async function playQueueIdx\(/,
    'player.js 需导出 playQueueIdx 供队列行点击复用切歌链路');
  const app = read('js', 'app.js');
  assert.match(app, /playQueueIdx/, 'app.js 的 _playQueueIdx 应转调 playQueueIdx');
  assert.doesNotMatch(app, /queue\[idx\]\.url/, '队列行没有 url 字段，该分支恒假（H6a）');
});

test('virtualList.js: setData 必须强制重绘（同可视区间换数据——排序/过滤——非 force 渲染会早退成旧行）', () => {
  const src = read('js', 'virtualList.js');
  // 断言锚在 setData 函数体内（body 无嵌套花括号，[^}] 恰好圈住函数体）
  assert.match(src, /setData\(data\) \{[^}]*_render\(true\)/,
    'setData 后可视范围不变时 _render 无 force 早退，本地库排序/过滤失效错位');
});

test('download.js: 勾选不得双触发（input onchange 与容器 onclick 各 toggle 一次，净零）', () => {
  const src = read('js', 'views', 'download.js');
  assert.doesNotMatch(src, /onchange="event\.stopPropagation\(\);toggleDlSelect\(/,
    'input 的 click 冒泡到容器 onclick 已 toggle，onchange 再 toggle 一次 = 永远选不中');
});

test('local.js: 转码选中必须读本视图的 _selectedLocal（selectedSongs 是搜索页的状态，本地页恒空）', () => {
  const src = read('js', 'views', 'local.js');
  assert.doesNotMatch(src, /getState\('selectedSongs'\)/,
    'local.js 不该引用搜索页的 selectedSongs 状态');
  assert.match(src, /function _selectedSongsToConvert\(\) \{[\s\S]{0,500}_selectedLocal/,
    '转码选中应来自本视图的 _selectedLocal');
});

// ── 批③：播放链竞态（2026-09 第二轮审计 M7/M8/M9 + 定时停止反恢复）──

test('player.js: 恢复进度监听必须先移除旧监听再挂新（once 监听跨歌泄漏，歌A metadata 慢会把歌B seek 到A的位置）', () => {
  const src = read('js', 'player.js');
  assert.match(src, /function attachResumeSeekListener\(/,
    'loadAndPlay 两个分支各自裸 addEventListener loadedmetadata，需要统一的先删后挂助手');
  const uses = src.match(/attachResumeSeekListener\(/g) || [];
  assert.ok(uses.length >= 3,
    '助手定义 + 本地分支 + 网络分支至少三处出现，确保两分支都换了');
  assert.match(src, /removeEventListener\('loadedmetadata', _pendingResumeHandler\)/,
    '助手内必须先移除上一首歌遗留的监听再挂新的（M7）');
});

test('player.js: 歌词加载必须带请求序号守卫（快速切歌时慢响应的旧歌词覆盖新歌）', () => {
  const src = read('js', 'player.js');
  assert.match(src, /let _lyricRequestId = 0/, 'M8：歌词请求序号计数器');
  // 本地分支与网络分支的歌词块都应在 await 之后比对 reqId
  const guards = src.match(/reqId !== _lyricRequestId/g) || [];
  assert.ok(guards.length >= 2, '本地 readLocalLrc 与网络 getLyrics 两条歌词路径都要有守卫');
});

test('search.js: playSong 必须支持队列覆盖参数（batchPlay 传入勾选列表，不能被整页覆盖）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /async function playSong\(idx, queueOverride = null\)/,
    'M9：playSong 增加队列参数');
  assert.match(src, /const songs = queueOverride \|\| getState\('songs'\)/,
    'song 查找优先用覆盖队列');
  assert.match(src, /setState\('playQueue', queueOverride \|\| songs\)/,
    '队列写入同样尊重覆盖，否则 batchPlay 的勾选列表被整页覆盖');
  assert.match(src, /playSong\(0, playList\)/, 'batchPlay 应把勾选列表传给 playSong');
});

test('player-controls.js: 定时到期只能暂停，不得调用 togglePlay（暂停态下调 togglePlay 会恢复播放，定时反而"停止失败"）', () => {
  const src = read('js', 'player-controls.js');
  const timerBlock = src.match(/if \(remain <= 0\) \{[\s\S]*?clearSleepTimer\(\);/);
  assert.ok(timerBlock, '未找到定时到期处理块');
  assert.doesNotMatch(timerBlock[0], /togglePlay/,
    'audio.pause() 后再 togglePlay 会把刚暂停的播放又续上');
  assert.match(timerBlock[0], /audio\.pause\(\)/, '到期必须主动 pause');
});

// ── 增量129：换库路径必须重套筛选（与 refreshLocalLibrary 同一约定）──

/** 剥注释后再扫描：本仓库有「注释里写代码示例」的惯例，不剥会把说明文字当成代码证据 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

test('自检: stripComments 生效（注释里的 setState 示例不得被当成代码）', () => {
  assert.ok(!stripComments("// setState('localFiltered', x)").includes("setState('localFiltered'"), '行注释未剥离');
  assert.ok(!stripComments("/* setState('localFiltered') */ let a = 1;").includes("setState('localFiltered'"), '块注释未剥离');
  assert.ok(stripComments("setState('localFiltered', y);").includes("setState('localFiltered'"), '代码被误剥离');
});

test('local.js: 凡写 localSongs 的路径必须随后调 filterLocalSongs（只写 localFiltered 会静默丢掉全部过滤轴）', () => {
  const lines = stripComments(read('js', 'views', 'local.js')).split('\n');
  const sites = [];
  lines.forEach((line, i) => {
    if (!line.includes("setState('localSongs'")) return;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      if (lines[j].includes('filterLocalSongs()')) { sites.push({ at: i + 1, ok: true }); return; }
      if (lines[j].includes("setState('localFiltered'")) { sites.push({ at: i + 1, ok: false, badAt: j + 1 }); return; }
    }
    sites.push({ at: i + 1, ok: false, badAt: null });
  });
  assert.ok(sites.length >= 3,
    `应找到至少 3 条写入 localSongs 的路径（重扫 / 重选目录后重扫 / fs.watch 自动刷新），实际 ${sites.length}`);
  for (const s of sites) {
    assert.ok(s.ok, s.badAt
      ? `local.js:${s.at} 写了 localSongs，随后却直接写 localFiltered（第 ${s.badAt} 行）——重扫后收藏/格式/音质/完整度/关键词全部轴静默失效，按钮还亮着`
      : `local.js:${s.at} 写了 localSongs，但 8 行内没有 filterLocalSongs()，新库不会重套筛选`);
  }
});

test('local.js: localFiltered 只允许由 filterLocalSongs 写入（多一处就多一条绕过过滤轴的路径）', () => {
  const code = stripComments(read('js', 'views', 'local.js'));
  const writes = (code.match(/setState\('localFiltered'/g) || []).length;
  assert.strictEqual(writes, 1, `local.js 里应只有 filterLocalSongs 一处写 localFiltered，实际 ${writes} 处`);
});

// ── 增量133：删重后的库变更必须重跑管线（回调注入管线入口，不是裸渲染器）──

/** 用花括号配平抽函数体（含首尾大括号）；扫描前请先 stripComments */
function fnBodyL(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

/** 渲染层全部视图模块（派生，不硬编码文件名——新增视图自动纳入扫描） */
const VIEW_FILES = fs.readdirSync(R('js', 'views')).filter((f) => f.endsWith('.js'));

test('回归钉：localFiltered 只允许由 filterLocalSongs 写入（扫全部视图文件，不只看 local.js）', () => {
  const counts = {};
  for (const f of VIEW_FILES) {
    const n = (stripComments(read('js', 'views', f)).match(/setState\('localFiltered'/g) || []).length;
    if (n) counts[f] = n;
  }
  assert.deepStrictEqual(counts, { 'local.js': 1 },
    'localFiltered 是 filterLocalSongs 算出的派生状态，只允许 local.js 写一次。'
    + '别的视图模块写它 = 绕过收藏/格式/音质/完整度/关键词全部过滤轴，'
    + `且只写一个容器（网格视图下不重绘）。实际写入分布：${JSON.stringify(counts)}`);
});

test('回归钉：库变更回调必须注入过滤管线入口，不得注入裸渲染器', () => {
  const src = stripComments(read('js', 'views', 'local.js'));
  const m = /setLibraryChangeHandler\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(src);
  assert.ok(m, 'local.js 必须注册库变更回调 —— local-stats 删重后靠它刷新界面');
  const fn = m[1];
  assert.ok(!/^render/.test(fn),
    `注入的是裸渲染器 ${fn}()：它只写一个容器，网格视图下删重后界面毫无变化`
    + '（歌曲已删、格子还在），且不重套过滤轴与排序。必须注入 filterLocalSongs()。');
  const body = fnBodyL(src, fn);
  assert.ok(body.includes('renderLocalGrid(') && body.includes('renderLocalSongs('),
    `注入的 ${fn}() 必须同时兼顾网格与列表两种视图（它是管线入口，不是单容器渲染器）`);
});

test('回归钉：删重只改源数据，不得就地改派生状态 localFiltered', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'local-stats.js')), 'deleteSelectedDups');
  assert.ok(body.includes('deleteFile'),
    'deleteSelectedDups 需调用 api.deleteFile（哨兵缺失，钉可能已失效）');
  assert.ok(!body.includes('localFiltered'),
    'deleteSelectedDups 不得碰 localFiltered：它是 filterLocalSongs 由五个过滤轴 + 排序算出的派生状态，'
    + '就地 splice 既绕过全部过滤轴，又让网格视图完全不重绘（删了歌、格子还在）');
  assert.match(body, /_onLibraryChanged\(\)/,
    'deleteSelectedDups 删除成功后必须触发库变更回调，否则列表/网格不会刷新');
});

// ── 增量134：首页分区列表与「查看完整榜单」弹窗必须共用同一个过滤词 ──

test('home.js: 分区列表的计数必须来自过滤结果（用未过滤的 data.length 会让「查看完整榜单」在筛选后仍报全量）', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'home.js')), 'renderSection');
  assert.ok(body.includes('filterHomeSection('),
    'renderSection 需走 filterHomeSection 收敛（哨兵缺失，钉可能已失效）');
  const call = /listHtml\(([^)]*)\)/.exec(body);
  assert.ok(call, 'renderSection 需调用 listHtml');
  assert.ok(call[1].includes('pairs.length'),
    `listHtml 的计数实参必须来自过滤结果 pairs.length，实际「${call[1]}」——`
    + '用 data.length（未过滤总量）会让筛选后仍显示「共 N 首」，'
    + '且 N > LIST_FOLD 时按钮明明该消失却还在（点开只看到 2 首）');
  assert.ok(!call[1].includes('data.length'),
    'listHtml 的计数实参不得引用未过滤的 data.length');
});

test('home.js: 「查看完整榜单」弹窗必须应用同一个过滤词', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'home.js')), 'openHomeChartModal');
  assert.ok(body.includes('_getSection('),
    'openHomeChartModal 需从 _getSection 取分区数据（哨兵缺失，钉可能已失效）');
  assert.ok(body.includes('filterHomeSection('),
    'openHomeChartModal 必须用 filterHomeSection 收敛歌曲 —— 分区列表已按过滤词收敛，'
    + '弹窗却渲染全量时，用户筛出 3 首、点「查看完整榜单」会看到 30 首，前后自相矛盾且无任何提示');
  const call = /songRowsHtml\(\s*meta\s*,\s*([^)]*)\)/.exec(body);
  assert.ok(call, 'openHomeChartModal 需调用 songRowsHtml');
  assert.ok(call[1].includes('pairs'),
    `songRowsHtml 的歌曲实参必须是过滤结果 pairs（保留原始下标，playRecommendById 的索引语义不变），实际「${call[1]}」`);
  assert.ok(body.includes('home.filteredCount'),
    '有过滤词时必须显式写出「命中/总量」与筛选词，否则用户会以为榜单被截断');
});

test('lang: zh/en 词条必须完全对齐（缺键或占位符不一致会让界面漏出 key 或原样显示 {n}）', () => {
  const dir = path.join(__dirname, '..', 'src', 'renderer', 'js', 'lang');
  const zh = JSON.parse(fs.readFileSync(path.join(dir, 'zh.json'), 'utf8'));
  const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
  const onlyZh = Object.keys(zh).filter((k) => !(k in en));
  const onlyEn = Object.keys(en).filter((k) => !(k in zh));
  assert.deepStrictEqual([onlyZh, onlyEn], [[], []],
    `双语词条键必须一一对应 —— 仅 zh 有：${onlyZh.join(', ') || '无'}；仅 en 有：${onlyEn.join(', ') || '无'}`);
  const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
  const bad = Object.keys(zh).filter((k) => k in en && ph(zh[k]) !== ph(en[k]));
  assert.deepStrictEqual(bad, [],
    `以下词条中英占位符不一致（某语言下会原样显示 {n} 之类）：${bad.join(', ')}`);
});

// ── 增量135：渲染函数不得反向回写源状态 ──

const RENDERER_DIR = path.join(__dirname, '..', 'src', 'renderer');

/** 递归收集渲染层全部 .js（派生，不硬编码文件名——新增文件自动纳入扫描） */
function walkRendererJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRendererJs(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('回归钉：render* 函数不得写 state（渲染只读；写状态属反向回写）', () => {
  const files = walkRendererJs(RENDERER_DIR);
  assert.ok(files.length >= 20, `只扫到 ${files.length} 个渲染层文件，本钉可能已失效`);

  const offenders = [];
  let scanned = 0;
  for (const f of files) {
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    const seen = new Set();
    // 含 `_render*`（本仓库私有渲染器多用下划线前缀，漏掉它等于漏掉一半）
    for (const m of code.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+(_?render[A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[1];
      if (seen.has(name)) continue;
      seen.add(name);
      scanned++;
      const writes = [...fnBodyL(code, name).matchAll(/(?:state\.set|setState)\(/g)].length;
      if (writes) {
        offenders.push(`${path.relative(RENDERER_DIR, f).replace(/\\/g, '/')} :: ${name}() 内 ${writes} 处`);
      }
    }
  }
  assert.ok(scanned >= 40, `只扫到 ${scanned} 个 render* 函数，本钉可能已失效`);
  assert.deepStrictEqual(offenders, [],
    'render* 是渲染函数，只应读 state 并画 DOM。写 state 会让「一次纯 UI 重绘」'
    + '静默改写全局状态，并掩盖真正的写入点（数据流方向被反转）。'
    + `实际：${offenders.join(' | ')}`);
});

test('接线钉：queueSnapshot 的唯一写入点是队列事件回调（app.js onQueueUpdated）', () => {
  const writers = [];
  for (const f of walkRendererJs(RENDERER_DIR)) {
    const n = (stripComments(fs.readFileSync(f, 'utf8')).match(/state\.set\(\s*'queueSnapshot'/g) || []).length;
    if (n) writers.push(`${path.relative(RENDERER_DIR, f).replace(/\\/g, '/')}:${n}`);
  }
  assert.deepStrictEqual(writers, ['js/app.js:1'],
    'queueSnapshot 是队列事件（app.js onQueueUpdated）的产物，应只有一个写入点。'
    + '多一处就是一条「不来自队列事件」的路径 —— renderQueue 曾经就是（每次 UI 重绘回写一次），'
    + `且它是全仓 render* 里唯一写 state 的。实际：${writers.join(', ') || '无'}`);
});

test('接线钉：renderQueue 必须只读 queueSnapshot，不得回写', () => {
  const body = fnBodyL(stripComments(read('js', 'views', 'download.js')), 'renderQueue');
  assert.ok(body.includes('applyQueueFilter('),
    'renderQueue 需按筛选条件渲染（哨兵缺失，钉可能已失效）');
  assert.ok(!body.includes("state.set('queueSnapshot'"),
    'renderQueue 不得写 queueSnapshot：唯一写入点是队列事件（app.js:309）。'
    + '本函数同时被切筛选/分组/展开详情等纯 UI 路径调用，一旦传入子集就会静默改掉全局快照，'
    + '而 search.js 的徽标、app.js:740、本文件十余处 getState 全读它');
});
