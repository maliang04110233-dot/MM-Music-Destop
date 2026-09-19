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
