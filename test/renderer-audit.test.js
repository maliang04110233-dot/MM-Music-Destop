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

test('search.js: doSearch 必须 await handleLinkInput（否则 _linkHandled 恒 false，链接搜索永不生效）', () => {
  const src = read('js', 'views', 'search.js');
  assert.match(src, /async function doSearch\(/, 'doSearch 需为 async');
  assert.match(src, /await handleLinkInput\(/, '必须先 await 链接识别再读 _linkHandled');
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
