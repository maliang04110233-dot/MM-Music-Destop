/**
 * 通用右键上下文菜单（单例浮层）
 *
 * 与页面逻辑解耦：调用方只传 { x, y, items }，菜单项为纯对象
 * { icon?, label, onClick?, sep?, danger? }。文本一律走 textContent，
 * 歌曲标题等用户可控字段不会进 HTML。
 */

let _el = null;

export function closeContextMenu() {
  if (!_el) return;
  _el.remove();
  _el = null;
}

function _bindAutoClose() {
  // 下一轮事件循环再挂 mousedown，避免打开它的那次点击立即把它关掉
  setTimeout(() => {
    if (!_el) return;
    document.addEventListener('mousedown', _onDocDown, true);
  }, 0);
}

function _onDocDown(e) {
  // 只处理「点外部」；菜单项内部点击交给按钮自己的 click 处理
  // （若在 mousedown 就移除元素，click 永远派发不到）
  if (_el && !_el.contains(e.target)) { detach(); closeContextMenu(); }
}

function _onKey(e) {
  if (e.key === 'Escape') { detach(); closeContextMenu(); }
}

function detach() {
  document.removeEventListener('mousedown', _onDocDown, true);
  document.removeEventListener('keydown', _onKey);
}

// 全局兜底：窗口缩放/滚动会让固定坐标失效，直接收起
window.addEventListener('resize', () => { detach(); closeContextMenu(); });
window.addEventListener('scroll', () => { detach(); closeContextMenu(); }, true);

/**
 * @param {number} x clientX
 * @param {number} y clientY
 * @param {Array<{label?:string,icon?:string,onClick?:Function,sep?:boolean,danger?:boolean}>} items
 */
export function showContextMenu(x, y, items) {
  detach();
  closeContextMenu();
  const el = document.createElement('div');
  el.className = 'ctx-menu';
  for (const it of items) {
    if (!it) continue;
    if (it.sep) {
      if (el.childElementCount) {
        const s = document.createElement('div');
        s.className = 'ctx-sep';
        el.appendChild(s);
      }
      continue;
    }
    if (!it.label) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (it.danger ? ' ctx-danger' : '');
    b.textContent = (it.icon ? it.icon + '  ' : '') + it.label;
    b.addEventListener('click', () => {
      detach(); closeContextMenu();
      try { if (it.onClick) it.onClick(); } catch (_e) { /* 单项失败不影响菜单框架 */ }
    });
    el.appendChild(b);
  }
  if (!el.childElementCount) return;
  document.body.appendChild(el);
  _el = el;
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 6)) + 'px';
  el.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 6)) + 'px';
  _bindAutoClose();
  document.addEventListener('keydown', _onKey);
}
