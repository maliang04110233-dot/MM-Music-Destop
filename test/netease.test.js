/**
 * 单元测试：网易云平台适配器 —— getUrl 降级链与错误语义
 *
 * 为什么只单测这一段：`search` 链路**已经**被 test/platform-fixture.test.js 用实测
 * 录制的 raw 响应覆盖（逐字段钉住映射、HTML 残留、协议、normalizeSong 幂等），
 * 所以这里不重复。真正的盲区是 fixture 够不到的那一层 —— **getUrl 一条都没测**，
 * 而它的三类静默失败代价最高：
 *
 *   1. 降级链顺序写错 → 请求 lossless 却悄悄给 128k（用户以为下的是无损，无任何报错）
 *   2. fee 语义互换 → 把「充钱能解决」说成「版权没有」，用户永远不会去填 Cookie
 *   3. catch 挪出循环 → 首个品质网络抖动就整首失败（本该降级成功）
 *
 * 打桩方式：替换 require.cache 里 NeteaseCloudMusicApi 的导出（沿用
 * test/kugou.test.js 对 src/api/request 的已验证手法），再清掉适配器模块缓存重新
 * require。适配器顶层 `const ncm = require('NeteaseCloudMusicApi')` 已捕获引用，
 * 所以必须换「模块导出对象本身」。
 *
 * 未命中即抛（本文件的核心守卫）：
 *   - 桩只提供白名单方法，调用白名单外的方法**立即抛错并记账**。
 *     漏桩若静默返回空对象，用例会假绿（本项目已记录的「守卫假绿」来源之一）。
 *   - 记账是必须的：抛出的错会被适配器自己的 try/catch 吞掉，
 *     光靠「抛错」无法让用例变红，只有末条元测试的计数才能把它暴露出来。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ── 打桩：NeteaseCloudMusicApi ───────────────────────────────
const SDK_PATH = require.resolve('NeteaseCloudMusicApi');
const realSdk = require(SDK_PATH);

/** 适配器实际会用到的方法；新增 SDK 依赖必须显式加进来 */
const SDK_METHODS = new Set([
  'search', 'song_url', 'song_detail', 'lyric', 'login_status',
  'playlist_detail', 'personalized', 'artists', 'artist_album', 'album',
]);

let calls = [];                    // 本轮 [{ method, args }]
let respond = null;                // (method, args) => response
let totalCalls = 0;                // 全程桩命中次数（元测试用）
const whitelistViolations = [];    // 白名单外的方法名（元测试用）

const stub = new Proxy({}, {
  get(_target, prop) {
    // Symbol（含 thenable 探测、util.inspect）一律放行，避免误伤
    if (typeof prop !== 'string' || prop === 'then') return undefined;
    if (!SDK_METHODS.has(prop)) {
      whitelistViolations.push(prop);
      throw new Error(
        `netease 适配器调用了白名单外的 SDK 方法 "${prop}" —— ` +
        '新增 SDK 依赖必须显式加进本测试白名单，否则打桩会静默失效');
    }
    return async (args) => {
      calls.push({ method: prop, args });
      totalCalls += 1;
      if (!respond) {
        throw new Error(`未打桩的 SDK 调用 ${prop}()（漏桩必须炸出来，不能静默返回空）`);
      }
      return respond(prop, args);
    };
  },
});

require.cache[SDK_PATH] = {
  id: SDK_PATH, filename: SDK_PATH, loaded: true, exports: stub,
};

const NET_PATH = require.resolve('../src/api/platforms/netease');
delete require.cache[NET_PATH];
const netease = require(NET_PATH);

// ── 造响应 ───────────────────────────────────────────────────

/** 拿到可用地址 */
const urlOk = (br) => ({
  body: { data: [{ url: `https://cdn.example/${br}.mp3`, type: 'mp3', br, size: 1234 }] },
});
/** url 为 null：区分 VIP 与版权/下架 */
const urlNull = (fee) => ({ body: { data: [{ url: null, fee }] } });
/** 该档完全没有数据（降级链继续往下走） */
const noData = () => ({ body: { data: [] } });

/** 每个用例前重置打桩状态 */
function reset(fn) {
  calls = [];
  respond = fn || null;
}

// ══════════════════════════════════════════════════════════
// 0. 自检
// ══════════════════════════════════════════════════════════

test('自检：SDK 打桩已生效（否则用例会打真实网络请求）', () => {
  assert.notStrictEqual(
    require(SDK_PATH), realSdk,
    '打桩未生效：适配器会拿到真实 SDK 并发真请求');
  assert.strictEqual(typeof netease.getUrl, 'function');
});

