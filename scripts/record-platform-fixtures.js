/**
 * 平台搜索响应录制脚本（手动运行，不进 npm test）
 *
 * 用途：平台接口演进后重录 test/fixtures/platforms/*.search.json。
 * 流程：真实网络跑一遍 8 个平台的 search()，捕获原始响应，与现有 fixture
 * 做字段骨架 diff，并截取前几条作为精简 fixture。
 *
 *   node scripts/record-platform-fixtures.js          # 只看 diff，不落盘
 *   node scripts/record-platform-fixtures.js --write  # 确认 diff 后覆盖 fixture
 *
 * 覆盖后必须跑 `node --test test/platform-fixture.test.js`：期望值表
 * （test/platform-fixture-expectations.js）会立刻指出映射漂移的位置 ——
 * 这正是「平台改接口，测试先红」的闭环。
 *
 * ⚠️ 录制走真实网络，可能受 VIP/限流影响；只录公开搜索接口，
 * 不传 cookie，天然无凭据泄漏（测试侧还有一条防泄漏断言兜底）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');
const FIX_DIR = path.join(ROOT, 'test', 'fixtures', 'platforms');
const WRITE = process.argv.includes('--write');
const KEYWORD = '晴天';

// ⚠️ 加载顺序即正确性：先拿真实传输引用、装好 Module._load 钩子，
// 之后才 require pluginRegistry / 平台模块 —— 让它们在钩子下捕获到包装层。
const realRequest = require('../src/api/request');
const realNcm = require('NeteaseCloudMusicApi');
const realQq = require('qq-music-api');

const CASES = require('../test/platform-fixture-expectations');

// 列表在响应中的位置（录制后截前 N 条，控制 fixture 体积）
const LIST_PATH = {
  netease: ['body', 'result', 'songs'],
  qq: ['list'],
  kugou: ['data', 'lists'],
  kuwo: ['abslist'],
  bilibili: ['data', 'result'],
  migu: ['songResultData', 'result'],
  fivesing: ['list'],
  soda: ['result_groups', 0, 'data'],
};
const KEEP = 3;

// ── 传输包装：真请求 + 旁路捕获 ────────────────────────────
const captured = new Map(); // platformId → raw response
let current = null;         // { id, marker }

function captureOnce(url, marker, response) {
  if (current && !captured.has(current.id) && String(url).includes(marker)) {
    captured.set(current.id, response);
  }
}

const wrappedRequest = async (url, opts) => {
  const r = await realRequest(url, opts);
  if (current) captureOnce(url, current.marker, r);
  return r;
};
Object.assign(wrappedRequest, realRequest);
wrappedRequest.testAudioLink = realRequest.testAudioLink;

const ncmWrap = new Proxy(realNcm, {
  get(t, k) {
    if (k === 'search') {
      return async (q) => {
        const r = await realNcm.search(q);
        if (current && current.id === 'netease') captureOnce('ncm:search', current.marker, r);
        return r;
      };
    }
    return Reflect.get(t, k);
  },
});
const qqWrap = {
  api: async (route, q) => {
    const r = await realQq.api(route, q);
    if (route === 'search') captureOnce('qqapi:' + route, current ? current.marker : '', r);
    return r;
  },
};

const REQUEST_PATH = require.resolve('../src/api/request');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'NeteaseCloudMusicApi') return ncmWrap;
  if (request === 'qq-music-api') return qqWrap;
  if (request === '../request' || request === './request') {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch (_e) { /* noop */ }
    if (resolved === REQUEST_PATH) return wrappedRequest;
  }
  return origLoad.apply(this, arguments);
};

// 钩子就位后才加载平台（它们会在钩子下捕获到包装层）
const { loadPlatformPlugins, defaultRegistry: reg } = require('../src/api/pluginRegistry');
loadPlatformPlugins();

// ── 形状骨架（diff 用）────────────────────────────────────
function keyPaths(v, prefix, depth, out) {
  if (depth <= 0 || v == null) return out;
  if (Array.isArray(v)) {
    out.add(`${prefix}[]`);
    for (const item of v) keyPaths(item, `${prefix}[]`, depth - 1, out);
  } else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(`${prefix}.${k}`);
      keyPaths(x, `${prefix}.${k}`, depth - 1, out);
    }
  }
  return out;
}
const skeletonOf = (obj) => keyPaths(obj, '$', 7, new Set());

function trim(response, id) {
  const walk = LIST_PATH[id] || [];
  let node = response;
  for (let i = 0; i < walk.length - 1; i++) {
    if (node == null) return response;
    node = node[walk[i]];
  }
  const listKey = walk[walk.length - 1];
  if (node && Array.isArray(node[listKey])) node[listKey] = node[listKey].slice(0, KEEP);
  return response;
}

// ── 主流程 ────────────────────────────────────────────────
(async () => {
  const failed = [];
  for (const [id, c] of Object.entries(CASES)) {
    const platform = reg.get(id);
    current = { id, marker: c.marker };
    try {
      await platform.search(KEYWORD, 1);
    } catch (e) {
      console.log(`  ⚠️ ${id}: 请求失败 ${e.message}`);
      failed.push(id);
    }
    current = null;
  }

  let drift = 0;
  for (const id of Object.keys(CASES)) {
    const file = path.join(FIX_DIR, `${id}.search.json`);
    const fresh = captured.get(id);
    const old = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    console.log(`\n== ${id} ${fresh ? (old ? '' : '（新平台，无旧 fixture）') : '— 未捕获到响应'}`);
    if (!fresh) { failed.push(id); continue; }
    if (old) {
      const a = skeletonOf(old);
      const b = skeletonOf(fresh);
      const added = [...b].filter((x) => !a.has(x));
      const removed = [...a].filter((x) => !b.has(x));
      if (!added.length && !removed.length) {
        console.log('  骨架无变化');
        continue;
      }
      drift++;
      if (removed.length) console.log('  🔴 接口不再返回:', removed.slice(0, 12).join(', '), removed.length > 12 ? '…' : '');
      if (added.length) console.log('  🆕 新增字段:', added.slice(0, 12).join(', '), added.length > 12 ? '…' : '');
    }
    if (WRITE) {
      fs.writeFileSync(file, JSON.stringify(trim(fresh, id), null, 2) + '\n');
      console.log('  ✍️ 已写入（精简到前 ' + KEEP + ' 条）→', path.relative(ROOT, file));
    }
  }

  console.log(`\n录制 ${captured.size}/${Object.keys(CASES).length} 平台` +
    (failed.length ? `；失败: ${failed.join(', ')}` : '') +
    (drift && !WRITE ? `；${drift} 个平台形状漂移（--write 落盘后跑测试）` : ''));
  process.exit(failed.length && captured.size === 0 ? 1 : 0);
})();
