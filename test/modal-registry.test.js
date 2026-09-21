/**
 * 增量197：浮层注册表——data-attribute 契约（148/151/185「手抄清单必漏」律的第四次立法）
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
 * 其余四枚 playlist 子 modal + convert/dlTemplate + welcome 只入守卫面、
 * Esc 语义未逐视图核实前不授关闭权（legacy 里它们本来 Esc 也关不掉，
 * 行为零变化；「六浮层 Esc 不可关」作为已登记债另立增量还）。
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

// ── ⑥ index.html 收敛钉：九个静态浮层全部挂身份；三枚授关闭契约；其余是登记债 ──
test('⑥ index.html 收敛钉：九个静态浮层全部挂身份；三枚授关闭契约；其余是登记债', async () => {
  const html = readFile('index.html');
  const ALL = ['editOverlay', 'settingsOverlay', 'convertModal', 'playlistModal',
    'dlTemplateEditorModal', 'playlistDetailModal', 'playlistEditorModal',
    'playlistTrashModal', 'playlistSelectModal'];
  const CLOSABLE = {
    playlistModal: ['closePlaylistModal', '90'],
    editOverlay: ['closeEdit', '80'],
    settingsOverlay: ['closeSettings', '70'],
  };
  for (const id of ALL) {
    const m = html.match(new RegExp('<div[^>]*id="' + id + '"[^>]*>'));
    assert.ok(m, id + ' 应存在于 index.html');
    assert.ok(/ data-modal(=| |>)/.test(m[0] + ' '), id + ' 必须挂 data-modal（背景键守卫面）');
    const close = CLOSABLE[id];
    if (close) {
      assert.ok(m[0].includes('data-modal-close="' + close[0] + '"'),
        id + ' 应登记关闭契约 data-modal-close="' + close[0] + '"');
      assert.ok(m[0].includes('data-modal-pri="' + close[1] + '"'),
        id + ' 应带优先级 ' + close[1]);
    } else {
      // 登记债钉：逐视图 Esc 语义未核实前不得授关闭权；核实一个、从这里删一个、
      // 并在本文件补一枚该浮层的实弹行为测（③⑤ 是形状范例）。
      assert.ok(!m[0].includes('data-modal-close='),
        id + ' 的 Esc 可关性尚未逐视图核实——先补行为测再登记，勿裸挂契约');
    }
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
