/**
 * MusicDL 下载管理视图
 */

import { logger } from '../logger.js';

// ── DOM 缓存 ──────────────────────────────────────────
const _dlDom = {
  queueList: null,
  queueBadge: null,
  dlSelectionBar: null,
  dlSelectionCount: null,
};

function _cacheDlDom() {
  _dlDom.queueList = document.getElementById('queueList');
  _dlDom.queueBadge = document.getElementById('queueBadge');
  _dlDom.dlSelectionBar = document.getElementById('dlSelectionBar');
  _dlDom.dlSelectionCount = document.getElementById('dlSelectionCount');
}

let _dlFilter = 'all';         // 'all' | 'active' | 'done' | 'error'
let _dlSelectionMode = false;
const _selectedDl = new Set(); // 存 taskId
const _expandedDlDetails = new Set(); // 存已展开详情的 taskId

// ── 筛选 ──────────────────────────────────────────────
function setDownloadFilter(f) {
  _dlFilter = f;
  document.querySelectorAll('#downloadFilterTabs .filter-tab').forEach(btn => {
    btn.classList.toggle('active', btn.textContent.includes(
      f === 'all' ? '全部' : f === 'active' ? '下载中' : f === 'done' ? '已完成' : '失败'
    ));
  });
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
}

// ── 选择模式 ─────────────────────────────────────────
function enterDlSelectionMode() {
  _dlSelectionMode = true;
  _selectedDl.clear();
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function exitDlSelectionMode() {
  _dlSelectionMode = false;
  _selectedDl.clear();
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function toggleDlSelect(taskId) {
  if (_selectedDl.has(taskId)) _selectedDl.delete(taskId);
  else _selectedDl.add(taskId);
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function selectAllDl() {
  const queue = getState('queueSnapshot') || [];
  queue.forEach(s => _selectedDl.add(s.taskId));
  renderQueue(queue);
  updateDlSelectionBar();
}

function deselectAllDl() {
  _selectedDl.clear();
  const queue = getState('queueSnapshot') || [];
  renderQueue(queue);
  updateDlSelectionBar();
}

function updateDlSelectionBar() {
  if (!_dlDom.dlSelectionBar) return;
  const n = _selectedDl.size;
  if (!_dlSelectionMode) { _dlDom.dlSelectionBar.style.display = 'none'; return; }
  if (_dlDom.dlSelectionCount) _dlDom.dlSelectionCount.textContent = n;
  _dlDom.dlSelectionBar.style.display = 'flex';
}

// ── 批量操作 ─────────────────────────────────────────
async function batchRetryDl() {
  const queue = getState('queueSnapshot') || [];
  let ok = 0;
  for (const taskId of _selectedDl) {
    try {
      const s = queue.find(x => x.taskId === taskId);
      if (s && s.status === 'error') {
        const r = await api.retryDownload(taskId);
        if (r && r.ok) ok++;
      }
    } catch (e) {
      logger.warn('[batchRetry] 重试失败:', taskId, e.message);
    }
  }
  showToast(`重试完成：${ok} 项已重新加入队列`, ok > 0 ? 'success' : 'warn', 3000);
  exitDlSelectionMode();
}

async function batchRemoveDl() {
  if (!_selectedDl.size) return;
  let removed = 0;
  for (const taskId of _selectedDl) {
    try {
      const r = await api.removeQueueItem(taskId);
      if (r && (r.removed !== undefined || r.ok !== undefined)) removed++;
    } catch (e) {
      logger.warn('[batchRemove] 删除失败:', taskId, e.message);
    }
  }
  showToast(`已删除 ${removed} 项`, 'success', 2500);
  exitDlSelectionMode();
}

// ── 渲染 ──────────────────────────────────────────────
function renderQueue(queue) {
  if (!_dlDom.queueList || !_dlDom.queueBadge) return;
  const el = _dlDom.queueList;
  const badge = _dlDom.queueBadge;
  const active = queue.filter(s => s.status !== 'done');
  badge.textContent = active.length;
  state.set('queueSnapshot', queue);

  // 按筛选过滤
  let filtered = queue;
  if (_dlFilter === 'active') filtered = queue.filter(s => s.status === 'downloading' || s.status === 'pending');
  else if (_dlFilter === 'done') filtered = queue.filter(s => s.status === 'done');
  else if (_dlFilter === 'error') filtered = queue.filter(s => s.status === 'error');

  if (!filtered.length) {
    const emptyMsg = _dlFilter === 'all' ? '暂无下载任务' : _dlFilter === 'active' ? '暂无正在下载的任务' : _dlFilter === 'done' ? '暂无已完成的任务' : '暂无失败的任务';
    // 全部 tab 空态给引导（去搜索/看历史）；筛选 tab 空态保持一句话
    el.innerHTML = _dlFilter === 'all' && !queue.length
      ? `<div class="queue-empty queue-empty-guide">
          <div class="queue-empty-icon">📥</div>
          <div class="queue-empty-text">${emptyMsg}</div>
          <div class="queue-empty-hint">搜索喜欢的歌，点 ⬇ 加入下载队列</div>
          <div class="queue-empty-actions">
            <button class="setting-btn" onclick="switchTab('search')">🔍 去搜索</button>
            <button class="setting-btn" onclick="switchDlSubTab('history')">📜 下载历史</button>
          </div>
        </div>`
      : `<div class="queue-empty">${emptyMsg}</div>`;
    return;
  }

  // 最新在上
  el.innerHTML = filtered.slice(-50).reverse().map(s => {
    const selected = _selectedDl.has(s.taskId) && _dlSelectionMode;
    const isExpanded = _expandedDlDetails.has(s.taskId);
    // 遮罩下载链接（只显示域名和文件名）
    const maskedUrl = s.downloadUrl ? maskUrl(s.downloadUrl) : '';
    // 格式化文件大小
    const fileSize = s.fileSize ? formatFileSize(s.fileSize) : '';
    // 格式化下载耗时
    const downloadTime = s.downloadTime ? formatDuration(s.downloadTime) : '';
    return `
    <div class="queue-item queue-status-${s.status}${selected && _dlSelectionMode ? ' selected' : ''}">
      ${_dlSelectionMode ? `
      <div class="queue-item-cb" onclick="event.stopPropagation();toggleDlSelect('${escAttr(s.taskId)}')">
        <input type="checkbox" id="dlcb_${escAttr(s.taskId)}" ${selected ? 'checked' : ''} onchange="event.stopPropagation();toggleDlSelect('${escAttr(s.taskId)}')">
      </div>` : ''}
      ${s.cover
        ? `<img class="queue-cover" src="${escAttr(s.cover)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : ''}
      <div class="queue-cover-ph" ${s.cover ? 'style="display:none"' : ''}>🎵</div>
      <div class="queue-info" onclick="event.stopPropagation();toggleQueueDetail('${escAttr(s.taskId)}')" style="cursor:pointer;">
        <div class="queue-title">${esc(s.title || '未知')}</div>
        <div class="queue-status status-${s.status}">${statusLabel(s.status)}${s.error ? ': ' + esc(s.error) : ''}${errorTag(s.errorCode)}</div>
        ${s.status === 'downloading' ? `
        <div class="progress-bar-wrap"><div class="progress-bar" id="prog-${escAttr(s.taskId)}" style="width:${s.progress||0}%"></div></div>` : ''}
      </div>
      <button class="queue-detail-toggle" onclick="event.stopPropagation();toggleQueueDetail('${escAttr(s.taskId)}')" title="${isExpanded ? '收起详情' : '展开详情'}">${isExpanded ? '▾' : '▸'}</button>
      ${(!_dlSelectionMode && s.status === 'pending') ? `<button class="queue-cancel" onclick="event.stopPropagation();api.cancelDownload('${escAttr(s.taskId)}')" title="取消">✕</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'done') ? `<button class="queue-cancel" style="color:var(--neon-green)" title="打开文件夹" onclick="event.stopPropagation();api.openFolder('${escAttr(getState('saveDir') || '')}')">📂</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'done') ? `<button class="queue-cancel" style="color:var(--neon-cyan)" title="转换格式" onclick="event.stopPropagation();showConvertModal('${escAttr(s.savePath || '')}', '${escAttr(s.title || '')}')">🔄</button>` : ''}
      ${(!_dlSelectionMode && s.status === 'error') ? `
        <button class="queue-cancel" style="color:var(--neon-orange)" title="重试下载" onclick="event.stopPropagation();retryQueueItem('${escAttr(s.taskId)}')">🔄</button>
        <button class="queue-cancel" title="移除" onclick="event.stopPropagation();removeQueueItem('${escAttr(s.taskId)}')">✕</button>
      ` : ''}
    </div>
    ${isExpanded ? `
    <div class="queue-detail-panel">
      <div class="queue-detail-grid">
        ${fileSize ? `<div class="queue-detail-row"><span class="queue-detail-label">文件大小</span><span class="queue-detail-value">${fileSize}</span></div>` : ''}
        ${downloadTime ? `<div class="queue-detail-row"><span class="queue-detail-label">下载耗时</span><span class="queue-detail-value">${downloadTime}</span></div>` : ''}
        ${s.retries != null && s.retries > 0 ? `<div class="queue-detail-row"><span class="queue-detail-label">重试次数</span><span class="queue-detail-value">${s.retries}</span></div>` : ''}
        ${s.savePath ? `<div class="queue-detail-row"><span class="queue-detail-label">文件路径</span><span class="queue-detail-value queue-detail-path" title="${escAttr(s.savePath)}">${esc(s.savePath)}</span></div>` : ''}
        ${s.source ? `<div class="queue-detail-row"><span class="queue-detail-label">来源</span><span class="queue-detail-value">${esc(s.source)}${s.quality ? ' · ' + esc(s.quality) : ''}</span></div>` : ''}
        ${maskedUrl ? `<div class="queue-detail-row"><span class="queue-detail-label">下载链接</span><span class="queue-detail-value queue-detail-url" title="${escAttr(s.downloadUrl)}">${esc(maskedUrl)}</span></div>` : ''}
        ${s.error ? `<div class="queue-detail-row queue-detail-error"><span class="queue-detail-label">错误信息</span><span class="queue-detail-value">${esc(s.error)}</span></div>` : ''}
      </div>
    </div>` : ''}`;
  }).join('');
}

// esc() 和 statusLabel() 已由 utils.js 全局导出，此处不再重复定义

// ── 错误分类标签 ───────────────────────────────────────
const ERROR_TAGS = {
  VIP_REQUIRED:      { label: '需VIP', color: 'var(--neon-orange)' },
  AUTH_EXPIRED:      { label: 'Cookie过期', color: 'var(--neon-orange)' },
  LOGIN_REQUIRED:    { label: '需登录', color: 'var(--neon-orange)' },
  COPYRIGHT_RESTRICTED: { label: '版权受限', color: 'var(--neon-purple)' },
  UNAVAILABLE:       { label: '不可用', color: 'var(--neon-purple)' },
  CDN_EMPTY:         { label: 'CDN异常', color: 'var(--neon-red)' },
  NETWORK_TIMEOUT:   { label: '网络超时', color: 'var(--neon-yellow)' },
  NO_AUDIO_STREAM:   { label: '无音频流', color: 'var(--neon-red)' },
  UNKNOWN_PLATFORM:  { label: '未知平台', color: 'var(--text-dim)' },
};

function errorTag(errorCode) {
  const tag = ERROR_TAGS[errorCode];
  if (!tag) return '';
  return `<span style="display:inline-block;font-size:10px;padding:1px 6px;border-radius:4px;background:${tag.color}22;color:${tag.color};border:1px solid ${tag.color}44;margin-left:6px;">${tag.label}</span>`;
}

// ── 单项操作 ─────────────────────────────────────────
async function toggleQueueDetail(taskId) {
  try {
    if (_expandedDlDetails.has(taskId)) {
      _expandedDlDetails.delete(taskId);
    } else {
      _expandedDlDetails.add(taskId);
    }
    const queue = getState('queueSnapshot') || [];
    renderQueue(queue);
  } catch (e) {
    logger.warn(`[toggleQueueDetail] error:`, e);
  }
}

// ── 辅助格式化 ─────────────────────────────────────────
function formatFileSize(bytes) {
  if (bytes == null || bytes === 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
}

function formatDuration(ms) {
  if (ms == null || ms === 0) return '';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  const remain = sec % 60;
  return min + ' 分 ' + (remain > 0 ? remain + ' 秒' : '');
}

function maskUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const host = u.hostname;
    // 提取文件名部分
    const parts = u.pathname.split('/');
    const filename = parts[parts.length - 1];
    if (filename.length > 20) {
      return host + '/…' + filename.slice(-18);
    }
    return host + '/' + filename;
  } catch (_e) {
    // 非法 URL，截断显示
    if (url.length > 40) return url.slice(0, 20) + '…' + url.slice(-16);
    return url;
  }
}

async function retryQueueItem(taskId) {
  try {
    const r = await api.retryDownload(taskId);
    if (r && r.ok) { showToast('已加入重试队列', 'info', 2000); }
    else { showToast('重试失败：' + (r?.error || '未知错误'), 'error', 3000); }
  } catch (e) {
    showToast('重试失败：' + e.message, 'error', 3000);
  }
}

// ── 重试所有失败任务 ─────────────────────────────────
async function retryAllFailed() {
  const queue = getState('queueSnapshot') || [];
  const failed = queue.filter(s => s.status === 'error');
  if (!failed.length) { showToast('没有失败的任务', 'info', 1500); return; }

  // 按错误类型分类统计
  const errors = {};
  failed.forEach(s => {
    const code = s.errorCode || 'UNKNOWN';
    errors[code] = (errors[code] || 0) + 1;
  });
  const summary = Object.entries(errors).map(([k, v]) => `${k}:${v}`).join(' ');
  showToast(`正在重试 ${failed.length} 个失败任务 (${summary})...`, 'info', 2000);

  let ok = 0;
  for (const s of failed) {
    try {
      // VIP_REQUIRED / AUTH_EXPIRED / LOGIN_REQUIRED 等致命错误不自动重试
      if (s.errorCode && /^(VIP_REQUIRED|AUTH_EXPIRED|LOGIN_REQUIRED)$/.test(s.errorCode)) {
        continue;
      }
      const r = await api.retryDownload(s.taskId);
      if (r && r.ok) ok++;
    } catch (_e) { /* 单个失败不影响整体 */ }
  }

  const skipped = failed.length - ok;
  if (ok > 0) {
    showToast(`已重试 ${ok} 项${skipped > 0 ? `，跳过 ${skipped} 项（需登录/VIP）` : ''}`, 'success', 3000);
  } else {
    showToast('所有失败任务均需手动处理（VIP/登录限制）', 'warn', 3000);
  }
}

async function removeQueueItem(taskId) {
  try {
    await api.removeQueueItem(taskId);
  } catch (e) {
    showToast('删除失败：' + e.message, 'error', 3000);
  }
}

async function clearFinishedDownloads() {
  try {
    const r = await api.clearFinishedQueue();
    showToast(`已清空 ${r.removed} 个已完成任务`, 'success');
  } catch (e) {
    showToast('清空失败：' + e.message, 'error', 3000);
  }
}

async function clearAllDownloads() {
  if (!confirm('确认清空所有下载任务？正在进行的下载也会被取消。')) return;
  try {
    const r = await api.clearAllQueue();
    showToast(`已清空 ${r.removed} 个任务`, 'success');
  } catch (e) {
    showToast('清空失败：' + e.message, 'error', 3000);
  }
}

function openSaveDir() {
  const saveDir = getState('saveDir');
  if (saveDir) api.openFolder(saveDir);
  else showToast('尚未设置保存目录', 'warn');
}

async function exportCurrentPlaylist() {
  const queue = getState('queueSnapshot') || [];
  if (!queue.length) {
    showToast('当前没有下载任务', 'warn');
    return;
  }

  // 只导出已完成的歌曲
  const completedSongs = queue.filter(s => s.status === 'done' && s.filePath);
  if (!completedSongs.length) {
    showToast('没有已完成的歌曲可导出', 'warn');
    return;
  }

  try {
    const result = await api.exportPlaylist({
      songs: completedSongs.map(s => ({
        title: s.title,
        artist: s.artist,
        filePath: s.filePath,
        duration: s.duration || 0,
      })),
      format: 'm3u',
      name: 'MusicDL Playlist',
    });

    if (result.canceled) return;
    if (result.error) {
      showToast('导出失败: ' + result.error, 'error');
      return;
    }

    showToast(`✅ 已导出 ${completedSongs.length} 首歌曲`, 'success');
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

// ── 导出 ──────────────────────────────────────────────
// ── ES Module 导出 ──────────────────────────────────────
export {
  renderQueue,
  setDownloadFilter,
  toggleQueueDetail,
  enterDlSelectionMode,
  exitDlSelectionMode,
  toggleDlSelect,
  selectAllDl,
  deselectAllDl,
  batchRetryDl,
  batchRemoveDl,
  retryQueueItem,
  removeQueueItem,
  clearFinishedDownloads,
  clearAllDownloads,
  openSaveDir,
  exportCurrentPlaylist,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.renderQueue = renderQueue;
window.setDownloadFilter = setDownloadFilter;
window.toggleQueueDetail = toggleQueueDetail;
window.enterDlSelectionMode = enterDlSelectionMode;
window.exitDlSelectionMode = exitDlSelectionMode;
window.toggleDlSelect = toggleDlSelect;
window.selectAllDl = selectAllDl;
window.deselectAllDl = deselectAllDl;
// 音频格式转换入口已收敛到 ../converter-core.js
// （showConvertModal / closeConvertModal / doConvertAudio 由该模块挂到 window）


window.batchRetryDl = batchRetryDl;
window.batchRemoveDl = batchRemoveDl;
window.retryQueueItem = retryQueueItem;
window.retryAllFailed = retryAllFailed;
window.removeQueueItem = removeQueueItem;
window.clearFinishedDownloads = clearFinishedDownloads;
window.clearAllDownloads = clearAllDownloads;
window.openSaveDir = openSaveDir;
window.exportCurrentPlaylist = exportCurrentPlaylist;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheDlDom();
