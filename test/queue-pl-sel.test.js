/**
 * 增量115 测试：播放队列多选「🎼 加歌单」
 *
 * pickPlSavableRows/isPlSavableRow 纯函数直调（死行进歌单即坏数据，
 * 判形是命门）；app/HTML/面板接线走静态钉。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8');
const PALETTE_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8');
const QP_JS = fs.readFileSync(path.join(__dirname, '../src/renderer/js/queuePlaylist.js'), 'utf8');

async function fresh() {
  return import(`../src/renderer/js/queuePlaylist.js?v=${Math.random()}`);
}

test('isPlSavableRow：drop 拒、本地缺路径拒、在线缺 id 拒、正常行过', async () => {
  const { isPlSavableRow } = await fresh();
  assert.equal(isPlSavableRow({ title: 'T', source: 'netease', id: 1 }), true);
  assert.equal(isPlSavableRow({ title: 'T', source: 'local', filePath: 'C:\\m\\a.mp3' }), true);
  assert.equal(isPlSavableRow({ title: 'T', source: 'drop', id: 'x' }), false, 'blob 行重启即死');
  assert.equal(isPlSavableRow({ title: 'T', source: 'local' }), false, '本地行没路径播不动');
  assert.equal(isPlSavableRow({ title: 'T', source: 'qq' }), false, '在线行没 id 取不了流');
  assert.equal(isPlSavableRow({ source: 'qq', id: 1 }), false, '没标题不进歌单');
  assert.equal(isPlSavableRow(null), false);
  assert.equal(isPlSavableRow({ title: 'T', id: 0 }), true, 'id=0 是合法键不是缺失');
});

test('pickPlSavableRows：保序滤死行、盖 addedAt、不改入参、脏输入回空', async () => {
  const { pickPlSavableRows } = await fresh();
  const a = { title: 'A', source: 'netease', id: 1 };
  const d = { title: 'D', source: 'drop', id: 'blob:1' };
  const b = { title: 'B', source: 'qq', id: 2, url: 'runtime-only' };
  const out = pickPlSavableRows([a, null, d, b], 777);
  assert.deepEqual(out.map(s => s.title), ['A', 'B'], '死行剔除且保序');
  assert.ok(out.every(s => s.addedAt === 777));
  assert.equal(out[1].url, 'runtime-only', '行对象透传（与增量76 queueToSongs 同形）');
  assert.equal(a.addedAt, undefined, '入参不得被改动（纯）');
  assert.deepEqual(pickPlSavableRows(null, 1), []);
  assert.deepEqual(pickPlSavableRows('x', 1), []);
});

test('接线钉：app 判形调用 + 按钮计数 + window 挂桥 + HTML/面板落位 + 76 旧链不动', () => {
  assert.match(QP_JS, /export function pickPlSavableRows\(rows, now = Date\.now\(\)\) \{/);
  assert.ok(!/\bdocument\b/.test(QP_JS) && !/\bwindow\b/.test(QP_JS), 'queuePlaylist 顶层不得碰 DOM');
  assert.match(APP_JS, /import \{ queueToSongs, defaultQueuePlaylistName, pickPlSavableRows \} from '\.\/queuePlaylist\.js';/);
  assert.ok(APP_JS.includes('🎼 歌单 ${_pqSel.size}'), '按钮计数跟着选态走');
  assert.match(APP_JS, /window\.pqSelAddPlaylist = \(\) => \{/);
  assert.ok(APP_JS.includes('filter(s => _pqSel.has(s))'), '按队列原序投影，不跟勾选乱序');
  assert.ok(APP_JS.includes('pickPlSavableRows(picked);'));
  assert.ok(APP_JS.includes("showToast('先勾选要加歌单的行', 'warn')"));
  assert.ok(APP_JS.includes("window.quickAddToPlaylist(rows)"), '复用既有批量链，零新通道');
  assert.match(HTML, /<button class="pq-clear-btn hidden" id="pqSelPlBtn" onclick="pqSelAddPlaylist\(\)"/);
  assert.match(PALETTE_JS, /id: 'pq-selpl'[\s\S]{0,220}?_call\('pqSelAddPlaylist'\)/);
  assert.ok(APP_JS.includes('const songs = queueToSongs(getState(\'playQueue\') || []);'), '76 整单存为链不动');
});
