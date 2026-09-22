'use strict';

// 任务栏下载进度 + 托盘提示。
// 数据源：context.safeSend 在 queue-updated / download-progress 时调用 refresh()。
// 本模块不 require electron —— 窗口/托盘 getter 由 index.js 注入，纯计算部分可单测。

let _getWindows = () => [];
let _getTray = () => null;
let _lastRatio = null;   // 上一次设置的进度值（去抖）
let _lastTip = null;     // 上一次托盘文案

/** 队列 → 统计（纯函数） */
function computeQueueStats(list) {
  const arr = Array.isArray(list) ? list : [];
  let pending = 0, downloading = 0, done = 0, error = 0, sum = 0;
  for (const s of arr) {
    if (!s) continue;
    if (s.status === 'pending') pending++;
    else if (s.status === 'downloading') {
      downloading++;
      const p = typeof s.progress === 'number' ? s.progress : 0;
      sum += Math.min(1, Math.max(0, p / 100));
    }
    else if (s.status === 'done') done++;
    else if (s.status === 'error') error++;
  }
  const denom = pending + downloading + done;
  const active = pending + downloading;
  let ratio;
  if (denom === 0 || active === 0) ratio = -1; // -1 = 清除任务栏进度
  else ratio = (done + sum) / denom;
  let tooltip = '揽乐';
  if (active > 0) {
    tooltip = `揽乐 — 下载中 ${downloading} · 排队 ${pending} · 已完成 ${done}`;
    if (error > 0) tooltip += ` · 失败 ${error}`;
  }
  return { pending, downloading, done, error, ratio, tooltip };
}

function init(opts) {
  _getWindows = opts.getWindows || (() => []);
  _getTray = opts.getTray || (() => null);
  _lastRatio = null;
  _lastTip = null;
}

/** 依据当前队列刷新任务栏与托盘（幂等、去抖、永不抛错） */
function apply(list) {
  let s;
  try { s = computeQueueStats(list); } catch (_e) { return; }
  // 进度取整到 1% 去抖；清除（-1）不受去抖限制
  const rounded = s.ratio < 0 ? s.ratio : Math.round(s.ratio * 100) / 100;
  if (rounded !== _lastRatio) {
    _lastRatio = rounded;
    for (const w of _getWindows()) {
      try {
        if (w && !w.isDestroyed()) w.setProgressBar(rounded);
      } catch (_e) { /* 窗口可能已销毁 */ }
    }
  }
  if (s.tooltip !== _lastTip) {
    _lastTip = s.tooltip;
    try {
      const tray = _getTray();
      if (tray) tray.setToolTip(s.tooltip);
    } catch (_e) { /* 托盘可能已销毁 */ }
  }
}

function refresh(getQueue) {
  try { apply(getQueue()); } catch (_e) { /* 永不影响发送路径 */ }
}

/** 测试用：重置去抖状态 */
function _reset() { _lastRatio = null; _lastTip = null; }

module.exports = { init, apply, refresh, computeQueueStats, _reset };
