/**
 * MusicDL 下载历史页面
 */

const PAGE_SIZE = 50;
import { logger } from '../logger.js';
let historyPage = 0;
let historyFilter = '';

// ── DOM 缓存 ──────────────────────────────────────────
const _historyDom = {
  list: null,
  info: null,
};

function _cacheHistoryDom() {
  _historyDom.list = document.getElementById('historyList');
  _historyDom.info = document.getElementById('historyInfo');
}

async function loadHistory() {
  try {
    const opts = { limit: PAGE_SIZE, offset: historyPage * PAGE_SIZE };
    if (historyFilter) opts.keyword = historyFilter;
    
    const [result, stats] = await Promise.all([
      api.queryHistory(opts),
      api.getHistoryStats(),
    ]);
    // queryHistory 返回 { items, total }，解包后再渲染
    renderHistory((result && result.items) || [], stats);
  } catch (e) {
    logger.warn('加载历史失败:', e);
    if (_historyDom.list) {
      _historyDom.list.innerHTML = '<div class="empty-state">加载失败: ' + esc(e.message) + '</div>';
    }
  }
}

function renderHistory(items, stats) {
  if (_historyDom.info && stats) {
    _historyDom.info.textContent = `总计 ${stats.total} 首 · 成功 ${stats.done || 0} · 失败 ${stats.error || 0}`;
  }

  if (!_historyDom.list) return;

  if (!items || !items.length) {
    _historyDom.list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📜</div>
      <div class="empty-text">暂无下载历史</div>
      <div class="empty-hint">下载完成的音乐会在这里显示</div>
    </div>`;
    return;
  }

  _historyDom.list.innerHTML = items.map(s => `
    <div class="history-row ${s.status === 'error' ? 'history-row-error' : ''}">
      <div class="history-icon">${s.status === 'done' ? '✅' : '❌'}</div>
      <div class="history-info">
        <div class="history-title">${esc(s.title)}</div>
        <div class="history-meta">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}</div>
      </div>
      <span class="source-badge badge-${s.source}">${srcLabel(s.source)}</span>
      <span class="history-quality">${s.quality || 'standard'}</span>
      <span class="history-size">${formatBytes(s.size)}</span>
      <span class="history-time">${fmtDate(s.finishedAt)}</span>
      <div class="history-actions">
        ${s.status === 'done' && s.savePath
          ? `<button class="action-btn" title="打开文件夹" onclick="api.openFolder('${escAttr(s.savePath)}')">📂</button>`
          : ''}
        ${s.status === 'error'
          ? `<button class="action-btn" title="重新下载" onclick="retryFromHistory('${escAttr(s.id)}', '${escAttr(s.source)}', '${escAttr(s.title)}', '${escAttr(s.artist)}', '${escAttr(s.album || '')}', '${escAttr(s.quality || 'standard')}')">🔄</button>`
          : ''}
      </div>
    </div>
  `).join('');
}

async function retryFromHistory(id, source, title, artist, album, quality) {
  const saveDir = getState('saveDir');
  try {
    await api.addToQueue({
      id, source, title, artist, album: album || '',
      saveDir, quality: quality || 'standard',
      cover: '', duration: 0,
    });
    showToast(`「${title}」已重新加入下载队列`, 'success');
    // 已在合并页内：直接切到队列子 tab（不再跨页跳转）
    if (typeof switchDlSubTab === 'function') switchDlSubTab('queue');
    else {
      const dlNav = document.querySelector('.nav-item[data-tab="download"]');
      if (dlNav) switchTab('download', dlNav);
    }
  } catch (e) {
    showToast('重试失败: ' + e.message, 'error');
  }
}

function filterHistory() {
  const input = document.getElementById('historyFilter');
  historyFilter = input?.value?.trim() || '';
  historyPage = 0;
  loadHistory();
}

function historyPrevPage() {
  if (historyPage > 0) { historyPage--; loadHistory(); }
}

function historyNextPage() {
  historyPage++;
  loadHistory();
}

async function clearAllHistory() {
  if (!confirm('确认清空所有下载历史？')) return;
  try {
    await api.clearHistory();
  } catch (e) {
    showToast('清空失败：' + e.message, 'error');
    return;
  }
  historyPage = 0;
  loadHistory();
  showToast('下载历史已清空', 'info');
}

function fmtDate(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (_e) { return ''; }
}

// 导出到全局
// ── ES Module 导出 ──────────────────────────────────────
export {
  loadHistory,
  filterHistory,
  historyPrevPage,
  historyNextPage,
  clearAllHistory,
  retryFromHistory,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.loadHistory = loadHistory;
window.filterHistory = filterHistory;
window.historyPrevPage = historyPrevPage;
window.historyNextPage = historyNextPage;
window.clearAllHistory = clearAllHistory;
window.retryFromHistory = retryFromHistory;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheHistoryDom();
