/**
 * 单元测试：api/services/resolveTrackService.js —— 取流解析（换源机制）
 *
 * 换源是本工程**用户可感知度最高**的机制之一：
 *   少换一次 → 用户 VIP 曲听不了；多换一次 → 白费请求 + 触发平台风控。
 * 所以这里逐条钉住决策边界，而不是只测「能返回 url」。
 *
 * 全部用桩注入：不触网、不加载 8 个平台、不依赖真实 matchMusic/健康度。
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  createResolveTrackService,
  shouldFallbackToOtherSource,
  FALLBACK_CODES,
} = require('../src/api/services/resolveTrackService');
const { ERROR_CODES } = require('../src/shared/errors');

// ── 测试替身 ──────────────────────────────────────────────

/** 健康度桩：记录所有记账调用，rankByHealth 默认恒等 */
function makeHealth(rankFn) {
  const calls = [];
  return {
    calls,
    recordResult: (s, ok) => calls.push([s, !!ok]),
    rankByHealth: rankFn || ((a) => a),
  };
}

const okResult = (extra = {}) => ({ url: 'https://cdn/x.mp3', ext: 'mp3', ...extra });

/**
 * 造一个可控的 getUrl 桩。
 * @param {Object} map  `source:id` → 结果对象 | 抛错的 Error
 */
function makeGetUrl(map) {
  const calls = [];
  const fn = async (id, source) => {
    calls.push([source, String(id)]);
    const key = `${source}:${id}`;
    if (!(key in map)) return { error: `未知数据源: ${source}`, code: 'UNKNOWN_SOURCE' };
    const v = map[key];
    if (v instanceof Error) throw v;
    return v;
  };
  fn.calls = calls;
  return fn;
}

const SONG = { id: '1', source: 'netease', title: '测试曲', artist: '歌手A' };

function build(map, opts = {}) {
  const health = opts.health || makeHealth();
  const getUrl = makeGetUrl(map);
  const svc = createResolveTrackService({
    getUrl,
    searchFn: opts.searchFn || (async () => []),
    hasCookie: opts.hasCookie || (() => false),
    findCandidates: opts.findCandidates || (async () => []),
    sourceHealth: health,
    ...(opts.probeUrl ? { probeUrl: opts.probeUrl } : {}),
  });
  return { svc, health, getUrl };
}

// ══════════════════════════════════════════════════════════
// 构造与依赖注入
// ══════════════════════════════════════════════════════════

test('createResolveTrackService: 缺 getUrl 立即抛错（早失败优于静默失效）', () => {
  assert.throws(
    () => createResolveTrackService({ findCandidates: async () => [], sourceHealth: makeHealth() }),
    /必须注入 getUrl/,
  );
});

test('createResolveTrackService: 缺 findCandidates 立即抛错', () => {
  assert.throws(
    () => createResolveTrackService({ getUrl: async () => ({}), sourceHealth: makeHealth() }),
    /必须注入 findCandidates/,
  );
});

test('createResolveTrackService: 缺 sourceHealth.recordResult 立即抛错', () => {
  assert.throws(
    () => createResolveTrackService({ getUrl: async () => ({}), findCandidates: async () => [] }),
    /必须注入 sourceHealth/,
  );
});

test('createResolveTrackService: 返回冻结对象（防运行时打补丁）', () => {
  const { svc } = build({});
  assert.ok(Object.isFrozen(svc));
});

// ══════════════════════════════════════════════════════════
// shouldFallbackToOtherSource —— 换源决策（核心）
// ══════════════════════════════════════════════════════════

test('决策：已成功（有 url）不换源', () => {
  assert.strictEqual(shouldFallbackToOtherSource(okResult()), false);
});

test('决策：换源类错误码全部触发换源', () => {
  for (const code of FALLBACK_CODES) {
    assert.strictEqual(
      shouldFallbackToOtherSource({ error: 'x', code }), true,
      `${code} 应触发换源`,
    );
  }
});

test('决策：CDN 签名过期（HTTP 403/404/410）无 code 也换源', () => {
  for (const s of ['HTTP 403', 'HTTP 404', 'HTTP 410', 'request failed with HTTP 403 for url']) {
    assert.strictEqual(shouldFallbackToOtherSource({ error: s }), true, `${s} 应换源`);
  }
});

