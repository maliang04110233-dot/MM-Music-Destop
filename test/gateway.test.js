/**
 * 单元测试：api/gateway.js —— 平台网关
 *
 * 网关的职责是把「调用平台」这件事的样板收敛到一处：
 *   1. 能力检查 —— 平台不存在 / 未实现方法 ⇒ 可预期的空结果，不抛错
 *   2. cookie 注入 —— 统一从注入的 reader 取，容错
 *   3. 错误收敛 —— 平台抛错不向上传播，转为空值 / 原始错误对象
 *
 * 本测试**不加载真实平台**（无网络、无 8 个平台），
 * 用注入的桩 registry 精确控制每种能力组合 —— 这正是把 registry
 * 做成依赖注入而非模块级单例的收益。
 */

const test = require('node:test');
const assert = require('node:assert');

const { createPlatformGateway, EMPTY } = require('../src/api/gateway');

/**
 * 造一个最小 registry 桩：只实现 gateway 用到的 5 个方法。
 * @param {Object} plugins id → 平台对象
 * @param {string[]} [order] 显式顺序
 */
function makeRegistry(plugins, order) {
  const ids = order || Object.keys(plugins);
  return {
    get: (id) => plugins[id],
    getIds: () => [...ids],
    getAll: () => ids.map((id) => plugins[id]).filter(Boolean),
    has: (id) => !!plugins[id],
    getCapabilities: (id) => plugins[id] && plugins[id]._caps,
    size: ids.length,
  };
}

/** 按 CAPABILITY_METHODS 语义给桩平台推导 _caps */
const CAP_METHODS = {
  album: 'searchAlbum',
  albumSongs: 'getAlbumSongs',
  singer: 'searchSinger',
  singerSongs: 'getSingerSongs',
  singerAlbums: 'getSingerAlbums',
  lyrics: 'getLyrics',
  lyricsByTitle: 'getLyricsByTitle',
  linkDetail: 'getSongDetail',
  cookie: 'verifyCookie',
  playlistDetail: 'getPlaylistDetail',
};

function withCaps(plugin) {
  const caps = {};
  for (const [k, m] of Object.entries(CAP_METHODS)) caps[k] = typeof plugin[m] === 'function';
  plugin._caps = Object.freeze(caps);
  return plugin;
}

// ══════════════════════════════════════════════════════════
// 构造与依赖注入
// ══════════════════════════════════════════════════════════

test('createPlatformGateway: 未注入 registry 时立即抛错', () => {
  assert.throws(() => createPlatformGateway({}), /必须注入 registry/);
});

test('createPlatformGateway: 返回冻结对象，防止调用方打补丁', () => {
  const gw = createPlatformGateway({ registry: makeRegistry({}) });
  assert.ok(Object.isFrozen(gw), 'gateway 应冻结，避免被就地改方法');
});

// ══════════════════════════════════════════════════════════
// 能力检查：不存在 / 未实现 ⇒ 可预期空值，不抛错
// ══════════════════════════════════════════════════════════

test('search: 未知平台返回 []（不抛错）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({}) });
  assert.deepStrictEqual(await gw.search('nope', 'keyword'), []);
});

test('search: 平台存在但无 search 方法返回 []', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ x: withCaps({}) }) });
  assert.deepStrictEqual(await gw.search('x', 'keyword'), []);
});

test('search: 正常返回平台结果，并注入 cookie', async () => {
  let seenCookie = null;
  const reg = makeRegistry({
    p: withCaps({
      search: async (kw, page, cookie) => { seenCookie = cookie; return [{ title: kw, page }]; },
    }),
  });
  const gw = createPlatformGateway({ registry: reg, getCookie: () => 'COOKIE_VAL' });
  const r = await gw.search('p', 'abc', 2);
  assert.deepStrictEqual(r, [{ title: 'abc', page: 2 }]);
  assert.strictEqual(seenCookie, 'COOKIE_VAL', 'cookie 应透传给平台 search');
});

test('search: 平台抛错时收敛为 []，不向上传播', async () => {
  const reg = makeRegistry({
    p: withCaps({ search: async () => { throw new Error('boom'); } }),
  });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(await gw.search('p', 'x'), [], '平台异常应被吞为空结果');
});

test('getCookie 自身抛错不应让调用失败（容错为空白 cookie）', async () => {
  let seen = 'unset';
  const reg = makeRegistry({
    p: withCaps({ search: async (_kw, _pg, cookie) => { seen = cookie; return []; } }),
  });
  const gw = createPlatformGateway({
    registry: reg,
    getCookie: () => { throw new Error('cookie store 未就绪'); },
  });
  await gw.search('p', 'x');
  assert.strictEqual(seen, '', 'cookie reader 抛错时应退化为空串');
});

