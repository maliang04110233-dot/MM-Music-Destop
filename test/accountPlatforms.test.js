/**
 * 平台账号页清单派生
 *
 * splitPlatformsByCookie 是纯函数，不碰 DOM / api。
 * renderer 的 logger / utils 在模块顶层读 window / document，所以 import 前先补桩。
 *
 * 这一组测试钉住的是「加平台后账号页要跟着长」这个契约：
 * 账号页不再持有自己的平台字面量，只信主进程插件能力表。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

globalThis.document = undefined;
globalThis.window = { location: { hostname: 'localhost', protocol: 'file:' }, __PLATFORMS: [] };
// utils.js 的 getPlatforms 读 window.__PLATFORMS（导出的是模块内函数声明，不是全局），所以清单桩要打在这里
globalThis.getPlatforms = () => [];
globalThis.fallbackPlatformIds = () => ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];
globalThis.platformName = (id) => id;

const MODULE_URL = 'file:///' + path.join(__dirname, '..', 'src', 'renderer', 'js', 'accountPlatforms.js')
  .split(path.sep).join('/');

let mod;
test.before(async () => { mod = await import(MODULE_URL); });

/** 构造一条模拟主进程 toClientPayload 的平台条目 */
function plat(id, opts) {
  return Object.assign({ id, name: id, icon: '🎵', capabilities: {} }, opts || {});
}

test('无 IPC 清单时回落到兜底的 3 个支持登录平台', () => {
  for (const bad of [undefined, null, [], 'x', 0]) {
    const { cookie, anonymous } = mod.splitPlatformsByCookie(bad);
    assert.equal(anonymous.length, 0, JSON.stringify(bad) + ' 不应冒出匿名平台');
    assert.equal(cookie.map(p => p.id).join(','), 'netease,qq,bilibili', JSON.stringify(bad));
    assert.equal(cookie.some(p => p.loginUrl), false, '兜底清单不需要 loginUrl（登录走 loginWindow）');
  }
});

test('空清单回退的是副本，不是兜底常量本身', () => {
  const a = mod.splitPlatformsByCookie([]).cookie;
  const b = mod.splitPlatformsByCookie(null).cookie;
  assert.notEqual(a, mod.FALLBACK_ACCOUNT_PLATFORMS, '不得直接暴露模块常量');
  assert.notEqual(a, b, '两次调用不应共享同一数组');
});

test('按 capabilities.cookie 拆分主进程清单，顺序与主进程一致', () => {
  const { cookie, anonymous } = mod.splitPlatformsByCookie([
    plat('netease', { capabilities: { cookie: true, lyrics: true } }),
    plat('qq', { capabilities: { cookie: true } }),
    plat('bilibili', { capabilities: { cookie: true, lyrics: true } }),
    plat('kugou', { capabilities: { lyrics: false } }),
    plat('kuwo'),
    plat('migu'),
    plat('soda'),
    plat('fivesing'),
  ]);
  assert.equal(cookie.map(p => p.id).join(','), 'netease,qq,bilibili');
  assert.equal(anonymous.map(p => p.id).join(','), 'kugou,kuwo,migu,soda,fivesing');
});

test('主进程清单不含 Cookie 平台时如实返回空，不拿兜底冒充', () => {
  const { cookie, anonymous } = mod.splitPlatformsByCookie([plat('kugou'), plat('soda')]);
  assert.equal(cookie.length, 0);
  assert.equal(anonymous.length, 2);
});

test('capabilities 缺失 / 不是布尔 true 时一律按免登录处理', () => {
  const cases = [
    plat('a'),
    plat('a', { capabilities: undefined }),
    plat('a', { capabilities: {} }),
    plat('a', { capabilities: null }),
    plat('a', { capabilities: 'cookie' }),
    plat('a', { capabilities: true }),
    plat('a', { capabilities: { cookie: 'yes' } }),
    plat('a', { capabilities: { cookie: 1 } }),
    plat('a', { capabilities: { cookie: false } }),
  ];
  const { cookie, anonymous } = mod.splitPlatformsByCookie(cases);
  assert.equal(cookie.length, 0);
  assert.equal(anonymous.length, cases.length);
  for (const p of cases) {
    assert.equal(mod.hasCookieCapability(p), false, JSON.stringify(p.capabilities));
  }
});

