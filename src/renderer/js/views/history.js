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

let _historyItems = []; // 当前页数据缓存：▶ 按钮按行号回查记录对象

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
  _historyItems = items || [];
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

  _historyDom.list.innerHTML = _historyItems.map((s, idx) => `
    <div class="history-row ${s.status === 'error' ? 'history-row-error' : ''}">
      <div class="history-icon">${s.status === 'done' ? '✅' : '❌'}</div>
      <div class="history-info">
        <div class="history-title">${esc(s.title)}</div>
        <div class="history-meta">${esc(s.artist)}${s.album ? ' · ' + esc(s.album) : ''}</div>
      </div>
      <span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>
      <span class="history-quality">${esc(s.quality || 'standard')}</span>
      <span class="history-size">${formatBytes(s.size)}</span>
      <span class="history-time">${fmtDate(s.finishedAt)}</span>
      <div class="history-actions">
        ${s.status === 'done' && s.savePath
          ? `<button class="action-btn" title="本地播放（下载完直接听）" onclick="playHistoryItem(${idx})">▶</button>`
          : ''}
        ${s.status === 'done' && s.savePath
          ? `<button class="action-btn" title="打开文件夹" onclick="api.openFolder('${escQ(s.savePath)}')">📂</button>`
          : ''}
        ${s.status === 'error'
          ? `<button class="action-btn" title="重新下载" onclick="retryFromHistory('${escQ(s.id)}', '${escQ(s.source)}', '${escQ(s.title)}', '${escQ(s.artist)}', '${escQ(s.album || '')}', '${escQ(s.quality || 'standard')}')">🔄</button>`
          : ''}
      </div>
    </div>
  `).join('');
}

async function retryFromHistory(id, source, title, artist, album, quality) {
  const saveDir = getState('saveDir');
  try {
    // 历史页的重试按钮只出现在 error 记录上，但同曲可能在其他源下过：
    // 仍查一次历史去重，命中弹「仍要下载」；forceRedownload 时跳过确认
    const r = await api.addToQueue({
      id, source, title, artist, album: album || '',
      saveDir, quality: quality || 'standard',
      cover: '', duration: 0,
    });
    if (r && r.duplicated) {
      showToast(`「${title}」已在下载队列中`, 'warn', 2500);
    } else if (r && r.alreadyDownloaded) {
      showRedownloadToast(title, r.finishedAt, () => {
        api.addToQueue({
          id, source, title, artist, album: album || '',
          saveDir, quality: quality || 'standard',
          cover: '', duration: 0, forceRedownload: true,
        }).then(() => showToast(`「${title}」已重新加入下载队列`, 'success'))
          .catch(e => showToast('重试失败: ' + e.message, 'error'));
      });
    } else {
      showToast(`「${title}」已重新加入下载队列`, 'success');
    }
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

// ▶ 本地播放：复用 download.js 桥接的 playDownloadedFile（两视图同属下载合并页，必同加载）
async function playHistoryItem(idx) {
  const s = _historyItems[idx];
  if (!s || !s.savePath) { showToast('未找到文件路径', 'error'); return; }
  if (typeof window.playDownloadedFile !== 'function') { showToast('播放模块未加载，请刷新重试', 'error'); return; }
  await window.playDownloadedFile(s);
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
  playHistoryItem,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.loadHistory = loadHistory;
window.filterHistory = filterHistory;
window.historyPrevPage = historyPrevPage;
window.historyNextPage = historyNextPage;
window.clearAllHistory = clearAllHistory;
window.retryFromHistory = retryFromHistory;
window.playHistoryItem = playHistoryItem;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheHistoryDom();
