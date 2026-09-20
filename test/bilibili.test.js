/**
 * 单元测试：B 站平台适配器 —— parseDuration / getUrl DASH 选流 / 排行 / 访客指纹
 *
 * 为什么是这几段：`search` 链路**已经**被 test/platform-fixture.test.js 用实测录制的
 * raw 响应覆盖，字幕转 LRC 与选轨**已经**被 test/bilibili-lyrics.test.js 覆盖，
 * 这里不重复。真正的盲区是：
 *   - parseDuration：**已导出却零测试**，其中 hh:mm:ss 分支从没被执行过
 *   - getUrl：DASH 选流（standard 该取最低带宽）、fnval=16 硬约束、
 *     「有 DASH 无 audio」的登录墙 vs 会员番剧文案
 *   - getRanking：data 是数组（已实测）、play→playCount、封面补协议
 *   - 访客指纹：1h TTL 复用 + spi 失败兜底（兜底没了 = 风控下全部下不了且无报错）
 *
 * 打桩方式：替换 require.cache 里 src/api/request 的导出（test/kugou.test.js 已验证
 * 的手法），再清掉适配器模块缓存重新 require —— 适配器顶层已捕获 request 引用。
 *
 * 未命中即抛：桩按 URL 分派，未打桩的端点**立刻抛错并记账**。漏桩若静默返回空对象，
 * 用例会假绿。要模拟「接口挂了」必须显式写 { throw: '...' }，而不是靠漏桩 ——
 * 否则「故意失败」与「漏桩」在记账上无法区分，元测试就失去意义。
 *
 * ⚠️ 模块级缓存（bilibili.js 特有）：_visitorCookie / _wbiKey / _cidCache 跨用例残留。
 * 处置：需要确定性的用例**一律显式传 cookie**（resolveCookie 会短路，不打指纹接口）；
 * 只有访客指纹那两个用例不传 cookie，且必须排在最前面（依赖缓存尚未被填充）。
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// ── 打桩：src/api/request ───────────────────────────────────
const REQ_PATH = require.resolve('../src/api/request');
const realRequest = require(REQ_PATH);

let routes = [];       // [{ marker, response?, throw?, hits }]
let calls = [];        // 本轮 [{ url, opts }]
let totalCalls = 0;    // 全程桩命中次数
const unrouted = [];   // 未打桩的 URL（元测试用）

const stubRequest = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, opts });
  totalCalls += 1;
  const hit = routes.find((r) => u.includes(r.marker));
  if (!hit) {
    unrouted.push(u);
    throw new Error(`未打桩的端点: ${u} —— 漏桩必须炸出来，不能静默返回空`);
  }
  hit.hits = (hit.hits || 0) + 1;
  if (hit.throw) throw new Error(hit.throw);
  return structuredClone(hit.response);
};
stubRequest.testAudioLink = async () => {
  throw new Error('本文件不应触达 testAudioLink（适配器边界）');
};

require.cache[REQ_PATH] = {
  id: REQ_PATH, filename: REQ_PATH, loaded: true, exports: stubRequest,
};

const BILI_PATH = require.resolve('../src/api/platforms/bilibili');
delete require.cache[BILI_PATH];
const bili = require(BILI_PATH);

// ── 造响应 ───────────────────────────────────────────────────
const SPI_OK = { marker: 'frontend/finger/spi', response: { data: { b_3: 'B3REAL', b_4: 'B4REAL' } } };
const audio = (bandwidth, url) => ({ bandwidth, baseUrl: url, base_url: url });
const viewResp = (over = {}) => ({ data: { bvid: 'BV1xx', aid: 812345, cid: 999888, ...over } });
const dashResp = (audios) => ({ data: { dash: { audio: audios } } });

/** 每个用例前重置打桩状态 */
function reset(routesList) {
  routes = routesList || [];
  calls = [];
}

/** 取本轮第一条命中某端点的调用 */
function callOf(marker) {
  return calls.find((c) => c.url.includes(marker));
}

// ══════════════════════════════════════════════════════════
// 0. 自检
// ══════════════════════════════════════════════════════════

test('自检：request 打桩已生效（否则用例会打真实网络请求）', () => {
  assert.notStrictEqual(require(REQ_PATH), realRequest, '打桩未生效：会发真请求');
  assert.strictEqual(typeof bili.getUrl, 'function');
  assert.strictEqual(typeof bili.parseDuration, 'function');
});

