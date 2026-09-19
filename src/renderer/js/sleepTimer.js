/**
 * 睡眠定时器 —— N 分钟后自动暂停播放
 *
 * 核心是 createSleepTimer 纯工厂（定时器/时钟全部可注入，node 可单测）；
 * UI 侧把播放器「更多」菜单项接上预设档位弹层：
 *   到点只「暂停」不「停止」——复用 togglePlay 的暂停路径，
 *   播放进度与收听统计照常落盘，醒来点继续还能接着听。
 */

import { showContextMenu } from './contextMenu.js';
import { logger } from './logger.js';

const PRESETS = [15, 30, 45, 60, 90];

/**
 * @param {Object} deps
 * @param {Function} deps.setTimeoutFn
 * @param {Function} deps.clearTimeoutFn
 * @param {() => number} deps.nowFn
 * @param {() => void} deps.onFire 到点回调
 */
function createSleepTimer({ setTimeoutFn, clearTimeoutFn, nowFn = Date.now, onFire }) {
  let _token = null;
  let _endsAt = 0;

  function cancel() {
    if (_token !== null) { clearTimeoutFn(_token); _token = null; }
    _endsAt = 0;
  }

  function arm(minutes) {
    cancel();
    if (!(minutes > 0)) return;
    _endsAt = nowFn() + minutes * 60000;
    _token = setTimeoutFn(() => {
      _token = null;
      _endsAt = 0;
      try { if (onFire) onFire(); } catch (e) { logger.warn('[sleepTimer] onFire 失败:', e && e.message); }
    }, minutes * 60000);
  }

  function active() { return _token !== null; }

  /** 剩余分钟数（向上取整，至少 1；未武装为 0） */
  function remainingMin() {
    if (_token === null) return 0;
    return Math.max(1, Math.ceil((_endsAt - nowFn()) / 60000));
  }

  return { arm, cancel, active, remainingMin };
}

// ── UI 单例 ──────────────────────────────────────────
let _st = null;
let _armedPreset = 0; // 仅用于菜单里给当前档位打 ✓（剩余分钟随时间漂移，档位不变）

function _timer() {
  if (!_st) _st = createSleepTimer({ setTimeoutFn: setTimeout, clearTimeoutFn: clearTimeout, onFire: _fire });
  return _st;
}

function _renderVal() {
  const el = document.getElementById('btnSleepTimerVal');
  const t = _st;
  if (el) el.textContent = (t && t.active()) ? `${t.remainingMin()}分` : '';
}

function _fire() {
  _armedPreset = 0;
  try {
    const audioEl = document.getElementById('audioPlayer');
    // 只暂停正在播放的；已暂停则不动（togglePlay 是开关语义）
    if (audioEl && !audioEl.paused && typeof window.togglePlay === 'function') window.togglePlay();
    showToast('⏾ 睡眠定时到点，已暂停播放', 'info', 3500);
  } catch (e) {
    logger.warn('[sleepTimer] 触发失败:', e && e.message);
  }
  _renderVal();
}

function _arm(minutes) {
  const t = _timer();
  t.arm(minutes);
  _armedPreset = minutes;
  showToast(`⏾ 将在 ${minutes} 分钟后自动暂停播放`, 'info', 2500);
  _renderVal();
}

function openSleepTimerMenu() {
  try { if (typeof window.closePlayerMore === 'function') window.closePlayerMore(); } catch (_e) { /* 收起失败不挡菜单 */ }
  const t = _timer();
  const items = PRESETS.map(m => ({
    icon: m === _armedPreset && t.active() ? '✓' : '⏾',
    label: `${m} 分钟`,
    onClick: () => _arm(m),
  }));
  items.push({ sep: true });
  items.push({
    icon: '✕',
    label: t.active() ? `取消定时（剩 ${t.remainingMin()} 分）` : '不定时',
    danger: t.active(),
    onClick: () => {
      if (!t.active()) return;
      t.cancel();
      _armedPreset = 0;
      showToast('已取消睡眠定时', 'info', 2000);
      _renderVal();
    },
  });
  const btn = document.getElementById('btnSleepTimer');
  let x = 200, y = 200;
  if (btn) {
    const r = btn.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4;
  }
  showContextMenu(x, y, items);
}

// ── window 桥接 ───────────────────────────────────────
window.openSleepTimerMenu = openSleepTimerMenu;

export { createSleepTimer, openSleepTimerMenu, PRESETS };
