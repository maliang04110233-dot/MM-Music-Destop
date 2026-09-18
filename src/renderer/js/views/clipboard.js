/**
 * 剪贴板识别通知条（「复制即识别」的 UI 端）
 *
 * 主进程 clipboardWatch 命中音乐链接后推 clipboard-link 事件，
 * 这里在顶栏下方弹一条可操作的识别条：
 *   [查看] → 跳到搜索页，把原文喂给既有 handleLinkInput 完整流程
 *            （单曲渲染结果列表 / 歌单、专辑开弹窗，下载走现成链路）
 *   [忽略] → 收起；主进程按文本去重，同一条不会再弹
 *
 * 安全：raw 只作为参数回传给识别流程，绝不 innerHTML；
 * 展示文本仅平台 id / 类型 / 短链域名，一律 esc()。
 */

'use strict';

let _pending = null;

function _bannerEl() {
  let el = document.getElementById('clipBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'clipBanner';
    el.className = 'clip-banner';
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

function _typeLabel(type) {
  return { song: '单曲', playlist: '歌单', album: '专辑' }[type] || '音乐';
}

function showClipboardBanner(payload) {
  if (!payload) return;
  _pending = payload;
  const el = _bannerEl();
  const desc = payload.kind === 'short'
    ? `平台短链（${payload.host}）`
    : `${payload.platform} ${_typeLabel(payload.type)}`;
  el.innerHTML = `<span class="clip-banner-text">🔗 剪贴板里有${esc(desc)}链接</span>`
    + `<button class="btn-sm" onclick="clipboardBannerOpen()">查看</button>`
    + `<button class="btn-sm" onclick="clipboardBannerDismiss()">忽略</button>`;
  el.style.display = 'flex';
}

function hideClipboardBanner() {
  _pending = null;
  const el = document.getElementById('clipBanner');
  if (el) el.style.display = 'none';
}

function clipboardBannerDismiss() {
  hideClipboardBanner();
}

async function clipboardBannerOpen() {
  const p = _pending;
  if (!p) return;
  if (p.kind === 'short') {
    hideClipboardBanner();
    showToast('短链无法本地解析，请在浏览器打开后复制完整链接再粘贴', 'info', 4000);
    return;
  }
  hideClipboardBanner();
  if (typeof focusTab === 'function') focusTab('search', 'searchInput');
  const input = document.getElementById('searchInput');
  if (input && p.raw) input.value = p.raw;
  if (p.raw && typeof handleLinkInput === 'function') await handleLinkInput(p.raw);
}

// 事件接线：与订阅同一模式 —— window.api 在 ESM import 阶段还不存在，
// 必须由 app.js init()（buildApi 之后）调用
let _eventsWired = false;
function wireClipboardEvents() {
  if (_eventsWired) return;
  const a = window.api;
  if (!a || typeof a.onClipboardLink !== 'function') return;
  _eventsWired = true;
  a.onClipboardLink((payload) => { showClipboardBanner(payload); });
}

// ── window 桥接 ───────────────────────────────────────
window.showClipboardBanner = showClipboardBanner;
window.hideClipboardBanner = hideClipboardBanner;
window.clipboardBannerOpen = clipboardBannerOpen;
window.clipboardBannerDismiss = clipboardBannerDismiss;
window.wireClipboardEvents = wireClipboardEvents;
