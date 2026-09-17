/**
 * matchMusic 单测：规范化 / 打分 / VIP 候选过滤 / 并发去重
 * getDownloadUrlSmart 的门控逻辑（shouldFallback）在 api 层，网络依赖重，
 * 由 E2E 覆盖；本文件只测纯函数与依赖注入路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeName, normalizeArtists, matchScore, isPaidCandidate,
  findMatchedCandidates, CANDIDATE_SOURCES, _resetForTest,
} = require('../src/utils/matchMusic');

// ── normalizeName ──────────────────────────────────────

test('normalizeName: 全角→半角 + 去标点空白 + 小写', () => {
  assert.strictEqual(normalizeName('晴天（Ｌｉｖｅ）'), '晴天live'); // 词保留，只去标点
  assert.strictEqual(normalizeName('晴天'), '晴天');
  assert.strictEqual(normalizeName('ＱＱ愛樂團'), 'qq愛樂團');
  assert.strictEqual(normalizeName('Sunny Day!'), 'sunnyday');
  assert.strictEqual(normalizeName(''), '');
});

test('normalizeName: 标点/空白被剥离，词保留（版本词靠时长容差挡）', () => {
  assert.strictEqual(normalizeName('晴天【伴奏版】'), '晴天伴奏版');
  assert.strictEqual(normalizeName('晴天 (DJ Version)'), '晴天djversion');
  assert.strictEqual(normalizeName('晴天（Live）'), normalizeName('晴天(live)')); // 括号形态无关
});

// ── normalizeArtists ───────────────────────────────────

test('normalizeArtists: 多人歌手排序拼接，顺序无关', () => {
  assert.strictEqual(
    normalizeArtists('周杰伦/费玉清'),
    normalizeArtists('费玉清、周杰伦')
  );
  assert.strictEqual(
    normalizeArtists('A, B & C'),
    normalizeArtists('C；B；A')
  );
});

// ── matchScore ─────────────────────────────────────────

test('matchScore: 歌名+歌手+时长全中 = 3', () => {
  const orig = { title: '晴天', artist: '周杰伦', duration: 269000 };
  const cand = { title: '晴天', artist: '周杰伦', duration: 272000 }; // 3s 差在容差内
  assert.strictEqual(matchScore(orig, cand), 3);
});

test('matchScore: 时长差超 5s 降级', () => {
  const orig = { title: '晴天', artist: '周杰伦', duration: 269000 };
  const cand = { title: '晴天', artist: '周杰伦', duration: 290000 }; // 21s 差
  assert.strictEqual(matchScore(orig, cand), 2); // 歌名+歌手仍成立
});

test('matchScore: 翻唱——歌名带版本词(规范化后不同名) = 0；纯同名不同歌手 = 1 不达门槛', () => {
  const orig = { title: '晴天', artist: '周杰伦', duration: 269000 };
  // 版本词让规范化后歌名不同（晴天女声版 ≠ 晴天），直接 0
  assert.strictEqual(matchScore(orig, { title: '晴天(女声版)', artist: '王小美', duration: 269000 }), 0);
  // 歌名完全相同、歌手不同、无时长 = 1（低于采纳门槛 2）
  assert.strictEqual(matchScore(orig, { title: '晴天', artist: '王小美' }), 1);
});

test('matchScore: 歌名不同 = 0', () => {
  assert.strictEqual(matchScore({ title: '晴天' }, { title: '七里香' }), 0);
});

// ── isPaidCandidate ────────────────────────────────────

test('isPaidCandidate: netease fee 1/4 付费，0/8 免费', () => {
  assert.strictEqual(isPaidCandidate({ source: 'netease', fee: 1 }), true);
  assert.strictEqual(isPaidCandidate({ source: 'netease', fee: 4 }), true);
  assert.strictEqual(isPaidCandidate({ source: 'netease', fee: 0 }), false);
  assert.strictEqual(isPaidCandidate({ source: 'netease', fee: 8 }), false);
});

test('isPaidCandidate: qq pay.payplay/paydownload = 1 付费', () => {
  assert.strictEqual(isPaidCandidate({ source: 'qq', pay: { payplay: 1 } }), true);
  assert.strictEqual(isPaidCandidate({ source: 'qq', pay: { paydownload: 1 } }), true);
  assert.strictEqual(isPaidCandidate({ source: 'qq', pay: { payplay: 0 } }), false);
  assert.strictEqual(isPaidCandidate({ source: 'qq' }), false);
});

// ── findMatchedCandidates（依赖注入，无网络）────────────

function makeDeps(resultsBySource, cookieSet = new Set()) {
  return {
    searchFn: (src, _kw) => resultsBySource[src] || [],
    hasCookie: (src) => cookieSet.has(src),
  };
}

test('findMatchedCandidates: 无 Cookie 时付费候选降权保留（免费在前）', async () => {
  _resetForTest();
  const song = { id: 'bv1', source: 'bilibili', title: '晴天', artist: '周杰伦', duration: 269000 };
  const deps = makeDeps({
    netease: [
      { id: 'n1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000, fee: 1 }, // VIP：降权垫后
      { id: 'n2', source: 'netease', title: '晴天', artist: '周杰伦', duration: 270000, fee: 0 }, // 免费：靠前
    ],
    qq: [
      { id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000, pay: { payplay: 1 } }, // 付费：降权
    ],
    kugou: [
      { id: 'k1', source: 'kugou', title: '晴天', artist: '周杰伦', duration: 269000 }, // 免费靠前
    ],
  }, new Set()); // 无任何 Cookie

  const out = await findMatchedCandidates(deps, song);
  const ids = out.map(c => c.id);
  // 全部保留（原付费直接过滤会让「原歌付费→跨源同曲也付费」换源 0 候选）
  assert.deepStrictEqual(ids.slice().sort(), ['k1', 'n1', 'n2', 'q1']);
  // 免费候选（k1/n2）必须排在付费（n1/q1）之前
  assert.deepStrictEqual(ids.slice(0, 2).sort(), ['k1', 'n2']);
});

test('findMatchedCandidates: 有 Cookie 时付费候选保留', async () => {
  _resetForTest();
  const song = { id: 'bv1', source: 'bilibili', title: '晴天', artist: '周杰伦', duration: 269000 };
  const deps = makeDeps({
    netease: [
      { id: 'n1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000, fee: 1 },
    ],
  }, new Set(['netease']));

  const out = await findMatchedCandidates(deps, song);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, 'n1');
});

test('findMatchedCandidates: 门槛过滤——翻唱与带版本词的候选被排除', async () => {
  _resetForTest();
  const song = { id: 'q-vip', source: 'qq', title: '搁浅', artist: '周杰伦', duration: 240000 };
  const deps = makeDeps({
    netease: [
      { id: 'n1', source: 'netease', title: '搁浅', artist: '王小美', duration: 240000 }, // 歌手不同 score 1
      { id: 'n2', source: 'netease', title: '搁浅', artist: '周杰伦', duration: 241000 }, // score 3
    ],
    kugou: [
      // 规范化后 '搁浅钢琴版' ≠ '搁浅'，score 0，直接排除
      { id: 'k1', source: 'kugou', title: '搁浅(钢琴版)', artist: '周杰伦', duration: 240000 },
    ],
  });

  const out = await findMatchedCandidates(deps, song);
  const ids = out.map(c => c.id);
  assert.deepStrictEqual(ids, ['n2']); // n1 门槛挡、k1 版本词排除，只剩 n2
});

test('findMatchedCandidates: 并发去重——同 key 只搜一次', async () => {
  _resetForTest();
  let calls = 0;
  const song = { id: 'x1', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 };
  const deps = {
    searchFn: async () => { calls++; await new Promise(r => setTimeout(r, 50)); return []; },
    hasCookie: () => true,
  };

  await Promise.all([
    findMatchedCandidates(deps, song),
    findMatchedCandidates(deps, song),
    findMatchedCandidates(deps, song),
  ]);
  // 每个源一次搜索，3 个并发请求合并为 1 轮（除本源外每个候选源各 1 次 searchFn）
  assert.strictEqual(calls, CANDIDATE_SOURCES.length - 1);
});

test('findMatchedCandidates: 缓存命中——第二次不再搜索', async () => {
  _resetForTest();
  let calls = 0;
  const song = { id: 'x1', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 };
  const deps = {
    searchFn: async () => { calls++; return [{ id: 'n1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000 }]; },
    hasCookie: () => true,
  };

  const a = await findMatchedCandidates(deps, song);
  const b = await findMatchedCandidates(deps, song);
  assert.strictEqual(calls, CANDIDATE_SOURCES.length - 1); // 只首轮：各候选源搜一次，缓存轮 0 次
  // searchFn 不分源都返回 n1（source:'netease'），每个源的结果都贡献同一个候选
  assert.strictEqual(a.length, CANDIDATE_SOURCES.length - 1);
  assert.deepStrictEqual(a.map(x => x.id), b.map(x => x.id));
});

test('findMatchedCandidates: 单源候选超限时最多取 5 个', async () => {
  _resetForTest();
  const song = { id: 'x1', source: 'bilibili', title: '晴天', artist: '周杰伦', duration: 269000 };
  const many = Array.from({ length: 10 }, (_, i) => ({
    id: 'n' + i, source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000,
  }));
  const deps = makeDeps({ netease: many });

  const out = await findMatchedCandidates(deps, song);
  assert.ok(out.length <= 5);
});

test('findMatchedCandidates: 参数无效返回空数组', async () => {
  _resetForTest();
  const deps = makeDeps({});
  assert.deepStrictEqual(await findMatchedCandidates(deps, null), []);
  assert.deepStrictEqual(await findMatchedCandidates(deps, { title: 'x' }), []); // 无 source
});

// ── splitBiliTitle（B 站歌名拆歌手）───────────────────

test('splitBiliTitle: 「歌名 - 歌手」→ 拆出真实歌名歌手', async () => {
  const { splitBiliTitle } = require('../src/utils/matchMusic');
  const song = { id: 'BV1', source: 'bilibili', title: '晴天 - 周杰伦', artist: '长安三万里-', duration: 270000 };
  const split = splitBiliTitle(song);
  assert.strictEqual(split.title, '晴天');
  assert.strictEqual(split.artist, '周杰伦');
  // 原对象不被修改
  assert.strictEqual(song.title, '晴天 - 周杰伦');
});

test('splitBiliTitle: 无分隔符 / 非B站 原样返回', async () => {
  const { splitBiliTitle } = require('../src/utils/matchMusic');
  assert.deepStrictEqual(
    splitBiliTitle({ id: '1', source: 'netease', title: '晴天', artist: '周杰伦' }),
    { id: '1', source: 'netease', title: '晴天', artist: '周杰伦' }
  );
  const noSep = splitBiliTitle({ id: '2', source: 'bilibili', title: '晴天MV修复版', artist: 'UP主', duration: 1 });
  assert.strictEqual(noSep.title, '晴天MV修复版');
});

test('findMatchedCandidates: B 站歌拆名后能匹配音乐源同曲', async () => {
  _resetForTest();
  const song = { id: 'BV1', source: 'bilibili', title: '晴天 - 周杰伦', artist: '长安三万里-', duration: 270000 };
  const deps = makeDeps({
    netease: [
      { id: 'n1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000, fee: 0 },
      { id: 'n2', source: 'netease', title: '晴天(深情版)', artist: 'Lucky小爱', duration: 270738, fee: 8 }, // 翻唱
    ],
  });
  const out = await findMatchedCandidates(deps, song);
  assert.deepStrictEqual(out.map(c => c.id), ['n1']); // 拆名后匹配原曲，翻唱被挡
});

// ── B 站装饰标题（书名号/【Hi-Res】/MV 前缀）────────────

test('splitBiliTitle: 书名号《歌名》优先提取，装饰连字符不误切', async () => {
  const { splitBiliTitle } = require('../src/utils/matchMusic');
  const song = {
    id: 'BV2', source: 'bilibili',
    title: '【Hi-Res无损音质】｜《晴天》- 周杰伦 -‘故事的小黄花’',
    artist: 'VV音乐局', duration: 270000,
  };
  const split = splitBiliTitle(song);
  assert.strictEqual(split.title, '晴天');
  assert.strictEqual(split.artist, '周杰伦');
});

test('titleHit: 版本装饰词剥尾后全等命中，子串/短名不误配', async () => {
  const { splitBiliTitle, matchScore } = require('../src/utils/matchMusic');
  // 书名号拆出核心后 titleHit 走全等
  const split = splitBiliTitle({ id: 'BV3', source: 'bilibili', title: '《搁浅》- 周杰伦', artist: 'UP', duration: 260000 });
  assert.strictEqual(matchScore(split, { title: '搁浅', artist: '周杰伦', duration: 259000 }), 3);
  // 版本词剥尾：「晴天live」≡「晴天」（歌手同、时长同 → 3 分）
  assert.strictEqual(
    matchScore({ title: '晴天live', artist: '周杰伦', duration: 270000 }, { title: '晴天', artist: '周杰伦', duration: 269000 }), 3);
  // 「晴天(DJ Version)」剥尾后仍同歌名，但时长若超出容差只拿歌名+歌手的 2 分
  assert.strictEqual(
    matchScore({ title: '晴天 (DJ Version)', artist: '周杰伦', duration: 312000 }, { title: '晴天', artist: '周杰伦', duration: 269000 }), 2);
  // 子串不误配：「吻」vs「吻别」、「晴天」vs「晴天娃娃」都是 0 分
  assert.strictEqual(matchScore({ title: '吻', artist: 'A', duration: 1 }, { title: '吻别', artist: 'A', duration: 1 }), 0);
  assert.strictEqual(matchScore({ title: '晴天', artist: 'A', duration: 1 }, { title: '晴天娃娃', artist: 'A', duration: 1 }), 0);
});

test('findMatchedCandidates: B 站装饰标题（书名号+Hi-Res连字符）匹配音乐源原曲', async () => {
  _resetForTest();
  const song = {
    id: 'BV4', source: 'bilibili',
    title: '【Hi-Res无损音质】｜《晴天》- 周杰伦 -‘故事的小黄花’',
    artist: 'VV音乐局', duration: 270000,
  };
  const deps = makeDeps({
    netease: [{ id: 'n1', source: 'netease', title: '晴天', artist: '周杰伦', duration: 269000, fee: 0 }],
    qq: [{ id: 'q1', source: 'qq', title: '晴天', artist: '周杰伦', duration: 269000 }],
  });
  const out = await findMatchedCandidates(deps, song);
  assert.ok(out.length >= 1, `应有候选，实际 ${JSON.stringify(out.map(c => c.source))}`);
  assert.strictEqual(out[0].title, '晴天');
});