test('非对象 / 无 id 的条目被丢弃，合法条目保留', () => {
  const { cookie, anonymous } = mod.splitPlatformsByCookie([
    null, undefined, 7, 'x', {}, { name: '无 id' },
    { id: '', name: '空 id' },
    plat('netease', { capabilities: { cookie: true } }),
    plat('soda'),
  ]);
  assert.equal(cookie.length, 1);
  assert.equal(anonymous.length, 1);
  assert.equal(anonymous[0].id, 'soda');
});

test('登录窗口能力：只有主进程配了 LOGIN_CONFIGS 的平台可一键登录', () => {
  assert.equal(mod.hasLoginWindow('netease'), true);
  assert.equal(mod.hasLoginWindow('qq'), true);
  assert.equal(mod.hasLoginWindow('bilibili'), true);
  assert.equal(mod.hasLoginWindow('migu'), false);
  assert.equal(mod.hasLoginWindow('soda'), false);
  assert.equal(mod.hasLoginWindow('fivesing'), false);
  assert.equal(mod.hasLoginWindow(undefined), false);
  assert.equal(mod.hasLoginWindow(''), false);
});

test('Cookie 文本框占位符由字段配置生成', () => {
  assert.equal(mod.cookiePlaceholder([
    { key: 'MUSIC_U', label: '登录凭证', required: true },
    { key: '__csrf', label: '防跨站' },
  ]), 'MUSIC_U=xxxx; __csrf=xxxx; ...');
  assert.equal(mod.cookiePlaceholder([]), '粘贴该平台的完整 Cookie 字符串');
  assert.equal(mod.cookiePlaceholder(undefined), '粘贴该平台的完整 Cookie 字符串');
  assert.equal(mod.cookiePlaceholder(null), '粘贴该平台的完整 Cookie 字符串');
  assert.equal(mod.cookiePlaceholder([null, { label: '无 key' }, {}]), '粘贴该平台的完整 Cookie 字符串');
});

test('分平台提示：定制优先，未定制走通用文案', () => {
  const hints = { qq: '需含 <code>uin=</code> 字段' };
  assert.equal(mod.cookieHint('qq', hints), '需含 <code>uin=</code> 字段');
  assert.equal(mod.cookieHint('netease', hints).includes('<code>Cookie:</code>'), true);
  assert.equal(mod.cookieHint('netease', undefined).includes('<code>Cookie:</code>'), true);
  assert.equal(mod.cookieHint('netease', null).includes('<code>Cookie:</code>'), true);
  assert.equal(mod.cookieHint('netease', '不是对象').includes('<code>Cookie:</code>'), true);
});

test('accountPlatforms: 主进程清单未就绪时走内置 id 表兜底', () => {
  globalThis.window.__PLATFORMS = [];
  const { cookie, anonymous } = mod.accountPlatforms();
  assert.equal(cookie.map(p => p.id).join(','), 'netease,qq,bilibili');
  // 兜底表来自 utils 的 FALLBACK_PLATFORM_NAMES，名字与主进程清单口径一致
  assert.equal(anonymous.map(p => p.id).join(','), 'kugou,kuwo,migu,fivesing,soda');
  assert.equal(anonymous[3].name, '5sing');
  assert.equal(anonymous[4].shortName, anonymous[4].name, '无英文名时 shortName 回落 name');
});

test('accountPlatforms: 主进程清单就绪时优先使用，覆盖内置兜底', () => {
  globalThis.window.__PLATFORMS = [
    plat('netease', { capabilities: { cookie: true }, name: '网易云音乐' }),
    plat('kugou', { name: '酷狗音乐' }),
  ];
  try {
    const { cookie, anonymous } = mod.accountPlatforms();
    assert.equal(cookie.map(p => p.id).join(','), 'netease');
    assert.equal(cookie[0].name, '网易云音乐', '优先用主进程名字');
    assert.equal(anonymous.map(p => p.id).join(','), 'kugou');
  } finally {
    globalThis.window.__PLATFORMS = [];
  }
});