// ══════════════════════════════════════════════════════════
// getUrl：**刻意不吞错误**（换源机制依赖 code）
// ══════════════════════════════════════════════════════════

test('getUrl: 未知平台返回带 code 的错误对象（供换源判断）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({}) });
  const r = await gw.getUrl('nope', '1', 'standard');
  assert.strictEqual(r.code, 'UNKNOWN_SOURCE');
  assert.ok(r.error, '应带可展示的 error 文案');
});

test('getUrl: 平台返回的成功结果原样透传（含 url/quality 等字段）', async () => {
  const payload = { url: 'https://cdn/x.mp3', ext: 'mp3', quality: '320k' };
  const reg = makeRegistry({ p: withCaps({ getUrl: async () => payload }) });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(await gw.getUrl('p', 'id', '320k'), payload);
});

test('getUrl: 平台抛错时转为 { error } 而非透传异常', async () => {
  const reg = makeRegistry({
    p: withCaps({ getUrl: async () => { throw new Error('403 expired'); } }),
  });
  const gw = createPlatformGateway({ registry: reg });
  const r = await gw.getUrl('p', 'id', 'standard');
  assert.ok(r.error, '应有 error 字段');
  assert.strictEqual(r.url, undefined, '失败结果不应带 url');
});

// ══════════════════════════════════════════════════════════
// 返回形态约定：必须与消费方历史期望逐条一致
// ══════════════════════════════════════════════════════════

test('getLyrics: 统一返回 { lrc }，非字符串结果退化为空串', async () => {
  const reg = makeRegistry({
    ok: withCaps({ getLyrics: async () => '[00:01]hi' }),
    bad: withCaps({ getLyrics: async () => null }),
    none: withCaps({}),
  });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(await gw.getLyrics('ok', '1'), { lrc: '[00:01]hi' });
  assert.deepStrictEqual(await gw.getLyrics('bad', '1'), { lrc: '' });
  assert.deepStrictEqual(await gw.getLyrics('none', '1'), { lrc: '' });
});

test('searchAlbum / getSingerAlbums: 无能力 ⇒ { albums: [], total: 0 }', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ p: withCaps({}) }) });
  assert.deepStrictEqual(await gw.searchAlbum('p', 'kw'), { albums: [], total: 0 });
  assert.deepStrictEqual(await gw.getSingerAlbums('p', 'mid'), { albums: [], total: 0 });
});

test('searchSinger: 无能力 ⇒ { singers: [], total: 0, page }（保留传入 page）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ p: withCaps({}) }) });
  assert.deepStrictEqual(await gw.searchSinger('p', 'kw', 3),
    { singers: [], total: 0, page: 3 });
});

test('searchSinger: 平台返回畸形结果（singers 非数组）时退化为空', async () => {
  const reg = makeRegistry({ p: withCaps({ searchSinger: async () => ({ singers: 'oops' }) }) });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(await gw.searchSinger('p', 'kw', 1), { singers: [], total: 0, page: 1 });
});

test('getAlbumSongs / getSingerSongs: 非数组结果一律退化为 []', async () => {
  const reg = makeRegistry({
    p: withCaps({ getAlbumSongs: async () => 'nope', getSingerSongs: async () => null }),
  });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(await gw.getAlbumSongs('p', 'mid'), []);
  assert.deepStrictEqual(await gw.getSingerSongs('p', 'mid'), []);
});

test('getSongDetail: 无能力 ⇒ null（链接识别依赖此约定）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ p: withCaps({}) }) });
  assert.strictEqual(await gw.getSongDetail('p', 'id'), null);
});

test('verifyCookie: 无能力 ⇒ { valid:false }（与既有行为一致）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ p: withCaps({}) }) });
  assert.deepStrictEqual(await gw.verifyCookie('p', 'c'), { valid: false });
});

// ══════════════════════════════════════════════════════════
// 能力查询：派生而非硬编码清单
// ══════════════════════════════════════════════════════════

test('platformsWith: 按能力推导平台集合（新平台自动进入，无需改清单）', () => {
  const reg = makeRegistry({
    a: withCaps({ searchSinger: async () => ({}) }),
    b: withCaps({}),
    c: withCaps({ searchSinger: async () => ({}) }),
  });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(gw.platformsWith('singer'), ['a', 'c']);
  assert.deepStrictEqual(gw.platformsWith('album'), []);
});

test('platformsWith: 未知能力名返回空数组而非抛错', () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ a: withCaps({}) }) });
  assert.deepStrictEqual(gw.platformsWith('no-such-capability'), []);
});

test('supports: 未知平台返回 false', () => {
  const gw = createPlatformGateway({ registry: makeRegistry({}) });
  assert.strictEqual(gw.supports('nope', 'singer'), false);
});

// ══════════════════════════════════════════════════════════
// fanOut：跨平台并发聚合的语义
// ══════════════════════════════════════════════════════════

