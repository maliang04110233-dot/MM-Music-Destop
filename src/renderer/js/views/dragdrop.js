/**
 * 拖拽音乐链接进窗口 → 即识别（「复制即识别」的鼠标版）
 *
 * 从浏览器/IM 里选中分享链接拖到本窗口任意位置，出现投放提示层，
 * 松手后把文本喂给搜索页既有 doSearch —— 链接走 handleLinkInput
 * 完整识别（单曲渲染/歌单专辑弹窗），普通文本走关键词搜索；
 * 例外：拖入 .lrc（或内容像歌词的 .txt）且当前播的是本地歌曲时，
 * 写 sidecar 歌词（write-local-lrc）并即时生效——下载党批量补歌词的快捷通道。
 *
 * 全局 dragover/drop 一律 preventDefault：顺带堵住 Electron
 * 默认「拖文件进窗口直接导航」的坑。
 */

'use strict';

import { pickDroppedText, isLrcFilename, looksLikeLrc, MAX_LRC_BYTES } from '../dragText.js';

let _depth = 0; // dragenter/dragleave 计数：子元素间穿梭不误隐藏

function _hasDragText(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  const arr = Array.from(types);
  return !arr.includes('Files') && (arr.includes('text/plain') || arr.includes('text') || arr.includes('URL'));
}

/** 拖拽悬停时试探是否歌词文件（Chromium 在 dragenter 允许 items 取文件名） */
function _dragLrcHint(e) {
  try {
    const dt = e.dataTransfer;
    if (!dt || !Array.from(dt.types || []).includes('Files')) return false;
    const items = dt.items || [];
    for (const it of items) {
      if (it && it.kind === 'file') {
        const f = it.getAsFile();
        if (f && isLrcFilename(f.name)) return true;
      }
    }
  } catch (_e) { /* 试探失败按普通拖拽处理 */ }
  return false;
}

function _overlayEl() {
  let el = document.getElementById('dropZone');
  if (!el) {
    el = document.createElement('div');
    el.id = 'dropZone';
    el.className = 'drop-zone';
    el.style.display = 'none';
    el.innerHTML = '<div class="drop-zone-inner">🔗 松手即识别音乐链接</div>';
    document.body.appendChild(el);
  }
  return el;
}

function _show(lrcMode) {
  const el = _overlayEl();
  const inner = el.querySelector('.drop-zone-inner');
  if (inner) inner.textContent = lrcMode ? '🎼 松手导入歌词到当前本地歌曲' : '🔗 松手即识别音乐链接';
  el.style.display = 'flex';
}
function _hide() {
  const el = document.getElementById('dropZone');
  if (el) el.style.display = 'none';
}

document.addEventListener('dragover', (e) => {
  e.preventDefault(); // 所有拖放都拦下：禁止默认导航；文本拖放额外标记可 drop
  if (_hasDragText(e) && e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragenter', (e) => {
  e.preventDefault();
  if (!_hasDragText(e) && !_dragLrcHint(e)) return;
  _depth++;
  _show(_dragLrcHint(e));
});

document.addEventListener('dragleave', (e) => {
  e.preventDefault();
  if (_depth > 0) {
    _depth--;
    if (_depth === 0) _hide();
  }
});

document.addEventListener('drop', async (e) => {
  e.preventDefault();
  _depth = 0;
  _hide();
  const text = pickDroppedText(e.dataTransfer);
  if (text) {
    if (typeof focusTab === 'function') focusTab('search', 'searchInput');
    const input = document.getElementById('searchInput');
    if (!input) return;
    input.value = text;
    if (typeof doSearch === 'function') doSearch();
    return;
  }
  await _handleLrcDrop(e.dataTransfer);
});

async function _handleLrcDrop(dt) {
  const files = dt && dt.files;
  if (!files || !files.length) return;
  const f = files[0];
  if (!f || !isLrcFilename(f.name)) return; // 非歌词候选：维持原「文件不接管」语义
  if (f.size > MAX_LRC_BYTES) { showToast(`歌词文件过大（${Math.round(f.size / 1024)} KB）`, 'warn'); return; }
  let lrc;
  try { lrc = await f.text(); } catch (e2) { showToast('读取歌词文件失败：' + e2.message, 'error'); return; }
  if (!lrc || !lrc.trim()) { showToast('歌词文件是空的', 'warn'); return; }
  // .txt 名称无信息量，必须内容像 LRC（≥3 行时间戳）才敢覆盖 sidecar
  if (/\.txt$/i.test(f.name) && !looksLikeLrc(lrc)) { showToast(`「${f.name}」看起来不是歌词文本`, 'warn'); return; }
  const songPath = getState('_currentLocalFilePath');
  if (!songPath) { showToast('当前播放的不是本地歌曲，无法写入歌词', 'warn'); return; }
  if (!confirm(`把「${f.name}」写入当前歌曲旁的 .lrc？（覆盖同名旧歌词文件）`)) return;
  try {
    const r = await api.writeLocalLrc(songPath, lrc);
    if (!r || !r.success) { showToast('写入失败：' + ((r && r.error) || '未知错误'), 'error'); return; }
    if (typeof window.parseLrc === 'function') window.parseLrc(lrc);
    showToast('🎼 歌词已写入并生效', 'success');
  } catch (e2) {
    showToast('写入失败：' + e2.message, 'error');
  }
}
