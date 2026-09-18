/**
 * 单元测试：咪咕平台（纯函数 + 适配器接线）
 *
 * 网络链路（搜索 / HEAD 取流 / 歌词）由 .preview/probe-migu-*.cjs 实测覆盖，
 * 这里只测无需网络、但回归代价高的部分：
 *   - 字段映射：咪咕返回的 singers / albums / imgItems 都是**数组**，
 *     裸取 s.singer 会静默得到 undefined（实测踩过），必须守住
 *   - id 语义：确认沿用 contentId，不把 copyrightId 编码进 id
 *   - 适配器是否真的注册进了插件中心（曾出现"实现写了但从未 require"）
 */

const test = require('node:test');
const assert = require('node:assert');
const migu = require('../src/api/platforms/migu');
const api = require('../src/api/index.js');

const { mapSong, headLocation, QUALITY_TONE } = migu._internal;

// ── mapSong：真实返回形态（数组字段）──────────────────────

test('mapSong: singers/albums/imgItems 为数组时必须正确摊平', () => {
  const out = mapSong({
    contentId: '600929000000096577',
    name: '圣诞星（feat. 杨瑞代）',
    singers: [{ id: '112', name: '周杰伦' }],
    albums: [{ id: '1140505221', name: '圣诞星', type: '1' }],
    imgItems: [{ imgSizeType: '01', img: 'https://d.musicapp.migu.cn/data/oss/x.webp' }],
  });
  assert.strictEqual(out.id, '600929000000096577');
  assert.strictEqual(out.title, '圣诞星（feat. 杨瑞代）');
  assert.strictEqual(out.artist, '周杰伦');
  assert.strictEqual(out.album, '圣诞星');
  assert.strictEqual(out.cover, 'https://d.musicapp.migu.cn/data/oss/x.webp');
  assert.strictEqual(out.source, 'migu');
});

test('mapSong: 多歌手用顿号连接', () => {
  const out = mapSong({
    contentId: '1',
    name: '歌',
    singers: [{ name: '周杰伦' }, { name: '杨瑞代' }],
  });
  assert.strictEqual(out.artist, '周杰伦、杨瑞代');
});

test('mapSong: 非法歌手项不会污染结果', () => {
  const out = mapSong({ contentId: '1', name: '歌', singers: [{ name: 'A' }, null, {}, { name: '' }] });
  assert.strictEqual(out.artist, 'A');
});

test('mapSong: duration 恒为 0（咪咕搜索接口不返回时长）', () => {
  const out = mapSong({ contentId: '1', name: '歌', singers: [{ name: 'A' }] });
  assert.strictEqual(out.duration, 0);
});

test('mapSong: id 沿用 contentId（守住「不把 copyrightId 编码进 id」的架构决策）', () => {
  const out = mapSong({ contentId: '600929000000096577', copyrightId: '60054704965', name: '歌' });
  // 若未来有人把 id 改成 `contentId|copyrightId` 这类复合形态，这里会失败并提醒复核
  assert.strictEqual(out.id, '600929000000096577');
  assert.ok(!String(out.id).includes('|'), 'id 不应含分隔符');
  assert.ok(!String(out.id).includes('60054704965'), 'id 不应混入 copyrightId');
});

test('mapSong: 缺 contentId 或 name 时返回 null', () => {
  assert.strictEqual(mapSong({ name: '歌' }), null);
  assert.strictEqual(mapSong({ contentId: '1' }), null);
  assert.strictEqual(mapSong({ contentId: '1', name: '   ' }), null);
  assert.strictEqual(mapSong(null), null);
  assert.strictEqual(mapSong(undefined), null);
});

test('mapSong: 数组字段缺失或为空时容错（不抛异常）', () => {
  const out = mapSong({ contentId: '1', name: '歌' });
  assert.strictEqual(out.artist, '');
  assert.strictEqual(out.album, '');
  assert.strictEqual(out.cover, '');
});

test('mapSong: 数组为空数组时同样安全', () => {
  const out = mapSong({ contentId: '1', name: '歌', singers: [], albums: [], imgItems: [] });
  assert.strictEqual(out.artist, '');
  assert.strictEqual(out.album, '');
  assert.strictEqual(out.cover, '');
});

test('mapSong: 标量 singer/albumName 也能兜底（非当前形态，防御性）', () => {
  const out = mapSong({ contentId: '1', name: '歌', singer: '周杰伦', albumName: '专辑名' });
  assert.strictEqual(out.artist, '周杰伦');
  assert.strictEqual(out.album, '专辑名');
});

test('mapSong: title 前后空白被裁剪', () => {
  const out = mapSong({ contentId: '1', name: '  歌名  ' });
  assert.strictEqual(out.title, '歌名');
});

// ── headLocation：容错 ────────────────────────────────────

test('headLocation: 非法 URL 返回空串且不抛异常', async () => {
  assert.strictEqual(await headLocation('not-a-url'), '');
  assert.strictEqual(await headLocation(''), '');
  assert.strictEqual(await headLocation(null), '');
});

test('headLocation: 不可达主机返回空串（不 reject）', async () => {
  const r = await headLocation('http://127.0.0.1:1/nope', 1500);
  assert.strictEqual(r, '');
});

// ── 音质映射 ──────────────────────────────────────────────

test('QUALITY_TONE 覆盖三档音质且 resourceType 正确', () => {
  assert.deepStrictEqual(QUALITY_TONE.lossless, { toneFlag: 'SQ', resourceType: 'E' });
  assert.deepStrictEqual(QUALITY_TONE.hq, { toneFlag: 'HQ', resourceType: '2' });
  assert.deepStrictEqual(QUALITY_TONE.standard, { toneFlag: 'PQ', resourceType: '2' });
});

// ── 取流参数约束 ──────────────────────────────────────────

test('miguGetUrl: 缺 id 时返回 BAD_PARAMS 且不发起网络请求', async () => {
  const r = await migu.miguGetUrl('');
  assert.strictEqual(r.code, 'BAD_PARAMS');
  assert.strictEqual(r.fatal, true);
});

// ── 歌词容错 ──────────────────────────────────────────────

test('miguGetLyrics: 缺 id 返回空串', async () => {
  assert.strictEqual(await migu.miguGetLyrics(''), '');
  assert.strictEqual(await migu.miguGetLyrics(null), '');
});

// ── 适配器接线 ────────────────────────────────────────────

test('插件中心已注册 migu，且三项能力齐备', () => {
  const p = api.registry.get('migu');
  assert.ok(p, 'migu 未注册到插件中心');
  assert.strictEqual(typeof p.search, 'function');
  assert.strictEqual(typeof p.getUrl, 'function');
  assert.strictEqual(typeof p.getLyrics, 'function');
});

test('咪咕未声明不具备的专辑/歌手能力', () => {
  const p = api.registry.get('migu');
  // 咪咕没有专辑/歌手接口：不应凭空声明，否则 UI 切到专辑页只会拿到静默空列表
  assert.strictEqual(p.searchAlbum, undefined);
  assert.strictEqual(p.searchSinger, undefined);
});

test('migu 已进入换源候选源列表', () => {
  const { CANDIDATE_SOURCES } = require('../src/utils/matchMusic');
  assert.ok(CANDIDATE_SOURCES.includes('migu'), 'migu 未加入 CANDIDATE_SOURCES');
});

test('平台总数包含 migu（防止注册表被意外截断）', () => {
  const ids = api.registry.getIds();
  for (const expected of ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu']) {
    assert.ok(ids.includes(expected), `平台 ${expected} 丢失`);
  }
});
