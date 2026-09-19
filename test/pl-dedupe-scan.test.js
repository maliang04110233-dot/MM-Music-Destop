/**
 * 增量117：我的歌单「🧮 跨歌单重复检测」
 *
 * 84 的清重复只在单歌单内部折叠；同一首歌散在收藏夹+自建单+导入单
 * 无人报警。本模块纯函数扫全量歌单出跨单重复组（本地认 filePath、
 * 在线认 source:id，与收藏线 88/92 同键约定），弹层+复制走 playlist.js
 * 既有 copyText，零新 IPC。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SCAN_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/plDedupeScan.js'), 'utf8'
);
const PL_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/views/playlist.js'), 'utf8'
);
const HTML = fs.readFileSync(
  path.join(__dirname, '../src/renderer/index.html'), 'utf8'
);
const PALETTE_JS = fs.readFileSync(
  path.join(__dirname, '../src/renderer/js/commandPalette.js'), 'utf8'
);

async function fresh() {
  return import('../src/renderer/js/plDedupeScan.js?tc=' + Math.random());
}

test('songDedupeKey：本地认 filePath、在线认 source:id（id=0 合法），drop/缺键/无题一律 null', async () => {
  const { songDedupeKey } = await fresh();
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'local', filePath: 'C:\\m\\a.mp3' }), 'L:C:\\m\\a.mp3');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'netease', id: 42 }), 'O:netease:42');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'qq', id: 0 }), 'O:qq:0', 'id=0 是合法曲 id');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'drop', filePath: 'blob:x' }), null, 'drop 临时行不进报告');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'local' }), null, '本地缺路径判不了身份');
  assert.strictEqual(songDedupeKey({ title: 'T', source: 'netease' }), null, '在线缺 id 同上');
  assert.strictEqual(songDedupeKey({ source: 'netease', id: 1 }), null, '无题行跳过');
  assert.strictEqual(songDedupeKey(null), null);
});

test('findCrossPlaylistDupes：≥2 单才算跨、单内重复归 84、散落多的排前、同数按歌名', async () => {
  const { findCrossPlaylistDupes } = await fresh();
  const song = (id, title) => ({ id, source: 'netease', title, artist: 'A' });
  const pls = [
    { name: '收藏', songs: [song(1, '甲'), song(2, '乙'), song(2, '乙'), song(3, '丙')] },
    { name: '通勤', songs: [song(2, '乙'), song(1, '甲')] },
    { name: '导入', songs: [song(1, '甲')] },
    { name: '无歌单键', songs: '不是数组' },
    { name: '空' },
  ];
  const g = findCrossPlaylistDupes(pls);
  assert.deepStrictEqual(g.map(x => [x.title, x.where]), [
    ['甲', ['收藏', '通勤', '导入']],
    ['乙', ['收藏', '通勤']],
  ], '单内重复只算一次；×3 在前；丙只在收藏不出');
  assert.deepStrictEqual(findCrossPlaylistDupes(null), []);
  assert.deepStrictEqual(findCrossPlaylistDupes([]), []);
});

test('dedupeScanText：每组一行「歌 - 歌手 ×N: 单A、单B」，缺歌手不带横杠', async () => {
  const { dedupeScanText } = await fresh();
  const t = dedupeScanText([
    { title: '甲', artist: 'A', where: ['收藏', '通勤'] },
    { title: '乙', artist: '', where: ['X'] },
  ]);
  assert.strictEqual(t, '「甲 - A」×2: 收藏、通勤\n「乙」×1: X');
  assert.strictEqual(dedupeScanText(null), '');
});

test('接线钉桩：playlist.js 纯函数导入+三桥、HTML 按钮、面板 pl-dedupescan、扫描模块零 DOM', () => {
  assert.match(SCAN_JS, /export function songDedupeKey\(s\) \{/);
  assert.ok(!/document\.|window\./.test(SCAN_JS), '纯函数模块零 DOM');
  assert.match(PL_JS, /import \{ findCrossPlaylistDupes, dedupeScanText \} from '\.\.\/plDedupeScan\.js';/);
  assert.match(PL_JS, /function scanCrossPlaylistDupes\(\) \{\n {2}const pls = \(getState\('userPlaylists'\)/);
  assert.match(PL_JS, /window\.scanCrossPlaylistDupes = scanCrossPlaylistDupes;/);
  assert.match(PL_JS, /window\.copyDedupeScanReport = copyDedupeScanReport;/);
  assert.match(PL_JS, /overlay\.id = 'dedupeScanModal';/, '动态弹层用专属 id，不与静态容器撞');
  assert.match(HTML, /<button class="tab"[^>]*onclick="scanCrossPlaylistDupes\(\)"[^>]*>🧮 跨单查重<\/button>/);
  assert.match(PALETTE_JS, /\{ id: 'pl-dedupescan'[\s\S]{0,160}?_call\('scanCrossPlaylistDupes'\) \},/);
});
