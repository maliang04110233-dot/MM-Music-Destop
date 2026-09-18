/**
 * 单元测试：汽水音乐平台（纯函数 + 适配器接线）
 *
 * 网络链路（LunaPC 搜索 / 分享页取流 / 逐字歌词）由 .preview/dump-new-fields*.cjs
 * 与 .preview/selftest-new-platforms.cjs 实测覆盖；这里只测无需网络、但回归代价高的部分：
 *   - **单位陷阱**：搜索返回 duration 是**毫秒**，分享页 awl.duration 是**秒**，
 *     混用会让时长差 1000 倍、跨源匹配全灭
 *   - **_ROUTER_DATA 提取**：必须用花括号平衡扫描，非贪婪正则会因歌词文本里的 `};`
 *     提前截断（本文件里有对应回归用例）
 *   - **末句 endMs 是 MAX_SAFE_INTEGER**（"持续到结束"），拼 LRC 时若误用会得到天文数字
 *   - 适配器是否真的注册进了插件中心（曾出现"实现写了但从未 require"）
 */

const test = require('node:test');
const assert = require('node:assert');
const soda = require('../src/api/platforms/soda');
const api = require('../src/api/index.js');

const {
  mapTrack, pickCover, buildQuery, extractRouterData,
  sentencesToLrc, fmtLrcTime, estimateBr, CLIENT_PARAMS,
} = soda._internal;

// ── pickCover ─────────────────────────────────────────────

test('pickCover: 对象形态拼成完整 URL（与分享页 coverURL 格式一致）', () => {
  const out = pickCover({
    uri: 'tos-cn-v-2774c002/oYLBWqhTwB8gwAA6EJAWPJEAirdiaE8vQIbDV',
    urls: ['https://p3-luna.douyinpic.com/img/', 'https://p6-luna.douyinpic.com/img/'],
    template_prefix: 'tplv-b829550vbb',
  });
  assert.strictEqual(
    out,
    'https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/oYLBWqhTwB8gwAA6EJAWPJEAirdiaE8vQIbDV~c5_375x375.jpg',
  );
});

test('pickCover: 字符串形态直接返回', () => {
  const url = 'https://p3-luna.douyinpic.com/img/x~c5_375x375.jpg';
  assert.strictEqual(pickCover(url), url);
});

test('pickCover: 缺 uri / urls / 输入为空时返回空串', () => {
  assert.strictEqual(pickCover(null), '');
  assert.strictEqual(pickCover(undefined), '');
  assert.strictEqual(pickCover({}), '');
  assert.strictEqual(pickCover({ uri: 'x' }), '');
  assert.strictEqual(pickCover({ urls: ['https://x/'] }), '');
});

// ── mapTrack ──────────────────────────────────────────────

test('mapTrack: 真实搜索条目正确映射', () => {
  const out = mapTrack({
    id: '7615534715396245513',
    name: '晴天（Cover 周同學）',
    duration: 65019,
    artists: [{ name: '周同學' }],
    album: { name: '《拾八》', url_cover: { uri: 'abc', urls: ['https://p3-luna.douyinpic.com/img/'] } },
  });
  assert.strictEqual(out.id, '7615534715396245513');
  assert.strictEqual(out.title, '晴天（Cover 周同學）');
  assert.strictEqual(out.artist, '周同學');
  assert.strictEqual(out.album, '《拾八》');
  assert.strictEqual(out.cover, 'https://p3-luna.douyinpic.com/img/abc~c5_375x375.jpg');
  assert.strictEqual(out.source, 'soda');
});

test('mapTrack: duration 保持毫秒（搜索接口语义，不可当秒用）', () => {
  const out = mapTrack({ id: '1', name: 'x', duration: 65019 });
  assert.strictEqual(out.duration, 65019);
  // 若被误除以 1000 变成 65，这里会失败
  assert.ok(out.duration > 1000, 'duration 应仍是毫秒量级');
});

test('mapTrack: duration 缺失或非法时归 0', () => {
  assert.strictEqual(mapTrack({ id: '1', name: 'x' }).duration, 0);
  assert.strictEqual(mapTrack({ id: '1', name: 'x', duration: 'abc' }).duration, 0);
  assert.strictEqual(mapTrack({ id: '1', name: 'x', duration: null }).duration, 0);
});

