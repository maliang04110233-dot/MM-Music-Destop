/**
 * 增量198：浮层注册表——data-attribute 契约（148/151/185「手抄清单必漏」律的第四次立法）
 * 增量199：偿还建层时登记的六浮层 Esc 债 + ⑩ 把 HTML 契约属性送上实弹桥接
 *
 * 来龙：_anyModalOpen() 与 closeActiveModal() 各自手抄了一份浮层 id 清单。
 * 195 实测抓到活体证据：cmdkOverlay 从来不在两份清单里——背景键守卫与 Esc
 * 关闭对命令面板双双失明，195 只能靠面板自己的 capture 围堵做第二保险。
 * 巡扫还照出更老的反例：shortcutsHelp/convertModal/dlTemplateEditorModal/
 * playlistTrashModal 同样不在 _anyModalOpen 表里——浮层开着按 Space 会触发
 * 全局播放/暂停（130 行的守卫漏它们）。清单每加一个浮层就要记得改两处，
 * 而事实证明没人记得。
 *
 * 修法（本文件钉的就是这个契约）：浮层身份写进浮层自己的 DOM——
 *   data-modal                裸属性：计入背景键守卫面（_anyModalOpen 扫描）
 *   data-modal-close="fn|-"   Esc 可关：fn=调 window[fn]()；'-' 哨兵=直接 remove()
 *   data-modal-pri="N"        多层同开时按降序逐层关（缺省 0，同序稳定=DOM 序）
 * 两份手抄拆掉，注册表 = DOM 本身。esc-closable 五枚（help 100 / cmdk 95 /
 * playlist 90 / edit 80 / settings 70）完整保住 legacy 的关闭次序；
 * 建层时其余只入守卫面——「六浮层 Esc 不可关」作为登记债由 ⑥ 的反裸登记
 * 钉锁住，199 逐视图核实关闭语义后全额偿还（见 ⑥ CLOSABLE 注释与 ⑩ 实弹桥接）。
 *
 * RED 形状预告：①⑤ 首轮会死在桩的选择器 throw 上——legacy _anyModalOpen 末行
 * 查 '.welcome-overlay' 类选择器，不在承诺面内。桩拒绝为旧清单编造答案，
 * 这个 throw 本身就是手抄清单的验尸报告。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeDomStub, dispatchKey } from './helpers/dom-stub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const readFile = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

const req = createRequire(import.meta.url);
const SHORTCUTS_PATH = R('js', 'shortcuts.js');
const PALETTE_PATH = R('js', 'commandPalette.js');

async function loadFresh(absPath, qtag) {
  try { delete req.cache[req.resolve(absPath)]; } catch (_e) { /* ESM 时代无此缓存项 */ }
  return import(pathToFileURL(absPath).href + '?' + qtag + '=' + Math.random());
}

/** 装一个带全局环境的 shortcuts.js 新鲜实例（IIFE 会在 import 时挂 document 监听）。 */
async function loadShortcuts(doc) {
  global.document = doc;
  global.window = {
    location: { hostname: 'localhost', protocol: 'file:' },
    addEventListener: () => {},
  };
  global.window.document = doc;
  return loadFresh(SHORTCUTS_PATH, 'sr');
}

/** 造一个浮层：mod=带 data-modal；close/pri=关闭契约；hidden=初始收起。 */
function addModal(doc, { mod = true, close, pri, hidden = false, tag = 'div' } = {}) {
  const el = doc.createElement(tag);
  if (mod) el.setAttribute('data-modal', '');
  if (close !== undefined) el.setAttribute('data-modal-close', close);
  if (pri !== undefined) el.setAttribute('data-modal-pri', String(pri));
  if (hidden) el.classList.add('hidden');
  doc.body.appendChild(el);
  return el;
}