// ══════════════════════════════════════════════════════════
// 1. 降级链：顺序与长度都是契约
// ══════════════════════════════════════════════════════════

test('getUrl: lossless 链必须依次试 999000 → 320000 → 128000（顺序与长度都是契约）', async () => {
  reset(() => noData());
  const r = await netease.getUrl('186016', 'lossless');
  assert.deepStrictEqual(
    calls.map((c) => c.args.br), [999000, 320000, 128000],
    '降级链顺序/长度漂移：少一档会拿不到歌，顺序颠倒会静默降质');
  assert.strictEqual(r.code, 'UNAVAILABLE', '全档无数据时应报不可用');
});

test('getUrl: hq 链为 320000 → 128000', async () => {
  reset(() => noData());
  await netease.getUrl('186016', 'hq');
  assert.deepStrictEqual(calls.map((c) => c.args.br), [320000, 128000]);
});

test('getUrl: standard 链只有 128000（不得再多打一档）', async () => {
  reset(() => noData());
  await netease.getUrl('186016', 'standard');
  assert.deepStrictEqual(calls.map((c) => c.args.br), [128000]);
});

test('getUrl: 未知品质按 standard 兜底（不抛错，也不多试高档）', async () => {
  reset(() => noData());
  await netease.getUrl('186016', 'weird-quality');
  assert.deepStrictEqual(calls.map((c) => c.args.br), [128000]);
});

test('getUrl: 降级成功时必须如实回报 requestedBr（不得谎报最初请求的档位）', async () => {
  reset((_m, args) => (args.br === 128000 ? urlOk(128000) : noData()));
  const r = await netease.getUrl('186016', 'lossless');
  assert.strictEqual(r.requestedBr, 128000,
    'requestedBr 必须反映**实际拿到**的档位，否则下载记录会谎报无损');
  assert.strictEqual(r.br, 128000);
  assert.ok(String(r.url).includes('128000'));
  assert.deepStrictEqual(calls.map((c) => c.args.br), [999000, 320000, 128000]);
});

// ══════════════════════════════════════════════════════════
// 2. cookie 透传（VIP 曲依赖它）
// ══════════════════════════════════════════════════════════

test('getUrl: 传入 cookie 必须下发给 SDK（VIP 曲没有它拿不到地址）', async () => {
  reset(() => noData());
  await netease.getUrl('186016', 'standard', 'MUSIC_U=abc');
  assert.strictEqual(calls[0].args.cookie, 'MUSIC_U=abc');
});

test('getUrl: 空 cookie 不得作为字段下发（避免服务端把它当登录态）', async () => {
  reset(() => noData());
  await netease.getUrl('186016', 'standard');
  assert.ok(!('cookie' in calls[0].args), `不应下发 cookie 字段: ${JSON.stringify(calls[0].args)}`);
});

// ══════════════════════════════════════════════════════════
// 3. url=null 的语义区分（B12：VIP vs 版权/下架）
// ══════════════════════════════════════════════════════════

test('getUrl: url=null 且 fee=1 → VIP_REQUIRED（要引导用户去填 Cookie）', async () => {
  reset(() => urlNull(1));
  const r = await netease.getUrl('186016', 'standard');
  assert.strictEqual(r.code, 'VIP_REQUIRED');
  assert.strictEqual(r.fatal, true);
  assert.strictEqual(r.platform, '网易云');
});

test('getUrl: url=null 且 fee=0 → COPYRIGHT_RESTRICTED（不是 VIP 问题，别误导用户充钱）', async () => {
  reset(() => urlNull(0));
  const r = await netease.getUrl('186016', 'standard');
  assert.strictEqual(r.code, 'COPYRIGHT_RESTRICTED');
  assert.notStrictEqual(r.code, 'VIP_REQUIRED');
});

test('getUrl: fee 只有 1 算 VIP；4（专辑）与 8（低品质免费）都归版权限制', async () => {
  for (const fee of [4, 8]) {
    reset(() => urlNull(fee));
    const r = await netease.getUrl('186016', 'standard');
    assert.strictEqual(r.code, 'COPYRIGHT_RESTRICTED', `fee=${fee} 应归版权限制，不该报 VIP`);
  }
});

// ══════════════════════════════════════════════════════════
// 4. 异常处理：catch 必须在循环内
// ══════════════════════════════════════════════════════════

