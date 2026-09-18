/**
 * 簇 3：平台响应 fixture 契约测试
 *
 * 补现有平台单测的盲区：它们测的是 `_internal` 纯映射函数（喂的是手写字段），
 * 从不走「raw 响应 → 适配器 search() → 统一 Song」的完整链路。后果是
 * 平台改了响应字段名 / 嵌套层级时，生产链路静默返回空列表或缺字段，
 * 而单测依旧全绿。
 *
 * 机制：test/fixtures/platforms/<id>.search.json 存的是**实测录制的原始响应**
 * （scripts/record-platform-fixtures.js 可重录）。本测试在 Module._load 层拦截
 * 三种传输（src/api/request、NeteaseCloudMusicApi、qq-music-api），把 fixture
 * 喂给真实的适配器代码，然后断言：
 *   1. 输出条目数 = fixture 中合法条目数（脏条目被过滤，不是整批消失）
 *   2. 每首歌满足统一 Song 形状（shared/dto 的 isSongLike + 类型/无 HTML 残留）
 *   3. 首条目的字段值与手工核对过的期望**精确相等**（映射错一个字段即红）
 *   4. 适配器确实打了 fixture 对应的传输端点（改传输 = fixture 失效，必须重录）
 *
 * 平台改接口的响应流程：跑一次 record 脚本重录 fixture → 本测试红 →
 * 按新形状修适配器/期望值。测试先红，而不是用户先发现。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const { isSongLike, normalizeSong } = require('../src/shared/dto');

// ── fixture 装载 ──────────────────────────────────────────
const fixtureCache = {};
function loadFixture(id) {
  if (!(id in fixtureCache)) {
    const file = path.join(ROOT, 'test', 'fixtures', 'platforms', `${id}.search.json`);
    assert.ok(fs.existsSync(file), `缺少 fixture: ${file}（用 scripts/record-platform-fixtures.js 录制）`);
    fixtureCache[id] = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return fixtureCache[id];
}

// ── 传输层拦截（必须在 require 平台模块之前装好）────────────
const REQUEST_PATH = require.resolve('../src/api/request');
const origLoad = Module._load;

// 当前激活的平台：{ response, calls: [] }
let active = null;

const fakeRequest = async (url) => {
  if (!active) throw new Error('fixture 测试：平台在测试窗口外发起了网络请求');
  active.calls.push(String(url));
  return structuredClone(active.response);
};
fakeRequest.testAudioLink = async () => {
  throw new Error('search 链路不应触达 testAudioLink（fixture 测试边界）');
};

const ncmStub = {
  search: async () => {
    if (!active) throw new Error('fixture 测试：ncm 在测试窗口外被调用');
    active.calls.push('ncm:search');
    return structuredClone(active.response);
  },
};

const qqStub = {
  api: async (route) => {
    if (!active) throw new Error('fixture 测试：qq-music-api 在测试窗口外被调用');
    active.calls.push(`qqapi:${route}`);
    return structuredClone(active.response);
  },
};

Module._load = function (request, parent, isMain) {
  if (request === 'NeteaseCloudMusicApi') return ncmStub;
  if (request === 'qq-music-api') return qqStub;
  if (request === '../request' || request === './request') {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_e) { /* 非本项目 */ }
    if (resolved === REQUEST_PATH) return fakeRequest;
  }
  return origLoad.apply(this, arguments);
};

const platforms = {};
for (const id of ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda']) {
  platforms[id] = require(`../src/api/platforms/${id}`);
}
// 平台模块已全部加载、传输引用已被捕获，钩子使命完成，立刻还原
Module._load = origLoad;

/**
 * 跑一个平台的 fixture 断言。
 * @param {string} id 平台（=fixture 名）
 * @param {string} marker 期望命中的传输端点子串
 * @param {Array<object>} expect 逐条目的**字段子集**精确断言（全量形状由 assertSongShape 保证）
 */