test('mapTrack: 多歌手用顿号连接（matchMusic 的 normalizeArtists 认这个分隔符）', () => {
  const out = mapTrack({ id: '1', name: 'x', artists: [{ name: 'A' }, { name: 'B' }] });
  assert.strictEqual(out.artist, 'A、B');
});

test('mapTrack: 非法歌手项不会污染结果', () => {
  const out = mapTrack({ id: '1', name: 'x', artists: [null, {}, { name: 'A' }, { name: '' }] });
  assert.strictEqual(out.artist, 'A');
});

test('mapTrack: artists / album 缺失时容错为空串', () => {
  const out = mapTrack({ id: '1', name: 'x' });
  assert.strictEqual(out.artist, '');
  assert.strictEqual(out.album, '');
  assert.strictEqual(out.cover, '');
});

test('mapTrack: 缺 id 或 name 时返回 null', () => {
  assert.strictEqual(mapTrack({ name: 'x' }), null);
  assert.strictEqual(mapTrack({ id: '1' }), null);
  assert.strictEqual(mapTrack({ id: '1', name: '   ' }), null);
  assert.strictEqual(mapTrack(null), null);
  assert.strictEqual(mapTrack(undefined), null);
});

// ── buildQuery ────────────────────────────────────────────

test('buildQuery: 跳过 undefined/null 参数并做 URL 编码', () => {
  assert.strictEqual(buildQuery({ a: 1, b: undefined, c: null, d: 'x y' }), 'a=1&d=x%20y');
});

test('buildQuery: 中文关键词正确编码', () => {
  assert.strictEqual(buildQuery({ q: '晴天' }), 'q=%E6%99%B4%E5%A4%A9');
});

test('CLIENT_PARAMS: 关键客户端标识齐备（缺任一项都会拿到空 body）', () => {
  for (const k of ['aid', 'app_name', 'version_code', 'device_platform', 'iid', 'device_id', 'cdid', 'sim_region']) {
    assert.ok(CLIENT_PARAMS[k], `CLIENT_PARAMS 缺关键参数 ${k}`);
  }
  assert.strictEqual(CLIENT_PARAMS.app_name, 'luna');
  assert.strictEqual(CLIENT_PARAMS.aid, '386088');
});

// ── extractRouterData ─────────────────────────────────────

test('extractRouterData: 正常提取', () => {
  const html = '<script>window._ROUTER_DATA = {"loaderData":{"track_page":{"a":1}}};</script>';
  assert.deepStrictEqual(extractRouterData(html), { loaderData: { track_page: { a: 1 } } });
});

test('extractRouterData: 字符串内的 } 与 }; 不会提前截断（非贪婪正则的经典坑）', () => {
  const html = '_ROUTER_DATA = {"a":{"b":"};"},"c":2};done';
  const out = extractRouterData(html);
  assert.deepStrictEqual(out, { a: { b: '};' }, c: 2 });
});

test('extractRouterData: 字符串里的转义引号不会算错字符串边界', () => {
  const html = '_ROUTER_DATA = {"a":"he said \\"}\\" ok","b":1};done';
  assert.deepStrictEqual(extractRouterData(html), { a: 'he said "}" ok', b: 1 });
});

test('extractRouterData: 无标记或非法 JSON 返回 null', () => {
  assert.strictEqual(extractRouterData(''), null);
  assert.strictEqual(extractRouterData('<html>nothing here</html>'), null);
  assert.strictEqual(extractRouterData('_ROUTER_DATA = {broken'), null);
  assert.strictEqual(extractRouterData(null), null);
});

// ── fmtLrcTime / sentencesToLrc ───────────────────────────

test('fmtLrcTime: mm:ss.xx 补零格式', () => {
  assert.strictEqual(fmtLrcTime(0), '00:00.00');
  assert.strictEqual(fmtLrcTime(74712), '01:14.71');
  assert.strictEqual(fmtLrcTime(61615), '01:01.62');
  assert.strictEqual(fmtLrcTime(600000), '10:00.00');
});

test('fmtLrcTime: 秒位不会出现 60（59.999s 边界）', () => {
  assert.strictEqual(fmtLrcTime(59999), '01:00.00');
  assert.ok(!fmtLrcTime(59999).includes(':60.'));
});

test('fmtLrcTime: 负数/非法输入归零，不产生 NaN', () => {
  assert.strictEqual(fmtLrcTime(-5), '00:00.00');
  assert.strictEqual(fmtLrcTime('abc'), '00:00.00');
  assert.strictEqual(fmtLrcTime(null), '00:00.00');
});

