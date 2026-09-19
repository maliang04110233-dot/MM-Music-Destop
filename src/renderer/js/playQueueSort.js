/**
 * 播放队列拖拽排序
 *
 * applyPqDragMove 为纯函数（node 直测）：落在目标行 = 该位置，
 * 并同步换算 playIdx，保证拖拽后「正在播放」高亮跟到正确行。
 * DOM 接线全部走 document 事件委托，仅在浏览器环境挂载。
 */

import { logger } from './logger.js';

/**
 * @param {Array} queue 当前播放队列
 * @param {number} playIdx 当前播放下标
 * @param {number} from 拖走的行
 * @param {number} to 落到的行
 * @returns {{queue: Array, playIdx: number}|null} null=无效拖拽
 */
function applyPqDragMove(queue, playIdx, from, to) {
  if (!Array.isArray(queue) || queue.length < 2) return null;
  if (from < 0 || from >= queue.length || to < 0 || to >= queue.length || from === to) return null;
  const next = queue.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  let idx = playIdx;
  if (typeof idx === 'number' && idx >= 0) {
    if (from === idx) idx = to;                       // 拖动的是当前播放行本身
    else if (from < idx && idx <= to) idx--;          // 前面的行被挪到它后面
    else if (to <= idx && idx < from) idx++;          // 后面（或它本身位置）的行被挪到前面
  }
  return { queue: next, playIdx: idx };
}

// ── DOM 接线（事件委托，队列重渲染不需要重新绑定）────────
let _wired = false;
let _dragFrom = -1;

function _rowIdxOf(e) {
  const row = e.target && e.target.closest ? e.target.closest('.pq-item[data-pqidx]') : null;
  if (!row) return -1;
  const n = Number(row.getAttribute('data-pqidx'));
  return Number.isFinite(n) ? n : -1;
}

function _clearMarks() {
  document.querySelectorAll('.pq-dragging, .pq-drag-over')
    .forEach((el) => el.classList.remove('pq-dragging', 'pq-drag-over'));
}

function initPqDragSort() {
  if (_wired || typeof document === 'undefined') return;
  _wired = true;

  document.addEventListener('dragstart', (e) => {
    const idx = _rowIdxOf(e);
    if (idx < 0) return;
    _dragFrom = idx;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx)); // Firefox：不设数据不给拖
    const row = document.querySelector(`.pq-item[data-pqidx="${idx}"]`);
    if (row) row.classList.add('pq-dragging');
  });

  document.addEventListener('dragover', (e) => {
    if (_dragFrom < 0) return;
    const idx = _rowIdxOf(e);
    if (idx < 0 || idx === _dragFrom) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.pq-item.pq-drag-over')
      .forEach((el) => el.classList.remove('pq-drag-over'));
    const row = document.querySelector(`.pq-item[data-pqidx="${idx}"]`);
    if (row) row.classList.add('pq-drag-over');
  });

  document.addEventListener('drop', (e) => {
    if (_dragFrom < 0) return;
    const to = _rowIdxOf(e);
    const from = _dragFrom;
    _dragFrom = -1;
    _clearMarks();
    if (to < 0 || to === from) return;
    e.preventDefault();
    try {
      const r = applyPqDragMove(getState('playQueue') || [], getState('playIdx') ?? 0, from, to);
      if (!r) return;
      setState('playQueue', r.queue); // 订阅链路负责重渲染 + 持久化 + 徽标
      setState('playIdx', r.playIdx);
    } catch (err) {
      logger.warn('[pqSort] 拖拽排序失败:', err && err.message);
    }
  });

  document.addEventListener('dragend', () => {
    _dragFrom = -1;
    _clearMarks();
  });
}

if (typeof document !== 'undefined') initPqDragSort();

window.initPqDragSort = initPqDragSort;

export { applyPqDragMove, initPqDragSort };