// ── ① 守卫面按形状扫描：可见的 data-modal 即在场，hidden 即离场 ──
// RED 形态：legacy 的 getElementById 清单不认识测试浮层，末行 '.welcome-overlay'
// 类选择器被本家桩按承诺面 ⑦ 直接 throw——旧清单在桩面前无处遁形。
test('① 守卫面按形状扫描：可见的 data-modal 即在场，hidden 即离场', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  assert.equal(sc._anyModalOpen(), false, '无浮层时守卫面应为空');
  const closed = addModal(doc, { hidden: true });
  assert.equal(sc._anyModalOpen(), false, 'hidden 的浮层不算在场');
  const open = addModal(doc, {});
  assert.equal(sc._anyModalOpen(), true, '可见 data-modal 即在场');
  open.classList.add('hidden');
  assert.equal(sc._anyModalOpen(), false, '收起后即刻离场（class 是活的，不是开层时快照）');
  closed.remove();
});

// ── ② Esc 按 data-modal-pri 降序逐层关；同开只关一层；关成后 preventDefault ──
test('② Esc 按 data-modal-pri 降序逐层关；同开只关一层；关成后 preventDefault', async () => {
  const doc = makeDomStub();
  await loadShortcuts(doc); // 只吃它的 IIFE 挂监听副作用，②全程走实弹 dispatchKey
  // DOM 序故意为 B→A→C：若实现按 DOM 序偷懒关闭，A(pri=90) 就不会第一个倒下
  const b = addModal(doc, { close: 'closeB', pri: 80 });
  const a = addModal(doc, { close: 'closeA', pri: 90 });
  const c = addModal(doc, { close: 'closeC' }); // 无 pri → 缺省 0，最后
  const calls = [];
  const hide = (el, name) => () => { calls.push(name); el.classList.add('hidden'); };
  global.window.closeA = hide(a, 'closeA');
  global.window.closeB = hide(b, 'closeB');
  global.window.closeC = hide(c, 'closeC');

  const ev1 = dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeA'], '第一层 Esc 只关最高优先级（A，尽管 B 在 DOM 里更靠前）');
  assert.equal(ev1.defaultPrevented, true, '关了一层就该吃掉这次 Esc');

  dispatchKey(doc, 'Escape', doc.body);
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeA', 'closeB', 'closeC'], '连按逐层下台阶（pri 降序，缺省 0 殿后）');

  const ev4 = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(calls.length, 3, '全部收起后注册表无事可做');
  assert.equal(ev4.defaultPrevented, false, '没人可关时不吞键（legacy 语义：false→不 preventDefault）');
});

// ── ③ '-' 哨兵：无导出关闭函数的浮层（帮助弹层）由注册表直接摘除 ──
test('③ 短横哨兵 close="-"：无导出关闭函数的浮层由注册表直接摘除', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  const el = addModal(doc, { close: '-', pri: 100 });
  assert.ok(sc.closeActiveModal(), "'-' 浮层可关 → true");
  assert.ok(!doc.body.children.includes(el), "注册表按 '-' 摘除节点本体");
  assert.equal(sc._anyModalOpen(), false, '摘除后守卫面清空');
});

// ── ④ 守卫-only 浮层（只带 data-modal）：拦背景键，但 Esc 不越权代关 ──
// 绿即所愿：legacy 里这四枚子 modal Esc 本就关不掉，本测防的是实现"顺手过正"
// ——在逐视图关闭语义未核实前，注册表不许自作主张。
test('④ 守卫-only 浮层（只带 data-modal）：拦背景键，但 Esc 不越权代关', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  const el = addModal(doc, {});
  assert.equal(sc._anyModalOpen(), true, '守卫-only 也算在场（Space/searchListKey 让位）');
  assert.equal(sc.closeActiveModal(), false, '未登记关闭契约的浮层，Esc 不得动它');
  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, false, '未关成就不吃 Esc');
  assert.ok(doc.body.children.includes(el), '浮层本体原封不动');
});