// ══════════════════════════════════════════════════════════
// 1. parseDuration（已导出却零测试）
// ══════════════════════════════════════════════════════════

test('parseDuration: "mm:ss" / "hh:mm:ss" / 纯秒 三种形态都要对（hh:mm:ss 分支此前从未跑过）', () => {
  assert.strictEqual(bili.parseDuration('4:29'), 269, 'mm:ss');
  assert.strictEqual(bili.parseDuration('0:15'), 15);
  assert.strictEqual(bili.parseDuration('1:03:40'), 3820, 'hh:mm:ss = 3600+180+40');
  assert.strictEqual(bili.parseDuration('223'), 223, '纯秒');
});

test('parseDuration: 空/异常输入一律 0，不得产出 NaN（NaN*1000 会变成脏 duration）', () => {
  for (const bad of ['', null, undefined, 'abc', '--']) {
    const v = bili.parseDuration(bad);
    assert.strictEqual(v, 0, `parseDuration(${JSON.stringify(bad)}) 应为 0，得到 ${v}`);
    assert.ok(!Number.isNaN(v), 'NaN 会污染 duration 字段');
  }
});

// ══════════════════════════════════════════════════════════
// 2. 访客指纹（必须在其它用例之前 —— 依赖 _visitorCookie 尚未被填充）
// ══════════════════════════════════════════════════════════

test('访客指纹: spi 失败时兜底 "buvid3=anon;"（风控下没有它拿不到 DASH，且不会报错）', async () => {
  reset([
    { marker: 'frontend/finger/spi', throw: 'spi 挂了' },
    { marker: 'web-interface/view', response: viewResp() },
    { marker: 'player/playurl', response: dashResp([audio(64000, 'https://a/x.m4a')]) },
  ]);
  const r = await bili.getUrl('BVVISIT1', 'hq');
  assert.ok(r.url, `spi 挂掉不该让整首失败: ${JSON.stringify(r)}`);
  const play = callOf('player/playurl');
  assert.strictEqual(play.opts.headers.Cookie, 'buvid3=anon;',
    'spi 失败必须回退到老的假 buvid3，否则匿名请求会被风控拦掉');
});

test('访客指纹: 取到后缓存 1h，同一进程内不得每次请求都去取', async () => {
  reset([
    SPI_OK,
    { marker: 'web-interface/view', response: viewResp() },
    { marker: 'player/playurl', response: dashResp([audio(64000, 'https://a/x.m4a')]) },
  ]);
  await bili.getUrl('BVVISIT2', 'hq');
  assert.strictEqual(callOf('player/playurl').opts.headers.Cookie, 'buvid3=B3REAL; buvid4=B4REAL',
    'spi 拿到的正式访客指纹必须用上');
  const spiHits = () => routes.find((r) => r.marker === 'frontend/finger/spi').hits || 0;
  assert.strictEqual(spiHits(), 1, '首次应取一次访客指纹');

  await bili.getUrl('BVVISIT3', 'hq');
  assert.strictEqual(spiHits(), 1, '1h 内必须复用缓存，否则每次请求都多打一次指纹接口');
});

// ══════════════════════════════════════════════════════════
// 3. getUrl：DASH 选流与硬约束
// ══════════════════════════════════════════════════════════

test('getUrl: 非 standard 取最高带宽，standard 取最低带宽（不得恒定取第一档）', async () => {
  // 故意打乱顺序，确保断言依赖的是带宽排序而不是数组下标
  const audios = [
    audio(30280, 'https://a/low.m4a'),
    audio(132000, 'https://a/high.m4a'),
    audio(64000, 'https://a/mid.m4a'),
  ];
  reset([
    { marker: 'web-interface/view', response: viewResp() },
    { marker: 'player/playurl', response: dashResp(audios) },
  ]);
  const hq = await bili.getUrl('BV1xx', 'hq', 'SESSDATA=x');
  assert.strictEqual(hq.url, 'https://a/high.m4a', '非 standard 必须给最高带宽');
  assert.strictEqual(hq.ext, 'm4a', 'DASH 音频容器是 m4a，下载器依赖它');
  assert.strictEqual(hq.referer, 'https://www.bilibili.com/', 'B 站 CDN 需要 Referer');

  const std = await bili.getUrl('BV1xx', 'standard', 'SESSDATA=x');
  assert.strictEqual(std.url, 'https://a/low.m4a',
    'standard 必须给最低带宽，否则标准音质请求会悄悄下最高音质（体积翻数倍）');
});