test('fanOut: 单个平台失败不影响其它平台（allSettled 语义）', async () => {
  const reg = makeRegistry({
    a: withCaps({ search: async () => ['A'] }),
    b: withCaps({ search: async () => { throw new Error('b down'); } }),
    c: withCaps({ search: async () => ['C'] }),
  });
  const gw = createPlatformGateway({ registry: reg });
  const r = await gw.fanOut(['a', 'b', 'c'], (id) => gw.search(id, 'kw'));
  // ⚠️ gateway.search 自身已吞异常 ⇒ 失败平台表现为 ok:true + value:[]
  //    （这正是「单点失败不互相影响」的实现方式；fanOut 的 ok:false
  //      只在 fn 本身抛出时出现，见下一个用例）
  assert.deepStrictEqual(r.map((x) => x.platform), ['a', 'b', 'c'], '顺序应与入参一致');
  assert.deepStrictEqual(r[0].value, ['A']);
  assert.deepStrictEqual(r[1].value, [], '失败平台退化为空数组，而非中断整批');
  assert.deepStrictEqual(r[2].value, ['C']);
  assert.deepStrictEqual(r.map((x) => x.ok), [true, true, true]);
});

test('fanOut: fn 直接抛出时该平台记为 ok:false（不中断整批）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({}) });
  const r = await gw.fanOut(['a', 'b'], async (id) => {
    if (id === 'b') throw new Error('hard fail');
    return ['ok'];
  });
  assert.deepStrictEqual(r.map((x) => x.ok), [true, false]);
  assert.deepStrictEqual(r[0].value, ['ok']);
  assert.strictEqual(r[1].value, null, '抛错项的 value 为 null');
});

test('fanOut: 空数组 / 非数组入参返回空结果，不抛错', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({}) });
  assert.deepStrictEqual(await gw.fanOut([], async () => 1), []);
  assert.deepStrictEqual(await gw.fanOut(null, async () => 1), []);
});

// ══════════════════════════════════════════════════════════
// 推荐域：过渡实现的行为与空值退化
// ══════════════════════════════════════════════════════════

test('推荐域: 平台未实现该方法 ⇒ []（过渡字典的键不存在时）', async () => {
  const gw = createPlatformGateway({ registry: makeRegistry({ p: withCaps({}) }) });
  assert.deepStrictEqual(await gw.getTopList('p', 'name', 10), []);
  assert.deepStrictEqual(await gw.getRanking('p', 10), []);
  assert.deepStrictEqual(await gw.getHotSingers('p', 10), []);
});

test('推荐域: 按过渡字典映射到平台的老式具名导出', async () => {
  const calls = [];
  const reg = makeRegistry({
    netease: withCaps({
      neteaseGetTopList: async (name, limit) => { calls.push(['top', name, limit]); return [1, 2]; },
    }),
  });
  // ⚠️ 过渡字典键是平台 id —— 桩 registry 用的 id 必须与真实 id 一致
  const gw = createPlatformGateway({ registry: reg });
  const r = await gw.getTopList('netease', '飙升榜', 100);
  assert.deepStrictEqual(r, [1, 2]);
  assert.deepStrictEqual(calls, [['top', '飙升榜', 100]]);
});

test('推荐域: withCookie 选项把 cookie 注入为末位参数（B 站排行）', async () => {
  let seen = null;
  const reg = makeRegistry({
    bilibili: withCaps({
      bilibiliGetRanking: async (limit, cookie) => { seen = { limit, cookie }; return []; },
    }),
  });
  const gw = createPlatformGateway({ registry: reg, getCookie: () => 'BILI_CK' });
  await gw.getRanking('bilibili', 100);
  assert.deepStrictEqual(seen, { limit: 100, cookie: 'BILI_CK' });
});

test('推荐域: 平台返回非数组 ⇒ []（防止上层拿到脏数据）', async () => {
  const reg = makeRegistry({
    qq: withCaps({ qqGetHotSingers: async () => ({ not: 'array' }) }),
  });
  const gw = createPlatformGateway({ registry: reg });
  assert.deepStrictEqual(await gw.getHotSingers('qq', 30), []);
});

// ══════════════════════════════════════════════════════════
// EMPTY 约定导出（供测试与消费方对齐）
// ══════════════════════════════════════════════════════════

test('EMPTY: 各构造器返回新对象，避免调用方共享可变引用', () => {
  assert.notStrictEqual(EMPTY.list(), EMPTY.list());
  assert.notStrictEqual(EMPTY.albumResult(), EMPTY.albumResult());
  assert.deepStrictEqual(EMPTY.albumResult(), { albums: [], total: 0 });
  assert.deepStrictEqual(EMPTY.singerResult(5), { singers: [], total: 0, page: 5 });
});