test('sentencesToLrc: 逐字结构按句输出标准 LRC', () => {
  const out = sentencesToLrc([
    { startMs: 0, endMs: 5134, text: '作曲：哇欣', words: [{ text: '作曲：哇欣', startMs: 0, endMs: 5134 }] },
    { startMs: 10268, endMs: 15000, text: '作词：哇欣', words: [] },
  ]);
  assert.strictEqual(out, '[00:00.00]作曲：哇欣\n[00:10.27]作词：哇欣');
});

test('sentencesToLrc: 忽略 endMs（末句是 MAX_SAFE_INTEGER，不能进时间轴）', () => {
  const out = sentencesToLrc([{ startMs: 61615, endMs: 9007199254740991, text: '拜拜' }]);
  assert.strictEqual(out, '[01:01.62]拜拜');
  assert.ok(!/\d{6,}/.test(out), '输出不应出现天文数字');
});

test('sentencesToLrc: 跳过空文本 / 非法时间 / 非数组输入', () => {
  assert.strictEqual(sentencesToLrc([
    { startMs: 0, text: '  ' },
    { startMs: -1, text: 'x' },
    { startMs: 'abc', text: 'y' },
    { startMs: 1000, text: '有效' },
  ]), '[00:01.00]有效');
  assert.strictEqual(sentencesToLrc(null), '');
  assert.strictEqual(sentencesToLrc(undefined), '');
  assert.strictEqual(sentencesToLrc([]), '');
});

test('sentencesToLrc: 每一行都带方括号时间轴（渲染层 parseLrc 的硬要求）', () => {
  const out = sentencesToLrc([{ startMs: 0, text: 'A' }, { startMs: 5000, text: 'B' }]);
  for (const l of out.split('\n')) {
    assert.match(l, /^\[\d{1,2}:\d{1,2}\.\d{2}\]/, `行不符合 LRC 时间轴：${l}`);
  }
});

// ── estimateBr ────────────────────────────────────────────

test('estimateBr: 由体积与时长估算码率（分享页给的是秒，正好可用）', () => {
  // 实测：1052196 字节 / 65.019 秒 ≈ 129 kbps
  assert.strictEqual(estimateBr(1052196, 65.019), 129000);
});

test('estimateBr: 缺参或零值返回 null', () => {
  assert.strictEqual(estimateBr(0, 65), null);
  assert.strictEqual(estimateBr(1000, 0), null);
  assert.strictEqual(estimateBr(null, null), null);
  assert.strictEqual(estimateBr(undefined, undefined), null);
});

// ── 取流参数校验 ──────────────────────────────────────────

test('sodaGetUrl: 空 id 返回 BAD_PARAMS 且 fatal（可换源）', async () => {
  const r = await soda.sodaGetUrl('');
  assert.strictEqual(r.code, 'BAD_PARAMS');
  assert.strictEqual(r.fatal, true);
  assert.strictEqual((await soda.sodaGetUrl(null)).code, 'BAD_PARAMS');
});

test('sodaGetLyrics: 空 id 返回空串且不抛异常', async () => {
  assert.strictEqual(await soda.sodaGetLyrics(''), '');
  assert.strictEqual(await soda.sodaGetLyrics(null), '');
});

// ── 适配器接线 ────────────────────────────────────────────

test('插件中心已注册 soda，且三项能力齐备', () => {
  const p = api.registry.get('soda');
  assert.ok(p, 'soda 未注册到插件中心');
  assert.strictEqual(typeof p.search, 'function');
  assert.strictEqual(typeof p.getUrl, 'function');
  assert.strictEqual(typeof p.getLyrics, 'function');
});

test('汽水未声明不具备的专辑/歌手能力', () => {
  const p = api.registry.get('soda');
  assert.strictEqual(p.searchAlbum, undefined);
  assert.strictEqual(p.searchSinger, undefined);
});

test('soda 已进入换源候选源列表', () => {
  const { CANDIDATE_SOURCES } = require('../src/utils/matchMusic');
  assert.ok(CANDIDATE_SOURCES.includes('soda'), 'soda 未加入 CANDIDATE_SOURCES');
});

test('平台总数包含全部八个平台（防止注册表被意外截断）', () => {
  const ids = api.registry.getIds();
  for (const expected of ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda']) {
    assert.ok(ids.includes(expected), `平台 ${expected} 丢失`);
  }
});
