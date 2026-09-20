/**
 * 增量174：不可逆操作确认弹层 confirmDialog 的契约测试。
 *
 * 现状缺口：全渲染层 15 处不可逆操作用的是浏览器原生 confirm()——
 *   ① 外观是操作系统的灰白小窗，与霓虹深色主题当面割裂（QA 维度"组件使用"）；
 *   ② Electron 的 file:// 源会在标题栏露出 "file:// 显示此对话框" 技术行；
 *   ③ 最要命：159/157 特意写好的多行点名文案（「\n\n• 影响A\n• 影响B」），
 *      原生对话框会把换行压平成一行——诚实点名的 F2 纪律文案被浏览器吃掉。
 * 立法（沿用 168「同一个规则只许有一个家」）：确认弹层只有 confirmDialog.js 一个家；
 *   反向钉按形状扫（裸 confirm( 调用），新代码再写原生 confirm 即红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (...p) => path.join(ROOT, 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

// confirmDialog 的模型层是纯函数（DOM 只活在 askConfirm 体内），node 可直接 import
const load = async () => import(pathToFileURL(R('js', 'confirmDialog.js')).href + '?tc=' + Math.random());

// ── 模型层：文案归一化 ─────────────────────────────────────

test('confirmDetails：字符串入参照样变成 title，单行文案 lines 为空（没正文就不硬凑回显）', async () => {
  const { confirmDetails } = await load();
  const d = confirmDetails('确认清空所有下载任务？');
  assert.equal(d.title, '确认清空所有下载任务？');
  assert.deepEqual(d.lines, []);
  assert.equal(d.danger, false);
  assert.equal(d.okLabel, '确认');
  assert.equal(d.cancelLabel, '取消');
});

test('confirmDetails：含换行的多行文案按行拆开——原生 confirm 压平的行，弹层必须一行一行显示', async () => {
  const { confirmDetails } = await load();
  const text = '确认删除歌单「叶惠美」？\n\n• 歌单里有 10 首歌 —— 删的只是这份清单\n• 删除后 5 秒内可点「撤销」原样找回';
  const d = confirmDetails(text);
  assert.equal(d.title, '确认删除歌单「叶惠美」？');
  assert.deepEqual(d.lines, [
    '• 歌单里有 10 首歌 —— 删的只是这份清单',
    '• 删除后 5 秒内可点「撤销」原样找回',
  ]);
});

test('confirmDetails：对象入参可点名标题/按钮/危险级，空行只当分隔不进 lines', async () => {
  const { confirmDetails } = await load();
  const d = confirmDetails({
    title: '彻底删除？',
    lines: [],
    text: '第一行\n\n第二行',
    okLabel: '彻底删除',
    danger: true,
  });
  assert.equal(d.title, '彻底删除？');
  assert.deepEqual(d.lines, ['第一行', '第二行']);
  assert.equal(d.okLabel, '彻底删除');
  assert.equal(d.danger, true);
});

test('confirmDetails：入参宽容——null/undefined/数字都不炸，回落成字符串文案', async () => {
  const { confirmDetails } = await load();
  assert.equal(confirmDetails().title, '确认执行该操作？');
  assert.equal(confirmDetails(null).title, '确认执行该操作？');
  assert.equal(confirmDetails(42).title, '42');
});

// ── 反向钉：原生 confirm 全仓绝迹（按形状扫，168 立法第三次应用）──

test('渲染层不得再出现裸 confirm( 调用（弹层唯一家是 confirmDialog.js）', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.name.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
      src.split('\n').forEach((line, i) => {
        // 前置字符不为字母/$/_/. —— askConfirm(、deadConfirmText( 等派生名不误伤
        if (/(^|[^A-Za-z0-9_.$])confirm\s*\(/.test(line)) {          offenders.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 80)}`);
        }
      });
    }
  };
  walk(R('js'));
  assert.deepEqual(offenders, [], '仍有原生 confirm 调用:\n' + offenders.join('\n'));
});

// ── 接线钉：15 个调用点全部改走 askConfirm ──────────────────

const ASK_SITES = [
  ['app.js', 1],
  ['lyricEditor.js', 1],
  ['views/ai-music.js', 1],
  ['views/download.js', 1],
  ['views/dragdrop.js', 1],
  ['views/history.js', 3],
  ['views/local-stats.js', 1],
  ['views/playlist.js', 4],
  ['views/settings.js', 2],
];

test('15 处不可逆操作全部接线 askConfirm，且调用处必带 await（不 await 的确认框等于没有确认）', async () => {
  let total = 0;
  for (const [f, n] of ASK_SITES) {
    const src = read('js', ...f.split('/'));
    const calls = src.match(/await\s+askConfirm\(/g) || [];
    assert.equal(calls.length, n, `${f} 应有 ${n} 处 await askConfirm(`);
    assert.ok(src.includes("import { askConfirm } from './confirmDialog.js';")
      || src.includes("import { askConfirm } from '../confirmDialog.js';"),
    `${f} 需 import askConfirm`);
    total += calls.length;
  }
  assert.equal(total, 15, '调用点总数必须等于 15——多了少了都要先改这张表再改代码');
});

// ── 弹层自身的纪律 ────────────────────────────────────────

test('confirmDialog 弹层体纪律：文案全部 textContent 上屏（点名的歌单/文件名可能含尖括号），危险按钮走 token 不裸色', async () => {
  const src = read('js', 'confirmDialog.js');
  // 弹层展示用户数据（歌单名/文件名），禁止把入参拼进 innerHTML
  const innerHtmlLines = src.split('\n').filter(l => /innerHTML\s*=/.test(l));
  assert.ok(innerHtmlLines.every(l => !/\$\{[^}]*(title|line|text|okLabel|cancelLabel)/.test(l)),
    'innerHTML 里禁止插用户文案: ' + innerHtmlLines.filter(l => /\$\{[^}]*(title|line|text|okLabel|cancelLabel)/.test(l)).join(' | '));
  assert.ok(/danger/.test(src), '危险级（不可逆）按钮必须有区分');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src.split('\n').filter(l => !/^\s*[//*]/.test(l)).join('\n')),
    '样式全部走 CSS 类/token，JS 里不裸写色值');
});

test('样式落位钉：confirm-dialog 类写进 overlays.css，层级用 --z-overlay token（键盘可达增量立的规矩）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'overlays.css'), 'utf8');
  assert.ok(/\.confirm-dialog-overlay\b/.test(css), 'overlays.css 需有 .confirm-dialog-overlay');
  assert.ok(/\.confirm-dialog\b/.test(css), 'overlays.css 需有 .confirm-dialog');
  assert.ok(/\.confirm-dialog\.danger .*--red/.test(css), '危险按钮必须挂 --red token');
  const overlayRule = css.match(/\.confirm-dialog-overlay\s*{[^}]*}/);
  assert.ok(overlayRule && /var\(--z-overlay\)/.test(overlayRule[0]),
    '弹层层级必须用 var(--z-overlay)，不裸写数字（161 键盘可达的 token 纪律）');
});

test('无障碍钉：确认/取消按钮都可被键盘触发，弹层带 role=dialog 与 aria-modal', () => {
  const src = read('js', 'confirmDialog.js');
  assert.ok(/role.{0,4}dialog/.test(src), '需要 role=dialog');
  assert.ok(/aria-modal/.test(src), '需要 aria-modal');
  assert.ok(/\.focus\(\)/.test(src), '打开时必须把焦点放进弹层（原生窗抢不走键盘，弹层不能）');
  assert.ok(/Escape/.test(src) && /keydown/.test(src), 'Esc 必须等同取消');
});
