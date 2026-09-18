/**
 * eq-behaviour.test.js — EQ 簇「现状钉住」守卫
 *
 * 为什么是静态分析而非 DOM 测试：项目 devDependencies 无 jsdom，
 * 渲染层无法在 node --test 里实例化。故沿用 platform-contract.test.js /
 * renderer-contract.test.js 的同款手法——扫描源码文本断言结构。
 *
 * 本文件的职责不是"验证 EQ 好用"，而是**钉住两条已知缺陷的现状**：
 *   A. eqFilters 恒空 → 所有 gain 写入是空操作（DSP 未接入，UI 已如实标注）
 *   B. saveEqSettings 写 prefs.eqGains，但 restoreEqPresetSetting 不回读
 *      eqGains（只读 eqPreset / eqBypass）→ 手调单段增益重启后丢失
 *
 * 若将来有人真把 EQ 接上音频链路、或补上 eqGains 回读，这两个测试会转红。
 * 那是**预期的**：转红即强制一次显式决策（改测试 + 改 UI 文案），
 * 而不是让行为在无人注意时静默漂移。
 *
 * 注意：所有扫描前都会 stripComments——eq.js 头部注释里**故意**提到了
 * createBiquadFilter 等标识符用于说明缺陷，不能把注释当成代码证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

/** 去掉块注释与行注释，避免把"说明文字"误判为"代码事实" */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const EQ_SRC = read('src/renderer/js/player/eq.js');
const EQ_CODE = stripComments(EQ_SRC);
const PLAYER_CODE = stripComments(read('src/renderer/js/player.js'));
const PLAYER_SRC = read('src/renderer/js/player.js');
const HTML_SRC = read('src/renderer/index.html');

/** eq.js 的 export 名字集合：兼容 `export function f` 与独立 `export { a, b }` */
function exportsOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

const EQ_PUBLIC = ['applyEqPreset', 'resetEq', 'restoreEqPresetSetting', 'saveEqSettings', 'setEqBand', 'toggleEqBypass'];

// ── A. eqFilters 恒空 ─────────────────────────────────────────
test('eq.js: eqFilters 不存在任何填充点（钉住"增益写入是空操作"的现状）', () => {
  const fillRe = /eqFilters\s*(\.push\s*\(|\[[^\]]*\]\s*=(?!=))/g;
  const fills = [];
  let m;
  while ((m = fillRe.exec(EQ_CODE))) {
    fills.push(EQ_CODE.slice(0, m.index).split('\n').length);
  }
  assert.deepEqual(
    fills, [],
    `eqFilters 出现了填充点（行 ${fills.join(', ')}）。若 EQ 真的接上了音频链路，` +
    '请同步删除 index.html 里的 eqNotEffective 警告文案与本测试。'
  );
});

test('eq.js: 全仓不存在 createBiquadFilter / createMediaElementSource（钉住"未接入音频链路"）', () => {
  const offenders = [];
  const pattern = /\.(createBiquadFilter|createMediaElementSource|createGain)\s*\(/;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.name.endsWith('.js')) continue;
      if (pattern.test(stripComments(fs.readFileSync(full, 'utf8')))) {
        offenders.push(path.relative(process.cwd(), full).replace(/\\/g, '/'));
      }
    }
  };
  walk(path.resolve('src'));
  assert.deepEqual(
    offenders, [],
    `发现音频图创建点：${offenders.join(', ')}。EQ 已接入时请更新 index.html 的 eqNotEffective 文案与本测试。`
  );
});

test('index.html: 仍保留"EQ 未接入音频链路"的用户可见警告（与上面两条同步）', () => {
  assert.ok(
    HTML_SRC.includes('data-i18n="settings.general.eqNotEffective"'),
    'eqNotEffective 警告消失，但 eqFilters 仍是空数组 → 用户会被误导'
  );
});