// ── ⑤ 命令面板实弹：195 的账在这里还——面板开，注册表必须看得见、关得掉 ──
test('⑤ 命令面板实弹：195 的账在这里还——面板开，注册表必须看得见、关得掉', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  global.localStorage = {
    _m: new Map(),
    getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
    setItem(k, v) { this._m.set(k, String(v)); },
  };
  const pal = await loadFresh(PALETTE_PATH, 'pc');
  global.window.switchTab = () => {};
  const bgBtn = doc.createElement('button');
  doc.body.appendChild(bgBtn);
  bgBtn.focus();
  pal.openCommandPalette();

  assert.equal(sc._anyModalOpen(), true, '面板开着 = 守卫在场（手抄清单时代的 cmdkOverlay 盲区就此封堵）');
  const overlay = doc.getElementById('cmdkOverlay');
  assert.ok(overlay, '面板宿主就位');
  assert.equal(overlay.getAttribute('data-modal-close'), 'closeCommandPalette');
  assert.equal(overlay.getAttribute('data-modal-pri'), '95');

  assert.equal(sc.closeActiveModal(), true, '注册表该能关面板');
  assert.ok(overlay.classList.contains('hidden'), '关闭走面板自己的 teardown（挂 hidden），而非注册表越权拆节点');
  assert.equal(sc._anyModalOpen(), false, 'teardown 后离场');
});

// ── ⑥ index.html 全量对账：守卫面浮层必有去向——授关闭契约或登记为债（反裸登记） ──
test('⑥ index.html 全量对账：浮层要么授关闭契约、要么在 DEBT 立债，新漏对账即红', async () => {
  const html = readFile('index.html');
  const CLOSABLE = {
    playlistModal: ['closePlaylistModal', '90'],
    editOverlay: ['closeEdit', '80'],
    settingsOverlay: ['closeSettings', '70'],
    // 199 偿还：六枚关闭语义逐视图核实——函数体全是纯「hidden + 状态复位」，
    // 无写盘无破坏副作用；且六枚背景早就是「点背景即关」（onclick 里
    // event.target===this && closeXxx()），Esc 只是既有可供性的键盘同义。
    // pri 按层叠定：editor/select 会从 detail 之上打开（92/93 > 88），
    // dlTemplateEditor 在设置页内打开（75 > settingsOverlay 70，否则 Esc 先关宿主、子层悬空）。
    convertModal: ['closeConvertModal'],
    dlTemplateEditorModal: ['closeDlTemplateEditor', '75'],
    playlistDetailModal: ['closePlaylistDetail', '88'],
    playlistEditorModal: ['closePlaylistEditor', '92'],
    playlistTrashModal: ['closePlaylistTrash'],
    playlistSelectModal: ['closePlaylistSelectModal', '93'],
  };
  const DEBT = []; // 198 登记六笔，199 还清；新浮层裸挂 data-modal 未授契约必须先在此立债（附核实计划）
  const seen = new Set();
  for (const m of html.matchAll(/<div[^>]* data-modal[ >][^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])[1];
    assert.ok(!seen.has(id), id + ' 重复登记？');
    seen.add(id);
    if (DEBT.includes(id)) {
      assert.ok(!m[0].includes('data-modal-close='), id + ' 在债册中，不应已授关闭契约');
      continue;
    }
    assert.ok(id in CLOSABLE, id + ' 未对账——新浮层须先补 ⑩ 桥接测再授契约或立债（反裸登记钉）');
    const [fn, pri] = CLOSABLE[id];
    assert.ok(m[0].includes('data-modal-close="' + fn + '"'),
      id + ' 应登记关闭契约 data-modal-close="' + fn + '"');
    if (pri) assert.ok(m[0].includes('data-modal-pri="' + pri + '"'),
      id + ' 应带优先级 ' + pri);
  }
  for (const id of [...Object.keys(CLOSABLE), ...DEBT]) {
    assert.ok(seen.has(id), id + ' 在册但 DOM 缺席——浮层被搬走/改名，对账册须同步');
  }
  // 契约函数必须真挂在 window 上：注册表按 window[name] 找函数，
  // 挂空 = 每次 Esc 白吃不放行（closeActiveModal 对缺席函数仍返回 true 的 legacy 语义）
  const srcs = ['js/app.js', 'js/views/local.js', 'js/views/settings.js',
    'js/views/playlist.js', 'js/converter-core.js', 'js/commandPalette.js', 'js/shortcuts.js']
    .map((f) => readFile(f)).join('\n');
  for (const [fn] of Object.values(CLOSABLE)) {
    assert.ok(new RegExp('window\\.' + fn + '\\s*=').test(srcs),
      fn + ' 必须挂 window（注册表按 window 寻函数）');
  }
});