test('getUrl: playurl 必须带 fnval=16 与 cid/avid（丢了会退化成 durl 单流，全部下载失败）', async () => {
  reset([
    { marker: 'web-interface/view', response: viewResp() },
    { marker: 'player/playurl', response: dashResp([audio(64000, 'https://a/x.m4a')]) },
  ]);
  await bili.getUrl('BV1xx', 'hq', 'SESSDATA=x');
  const u = callOf('player/playurl').url;
  assert.ok(u.includes('fnval=16'), `playurl 必须带 fnval=16，实际: ${u}`);
  assert.ok(u.includes('fnver=0'), `playurl 必须带 fnver=0，实际: ${u}`);
  assert.ok(u.includes('fourk=1'), `playurl 必须带 fourk=1，实际: ${u}`);
  assert.ok(u.includes('qn=112'), `qn 应为 112，实际: ${u}`);
  assert.ok(u.includes('cid=999888'), `必须带上 cid，实际: ${u}`);
  assert.ok(u.includes('avid=812345'), `必须带上 avid，实际: ${u}`);
});

test('getUrl: 有 DASH 无 audio —— 带 cookie 报会员/番剧，不带 cookie 报需要登录', async () => {
  reset([
    { marker: 'web-interface/view', response: viewResp() },
    { marker: 'player/playurl', response: { data: { dash: { audio: [] } } } },
  ]);
  const loggedIn = await bili.getUrl('BV1xx', 'hq', 'SESSDATA=x');
  assert.strictEqual(loggedIn.code, 'NO_AUDIO_STREAM');
  assert.strictEqual(loggedIn.fatal, true);

  const anonymous = await bili.getUrl('BV1xx', 'hq');
  assert.strictEqual(anonymous.code, 'LOGIN_REQUIRED',
    '未登录必须引导登录，不能告诉用户「这视频就是没音频」（反之亦然）');
});

test('getUrl: 拿不到 cid 时报 BILI_URL_ERROR（fatal），不把异常抛给上层', async () => {
  reset([{ marker: 'web-interface/view', response: { data: { aid: 1 } } }]);
  const r = await bili.getUrl('BVNOCID', 'hq', 'SESSDATA=x');
  assert.strictEqual(r.code, 'BILI_URL_ERROR');
  assert.strictEqual(r.fatal, true);
  assert.strictEqual(callOf('player/playurl'), undefined, '拿不到 cid 就不该再请求 playurl');
});

// ══════════════════════════════════════════════════════════
// 4. getRanking：data 是数组（已实测）
// ══════════════════════════════════════════════════════════

test('排行: ranking/region 的 data 是数组（已实测），映射 bvid/剥标签/play→playCount', async () => {
  reset([{
    marker: 'ranking/region',
    response: {
      code: 0,
      data: [
        { bvid: 'BV1aa', title: '<em class="keyword">晴天</em>', author: 'UP甲', pic: 'http://i1.hdslb.com/a.jpg', duration: '4:29', play: 17802548 },
        { bvid: 'BV1bb', title: '稻香', author: 'UP乙', pic: '//i0.hdslb.com/b.jpg', duration: '3:43', play: 100 },
      ],
    },
  }]);
  const out = await bili.getRanking(10, 'SESSDATA=x');
  assert.strictEqual(out.length, 2, 'data 是数组 —— 若按 data.list 读，排行榜会恒空');
  assert.strictEqual(out[0].id, 'BV1aa');
  assert.strictEqual(out[0].title, '晴天', '必须剥掉 <em> 高亮标签（渲染层 XSS 面）');
  assert.strictEqual(out[0].artist, 'UP甲');
  assert.strictEqual(out[0].duration, 269000, 'duration 秒 → 毫秒');
  assert.strictEqual(out[0].playCount, 17802548,
    '接口给的是 play，没有 playCount 字段 —— 写错会让播放量恒 undefined');
  assert.strictEqual(out[0].source, 'bilibili');

  // 封面：search 的 pic 是协议相对 //，ranking 的 pic 是 http:// 明文，两种都要产出绝对 URL。
  // 现状钉（已核实，不是缺陷）：CSP 为 img-src 'self' data: http: https:，且窗口以
  // file:// 加载（main/index.js 的 loadFile），故 http 封面**能正常显示**。
  // 但若日后收紧 CSP（去掉 http:）或改用 https 承载，排行封面会最先裂 —— 这条钉会先红。
  assert.strictEqual(out[0].cover, 'http://i1.hdslb.com/a.jpg');
  assert.strictEqual(out[1].cover, 'https://i0.hdslb.com/b.jpg', '协议相对的 pic 必须补 https:');
});