test('决策：网络类错误不换源（换源同样会失败，只白费请求）', () => {
  for (const code of [ERROR_CODES.NETWORK_TIMEOUT, ERROR_CODES.NETWORK_ERROR]) {
    assert.strictEqual(
      shouldFallbackToOtherSource({ error: 'network', code }), false,
      `${code} 不应换源`,
    );
  }
});

test('决策：未知数据源不换源（歌本身可能不存在）', () => {
  assert.strictEqual(
    shouldFallbackToOtherSource({ error: '未知数据源: xxx', code: 'UNKNOWN_SOURCE' }), false,
  );
});

test('决策：无 code 且无 HTTP 特征的空失败不换源（避免无谓请求）', () => {
  assert.strictEqual(shouldFallbackToOtherSource({ error: '某个不明失败' }), false);
});

test('决策：入参为 null/undefined 不换源且不抛错', () => {
  assert.strictEqual(shouldFallbackToOtherSource(null), false);
  assert.strictEqual(shouldFallbackToOtherSource(undefined), false);
});

test('决策：HTTP 500 不在换源范围（服务端故障换源无意义）', () => {
  assert.strictEqual(shouldFallbackToOtherSource({ error: 'HTTP 500 Internal Server Error' }), false);
});

// ══════════════════════════════════════════════════════════
// resolve —— 主流程
// ══════════════════════════════════════════════════════════

test('resolve: 参数无效（缺 id/source）⇒ INVALID_ARGS，不调用任何依赖', async () => {
  const { svc, getUrl } = build({});
  const r1 = await svc.resolve({ source: 'netease', title: 'x' }, 'standard');
  assert.strictEqual(r1.code, 'INVALID_ARGS');
  const r2 = await svc.resolve({ id: '1', title: 'x' }, 'standard');
  assert.strictEqual(r2.code, 'INVALID_ARGS');
  assert.strictEqual(getUrl.calls.length, 0, '参数校验失败不应触碰平台');
});