test('getUrl: 某一档请求抛错必须继续试下一档（catch 在循环内，不是整首失败）', async () => {
  reset((_m, args) => {
    if (args.br === 999000) throw new Error('模拟 999000 档网络抖动');
    return urlOk(args.br);
  });
  const r = await netease.getUrl('186016', 'lossless');
  assert.ok(r.url, `首档抛错不该让整首失败: ${JSON.stringify(r)}`);
  assert.strictEqual(r.requestedBr, 320000);
  assert.deepStrictEqual(calls.map((c) => c.args.br), [999000, 320000]);
});

test('getUrl: 所有档位都失败 → UNAVAILABLE 且 fatal=true（不得返回 undefined）', async () => {
  reset(() => { throw new Error('全档都挂'); });
  const r = await netease.getUrl('186016', 'lossless');
  assert.ok(r, 'getUrl 必须返回错误对象，不能返回 undefined（上游会崩在别处）');
  assert.strictEqual(r.code, 'UNAVAILABLE');
  assert.strictEqual(r.fatal, true);
  assert.ok(String(r.error).includes('网易云'));
});

// ══════════════════════════════════════════════════════════
// 5. 榜单：榜名 → ID 映射（写错 = 静默空榜）
// ══════════════════════════════════════════════════════════

test('榜单：NETEASE_TOP_MAP 四个榜名→ID 逐条精确（服务端下发，写错即静默空榜）', () => {
  // 这组字面量是契约：ID 由网易云下发，本地无法推导。
  // 若测试变红，说明有人改了映射 —— 必须去线上核对该榜的真实 ID，不是改测试。
  assert.deepStrictEqual(netease.NETEASE_TOP_MAP, {
    飙升榜: 19723756,
    热歌榜: 3778678,
    新歌榜: 3779629,
    原创榜: 2884035,
  });
});

test('榜单：getTopList 必须把榜名换成 ID 再拉歌单（且把 limit 透传）', async () => {
  reset(() => ({ body: { playlist: { tracks: [] } } }));
  await netease.getTopList('热歌榜', 10);
  assert.strictEqual(calls[0].method, 'playlist_detail');
  assert.strictEqual(calls[0].args.id, 3778678, '热歌榜 ID 必须与服务端一致');
  assert.strictEqual(calls[0].args.limit, 10);
});

test('榜单：未知榜名返回空数组且**不发起任何请求**（不得拿 undefined 当 id 打接口）', async () => {
  reset(() => { throw new Error('未知榜名不该发起请求'); });
  const r = await netease.getTopList('这个榜不存在', 10);
  assert.deepStrictEqual(r, []);
  assert.strictEqual(calls.length, 0, `未知榜名不应发请求，实际: ${JSON.stringify(calls)}`);
});

// ══════════════════════════════════════════════════════════
// 6. 推荐歌单：三路响应形态兜底
// ══════════════════════════════════════════════════════════

test('推荐歌单：body.result / result / body 三种形态都要吃（显式写下的兜底意图）', async () => {
  const item = { id: 7001, name: '华语私人雷达', picUrl: 'https://p/r.jpg', playCount: 12345 };
  const shapes = [
    ['body.result', { body: { result: [item] } }],
    ['result', { result: [item] }],
    ['body', { body: [item] }],
  ];
  for (const [label, resp] of shapes) {
    reset(() => resp);
    const out = await netease.getRecommendPlaylists(6);
    assert.strictEqual(out.length, 1, `${label} 形态未被识别 —— 删掉兜底会让首页推荐歌单整块消失`);
    assert.deepStrictEqual(out[0], {
      id: '7001', name: '华语私人雷达', cover: 'https://p/r.jpg', playCount: 12345, source: 'netease',
    });
  }
  assert.strictEqual(calls[0].args.limit, 6, 'limit 必须透传给 personalized');
});

test('推荐歌单：异常与空响应一律返回空数组（首页不该因为推荐域挂掉而崩）', async () => {
  reset(() => { throw new Error('personalized 挂了'); });
  assert.deepStrictEqual(await netease.getRecommendPlaylists(6), []);
  reset(() => ({ body: {} }));
  assert.deepStrictEqual(await netease.getRecommendPlaylists(6), []);
});

// ══════════════════════════════════════════════════════════
// 7. 详情：同平台两套字段名（search 用 artists/album，detail 用 ar/al）
// ══════════════════════════════════════════════════════════

