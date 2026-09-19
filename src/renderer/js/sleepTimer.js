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
const MAX_SLEEP_MIN = 1440; // 自定义上限：一天

/**
 * 自定义分钟解析（增量111）：只收 1..1440 的整数字符串，其余一律 null。
 * @returns {number|null}
 */
function parseSleepMinutes(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = +s;
  return (n >= 1 && n <= MAX_SLEEP_MIN) ? n : null;
}

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
  items.push({ icon: '⌛', label: '自定义分钟…', onClick: () => openSleepCustomDialog() });
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

function _closeCustomDialog() {
  const el = document.getElementById('sleepCustomOverlay');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

/** 自定义分钟弹层（增量111）：edit-overlay 模式，Enter 即确认，复用 _arm 落档 */
function openSleepCustomDialog() {
  try { if (typeof window.closePlayerMore === 'function') window.closePlayerMore(); } catch (_e) { /* 收起失败不挡弹层 */ }
  _closeCustomDialog();
  const overlay = document.createElement('div');
  overlay.id = 'sleepCustomOverlay';
  overlay.className = 'edit-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closeCustomDialog(); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  title.textContent = '⏾ 自定义睡眠定时';
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', () => _closeCustomDialog());
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;opacity:.6;margin-bottom:8px;';
  hint.textContent = `到点自动暂停播放（1–${MAX_SLEEP_MIN} 分钟，回车即确认）`;
  const input = document.createElement('input');
  input.id = 'sleepCustomInput';
  input.type = 'number';
  input.min = '1';
  input.max = String(MAX_SLEEP_MIN);
  input.placeholder = '如 120';
  input.style.cssText = 'width:100%;padding:8px 10px;box-sizing:border-box;';
  const ok = document.createElement('button');
  ok.className = 'edit-save';
  ok.textContent = '开始定时';
  ok.style.cssText = 'margin-top:10px;';
  function submit() {
    const m = parseSleepMinutes(input.value);
    if (m === null) { showToast(`请输入 1–${MAX_SLEEP_MIN} 之间的整数分钟`, 'warn', 2500); return; }
    _closeCustomDialog();
    _arm(m);
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  ok.addEventListener('click', submit);
  body.appendChild(hint);
  body.appendChild(input);
  body.appendChild(ok);

  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  input.focus();
}

// ── window 桥接 ───────────────────────────────────────
window.openSleepTimerMenu = openSleepTimerMenu;
window.openSleepCustomDialog = openSleepCustomDialog;

export { createSleepTimer, openSleepTimerMenu, openSleepCustomDialog, parseSleepMinutes, PRESETS, MAX_SLEEP_MIN };