test('resolve: 本源成功 ⇒ 直接返回，不搜索候选', async () => {
  let searched = false;
  const { svc, health } = build(
    { 'netease:1': okResult() },
    { findCandidates: async () => { searched = true; return []; } },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.strictEqual(r.ext, 'mp3');
  assert.strictEqual(searched, false, '本源成功不应触发跨源搜索');
  assert.deepStrictEqual(health.calls, [['netease', true]]);
});

test('resolve: 本源失败但不可换源 ⇒ 返回本源原始错误（UI 文案不变）', async () => {
  let searched = false;
  const { svc } = build(
    { 'netease:1': { error: '网络错误，请检查网络连接', code: ERROR_CODES.NETWORK_ERROR } },
    { findCandidates: async () => { searched = true; return []; } },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.code, ERROR_CODES.NETWORK_ERROR);
  assert.strictEqual(r.error, '网络错误，请检查网络连接');
  assert.strictEqual(searched, false, '不可换源的失败不应触发搜索');
});

test('resolve: 本源失败且可换源 ⇒ 换源成功，附带 matchedSong / matchedFrom', async () => {
  const cand = { id: 'k9', source: 'kugou', title: '测试曲', artist: '歌手A' };
  const { svc, health } = build(
    {
      'netease:1': { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED },
      'kugou:k9': okResult({ ext: 'flac' }),
    },
    { findCandidates: async () => [cand] },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.strictEqual(r.source, 'kugou', '应标记实际提供流的源');
  assert.deepStrictEqual(r.matchedSong, cand);
  assert.strictEqual(r.matchedFrom, 'netease');
  assert.strictEqual(r.ext, 'flac');
  // 健康度：netease 失败 + kugou 成功
  assert.deepStrictEqual(health.calls, [['netease', false], ['kugou', true]]);
});

test('resolve: 换源逐个尝试，前面的候选失败则继续下一个', async () => {
  const c1 = { id: 'a', source: 'kugou', title: 't' };
  const c2 = { id: 'b', source: 'kuwo', title: 't' };
  const c3 = { id: 'c', source: 'migu', title: 't' };
  const { svc } = build(
    {
      'qq:1': { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED },
      'kugou:a': { error: '无音频流', code: ERROR_CODES.NO_AUDIO_STREAM },
      'kuwo:b': { error: 'HTTP 403' },
      'migu:c': okResult(),
    },
    { findCandidates: async () => [c1, c2, c3] },
  );
  const r = await svc.resolve({ id: '1', source: 'qq', title: 't', artist: 'a' }, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.strictEqual(r.source, 'migu', '应命中第三个候选');
});

test('resolve: 全部候选失败 ⇒ 返回**本源**错误（而非最后一个候选的错误）', async () => {
  const { svc } = build(
    {
      'netease:1': { error: '该歌曲需要 VIP 会员', code: ERROR_CODES.VIP_REQUIRED },
      'qq:9': { error: 'QQ 也失败', code: ERROR_CODES.COPYRIGHT_RESTRICTED },
    },
    { findCandidates: async () => [{ id: '9', source: 'qq', title: 't' }] },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.code, ERROR_CODES.VIP_REQUIRED, '应返回本源错误码');
  assert.strictEqual(r.error, '该歌曲需要 VIP 会员');
});

// ── _altSource 记忆 ───────────────────────────────────────

test('resolve: _altSource 记忆命中 ⇒ 直接返回，并标记 fromAltMemory', async () => {
  const song = { ...SONG, _altSource: { source: 'kugou', id: 'k9' } };
  const { svc, getUrl } = build({ 'kugou:k9': okResult() });
  const r = await svc.resolve(song, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.strictEqual(r.source, 'kugou');
  assert.strictEqual(r.fromAltMemory, true);
  assert.strictEqual(r.matchedFrom, 'netease');
  // 只应调用一次（记忆源），不应再试本源
  assert.deepStrictEqual(getUrl.calls, [['kugou', 'k9']]);
});

test('resolve: _altSource 记忆失效 ⇒ 回落正常流程（本源 → 换源）', async () => {
  const song = { ...SONG, _altSource: { source: 'kugou', id: 'k9' } };
  const cand = { id: 'w1', source: 'kuwo', title: 't' };
  const { svc, getUrl } = build(
    {
      'kugou:k9': { error: '无音频流', code: ERROR_CODES.NO_AUDIO_STREAM },
      'netease:1': okResult({ source: 'netease' }),
    },
    { findCandidates: async () => [cand] },
  );
  const r = await svc.resolve(song, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.strictEqual(r.fromAltMemory, undefined, '记忆失效不应标记 fromAltMemory');
  assert.deepStrictEqual(getUrl.calls, [['kugou', 'k9'], ['netease', '1']]);
});

test('resolve: _altSource 与本源同源时忽略记忆（不重复请求同一源）', async () => {
  const song = { ...SONG, _altSource: { source: 'netease', id: '1' } };
  const { svc, getUrl } = build({ 'netease:1': okResult() });
  await svc.resolve(song, 'standard');
  assert.deepStrictEqual(getUrl.calls, [['netease', '1']], '同源记忆应被忽略');
});

// ── 健康度 ────────────────────────────────────────────────

test('resolve: 候选按健康度重排（好源先试）', async () => {
  const c1 = { id: 'a', source: 'kugou', title: 't' };
  const c2 = { id: 'b', source: 'kuwo', title: 't' };
  const order = [];
  const svc = createResolveTrackService({
    getUrl: async (id, source) => {
      order.push(source);
      if (source === 'qq') return { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED };
      return source === 'kuwo' ? okResult() : { error: 'x' };
    },
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates: async () => [c1, c2],
    // 桩：把 kuwo 排到前面，模拟「kugou 健康度差」
    sourceHealth: {
      recordResult: () => {},
      rankByHealth: (arr) => [...arr].sort((x, _y) => (x.source === 'kuwo' ? -1 : 1)),
    },
  });
  const r = await svc.resolve({ id: '1', source: 'qq', title: 't', artist: 'a' }, 'standard');
  assert.strictEqual(r.source, 'kuwo');
  assert.deepStrictEqual(order, ['qq', 'kuwo'], '重排后应先试 kuwo');
});

test('resolve: 健康度记账失败不影响取流（统计是旁路）', async () => {
  const svc = createResolveTrackService({
    getUrl: async () => okResult(),
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates: async () => [],
    sourceHealth: { recordResult: () => { throw new Error('统计炸了'); } },
  });
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3', '记账抛错不应影响取流结果');
});

test('resolve: rankByHealth 抛错时用原序继续（不中断换源）', async () => {
  const c1 = { id: 'a', source: 'kugou', title: 't' };
  const svc = createResolveTrackService({
    getUrl: async (id, source) => (source === 'qq'
      ? { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED } : okResult()),
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates: async () => [c1],
    sourceHealth: { recordResult: () => {}, rankByHealth: () => { throw new Error('排序炸了'); } },
  });
  const r = await svc.resolve({ id: '1', source: 'qq', title: 't', artist: 'a' }, 'standard');
  assert.strictEqual(r.source, 'kugou');
});

// ── 异常与脏数据 ──────────────────────────────────────────

test('resolve: getUrl 抛异常 ⇒ 收敛为错误结果，不向上抛', async () => {
  const { svc } = build({ 'netease:1': new Error('boom') });
  const r = await svc.resolve(SONG, 'standard');
  assert.ok(r.error, '应返回错误对象而非抛错');
  assert.strictEqual(r.code, 'INTERNAL_ERROR');
  assert.strictEqual(r.fatal, true);
});

test('resolve: findCandidates 抛错 ⇒ 不中断，退化为返回本源错误', async () => {
  const { svc } = build(
    { 'netease:1': { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED } },
    { findCandidates: async () => { throw new Error('匹配炸了'); } },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.code, ERROR_CODES.VIP_REQUIRED);
});

test('resolve: findCandidates 返回非数组 ⇒ 按空候选处理', async () => {
  const { svc } = build(
    { 'netease:1': { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED } },
    { findCandidates: async () => null },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.code, ERROR_CODES.VIP_REQUIRED);
});

test('resolve: 候选中含脏数据（缺 id/source）被跳过', async () => {
  const good = { id: 'b', source: 'kuwo', title: 't' };
  const { svc } = build(
    {
      'netease:1': { error: 'VIP', code: ERROR_CODES.VIP_REQUIRED },
      'kuwo:b': okResult(),
    },
    { findCandidates: async () => [null, { id: '', source: 'x' }, { title: 'no id' }, good] },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.source, 'kuwo');
});

test('resolve: 数字 id 被归一化为字符串（平台 id 类型不一致的历史坑）', async () => {
  const { svc, getUrl } = build({ 'netease:12345': okResult() });
  await svc.resolve({ id: 12345, source: 'netease', title: 't' }, 'standard');
  assert.deepStrictEqual(getUrl.calls, [['netease', '12345']]);
});

// ── 返回形态契约 ──────────────────────────────────────────

test('resolve: 成功结果 ext 缺省补 mp3（下游据此定扩展名）', async () => {
  const { svc } = build({ 'netease:1': { url: 'https://cdn/x' } });
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.ext, 'mp3');
});

test('resolve: 失败结果形态统一为 { error, code, fatal }', async () => {
  const { svc } = build({ 'netease:1': {} });
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(typeof r.error, 'string');
  assert.strictEqual(typeof r.code, 'string');
  assert.strictEqual(r.fatal, true);
});

test('resolve: quality 原样透传给 getUrl', async () => {
  const seen = [];
  const svc = createResolveTrackService({
    getUrl: async (id, source, quality) => { seen.push(quality); return okResult(); },
    searchFn: async () => [],
    hasCookie: () => false,
    findCandidates: async () => [],
    sourceHealth: makeHealth(),
  });
  await svc.resolve(SONG, 'lossless');
  assert.deepStrictEqual(seen, ['lossless']);
});

// ══════════════════════════════════════════════════════════
// URL 过期重取（计划 Sprint B「待补：URL 过期重取」）
//
// 背景：平台给出的直链是**带签名的临时链**，TTL 常见 10~30 分钟。
// 播放侧（renderer）与下载侧（main）都先取流、再消费；只要中间隔了
// 足够久（挂着下载队列、用户暂停后很久才继续播放），链就会失效。
// 失效表现为 CDN 返回 403/404/410 —— 这正是 FALLBACK_HTTP_RE 覆盖的
// 形态：**没有业务错误码，只有一个 HTTP 状态文本**。
//
// 下面这些用例钉住的不是「HTTP 403 要换源」（上文已覆盖），而是
// **过期链重取时整条链路的形状约束**：
//   a) 无 code 的 HTTP 文本必须能一路穿透到换源决策（不被 normalize 抹掉）；
//   b) 重取必须打到「换源后的新源」，而不是复用失效链的源；
//   c) 同一首歌二次 resolve（模拟「用户重新点播放」）必须重新取流，
//      不得被上游任何缓存短路成同一失效链；
//   d) 全池失效时必须收敛成**死链可识别**的错误码，供 UI 提示"音源失效"。
// ══════════════════════════════════════════════════════════

test('URL 过期：无 code 的 HTTP 410 文本经 normalize 后仍保留 HTTP 特征', async () => {
  // 关键：normalizeTrackResult 必须**原样保留 error 文本**。
  // 若它把 error 重写成泛化文案（「内部错误，请重试」），
  // FALLBACK_HTTP_RE 就再也匹配不上 → 过期链永远不换源。
  const { svc } = build(
    { 'netease:1': { error: 'HTTP 410 Gone' } },
    { findCandidates: async () => [] },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.match(String(r.error), /HTTP\s*410/i,
    '过期文本被 normalize 抹掉后，FALLBACK_HTTP_RE 将失效，过期链不再换源');
});

test('URL 过期：直链失效 ⇒ 换源后返回**新链**，不复用失效链', async () => {
  const STALE = 'https://cdn-stale.example/expired.mp3?sign=old';
  const FRESH = 'https://cdn-fresh.example/ok.mp3?sign=new';
  const cand = { id: 'k9', source: 'kugou', title: '测试曲', artist: '歌手A' };
  const { svc, getUrl } = build(
    {
      // 本源：链已过期（签名失效，CDN 返 403，无业务 code）
      'netease:1': { error: 'HTTP 403 Forbidden', url: null },
      // 换源：拿到全新签名链
      'kugou:k9': { url: FRESH, ext: 'mp3' },
    },
    { findCandidates: async () => [cand] },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.url, FRESH, '必须返回重取到的新链');
  assert.notStrictEqual(r.url, STALE, '绝不能把失效链透传给消费方');
  assert.strictEqual(r.source, 'kugou', '应标记实际提供新链的源');
  assert.deepStrictEqual(getUrl.calls, [['netease', '1'], ['kugou', 'k9']],
    '重取必须打到换源后的新源上');
});

test('URL 过期：二次 resolve（用户重新点播放）⇒ 重新取流，不被缓存短路', async () => {
  // 模拟：第一次播放拿到链 → 放着过了 TTL → 用户再点播放。
  // 服务层**不应**自己做任何缓存；每次 resolve 都必须真的问一次 getUrl，
  // 否则用户会反复听到同一个失效链（表现为「点了没反应」）。
  const cand = { id: 'k9', source: 'kugou', title: '测试曲' };
  let expireAfter = 1; // 前 1 次调用返回有效链，之后全部过期
  const getUrl = async (_id, _source) => {
    if (expireAfter-- > 0) return okResult();
    return { error: 'HTTP 404 Not Found' };
  };
  const svc = createResolveTrackService({
    getUrl, searchFn: async () => [], hasCookie: () => false,
    findCandidates: async () => [cand], sourceHealth: makeHealth(),
  });

  const first = await svc.resolve(SONG, 'standard');
  assert.ok(first.url, '首次应拿到链');

  const second = await svc.resolve(SONG, 'standard');
  assert.ok(!second.url, '二次 resolve 必须重新取流（拿到的是已过期结果）');
  assert.match(String(second.error), /HTTP\s*404/i);
});

test('URL 过期：全池直链都过期 ⇒ 收敛为可识别的失效错误，而非空 url 静默成功', async () => {
  // 最坏情况：本源与所有候选的链同时过期。
  // 必须返回**带 error 的失败对象**，绝不能返回 { url: undefined } 这种
  // 「看起来成功但没有链」的形态 —— 那会让渲染层走到 proxied.fileUrl 判空，
  // 用户只看到一句泛化的「音源获取失败」，排查时无从下手。
  const { svc } = build(
    {
      'netease:1': { error: 'HTTP 403 Forbidden' },
      'kugou:k9': { error: 'HTTP 410 Gone' },
      'kuwo:w1': { error: 'HTTP 404 Not Found' },
    },
    {
      findCandidates: async () => [
        { id: 'k9', source: 'kugou', title: 't' },
        { id: 'w1', source: 'kuwo', title: 't' },
      ],
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.ok(!r.url, '全过期不应给出 url');
  assert.strictEqual(typeof r.error, 'string', '必须有可展示的错误文案');
  assert.ok(r.error.length > 0, '错误文案不能为空串');
  assert.match(String(r.error), /HTTP\s*(403|404|410)/i,
    '应保留具体 HTTP 状态，便于用户/日志定位是「音源失效」而非网络问题');
  // 返回的是**本源**错误（UI 文案与未换源时一致）
  assert.match(String(r.error), /403/);
});

test('URL 过期：过期链换源成功后回写 _altSource 语义（matchedSong 可用于下次直试）', async () => {
  // 过期重取成功 ⇒ 渲染层/下载层会把 matchedSong 写回 song._altSource。
  // 这里钉住服务层确实把 matchedSong 一并返回（否则回写会拿到 undefined，
  // 下次仍然白试一次失效的本源）。
  const cand = { id: 'k9', source: 'kugou', title: 't' };
  const { svc } = build(
    { 'netease:1': { error: 'HTTP 410 Gone' }, 'kugou:k9': okResult() },
    { findCandidates: async () => [cand] },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.deepStrictEqual(r.matchedSong, cand,
    'matchedSong 缺失时下游无法回写 _altSource，下次仍会白试失效本源');
  assert.strictEqual(r.matchedFrom, 'netease');
});

// ══════════════════════════════════════════════════════════
// 候选可播性探测（probeUrl 注入 —— go-music-dl Range 预检 / omniget 思路）
//
// 决策边界：探测只作用于**换源候选**（失败路径本已慢，多一次网络预检不伤
//  happy path）；只有决定性证据（非音频内容、404/410）才否决候选，
//  超时/连接错误等不定情形一律保守接受 —— 探测绝不能误杀能播的歌。
// ══════════════════════════════════════════════════════════

/** 探测桩：按 URL 返回配置结果；未配置的默认 { ok:true }；Error 值则抛出 */
function makeProbe(map = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const v = map[url];
    if (v instanceof Error) throw v;
    return v === undefined ? { ok: true } : v;
  };
  fn.calls = calls;
  return fn;
}

test('探测：候选取流成功后以直链调用 probeUrl', async () => {
  const probe = makeProbe();
  const { svc } = build(
    {
      'netease:1': { error: 'vip', code: 'VIP_REQUIRED' },
      'kuwo:w1': okResult({ url: 'https://cdn/w1.mp3' }),
    },
    {
      findCandidates: async () => [{ id: 'w1', source: 'kuwo', title: 't' }],
      probeUrl: probe,
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.source, 'kuwo');
  assert.deepStrictEqual(probe.calls, ['https://cdn/w1.mp3'],
    '候选 URL 必须经过探测才被采纳');
});

test('探测：text/plain 拒绝文本判死链 → 跳过该候选尝试下一源并记健康度失败', async () => {
  const probe = makeProbe({
    'https://cdn/dead.mp3': { ok: false, status: 200, contentType: 'text/plain', reason: 'not-audio' },
  });
  const { svc, health } = build(
    {
      'netease:1': { error: 'vip', code: 'VIP_REQUIRED' },
      'kuwo:w1': okResult({ url: 'https://cdn/dead.mp3' }),
      'kugou:k9': okResult({ url: 'https://cdn/live.mp3' }),
    },
    {
      findCandidates: async () => [
        { id: 'w1', source: 'kuwo', title: 't' },
        { id: 'k9', source: 'kugou', title: 't' },
      ],
      probeUrl: probe,
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.source, 'kugou', '死链候选应被跳过，继续尝试下一候选');
  assert.ok(health.calls.some(([s, ok]) => s === 'kuwo' && ok === false),
    '探测判死要记入 kuwo 健康度失败，让后续 rankByHealth 生效');
});

test('探测：404/410 为决定性失效证据 → 候选被否决', async () => {
  for (const status of [404, 410]) {
    const probe = makeProbe({
      [`https://cdn/${status}.mp3`]: { ok: false, status },
    });
    const { svc } = build(
      {
        'netease:1': { error: 'vip', code: 'VIP_REQUIRED' },
        [`kuwo:${status}`]: okResult({ url: `https://cdn/${status}.mp3` }),
      },
      {
        findCandidates: async () => [{ id: String(status), source: 'kuwo', title: 't' }],
        probeUrl: probe,
      },
    );
    const r = await svc.resolve(SONG, 'standard');
    assert.ok(!r.url, `HTTP ${status} 的候选链不应被返回`);
  }
});

test('探测：超时/连接错误属不定证据 → 保守接受候选', async () => {
  for (const inconclusive of [
    { ok: false, status: null, reason: 'timeout' },
    { ok: false, status: null, reason: 'econnreset' },
    { ok: false, status: 500, reason: 'HTTP 500' },
  ]) {
    const probe = makeProbe({ 'https://cdn/maybe.mp3': inconclusive });
    const { svc } = build(
      {
        'netease:1': { error: 'vip', code: 'VIP_REQUIRED' },
        'kuwo:w1': okResult({ url: 'https://cdn/maybe.mp3' }),
      },
      {
        findCandidates: async () => [{ id: 'w1', source: 'kuwo', title: 't' }],
        probeUrl: probe,
      },
    );
    const r = await svc.resolve(SONG, 'standard');
    assert.strictEqual(r.url, 'https://cdn/maybe.mp3',
      `不定探测结果 ${JSON.stringify(inconclusive)} 不应否决候选`);
  }
});

test('探测：probeUrl 自身抛异常 → 保守接受（探测实现故障不得阻断换源）', async () => {
  const probe = makeProbe({ 'https://cdn/x.mp3': new Error('probe 炸了') });
  const { svc } = build(
    {
      'netease:1': { error: 'vip', code: 'VIP_REQUIRED' },
      'kuwo:w1': okResult({ url: 'https://cdn/x.mp3' }),
    },
    {
      findCandidates: async () => [{ id: 'w1', source: 'kuwo', title: 't' }],
      probeUrl: probe,
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
});

test('探测：全部候选被否决时返回本源原始错误（与无探测时文案一致）', async () => {
  const probe = makeProbe({
    'https://cdn/a.mp3': { ok: false, status: 200, contentType: 'text/plain', reason: 'not-audio' },
    'https://cdn/b.mp3': { ok: false, status: 404 },
  });
  const { svc } = build(
    {
      'netease:1': { error: '需要VIP', code: 'VIP_REQUIRED' },
      'kuwo:w1': okResult({ url: 'https://cdn/a.mp3' }),
      'kugou:k9': okResult({ url: 'https://cdn/b.mp3' }),
    },
    {
      findCandidates: async () => [
        { id: 'w1', source: 'kuwo', title: 't' },
        { id: 'k9', source: 'kugou', title: 't' },
      ],
      probeUrl: probe,
    },
  );
  const r = await svc.resolve(SONG, 'standard');
  assert.ok(!r.url);
  assert.strictEqual(r.code, 'VIP_REQUIRED', '应回落到本源错误而非新造的探测错误码');
});

test('探测：本源成功路径零探测调用（happy path 不加延迟）', async () => {
  const probe = makeProbe();
  const { svc } = build({ 'netease:1': okResult() }, { probeUrl: probe });
  const r = await svc.resolve(SONG, 'standard');
  assert.strictEqual(r.url, 'https://cdn/x.mp3');
  assert.deepStrictEqual(probe.calls, []);
});

test('探测：_altSource 记忆命中路径零探测', async () => {
  const probe = makeProbe();
  const { svc } = build(
    { 'kugou:k9': okResult({ url: 'https://cdn/alt.mp3' }) },
    { probeUrl: probe },
  );
  const r = await svc.resolve({ ...SONG, _altSource: { source: 'kugou', id: 'k9' } }, 'standard');
  assert.strictEqual(r.url, 'https://cdn/alt.mp3');
  assert.strictEqual(r.fromAltMemory, true);
  assert.deepStrictEqual(probe.calls, []);
});
