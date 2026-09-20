/**
 * MusicDL Toast 通知系统
 *
 * 多级类型、自动消失。错误码文案不住这里：唯一住处是 diagnose.js 的码表（增量162）
 * 
 * ES Module — export 供其他模块 import，同时保留 window 全局供 HTML onclick
 */

// ── Toast 类型映射 ───────────────────────────────────
const TYPE_CONFIG = {
  info:    { icon: 'ℹ️',  duration: 3000, className: 'toast-info' },
  success: { icon: '✅',  duration: 3000, className: 'toast-success' },
  warn:    { icon: '⚠️',  duration: 4000, className: 'toast-warn' },
  error:   { icon: '❌',  duration: 5000, className: 'toast-error' },
};

/**
 * 显示 Toast 通知
 * @param {string} msg - 消息内容
 * @param {string} [type='info'] - info | success | warn | error
 * @param {number} [duration] - 显示时长 ms（覆盖默认）
 */
function showToast(msg, type = 'info', duration) {
  // 自动翻译（英文模式下）
  if (typeof window.translateMessage === 'function') {
    msg = window.translateMessage(msg);
  }
  const cfg = TYPE_CONFIG[type] || TYPE_CONFIG.info;
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast ${cfg.className}`;
  el.textContent = msg;
  container.appendChild(el);

  const dur = duration !== undefined ? duration : cfg.duration;
  setTimeout(() => {
    el.style.animation = 'toast-out .25s ease forwards';
    setTimeout(() => el.remove(), 250);
  }, dur);
}

/**
 * 显示下载错误（根据 fatal 区分样式）
 */
function showDownloadError(title, error, fatal) {
  const prefix = fatal ? '🔒 无法下载' : '下载失败';
  showToast(`${prefix}：${title} - ${error}`, 'error', 5000);
}

// ── ES Module 导出 ──────────────────────────────────────
export { showToast, showDownloadError };

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.showToast = showToast;
window.showDownloadError = showDownloadError;