// ── ⑦ 反向钉：两份手抄必须死透（短路与 legacy 清单的任何复辟形状都不许留） ──
test('⑦ 反向钉：两份手抄必须死透（短路与 legacy 清单的任何复辟形状都不许留）', async () => {
  const src = readFile('js/shortcuts.js');
  const grab = (name) => {
    const m = src.match(new RegExp('function ' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}'));
    assert.ok(m, name + ' 应仍存在');
    return m[0];
  };
  const scan = grab('_anyModalOpen');
  const close = grab('closeActiveModal');
  for (const [where, body] of [['_anyModalOpen', scan], ['closeActiveModal', close]]) {
    assert.ok(!body.includes('getElementById'), where + ' 不许再按 id 点名（手抄清单复辟形状）');
    assert.ok(!body.includes('const ids'), where + ' 不许再藏 id 数组');
    assert.ok(!/playlistModal|editOverlay|settingsOverlay|cmdkOverlay|shortcutsHelp|welcome/.test(body),
      where + ' 不许出现具体浮层名');
  }
  assert.ok(scan.includes('[data-modal'), '_anyModalOpen 应改为按注册表形状扫描');
  assert.ok(close.includes('[data-modal-close'), 'closeActiveModal 应改为按注册表形状扫描');
  assert.ok(!src.includes("'.welcome-overlay'"),
    'welcome 的守卫改走 data-modal 属性，类名暗号从 shortcuts.js 退役');
});

// ── ⑧ 帮助浮层就地注册：创建点挂身份 + '-' 契约 + 最高优先级；实弹 Esc 摘除 ──
test('⑧ 帮助浮层就地注册：创建点挂身份 + 短横哨兵契约 + 最高优先级；实弹 Esc 摘除', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc);
  sc.showShortcutsHelp();
  const help = doc.getElementById('shortcutsHelp');
  assert.ok(help, '帮助浮层已创建');
  assert.notEqual(help.getAttribute('data-modal'), null, '帮助浮层自报家门（守卫面曾漏它 → Space 漏按全局播放）');
  assert.equal(help.getAttribute('data-modal-close'), '-');
  assert.equal(help.getAttribute('data-modal-pri'), '100', '帮助永远最先倒下（legacy「优先关闭」注释的属性化）');

  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, true, '实弹 Esc 经 handleKey→注册表关帮助（legacy 行为保真）');
  assert.equal(doc.getElementById('shortcutsHelp'), null, '帮助浮层被摘除');
});

// ── ⑨ 桩自测（扫描器自带自测律）：承诺面 ⑦ 的四种形状 + 未知形式必须炸 ──
test('⑨ 桩自测（扫描器自带自测律）：承诺面 ⑦ 的四种形状 + 未知形式必须炸', async () => {
  const doc = makeDomStub();
  const plain = doc.createElement('div');
  plain.setAttribute('data-x', '');
  const also = doc.createElement('div');
  also.setAttribute('data-x', 'anything');
  also.classList.add('hidden');
  const named = doc.createElement('div');
  named.id = 'zz-top';
  const btn = doc.createElement('button');
  doc.body.appendChild(plain); doc.body.appendChild(also); doc.body.appendChild(named); doc.body.appendChild(btn);

  assert.equal(doc.querySelectorAll('[data-x]').length, 2, '[attr] 认属性存在，值为空串也算');
  assert.equal(doc.querySelector('[data-x]:not(.hidden)'), plain, ':not(.cls) 按 token 剔除');
  assert.equal(doc.querySelector('#zz-top'), named, 'document 级从 body 起走');
  assert.equal(doc.body.querySelectorAll('button')[0], btn, "tag 形式不回归");
  assert.throws(() => doc.querySelector('.welcome-overlay'), /桩只承诺/,
    '未知形式宁可炸，不静默答"无一人"');
});

