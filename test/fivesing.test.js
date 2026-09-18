/**
 * 单元测试：5sing 平台（纯函数 + 适配器接线）
 *
 * 网络链路（搜索 / getSongUrl 三档 / newget 歌词）由 .preview/dump-new-fields*.cjs
 * 与 .preview/selftest-new-platforms.cjs 实测覆盖；这里只测无需网络、但回归代价高的部分：
 *   - **songName 内嵌高亮标签**：搜「稻香」返回 `<em class="keyword">稻香</em>`，
 *     不剥 HTML 会让歌名带着标签进 UI 与文件名（实测形态，必须守住）
 *   - **id 必须编码 typeEname**：取流接口 songtype 缺失或错误一律「歌曲不存在」，
 *     故 id 形态 `<songId>_<typeEname>` 是硬契约，不能被简化成裸 songId
 *   - **伴奏曲 singer 字面值 "NULL"**：要归一成空串，否则 "null" 会作为歌手名
 *     进入跨源匹配与文件名
 *   - 适配器是否真的注册进了插件中心（曾出现"实现写了但从未 require"）
 */

const test = require('node:test');
const assert = require('node:assert');
const fivesing = require('../src/api/platforms/fivesing');
const api = require('../src/api/index.js');

const { mapSong, stripHtml, encodeId, decodeId, lrcFromDynamicWords, QUALITY_ORDER } = fivesing._internal;

// ── stripHtml ─────────────────────────────────────────────

test('stripHtml: 剥掉搜索高亮标签（真实返回形态）', () => {
  assert.strictEqual(stripHtml('<em class="keyword">稻香</em>'), '稻香');
  assert.strictEqual(stripHtml('晴天<em class="keyword">（钢琴版）</em>'), '晴天（钢琴版）');
});

test('stripHtml: 解码常见 HTML 实体', () => {
  assert.strictEqual(stripHtml('A&amp;B'), 'A&B');
  assert.strictEqual(stripHtml('&quot;引号&quot;'), '"引号"');
  assert.strictEqual(stripHtml('&lt;标签&gt;'), '<标签>');
  assert.strictEqual(stripHtml('a&nbsp;b'), 'a b');
});

test('stripHtml: 实体替换是单次扫描（&amp;lt; 不被二次解码成 <）', () => {
  // 顺序 replace 的实现会得到 '<'；单次扫描应停在字面 '&lt;'
  assert.strictEqual(stripHtml('A&amp;lt;B'), 'A&lt;B');
});

test('stripHtml: 非字符串输入不抛异常', () => {
  assert.strictEqual(stripHtml(null), '');
  assert.strictEqual(stripHtml(undefined), '');
  assert.strictEqual(stripHtml(123), '123');
});

// ── id 编解码（typeEname 必须保留）─────────────────────────

test('encodeId: 输出 `<songId>_<typeEname>` 形态', () => {
  assert.strictEqual(encodeId('15504842', 'fc'), '15504842_fc');
  assert.strictEqual(encodeId(15622111, 'bz'), '15622111_bz');
});

test('decodeId: 编解码往返一致', () => {
  assert.deepStrictEqual(decodeId(encodeId('15504842', 'fc')), { songId: '15504842', type: 'fc' });
  assert.deepStrictEqual(decodeId(encodeId(1, 'yc')), { songId: '1', type: 'yc' });
});

test('decodeId: 非法形态一律返回 null', () => {
  assert.strictEqual(decodeId('123'), null);          // 缺 type
  assert.strictEqual(decodeId('123_'), null);         // type 为空
  assert.strictEqual(decodeId('_fc'), null);          // songId 为空
  assert.strictEqual(decodeId('abc_fc'), null);       // songId 非数字
  assert.strictEqual(decodeId('123_f'), null);        // type 非两字母
  assert.strictEqual(decodeId('123_fc_extra'), null); // 多段
  assert.strictEqual(decodeId(''), null);
  assert.strictEqual(decodeId(null), null);
  assert.strictEqual(decodeId(undefined), null);
});

test('decodeId: songId 在前，故就算有人对它 parseInt 也能拿到正确 songId', () => {
  // 这是选 `<songId>_<type>` 而非 `<type>_<songId>` 的原因
  assert.strictEqual(parseInt(decodeId('15504842_fc').songId, 10), 15504842);
});

// ── mapSong ───────────────────────────────────────────────

test('mapSong: 真实搜索条目正确映射', () => {
  const out = mapSong({
    songId: 15504842,
    songName: '<em class="keyword">稻香</em>',
    singer: '兔裹煎蛋卷',
    typeEname: 'fc',
    typeName: '翻唱',
    originSinger: '周杰伦',
  });
  assert.strictEqual(out.id, '15504842_fc');
  assert.strictEqual(out.title, '稻香');
  assert.strictEqual(out.artist, '兔裹煎蛋卷');
  assert.strictEqual(out.source, 'fivesing');
});

test('mapSong: 伴奏曲 singer="NULL" 归一成空串', () => {
  const out = mapSong({ songId: 1, songName: '晴天', singer: 'NULL', typeEname: 'bz' });
  assert.strictEqual(out.artist, '');
  // 大写变体同样要处理
  assert.strictEqual(mapSong({ songId: 1, songName: 'x', singer: 'null', typeEname: 'bz' }).artist, '');
});