// ── B. eqGains 只写不读 ───────────────────────────────────────
test('eq.js: saveEqSettings 写入 prefs.eqGains', () => {
  assert.ok(
    /setPref\(\s*['"]eqGains['"]/.test(EQ_CODE),
    'saveEqSettings 不再写 eqGains，行为已变'
  );
});

test('eq.js: restoreEqPresetSetting 不读 eqGains（钉住"手调增益重启丢失"的现状）', () => {
  const start = EQ_CODE.indexOf('async function restoreEqPresetSetting');
  assert.ok(start >= 0, '未找到 restoreEqPresetSetting');
  const end = EQ_CODE.indexOf('\n}', start);
  const body = EQ_CODE.slice(start, end);
  const readKeys = [...body.matchAll(/getPref\(\s*['"]([^'"]+)['"]/g)].map(x => x[1]);
  assert.deepEqual(
    readKeys.sort(), ['eqBypass', 'eqPreset'],
    `restoreEqPresetSetting 读取的 key 变了：${JSON.stringify(readKeys)}。` +
    '若已补上 eqGains 回读，请同步更新本测试与 eq.js 头部注释里的已知状态第 2 条。'
  );
  assert.ok(
    !body.includes('eqGains'),
    'restoreEqPresetSetting 开始引用 eqGains —— 说明缺陷已修，请更新本测试与注释'
  );
});

// ── C. 公开面（拆分的核心约束） ────────────────────────────────
test('eq.js: 公开面恰为 6 个函数', () => {
  assert.deepEqual(
    exportsOf(EQ_CODE), EQ_PUBLIC,
    'eq.js 的 export 面变化了，player.js 的 re-export 与 window 挂载需同步'
  );
});

test('player.js: 从 ./player/eq.js import 的恰好是 eq.js 的全部公开函数', () => {
  // 注意：不能用 [\s\S]*? 桥接——前面的 stats.js import 会先被匹配到。
  // 用 [^}]* 限定在单个 import 语句的括号内，并锚定 eq.js 的 from。
  const m = PLAYER_CODE.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/player\/eq\.js'/);
  assert.ok(m, 'player.js 未从 ./player/eq.js import —— re-export 会 ReferenceError');
  const imported = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  assert.deepEqual(imported, EQ_PUBLIC, 'import 的名字集合与 eq.js 的 export 面不一致');
});

test('player.js: re-export 了 eq.js 的全部公开函数', () => {
  const m = PLAYER_CODE.match(/export\s*\{([\s\S]*?)\}\s*;/);
  assert.ok(m, 'player.js 未见 re-export 语句');
  const reexported = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  assert.deepEqual(reexported, EQ_PUBLIC, 're-export 的名字集合与 eq.js 的 export 面不一致');
});

test('player.js: 6 个 EQ 函数仍挂在 window 上（index.html onclick 的存活前提）', () => {
  for (const n of EQ_PUBLIC) {
    assert.ok(
      new RegExp(`window\\.${n}\\s*=`).test(PLAYER_CODE),
      `window.${n} 未挂载 —— index.html 的 onclick="${n}(...)" 会静默失效`
    );
  }
});

test('player.js: EQ 实现已清空（不应再有 EQ_BANDS / EQ_PRESETS / eqFilters 定义）', () => {
  const leaked = [];
  for (const sym of ['const EQ_BANDS', 'const EQ_PRESETS', 'const eqFilters', 'let eqBypassed', 'let currentEqPreset', 'function getEqGains']) {
    if (PLAYER_CODE.includes(sym)) leaked.push(sym);
  }
  assert.deepEqual(leaked, [], `player.js 仍残留 EQ 实现：${leaked.join(', ')}（拆分未完成或发生回退）`);
});

// ── D. 反向检查：保证这些断言真的在读源码 ─────────────────────
test('自检: stripComments 生效且扫描器能看见真实代码', () => {
  assert.ok(!stripComments('/* createBiquadFilter() */ let a = 1;').includes('createBiquadFilter'), '块注释未剥离');
  assert.ok(!stripComments('let a = 1; // eqFilters.push(x)').includes('eqFilters'), '行注释未剥离');
  assert.ok(stripComments('const x = eqFilters.push(1);').includes('eqFilters'), '代码被误剥离');
  assert.equal(PLAYER_SRC.length, read('src/renderer/js/player.js').length, 'PLayer_SRC 读取异常');
  assert.ok(PLAYER_SRC.includes('audioCtx'), 'player.js 读取内容异常（探针文件自检）');
});
