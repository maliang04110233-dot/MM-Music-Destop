// 一次性审计脚本：主进程 IPC 注册 vs preload 白名单交叉比对
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const mainFiles = walk(path.join(__dirname, '..', 'src', 'main'));
const rendererFiles = walk(path.join(__dirname, '..', 'src', 'renderer'));

// ── 提取主进程注册 ──
const handles = new Set(), ons = new Set(), sends = new Set();
const reHandle = /ipcMain\.handle(?:Once)?\(\s*['"]([^'"]+)['"]/g;
const reOn = /ipcMain\.on(?:Once)?\(\s*['"]([^'"]+)['"]/g;
const reSend = /webContents\.send\(\s*['\"]([^'\"]+)['\"]|\bsafeSend\(\s*['\"]([^'\"]+)['\"]/g;
for (const f of mainFiles.filter(f => !f.includes('preload'))) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(reHandle)) handles.add(m[1]);
  for (const m of src.matchAll(reOn)) ons.add(m[1]);
  for (const m of src.matchAll(reSend)) sends.add(m[1] || m[2]);
}

// ── 提取 preload 白名单 ──
const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.js'), 'utf8');
function extractSet(name) {
  const m = preloadSrc.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
  if (!m) throw new Error(`找不到 ${name}`);
  return new Set([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]));
}
const WL_SEND = extractSet('SAFE_CHANNELS_SEND');
const WL_RECV = extractSet('SAFE_CHANNELS_RECEIVE');
const WL_INVOKE = extractSet('SAFE_CHANNELS_INVOKE');

const mMapSrc = preloadSrc.match(/const METHOD_MAP = \{([\s\S]*?)\n\};/)[1];
const METHOD_MAP = Object.fromEntries([...mMapSrc.matchAll(/(\w+):\s*'([^']+)'/g)].map(m => [m[1], m[2]]));

console.log('=== 主进程注册统计 ===');
console.log(`ipcMain.handle: ${handles.size} 个 | ipcMain.on: ${ons.size} 个 | webContents.send: ${sends.size} 个`);
console.log('on 通道:', [...ons].sort().join(', '));
console.log('send 到渲染层:', [...sends].sort().join(', '));

let bugs = 0;
const bug = (msg) => { console.log('  ❌ ' + msg); bugs++; };
const ok = (msg) => console.log('  ✅ ' + msg);

console.log('\n=== 检查 1：INVOKE 白名单通道是否都有 ipcMain.handle ===');
for (const ch of [...WL_INVOKE].sort()) {
  if (!handles.has(ch)) {
    if (ons.has(ch)) bug(`'${ch}' 在 INVOKE 白名单，但主进程只有 ipcMain.on（invoke 会 "No handler registered"）`);
    else bug(`'${ch}' 在 INVOKE 白名单，但主进程完全没注册`);
  }
}
ok(`其余 ${[...WL_INVOKE].filter(c => handles.has(c)).length} 个 INVOKE 通道均有 handle`);

console.log('\n=== 检查 2：SEND 白名单通道是否都有 ipcMain.on ===');
for (const ch of [...WL_SEND].sort()) {
  if (!ons.has(ch)) bug(`'${ch}' 在 SEND 白名单，但主进程没有 ipcMain.on`);
}
ok(`SEND 白名单 ${[...WL_SEND].filter(c => ons.has(c)).length}/${WL_SEND.size} 有 on 接收器`);

console.log('\n=== 检查 3：RECEIVE 白名单通道主进程是否真的会 send ===');
for (const ch of [...WL_RECV].sort()) {
  if (!sends.has(ch)) bug(`'${ch}' 在 RECEIVE 白名单，但主进程从不 webContents.send 它`);
}
ok(`RECEIVE ${[...WL_RECV].filter(c => sends.has(c)).length}/${WL_RECV.size} 有发送方`);

console.log('\n=== 检查 4：主进程 send 到渲染层的通道是否都在 RECEIVE 白名单 ===');
for (const ch of [...sends].sort()) {
  if (!WL_RECV.has(ch)) bug(`主进程 send '${ch}'，但不在 RECEIVE 白名单（preload on 会静默丢弃）`);
}
ok(`反向 ${[...sends].filter(c => WL_RECV.has(c)).length}/${sends.size} 全部在白名单`);

console.log('\n=== 检查 5：METHOD_MAP 通道归类 ===');
for (const [name, ch] of Object.entries(METHOD_MAP)) {
  const inI = WL_INVOKE.has(ch), inS = WL_SEND.has(ch);
  if (inI && inS) bug(`${name}→'${ch}' 同时在 INVOKE 和 SEND 两个白名单（makeApiMethod 会优先 invoke）`);
  else if (!inI && !inS) bug(`${name}→'${ch}' 不在任何白名单（invoke 未授权）`);
}
ok(`METHOD_MAP ${Object.keys(METHOD_MAP).length} 项归类无冲突`);

console.log('\n=== 检查 6：渲染层 musicAPI 方法调用是否都有定义 ===');
// 方法来源有两处：METHOD_MAP 生成的 + _musicApiBase 显式定义的（on* 事件方法等）
const apiMethods = new Set(Object.keys(METHOD_MAP));
for (const m of preloadSrc.matchAll(/^  on(\w+)\(/gm)) apiMethods.add(m[1]);
for (const m of preloadSrc.matchAll(/^  (\w+)\(/gm)) apiMethods.add(m[1]);
const reCall = /\b(?:window\.)?(?:musicAPI|api)\.(\w+)\s*\(/g;
const reEvt = /\b(?:window\.)?(?:musicAPI|api)\.on(\w+)\s*\(/g;
const missings = new Set();
for (const f of rendererFiles) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(reCall)) {
    if (!apiMethods.has(m[1]) && !['invoke', 'on', 'version'].includes(m[1])) missings.add(m[1]);
  }
  for (const m of src.matchAll(reEvt)) {
    if (!apiMethods.has('on' + m[1])) missings.add('on' + m[1]);
  }
}
if (missings.size) { for (const x of [...missings].sort()) bug(`渲染层调用了 musicAPI.${x}()，但 preload 未暴露`); }
else ok('渲染层所有 musicAPI 调用均有暴露');

console.log('\n=== 检查 7：渲染层直接用 window.ipcRenderer 兼容桥的通道 ===');
const reCompat = /\bipcRenderer\.(invoke|send|on)\(\s*['"]([^'"]+)['"]/g;
for (const f of rendererFiles) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(reCompat)) {
    const [, kind, ch] = m;
    const wl = kind === 'invoke' ? WL_INVOKE : kind === 'send' ? WL_SEND : WL_RECV;
    if (!wl.has(ch)) bug(`${path.relative(process.cwd(), f)}: ipcRenderer.${kind}('${ch}') 不在 ${kind === 'on' ? 'RECEIVE' : kind.toUpperCase()} 白名单`);
  }
}

console.log(`\n━━━ 审计结果：${bugs === 0 ? '✅ 全部通过' : `❌ ${bugs} 个问题`} ━━━`);
process.exit(0);
