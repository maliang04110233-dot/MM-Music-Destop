/**
 * 拖拽音乐链接进窗口 → 即识别（「复制即识别」的鼠标版）
 *
 * 从浏览器/IM 里选中分享链接拖到本窗口任意位置，出现投放提示层，
 * 松手后把文本喂给搜索页既有 doSearch —— 链接走 handleLinkInput
 * 完整识别（单曲渲染/歌单专辑弹窗），普通文本走关键词搜索；
 * 文件拖入不接管（本应用不做本地文件导入）。
 *
 * 全局 dragover/drop 一律 preventDefault：顺带堵住 Electron
 * 默认「拖文件进窗口直接导航」的坑。
 */

'use strict';

import { pickDroppedText } from '../dragText.js';

let _depth = 0; // dragenter/dragleave 计数：子元素间穿梭不误隐藏

function _hasDragText(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  if (!types) return false;
  const arr = Array.from(types);
  return !arr.includes('Files') && (arr.includes('text/plain') || arr.includes('text') || arr.includes('URL'));
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

function _show() { _overlayEl().style.display = 'flex'; }
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
  if (!_hasDragText(e)) return;
  _depth++;
  _show();
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
  if (!text) return;
  if (typeof focusTab === 'function') focusTab('search', 'searchInput');
  const input = document.getElementById('searchInput');
  if (!input) return;
  input.value = text;
  if (typeof doSearch === 'function') doSearch();
});