test('排行: limit 必须截断（首页只展示前若干条）', async () => {
  reset([{
    marker: 'ranking/region',
    response: { data: Array.from({ length: 5 }, (_v, i) => ({ bvid: `BV${i}`, title: `t${i}`, play: i })) },
  }]);
  const out = await bili.getRanking(2, 'SESSDATA=x');
  assert.strictEqual(out.length, 2);
});

test('排行: 接口抛错返回空数组（首页不该因为排行挂掉而崩）', async () => {
  reset([{ marker: 'ranking/region', throw: 'ranking 挂了' }]);
  assert.deepStrictEqual(await bili.getRanking(10, 'SESSDATA=x'), []);
});

// ══════════════════════════════════════════════════════════
// 5. Cookie 校验与详情
// ══════════════════════════════════════════════════════════

test('Cookie 校验: isLogin 才 valid；vip 由 vipType>0 判定（0 必须为 false）', async () => {
  reset([{ marker: 'web-interface/nav', response: { data: { isLogin: true, uname: '小明', vipType: 2 } } }]);
  assert.deepStrictEqual(await bili.verifyCookie('c'), { valid: true, nickname: '小明', vip: true });

  reset([{ marker: 'web-interface/nav', response: { data: { isLogin: true, uname: '小红', vipType: 0 } } }]);
  assert.deepStrictEqual(await bili.verifyCookie('c'), { valid: true, nickname: '小红', vip: false });

  reset([{ marker: 'web-interface/nav', response: { data: { isLogin: false } } }]);
  assert.deepStrictEqual(await bili.verifyCookie('c'), { valid: false });

  reset([{ marker: 'web-interface/nav', throw: 'nav 挂了' }]);
  assert.deepStrictEqual(await bili.verifyCookie('c'), { valid: false },
    '校验异常必须报 invalid，绝不能误报 valid');
});

test('详情: getSongDetail 映射 owner/duration 秒→毫秒；无 bvid 或抛错一律 null', async () => {
  reset([{
    marker: 'web-interface/view',
    response: { data: { bvid: 'BV1xx', aid: 812345, title: '晴天', owner: { name: 'UP主' }, pic: 'https://i0/x.jpg', duration: 269 } },
  }]);
  const s = await bili.getSongDetail('BV1xx', 'c');
  assert.strictEqual(s.id, 'BV1xx');
  assert.strictEqual(s.aid, 812345);
  assert.strictEqual(s.title, '晴天');
  assert.strictEqual(s.artist, 'UP主');
  assert.strictEqual(s.album, '哔哩哔哩');
  assert.strictEqual(s.cover, 'https://i0/x.jpg');
  assert.strictEqual(s.duration, 269000, '接口 duration 是秒，标准形态是毫秒，差 1000 倍');
  assert.strictEqual(s.source, 'bilibili');

  reset([{ marker: 'web-interface/view', response: { data: { aid: 1 } } }]);
  assert.strictEqual(await bili.getSongDetail('BVzz', 'c'), null, '无 bvid 应返回 null');

  reset([{ marker: 'web-interface/view', throw: 'view 挂了' }]);
  assert.strictEqual(await bili.getSongDetail('BVww', 'c'), null);
});

// ══════════════════════════════════════════════════════════
// 6. 元测试：打桩没有静默失效
// ══════════════════════════════════════════════════════════

test('元：桩全程被命中，且没有任何未打桩端点（打桩没有静默失效）', () => {
  assert.deepStrictEqual(unrouted, [],
    '出现未打桩端点 —— 打桩已静默失效，本文件的断言可能全部假绿');
  assert.ok(totalCalls > 0, '桩一次都没被命中 —— 用例没走到真实链路，是空转假绿');
});