// ── ⑩ HTML 契约实弹桥接：从 index.html 读契约属性注入桩，注册表按 HTML 所言实弹关闭 ──
// 钉住「HTML 属性不是死文本」：⑥ 所定的 pri 层叠必须在 closeActiveModal 一层为真。
// 属性逐字从 HTML 抄，不手搓——HTML 改了契约，这里的剧本自动跟（或对不上账即红）。
test('⑩ HTML 契约实弹桥接：叠层浮层按 HTML 所定次序逐层关', async () => {
  const doc = makeDomStub();
  const sc = await loadShortcuts(doc); // IIFE 挂 handleKey，全程走实弹 dispatchKey
  const html = readFile('index.html');
  const els = {};
  for (const m of html.matchAll(/<div[^>]* data-modal[ >][^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])[1];
    const el = doc.createElement('div');
    el.id = id;
    el.classList.add('hidden');
    el.setAttribute('data-modal', ''); // 正则已筛过带此属性的 div，原样复刻
    const cm = /data-modal-close="([^"]+)"/.exec(m[0]);
    const pm = /data-modal-pri="([^"]+)"/.exec(m[0]);
    if (cm) el.setAttribute('data-modal-close', cm[1]);
    if (pm) el.setAttribute('data-modal-pri', pm[1]);
    doc.body.appendChild(el); // 注入序 = 文档序，② 的稳定排序承诺继续成立
    els[id] = el;
  }
  for (const id of ['playlistDetailModal', 'playlistEditorModal', 'playlistSelectModal',
    'playlistTrashModal', 'settingsOverlay', 'dlTemplateEditorModal']) {
    assert.ok(els[id], id + ' 四件套缺席，桥接剧本无主角');
  }
  const calls = [];
  for (const el of Object.values(els)) {
    const fn = el.getAttribute('data-modal-close');
    if (fn) global.window[fn] = () => { calls.push(fn); el.classList.add('hidden'); };
  }
  const open = (...ids) => {
    for (const el of Object.values(els)) el.classList.add('hidden');
    ids.forEach((i) => els[i].classList.remove('hidden'));
    calls.length = 0;
  };

  open('playlistDetailModal', 'playlistEditorModal');
  assert.equal(sc._anyModalOpen(), true, '叠层在场 = 守卫面在场');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistEditor'], 'editor 盖在 detail 上：先关顶层（92>88），不是底层的 detail');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistEditor', 'closePlaylistDetail'], '再按关底层——逐层退');
  const ev = dispatchKey(doc, 'Escape', doc.body);
  assert.equal(ev.defaultPrevented, false, '两层都收起后 Esc 交还自由');

  open('playlistDetailModal', 'playlistSelectModal');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistSelectModal'], '加入歌单浮层盖 detail：select 先关（93>88）');

  open('settingsOverlay', 'dlTemplateEditorModal');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeDlTemplateEditor'], '模板编辑器寄在设置页内：先关子再关母（75>70），否则宿主倒下子层悬空');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closeDlTemplateEditor', 'closeSettings'], '子退位后母才走');

  open('playlistTrashModal');
  assert.equal(sc._anyModalOpen(), true, '回收站浮层在场');
  dispatchKey(doc, 'Escape', doc.body);
  assert.deepEqual(calls, ['closePlaylistTrash'], '独开一枚缺省 pri 的浮层也关得动');
  assert.equal(sc._anyModalOpen(), false, '关闭函数挂 hidden 即离场（契约与守卫面同一事实源）');
});