test('mapSong: duration 恒为 0（5sing 搜索接口不返回时长）', () => {
  assert.strictEqual(mapSong({ songId: 1, songName: 'x', singer: 'A', typeEname: 'fc' }).duration, 0);
});

test('mapSong: cover 恒为空串（搜索接口不返回封面）', () => {
  assert.strictEqual(mapSong({ songId: 1, songName: 'x', singer: 'A', typeEname: 'fc' }).cover, '');
});

test('mapSong: 缺 typeEname 返回 null（缺它就取不到流，不该进列表）', () => {
  assert.strictEqual(mapSong({ songId: 15504842, songName: '稻香', singer: 'A' }), null);
  assert.strictEqual(mapSong({ songId: 15504842, songName: '稻香', singer: 'A', typeEname: '' }), null);
});

test('mapSong: 缺 songId / 歌名为空 / 输入非法时返回 null', () => {
  assert.strictEqual(mapSong({ songName: '稻香', typeEname: 'fc' }), null);
  assert.strictEqual(mapSong({ songId: 'abc', songName: '稻香', typeEname: 'fc' }), null);
  assert.strictEqual(mapSong({ songId: 1, songName: '   ', typeEname: 'fc' }), null);
  assert.strictEqual(mapSong(null), null);
  assert.strictEqual(mapSong(undefined), null);
});

// ── lrcFromDynamicWords ───────────────────────────────────

test('lrcFromDynamicWords: 保留带时间轴的行（真换行）', () => {
  const out = lrcFromDynamicWords('[00:14.71]我听见雨滴\n[00:20.55]我听见远方');
  assert.strictEqual(out, '[00:14.71]我听见雨滴\n[00:20.55]我听见远方');
});

test('lrcFromDynamicWords: 字面 \\n 两字符也能正确分行', () => {
  // 实测两种形态都出现过（真换行 / 字面反斜杠+n）
  const out = lrcFromDynamicWords('[00:01.00]A\\n[00:02.00]B');
  assert.strictEqual(out.split('\n').length, 2);
});

test('lrcFromDynamicWords: 剔除元信息行（[ti:] 等）与空行', () => {
  const out = lrcFromDynamicWords('[ti:歌名]\n[ar:歌手]\n[00:01.00]正文\n\n');
  assert.strictEqual(out, '[00:01.00]正文');
});

test('lrcFromDynamicWords: 输出每一行都带方括号时间轴（渲染层 parseLrc 的硬要求）', () => {
  const out = lrcFromDynamicWords('[00:01.00]A\n[01:02.50]B\n[1:2]C');
  for (const l of out.split('\n')) {
    assert.match(l, /^\[\d{1,2}:\d{1,2}([.:]\d{1,3})?\]/, `行不符合 LRC 时间轴：${l}`);
  }
});

test('lrcFromDynamicWords: 空输入返回空串（半数曲目该字段为空，不能当错误处理）', () => {
  assert.strictEqual(lrcFromDynamicWords(''), '');
  assert.strictEqual(lrcFromDynamicWords(null), '');
  assert.strictEqual(lrcFromDynamicWords(undefined), '');
});

// ── 音质档位 ──────────────────────────────────────────────

test('QUALITY_ORDER 覆盖三档且顺序为 sq→hq→lq（降级方向）', () => {
  assert.deepStrictEqual(QUALITY_ORDER, ['sq', 'hq', 'lq']);
});

// ── 取流 / 歌词参数校验 ────────────────────────────────────

test('fivesingGetUrl: 非法 id 返回 BAD_PARAMS 且 fatal（可换源）', async () => {
  const r = await fivesing.fivesingGetUrl('');
  assert.strictEqual(r.code, 'BAD_PARAMS');
  assert.strictEqual(r.fatal, true);
  const r2 = await fivesing.fivesingGetUrl('bare-songid-without-type');
  assert.strictEqual(r2.code, 'BAD_PARAMS');
});

test('fivesingGetLyrics: 非法 id 返回空串且不抛异常', async () => {
  assert.strictEqual(await fivesing.fivesingGetLyrics(''), '');
  assert.strictEqual(await fivesing.fivesingGetLyrics('nope'), '');
  assert.strictEqual(await fivesing.fivesingGetLyrics(null), '');
});

// ── 适配器接线 ────────────────────────────────────────────

test('插件中心已注册 fivesing，且三项能力齐备', () => {
  const p = api.registry.get('fivesing');
  assert.ok(p, 'fivesing 未注册到插件中心');
  assert.strictEqual(typeof p.search, 'function');
  assert.strictEqual(typeof p.getUrl, 'function');
  assert.strictEqual(typeof p.getLyrics, 'function');
});

test('5sing 未声明不具备的专辑/歌手能力', () => {
  const p = api.registry.get('fivesing');
  assert.strictEqual(p.searchAlbum, undefined);
  assert.strictEqual(p.searchSinger, undefined);
});

test('fivesing 已进入换源候选源列表', () => {
  const { CANDIDATE_SOURCES } = require('../src/utils/matchMusic');
  assert.ok(CANDIDATE_SOURCES.includes('fivesing'), 'fivesing 未加入 CANDIDATE_SOURCES');
});

test('平台总数包含全部八个平台（防止注册表被意外截断）', () => {
  const ids = api.registry.getIds();
  for (const expected of ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda']) {
    assert.ok(ids.includes(expected), `平台 ${expected} 丢失`);
  }
});
