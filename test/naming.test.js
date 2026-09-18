/**
 * 单元测试：utils/naming.js（下载文件命名模板）
 *
 * 跑：npm test
 *
 * 覆盖：基础五项 + 扩展变量（quality/bitrate/trackNo/playlist/year/date）、
 *       空值抑制、别名、未知变量、非法字符与控制字符清洗、路径逃逸防护。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  renderFileName,
  previewTemplate,
  unknownPlaceholders,
  TEMPLATE_VARS,
  QUALITY_LABELS,
  DEFAULT_TEMPLATE,
} = require('../src/utils/naming');

const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);

const NOW = new Date('2026-01-15T12:00:00');

const SONG = {
  title: '晴天',
  artist: '周杰伦',
  album: '叶惠美',
  source: 'netease',
  id: '12345',
  quality: 'hq',
  trackNo: '3',
  trackTotal: '12',
  playlistName: '周杰伦精选',
  year: '2003',
};

const BASE = { title: '晴天', artist: '周杰伦', album: '叶惠美', source: 'netease', id: '12345' };

// ── 基础五项（历史行为：缺值回退「未知」）─────────────────

test('naming: 默认模板渲染基础五项', () => {
  assert.strictEqual(renderFileName(DEFAULT_TEMPLATE, SONG, 'mp3'), '周杰伦 - 晴天.mp3');
  assert.strictEqual(renderFileName('{album}/{artist} - {title}', SONG, 'mp3'), '叶惠美_周杰伦 - 晴天.mp3');
});

test('naming: 基础五项缺值回退「未知」', () => {
  assert.strictEqual(renderFileName(DEFAULT_TEMPLATE, {}, 'mp3'), '未知 - 未知.mp3');
  assert.strictEqual(renderFileName('{title}', { title: '' }, 'mp3'), '未知.mp3');
  assert.strictEqual(renderFileName('{title}', { title: null }, 'mp3'), '未知.mp3');
});

test('naming: 数字 id 不再抛异常（历史实现把数字当字符串调 replace 会崩）', () => {
  assert.strictEqual(renderFileName('{id}-{title}', { id: 12345, title: 't', artist: 'a', album: 'x', source: 's' }, 'mp3'), '12345-t.mp3');
});

// ── 扩展变量 ──────────────────────────────────────────

test('naming: {quality} 原样输出档位 key', () => {
  assert.strictEqual(renderFileName('{quality}_{title}', { ...BASE, quality: 'hq' }, 'mp3'), 'hq_晴天.mp3');
  assert.strictEqual(renderFileName('{quality}_{title}', { ...BASE, quality: 'lossless' }, 'flac'), 'lossless_晴天.flac');
});

test('naming: {bitrate} 取 quality 档位的人读名', () => {
  assert.strictEqual(QUALITY_LABELS.hq, '320k');
  assert.strictEqual(renderFileName('{artist} - {title} [{bitrate}]', SONG, 'mp3'), '周杰伦 - 晴天 [320k].mp3');
  assert.strictEqual(renderFileName('{bitrate}', { ...BASE, quality: 'standard' }, 'mp3'), '128k.mp3');
  assert.strictEqual(renderFileName('{bitrate}', { ...BASE, quality: 'lossless' }, 'mp3'), 'FLAC.mp3');
});

test('naming: {bitrate} 也接受平台直给的 bitrate（bps/kbps 自适应）', () => {
  assert.strictEqual(renderFileName('{bitrate}', { ...BASE, bitrate: 320000 }, 'mp3'), '320k.mp3');
  assert.strictEqual(renderFileName('{bitrate}', { ...BASE, bitrate: '192' }, 'mp3'), '192k.mp3');
  assert.strictEqual(renderFileName('{bitrate}', { ...BASE, bitrate: '0' }, 'mp3'), '未知.mp3');
});

test('naming: {year} 接受年份数字与日期字符串，范围外当无值', () => {
  assert.strictEqual(renderFileName('{year}_{title}', { ...BASE, year: '2003' }, 'mp3'), '2003_晴天.mp3');
  assert.strictEqual(renderFileName('{year}_{title}', { ...BASE, year: 2003 }, 'mp3'), '2003_晴天.mp3');
  assert.strictEqual(renderFileName('{year}_{title}', { ...BASE, pubdate: '2003-07-31' }, 'mp3'), '2003_晴天.mp3');
  assert.strictEqual(renderFileName('{year}_{title}', { ...BASE, pubdate: '1714000000000' }, 'mp3'), '晴天.mp3');
  assert.strictEqual(renderFileName('{year}_{title}', { ...BASE, year: '1899' }, 'mp3'), '晴天.mp3');
});

test('naming: {trackNo} 按歌单总数补零，{track} 是别名', () => {
  assert.strictEqual(renderFileName('{trackNo}.{title}', SONG, 'mp3'), '03.晴天.mp3');
  assert.strictEqual(renderFileName('{track}.{title}', SONG, 'mp3'), '03.晴天.mp3');
  // 120 首歌 → 三位宽
  assert.strictEqual(renderFileName('{trackNo}.{title}', { ...BASE, trackNo: '7', trackTotal: '120' }, 'mp3'), '007.晴天.mp3');
  // 没有总数时至少两位
  assert.strictEqual(renderFileName('{trackNo}.{title}', { ...BASE, trackNo: '7' }, 'mp3'), '07.晴天.mp3');
});

test('naming: {playlist} 取 playlistName', () => {
  assert.strictEqual(renderFileName('{playlist}_{title}', SONG, 'mp3'), '周杰伦精选_晴天.mp3');
});

test('naming: {date} 为下载当天，可用 opts.now 固定', () => {
  assert.strictEqual(renderFileName('{title}_{date}', BASE, 'mp3', { now: NOW }), '晴天_20260115.mp3');
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = '' + today.getFullYear() + pad(today.getMonth() + 1) + pad(today.getDate());
  assert.strictEqual(renderFileName('{title}_{date}', BASE, 'mp3'), '晴天_' + todayStr + '.mp3');
});

test('naming: 组合模板', () => {
  assert.strictEqual(
    renderFileName('{playlist}/{trackNo} {artist} - {title} [{bitrate}]', SONG, 'mp3'),
    '周杰伦精选_03 周杰伦 - 晴天 [320k].mp3'
  );
});

// ── 空值抑制 ──────────────────────────────────────────

test('naming: 扩展变量缺值时不留下空括号/空分隔符', () => {
  // 括号壳被吃掉
  assert.strictEqual(renderFileName('{artist} - {title} [{bitrate}]', BASE, 'mp3'), '周杰伦 - 晴天.mp3');
  // 两侧都有破折号 → 只留一个
  assert.strictEqual(renderFileName('{artist} - {trackNo} - {title}', BASE, 'mp3'), '周杰伦 - 晴天.mp3');
  // 只有右侧破折号 → 整段吃掉
  assert.strictEqual(renderFileName('{artist} - {title} - {year}', BASE, 'mp3'), '周杰伦 - 晴天.mp3');
  // 只有左侧破折号 → 整段吃掉
  assert.strictEqual(renderFileName('{year} - {title}', BASE, 'mp3'), '晴天.mp3');
  // 两个都空 → 不留东西
  assert.strictEqual(renderFileName('{bitrate} - {year}', BASE, 'mp3'), '未知.mp3');
  // 点号分隔
  assert.strictEqual(renderFileName('{trackNo}.{title}', BASE, 'mp3'), '晴天.mp3');
  // 空格分隔
  assert.strictEqual(renderFileName('{artist} {trackNo}', BASE, 'mp3'), '周杰伦.mp3');
  // 路径分隔符相邻的空值
  assert.strictEqual(renderFileName('{trackNo}/{title}', BASE, 'mp3'), '晴天.mp3');
  assert.strictEqual(renderFileName('{artist}/{trackNo}', BASE, 'mp3'), '周杰伦.mp3');
  assert.strictEqual(renderFileName('{playlist}/{trackNo}/{artist}', BASE, 'mp3'), '周杰伦.mp3');
});

test('naming: 有的有值、有的没值时互不干扰', () => {
  assert.strictEqual(renderFileName('{artist} {bitrate} - {year} {title}', SONG, 'mp3'), '周杰伦 320k - 2003 晴天.mp3');
  assert.strictEqual(
    renderFileName('{artist} {bitrate} - {year} {title}', { ...BASE, quality: 'hq' }, 'mp3'),
    '周杰伦 320k - 晴天.mp3'
  );
});

// ── 未知变量 ──────────────────────────────────────────

test('naming: 未识别的变量原样保留，并能被 unknownPlaceholders 找出', () => {
  assert.strictEqual(renderFileName('{artist} - {foo}', SONG, 'mp3'), '周杰伦 - {foo}.mp3');
  assert.deepStrictEqual(unknownPlaceholders('{artist} - {foo} - {bitrate}'), ['foo']);
  assert.deepStrictEqual(unknownPlaceholders(DEFAULT_TEMPLATE), []);
  assert.deepStrictEqual(unknownPlaceholders('{track} - {date}'), []);
  // 重复的未知变量只报一次，且排序稳定
  assert.deepStrictEqual(unknownPlaceholders('{zebra} {apple} {zebra}'), ['apple', 'zebra']);
});

test('naming: TEMPLATE_VARS 覆盖全部支持的变量', () => {
  const keys = new Set(TEMPLATE_VARS.map(v => v.key));
  for (const k of ['title', 'artist', 'album', 'source', 'id', 'quality', 'bitrate', 'trackNo', 'playlist', 'year', 'date']) {
    assert.ok(keys.has(k), 'TEMPLATE_VARS 缺少 ' + k);
  }
  assert.ok(TEMPLATE_VARS.every(v => v.key && v.desc), '每个变量都要有说明文案');
});

// ── 清洗与防护 ──────────────────────────────────────────

test('naming: 非法字符替换成下划线', () => {
  const evil = { ...BASE, title: 'a<b>c:d"e/f\\g|h?i' };
  assert.strictEqual(renderFileName('{title}', evil, 'mp3'), 'a_b_c_d_e_f_g_h_i.mp3');
});

test('naming: 值里的控制字符（换行）不能进文件名', () => {
  assert.strictEqual(renderFileName('{title}', { ...BASE, title: '主歌' + NL + '副歌' }, 'mp3'), '主歌 副歌.mp3');
});

test('naming: 歌名里的 $& / $\' 不被当作替换模式解释', () => {
  assert.strictEqual(renderFileName('{artist} - {title}', { ...BASE, title: "price $& more" }, 'mp3'), '周杰伦 - price $& more.mp3');
  assert.strictEqual(renderFileName('{title}', { ...BASE, title: "a$'b" }, 'mp3'), "a$'b.mp3");
});

test('naming: 模板无法逃逸出下载目录', () => {
  for (const t of ['../etc/passwd', '/etc/passwd', BS + 'etc', '..' + BS + 'windows']) {
    const out = renderFileName(t, SONG, 'mp3');
    assert.ok(!out.includes('/') && !out.includes(BS), '不应出现路径分隔符: ' + out);
    assert.ok(!out.startsWith('..'), '不应出现穿越片段: ' + out);
    assert.ok(!out.startsWith('/'), '不应以斜杠开头: ' + out);
  }
  // 连续点被折叠
  assert.strictEqual(renderFileName('..', SONG, 'mp3'), '未知.mp3');
  // 模板字面量里的分隔符换成下划线
  assert.strictEqual(renderFileName('{quality}/{title}', SONG, 'mp3'), 'hq_晴天.mp3');
});

test('naming: 扩展名被清洗且为空时回退 mp3', () => {
  assert.strictEqual(renderFileName('{title}', SONG, ''), '晴天.mp3');
  assert.strictEqual(renderFileName('{title}', SONG, null), '晴天.mp3');
  assert.strictEqual(renderFileName('{title}', SONG, '../../etc'), '晴天.etc');
  assert.strictEqual(renderFileName('{title}', SONG, 'MP4'), '晴天.MP4');
});

// ── 预览 ──────────────────────────────────────────

test('naming: previewTemplate 输出稳定（不依赖当前时间）', () => {
  const once = previewTemplate('{title} - {date} [{bitrate}] {year}');
  const twice = previewTemplate('{title} - {date} [{bitrate}] {year}');
  assert.strictEqual(once, twice);
  assert.strictEqual(once, '晴天 - 20260115 [320k] 2003.mp3');
  assert.strictEqual(previewTemplate(DEFAULT_TEMPLATE), '周杰伦 - 晴天.mp3');
});
