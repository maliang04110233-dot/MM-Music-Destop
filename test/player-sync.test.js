/**
 * player-sync.test.js — 自 init() 内闭包提出的四个函数：等价性与契约守卫
 *
 * 背景
 * ----
 * syncToTray / syncToMiniPlayer / syncToDesktopLyric / restorePlayQueueFromSaved
 * 原先定义在 app.js 的 init() **内部**，彼此闭包引用 init 局部变量
 * （_audio / _dlLastLyricSongId / _queueRestored）。它们只被 init 调用、
 * 彼此互调，对模块外无其他调用方 —— 故可整体外提为 player-sync.js。
 *
 * 与 EQ 那次抽取的关键差异
 * ------------------------
 * EQ 簇是**自持**的（对外零引用）；这四个函数是 init 的**内部实现**，
 * 外提后 init 必须显式传 _audio，且四处事件回调的调用签名随之改变。
 * 因此本轮的失败模式不是「挂载丢失」而是**「调用签名不匹配」**：
 * 漏传 _audio → 函数内 `!audio` 提前 return → 托盘/迷你播放器/桌面歌词
 * **静默失去同步**，测试与构建全都照样通过。
 * 故守卫重点是「app.js 里的每个调用点都传了 _audio」。
 *
 * 静态分析而非 DOM 测试：项目 devDependencies 无 jsdom（同 EQ 轮）。
 * 扫描前一律 stripComments —— 本文件头部注释就提到了这些函数名，
 * 不剥注释会把说明文字当成代码证据（EQ 轮踩过这个坑）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.resolve(p), 'utf8');

/** 去掉块注释与行注释（块注释用等长空格替换以保留行结构） */
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

const APP_CODE = stripComments(read('src/renderer/js/app.js'));
const SYNC_CODE = stripComments(read('src/renderer/js/player-sync.js'));
const SYNC_SRC = read('src/renderer/js/player-sync.js');

/** player-sync.js 的 export 面（兼容 `export function f` 与独立 `export { a }`） */
function exportsOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/^\s*export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) out.add(n);
    }
  }
  return [...out].sort();
}

const PUBLIC = [
  'applyRestoredPlayMode', 'resetDesktopLyricSong', 'restorePlayQueueFromSaved',
  'syncToDesktopLyric', 'syncToMiniPlayer', 'syncToTray',
];

// ── A. 迁移完整性 ─────────────────────────────────────────────
test('app.js: 四个函数已不在 init() 内定义（外提完成，无残留实现）', () => {
  const leaked = [];
  for (const sym of [
    'function syncToTray', 'function syncToMiniPlayer', 'function syncToDesktopLyric',
    'function applyRestoredPlayMode', 'function restorePlayQueueFromSaved',
    'let _dlLastLyricSongId', 'let _queueRestored',
  ]) {
    if (APP_CODE.includes(sym)) leaked.push(sym);
  }
  assert.deepEqual(leaked, [], `app.js 仍残留已外提的实现：${leaked.join(', ')}`);
});

test('player-sync.js: 公开面恰为 6 个函数', () => {
  assert.deepEqual(exportsOf(SYNC_CODE), PUBLIC, 'player-sync.js 的 export 面发生了变化');
});

// ── B. 调用签名（本轮真正的失败模式） ──────────────────────────
test('app.js: 每个 syncTo* 调用点都传了 _audio 实参', () => {
  // 必须先剔除 import 语句：`import { syncToMiniPlayer } from ...` 里出现的
  // 函数名后紧跟 `}`，会被当成一个「零实参调用」而误报。
  const body = APP_CODE.replace(/^\s*import\s[\s\S]*?;\s*$/gm, '');
  const offenders = [];
  const re = /\b(syncToTray|syncToMiniPlayer|syncToDesktopLyric)\s*\(([^)]*)\)/g;
  let m;
  let seen = 0;
  while ((m = re.exec(body))) {
    seen++;
    const args = m[2].trim();
    if (args !== '_audio') {
      const line = body.slice(0, m.index).split('\n').length;
      offenders.push(`${m[1]}(${args}) @L${line}`);
    }
  }
  assert.ok(seen > 0, '未找到任何 syncTo* 调用 —— 扫描器或代码结构已变');
  assert.deepEqual(
    offenders, [],
    `以下调用点未按约定传 _audio（漏传会让同步静默失效）：${offenders.join('; ')}`
  );
});