test('详情：getSongDetail 用 ar/al 字段映射（歌手多值用 " / " 连接、封面补 param）', async () => {
  reset(() => ({
    body: {
      songs: [{
        id: 186016, name: '晴天',
        ar: [{ name: '周杰伦' }, { name: '杨瑞代' }],
        al: { name: '叶惠美', picUrl: 'https://p1.music.126.net/x.jpg' },
        dt: 269733,
      }],
    },
  }));
  const s = await netease.getSongDetail('186016');
  assert.strictEqual(calls[0].method, 'song_detail');
  assert.strictEqual(calls[0].args.ids, '186016', 'ids 必须传字符串');
  assert.strictEqual(s.id, '186016');
  assert.strictEqual(s.title, '晴天');
  assert.strictEqual(s.artist, '周杰伦 / 杨瑞代');
  assert.strictEqual(s.album, '叶惠美');
  assert.strictEqual(s.cover, 'https://p1.music.126.net/x.jpg?param=300y300');
  assert.strictEqual(s.duration, 269733, '网易云 dt 已是毫秒，不得再乘 1000');
  assert.strictEqual(s.source, 'netease');
});

test('分歧钉：song_detail 读 ar/al 而 search 读 artists/album —— 两套字段名并存是现状契约', async () => {
  // 正向：detail 侧喂 ar/al 能拿到值
  reset(() => ({ body: { songs: [{ id: 1, name: 'x', ar: [{ name: 'A' }], al: { name: 'B' }, dt: 1 }] } }));
  const ok = await netease.getSongDetail('1');
  assert.strictEqual(ok.artist, 'A');
  assert.strictEqual(ok.album, 'B');

  // 反向：detail 侧喂 search 那套字段名**必须拿不到值**。
  // 这条钉的作用是：若日后有人「统一字段名」，这里会立刻变红，
  // 强制他同时核对 search 侧 —— 而不是悄悄改坏一边。
  reset(() => ({ body: { songs: [{ id: 1, name: 'x', artists: [{ name: 'A' }], album: { name: 'B' }, duration: 1 }] } }));
  const wrong = await netease.getSongDetail('1');
  assert.strictEqual(wrong.artist, '',
    'song_detail 读的是 ar，不是 artists —— 若这里拿到 A，说明字段名被统一了，必须同步核对 search 侧');
  assert.strictEqual(wrong.album, '');
});

test('详情：拉不到（无 songs / bvid 缺失场景）返回 null，不抛错', async () => {
  reset(() => ({ body: { songs: [] } }));
  assert.strictEqual(await netease.getSongDetail('1'), null);
  reset(() => { throw new Error('song_detail 挂了'); });
  assert.strictEqual(await netease.getSongDetail('1'), null);
});

// ══════════════════════════════════════════════════════════
// 8. 歌词与 Cookie 校验：可选能力不得拖垮主流程
// ══════════════════════════════════════════════════════════

test('歌词：无 lrc 或接口抛错一律返回空串（歌词是可选的，不得让整首播放失败）', async () => {
  reset(() => ({ body: {} }));
  assert.strictEqual(await netease.getLyrics('1'), '');
  reset(() => ({ body: { lrc: { lyric: '[00:00.00]词' } } }));
  assert.strictEqual(await netease.getLyrics('1'), '[00:00.00]词');
  reset(() => { throw new Error('lyric 挂了'); });
  assert.strictEqual(await netease.getLyrics('1'), '');
});

test('Cookie 校验：无 profile.userId → valid:false；有则 nickname 兜底为「用户」', async () => {
  reset(() => ({ body: {} }));
  assert.deepStrictEqual(await netease.verifyCookie('c'), { valid: false });

  reset(() => ({ body: { profile: { userId: 1, nickname: '小明' } } }));
  assert.deepStrictEqual(await netease.verifyCookie('c'), { valid: true, nickname: '小明', vip: false });

  reset(() => ({ body: { profile: { userId: 1 } } }));
  assert.strictEqual((await netease.verifyCookie('c')).nickname, '用户',
    'nickname 缺失必须兜底，否则界面会显示 undefined');

  reset(() => { throw new Error('login_status 挂了'); });
  assert.deepStrictEqual(await netease.verifyCookie('c'), { valid: false },
    '校验失败必须报 invalid，绝不能误报 valid（否则用户以为登录成功，之后每首 VIP 歌都失败）');
});

// ══════════════════════════════════════════════════════════
// 9. 元测试：打桩没有静默失效
// ══════════════════════════════════════════════════════════

test('元：桩全程被命中，且没有任何白名单外调用（打桩没有静默失效）', () => {
  assert.deepStrictEqual(
    whitelistViolations, [],
    '出现了白名单外的 SDK 方法调用 —— 打桩已静默失效，本文件的断言可能全部假绿');
  assert.ok(totalCalls > 0,
    '桩一次都没被命中 —— 用例没走到真实链路，是空转假绿');
});