function runFixtureCase(id, marker, expect) {
  const session = { response: loadFixture(id), calls: [] };
  active = session;
  return Promise.resolve()
    .then(() => platforms[id].search('测试关键词', 1))
    .finally(() => { if (active === session) active = null; })
    .then((songs) => {
      assert.ok(Array.isArray(songs), `${id}: search 应返回数组`);
      assert.ok(session.calls.some((c) => c.includes(marker)),
        `${id}: 未命中期望传输端点 "${marker}"，实际调用: ${JSON.stringify(session.calls)} —— 传输改了就要重录 fixture`);
      assert.strictEqual(songs.length, expect.length,
        `${id}: 条目数漂移（脏条目应被过滤、好条目不该消失），得到 ${JSON.stringify(songs.map(s => s && s.id))}`);
      songs.forEach((s, i) => {
        assertSongShape(s, id);
        for (const [k, v] of Object.entries(expect[i])) {
          assert.strictEqual(s[k], v, `${id}[${i}].${k} 映射错误`);
        }
      });
    });
}
const CASES = require('./platform-fixture-expectations');

// 每个平台一个用例；expect 值是与 fixture 逐字段手工核对过的产物
for (const [id, c] of Object.entries(CASES)) {
  test(`fixture 契约：${id} search 形状与映射`, () => runFixtureCase(id, c.marker, c.expect));
}

function assertSongShape(song, platform) {
  assert.ok(isSongLike(song), `${platform}: 条目不是合法 Song: ${JSON.stringify(song)}`);
  assert.strictEqual(song.source, platform, `${platform}: source 字段漂移`);
  for (const f of ['id', 'title', 'artist', 'album', 'cover']) {
    assert.strictEqual(typeof song[f], 'string', `${platform}: ${f} 应为字符串，得到 ${typeof song[f]}`);
    assert.ok(!/<[^>]*>/.test(song[f]), `${platform}: ${f} 残留 HTML 标签（渲染层 XSS 面）: ${song[f]}`);
    assert.ok(!/&amp;|&lt;|&gt;/.test(song[f]), `${platform}: ${f} 残留未解码实体: ${song[f]}`);
  }
  assert.ok(Number.isFinite(song.duration) && song.duration >= 0,
    `${platform}: duration 应为非负毫秒数，得到 ${song.duration}`);
  assert.ok(song.cover === '' || /^https?:\/\//.test(song.cover),
    `${platform}: cover 应为空串或绝对 URL: ${song.cover}`);
  // normalizeSong 幂等：统一形状与 shared/dto 契约不冲突
  assert.deepStrictEqual(normalizeSong(normalizeSong(song)), normalizeSong(song));
}

// ── 交叉守卫 ──────────────────────────────────────────────

test('fixture 覆盖全部 8 个平台的 search 链路（新平台必须补录）', () => {
  const dir = path.join(ROOT, 'test', 'fixtures', 'platforms');
  const have = new Set(fs.readdirSync(dir).filter(f => f.endsWith('.search.json')).map(f => f.replace('.search.json', '')));
  const all = new Set(Object.keys(platforms));
  assert.deepStrictEqual(
    { missing: [...all].filter(x => !have.has(x)), orphan: [...have].filter(x => !all.has(x)) },
    { missing: [], orphan: [] },
  );
});

test('fixture 内不得含真实 Cookie / token（防录制时把凭据带进仓库）', () => {
  const dir = path.join(ROOT, 'test', 'fixtures', 'platforms');
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const re of [/Cookie-Header/i, /\btoken"?\s*:\s*"[A-Za-z0-9]{16,}/, /Netease.sid=/i, /"cookie"\s*:\s*"__[A-Z]/]) {
      if (re.test(src)) offenders.push(`${f}: ${re}`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});

test('录制脚本在仓库内且声明了写盘需 --write（防止误跑污染 fixture）', () => {
  const file = path.join(ROOT, 'scripts', 'record-platform-fixtures.js');
  assert.ok(fs.existsSync(file), '缺少录制脚本，fixture 将无法随平台接口演进而更新');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(/--write/.test(src), '录制脚本默认不得直接覆盖 fixture');
});