test('player-sync.js: 四个外发函数都以 audio 为第一形参', () => {
  for (const fn of ['syncToTray', 'syncToMiniPlayer', 'syncToDesktopLyric']) {
    const m = SYNC_CODE.match(new RegExp(`export\\s+function\\s+${fn}\\s*\\(([^)]*)\\)`));
    assert.ok(m, `未找到 ${fn} 的导出声明`);
    const first = m[1].split(',')[0].trim();
    assert.equal(first, 'audio', `${fn} 的第一形参应为 audio，实际为 "${first}"`);
  }
});

test('player-sync.js: 三个外发函数都保留了 !audio 的提前返回（空引用防护）', () => {
  for (const fn of ['syncToMiniPlayer', 'syncToDesktopLyric']) {
    const start = SYNC_CODE.indexOf(`export function ${fn}`);
    const body = SYNC_CODE.slice(start, SYNC_CODE.indexOf('\n}', start));
    assert.ok(/!\s*audio/.test(body), `${fn} 丢失了 !audio 防护`);
  }
});

// ── C. 原始行为逐条保留（防搬错逻辑） ──────────────────────────
test('player-sync.js: syncToMiniPlayer 仍推全 7 个字段', () => {
  const start = SYNC_CODE.indexOf('export function syncToMiniPlayer');
  const body = SYNC_CODE.slice(start, SYNC_CODE.indexOf('\n}', start));
  for (const key of ['title', 'artist', 'cover', 'playing', 'progress', 'lyric', 'time']) {
    // 兼容两种写法：`key: value` 与简写属性 `key,`（progress 就是简写）
    assert.ok(
      new RegExp(`\\b${key}\\s*[,:]`).test(body),
      `syncMiniPlayer 载荷丢了字段: ${key}`
    );
  }
  assert.ok(/fmtTime\(/.test(body), 'syncToMiniPlayer 丢了 fmtTime 时间格式化');
});

test('player-sync.js: syncToDesktopLyric 仍保留「换歌才推整份歌词」的节流', () => {
  const start = SYNC_CODE.indexOf('let _dlLastLyricSongId');
  const end = SYNC_CODE.indexOf('export function resetDesktopLyricSong');
  const body = SYNC_CODE.slice(start, end);
  assert.ok(/songKey\s*!==\s*_dlLastLyricSongId/.test(body), '换歌判据丢失 → 会每帧重推整份歌词');
  assert.ok(/resetDesktopLyricSong/.test(SYNC_CODE), '缺少重置入口（桌面歌词窗口要全量状态时需要）');
});

test('player-sync.js: restorePlayQueueFromSaved 仍保留 _queueRestored 防双重恢复', () => {
  const start = SYNC_CODE.indexOf('export function restorePlayQueueFromSaved');
  const body = SYNC_CODE.slice(start, SYNC_CODE.indexOf('\n}', start));
  assert.ok(/_queueRestored/.test(body), '防双重恢复标志丢失');
  assert.ok(/setState\(\s*'playQueue'/.test(body), '恢复时不再写 playQueue');
  assert.ok(/updatePlayerCard/.test(body), '不再在播放器卡片上显示待播歌曲');
  assert.ok(/applyRestoredPlayMode\(/.test(body), '不再恢复 loopMode/isShuffled');
});

test('player-sync.js: 仅依赖已挂 window 的既有全局（无新增 import 耦合）', () => {
  assert.equal(
    (SYNC_CODE.match(/^\s*import\s/gm) || []).length, 0,
    'player-sync.js 不应引入任何 import —— 它按本仓约定只依赖全局'
  );
  // 「依赖全局」清单在头部注释里会**跨行换行**，故取注释块整体而非单行
  const header = SYNC_SRC.slice(0, SYNC_SRC.indexOf('*/'));
  const m = header.match(/依赖全局：([\s\S]*?)(?:\n\s*\*\s*\n|\n\s*\*\/)/);
  assert.ok(m, '头部注释缺少「依赖全局」说明');
  const declared = m[1];
  const expected = ['api', 'getState', 'setState', 'fmtTime', 'showToast', 'updatePlayerCard', 'updatePlayModeButton'];
  const missing = expected.filter((n) => !declared.includes(n));
  assert.deepEqual(missing, [], `头部「依赖全局」清单漏了：${missing.join(', ')}`);

  // 反向校验：清单里声明的每个名字都应在正文中真的被使用（防清单过期）。
  // ⚠️ 正文要从 **SYNC_SRC（原始源码）** 切，不能用 SYNC_CODE ——
  //    SYNC_CODE 里注释已被抹成空格，没有 '*/' 可切，indexOf 返回 -1
  //    → slice(-1) 得到空串 → 所有名字都被误判为「未使用」。
  const bodyText = SYNC_SRC.slice(SYNC_SRC.indexOf('*/'));
  const unused = expected.filter((n) => !new RegExp(`\\b${n}\\b`).test(bodyText));
  assert.deepEqual(unused, [], `「依赖全局」清单声明了但正文未使用：${unused.join(', ')}`);
});

// ── D. app.js 侧仍完整接线 ────────────────────────────────────
test('app.js: 从 player-sync.js import 的恰好是实际用到的那些', () => {
  const m = APP_CODE.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/player-sync\.js'/);
  assert.ok(m, 'app.js 未从 ./player-sync.js import');
  const imported = m[1].split(',').map(s => s.trim()).filter(Boolean).sort();
  // applyRestoredPlayMode 由 restorePlayQueueFromSaved 内部调用，app.js 不需要
  assert.deepEqual(
    imported,
    ['resetDesktopLyricSong', 'restorePlayQueueFromSaved', 'syncToDesktopLyric', 'syncToMiniPlayer', 'syncToTray'],
    'import 名单变化了 —— 请确认没有引入未使用的符号或被删掉必要符号'
  );
});

test('app.js: 仍保留 playQueueRestored 监听与 4 个持久化订阅', () => {
  assert.ok(/api\.onPlayQueueRestored\(/.test(APP_CODE), 'playQueueRestored 监听丢失 → 启动不再恢复队列');
  for (const key of ['playQueue', 'playIdx', 'loopMode', 'isShuffled']) {
    assert.ok(
      new RegExp(`state\\.subscribe\\(\\s*'${key}'`).test(APP_CODE),
      `state.subscribe('${key}') 丢失 → ${key} 变化不再持久化`
    );
  }
});

test('app.js: 仍保留 _audio 模块级声明与事件绑定', () => {
  assert.ok(/^let _audio = null;/m.test(APP_CODE), '_audio 模块级声明丢失');
  assert.ok(/document\.getElementById\('audioPlayer'\)/.test(APP_CODE), '_audio 不再从 DOM 获取');
  assert.ok(/addEventListener\('timeupdate'/.test(APP_CODE), 'timeupdate 绑定丢失');
});

// ── E. 自检：确认扫描器真的在读代码 ───────────────────────────
test('自检: stripComments 生效，且两份源码都被正确读取', () => {
  assert.ok(!stripComments('/* syncToTray() */ let a = 1;').includes('syncToTray'), '块注释未剥离');
  assert.ok(!stripComments('let a = 1; // syncToTray()').includes('syncToTray'), '行注释未剥离');
  assert.ok(stripComments('syncToTray(_audio);').includes('syncToTray'), '代码被误剥离');
  assert.ok(APP_CODE.includes('onPlayQueueRestored'), 'app.js 读取内容异常');
  assert.ok(SYNC_CODE.includes('syncToMiniPlayer'), 'player-sync.js 读取内容异常');
});
