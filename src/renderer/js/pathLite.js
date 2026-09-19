/**
 * pathLite — 渲染层路径处理最小集
 *
 * 渲染层 nodeIntegration:false 且 vite-plugin-electron-renderer 不会
 * polyfill node 内建模块（实测 `import path from 'node:path'` 进 bundle
 * 变成裸 require("node:path")，contextIsolation 下无 require，模块顶层
 * 直接 ReferenceError 白屏）。本地库批量重命名只需要 extname/dirname/
 * join 三个函数，这里给纯 JS 实现，Windows/POSIX 分隔符都认。
 */

function lastSepIdx(s) {
  return Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
}

export function extname(p) {
  const s = String(p ?? '');
  const base = s.slice(lastSepIdx(s) + 1);
  const dot = base.lastIndexOf('.');
  // ".bashrc" 这类首字符点不算扩展名
  return dot > 0 ? base.slice(dot) : '';
}

export function dirname(p) {
  const s = String(p ?? '');
  const idx = lastSepIdx(s);
  if (idx < 0) return '.';
  if (idx === 0) return s[0];
  // Windows 盘根：'C:\a.mp3' → 'C:\'
  if (idx === 2 && /^[A-Za-z]:$/.test(s.slice(0, 2))) return s.slice(0, 3);
  return s.slice(0, idx);
}

export function basename(p) {
  const s = String(p ?? '');
  return s.slice(lastSepIdx(s) + 1);
}

export function join(dir, name) {
  const d = String(dir ?? '');
  const n = String(name ?? '');
  // name 已是绝对路径/带盘符时直接用（对齐 node:path.join 的绝对段语义）
  if (/^[A-Za-z]:/.test(n) || /^[\\/]/.test(n)) return n;
  if (d === '') return n;
  // 跟随父目录的分隔符风格（Windows 盘符目录无分隔符时用反斜杠）
  const hasSep = /[\\/]$/.test(d);
  const sep = hasSep ? '' : (d.includes('\\') ? '\\' : '/');
  return d + sep + n;
}
