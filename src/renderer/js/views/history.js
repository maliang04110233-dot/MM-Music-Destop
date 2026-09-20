/**
 * MusicDL 下载历史页面
 */

const PAGE_SIZE = 50;
import { logger } from '../logger.js';
import { showContextMenu } from '../contextMenu.js';
import { registerFavSong, isFavorite, toggleFavoriteByKey } from '../favorites.js';
import { favKey } from '../state.js';
import { HISTORY_STATUS_TABS, buildHistoryQuery, sourceOptions, classifyRetryResult, retrySummary } from '../historyFilters.js';
let historyPage = 0;
let _historyTotalPages = 1; // 最近一次查询的总页数（翻页钳制用）
let historyFilter = '';
let _historyStatus = '';
let _historySource = '';

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
    const opts = buildHistoryQuery(
      { keyword: historyFilter, status: _historyStatus, source: _historySource },
      historyPage, PAGE_SIZE,
    );
    
    const [result, stats] = await Promise.all([
      api.queryHistory(opts),
      api.getHistoryStats(),
    ]);
    // queryHistory 返回 { items, total }，解包后再渲染
    _historyTotalPages = Math.max(1, Math.ceil(((result && result.total) || 0) / PAGE_SIZE));
    // 筛选变更后当前页可能越界：钳到最后有效页并按新页重查一次
    // （重查后 historyPage < _historyTotalPages，不会递归）
    if (historyPage >= _historyTotalPages) {
      historyPage = _historyTotalPages - 1;
      if (historyPage > 0) { loadHistory(); return; }
      if (historyPage < 0) historyPage = 0;
    }
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
    const filtered = !!(historyFilter || _historyStatus || _historySource);
    _historyDom.list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">${filtered ? '🔍' : '📜'}</div>
      <div class="empty-text">${filtered ? '没有符合筛选条件的历史记录' : '暂无下载历史'}</div>
      <div class="empty-hint">${filtered ? '换个关键词，或把状态/来源切回「全部」' : '下载完成的音乐会在这里显示'}</div>
    </div>`;
    return;
  }

  _historyDom.list.innerHTML = _historyItems.map((s, idx) => `
    <div class="history-row ${s.status === 'error' ? 'history-row-error' : ''}" data-hidx="${idx}">
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

async function exportHistoryM3u() {
  const done = _historyItems.filter(s => s.status === 'done' && s.savePath);
  if (!done.length) {
    showToast('本页没有可导出的已完成下载', 'warn');
    return;
  }
  try {
    const result = await api.exportPlaylist({
      songs: done.map(s => ({
        title: s.title,
        artist: s.artist,
        filePath: s.savePath,
        // 主进程写 EXTINF 前 ÷1000，历史里 duration 是秒 → 必须乘回毫秒
        duration: (s.duration || 0) * 1000,
      })),
      format: 'm3u',
      name: 'MusicDL History',
    });
    if (result.canceled) return;
    if (result.error) {
      showToast('导出失败: ' + result.error, 'error');
      return;
    }
    const pageNote = _historyItems.length >= PAGE_SIZE ? '（仅当前页）' : '';
    showToast(`✅ 已导出 ${done.length} 首歌曲${pageNote}`, 'success');
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
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

// 一键重试全部失败项：无视当前状态页签（恒查 error），但尊重关键词/来源筛选；
// 逐条串行 addToQueue（下载引擎自带去重），计数在 historyFilters.classifyRetryResult
let _retryAllBusy = false;
async function retryFailedFromHistory() {
  if (_retryAllBusy) return;
  _retryAllBusy = true;
  const btn = document.getElementById('historyRetryBtn');
  if (btn) btn.disabled = true;
  try {
    const q = buildHistoryQuery({ keyword: historyFilter, status: 'error', source: _historySource }, 0, 200);
    const { items } = await api.queryHistory(q);
    const list = (items || []).filter(s => s && s.id != null);
    if (!list.length) { showToast('没有符合条件的失败记录', 'warn'); return; }
    const saveDir = getState('saveDir');
    const tally = { added: 0, dup: 0, had: 0, fail: 0 };
    for (const s of list) {
      try {
        const r = await api.addToQueue({
          id: s.id, source: s.source, title: s.title, artist: s.artist,
          album: s.album || '', saveDir, quality: s.quality || 'standard',
          cover: '', duration: 0,
        });
        tally[classifyRetryResult(r)] += 1;
      } catch (_e) {
        tally.fail += 1;
      }
    }
    showToast(retrySummary(tally), tally.added ? 'success' : 'warn', 5000);
    if (tally.added && typeof switchDlSubTab === 'function') switchDlSubTab('queue');
  } catch (e) {
    logger.warn('[history] 批量重试失败:', e.message);
    showToast('批量重试失败：' + e.message, 'error');
  } finally {
    _retryAllBusy = false;
    if (btn) btn.disabled = false;
  }
}

function filterHistory() {
  const input = document.getElementById('historyFilter');
  historyFilter = input?.value?.trim() || '';
  historyPage = 0;
  loadHistory();
}

// 状态/来源筛选变更：回第 0 页重查（组合逻辑在 historyFilters.buildHistoryQuery）
function setHistoryStatusFilter(v) {
  _historyStatus = String(v || '');
  const tabsEl = document.getElementById('historyStatusTabs');
  if (tabsEl) {
    for (const b of tabsEl.querySelectorAll('button')) {
      b.classList.toggle('active', (b.dataset.hst || '') === _historyStatus);
    }
  }
  historyPage = 0;
  loadHistory();
}

function setHistorySourceFilter(v) {
  _historySource = String(v || '');
  historyPage = 0;
  loadHistory();
}

function _initHistoryFilterBar() {
  const tabsEl = document.getElementById('historyStatusTabs');
  if (tabsEl && !tabsEl.childElementCount) {
    tabsEl.innerHTML = HISTORY_STATUS_TABS.map(t =>
      `<button class="filter-tab ${t.v === '' ? 'active' : ''}" data-hst="${esc(t.v)}" onclick="setHistoryStatusFilter('${esc(t.v)}')">${esc(t.label)}</button>`,
    ).join('');
  }
  const sel = document.getElementById('historySourceSel');
  if (sel && !sel.childElementCount) {
    const platforms = typeof getPlatforms === 'function' ? getPlatforms() : [];
    sel.innerHTML = sourceOptions(platforms).map(o =>
      `<option value="${esc(o.v)}">${esc(o.label)}</option>`,
    ).join('');
    sel.addEventListener('change', (e) => setHistorySourceFilter(e.target.value));
  }
}
_initHistoryFilterBar();

function historyPrevPage() {
  if (historyPage > 0) { historyPage--; loadHistory(); }
}

function historyNextPage() {
  // 受已知总页数钳制：翻到最后一页后再点不越界（否则可无限翻到空页）
  const lastPage = Math.max(0, (_historyTotalPages || 1) - 1);
  if (historyPage >= lastPage) return;
  historyPage = Math.min(historyPage + 1, lastPage);
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

// ── 行右键菜单 ────────────────────────────────────────
// 历史记录字段是下载任务子集，拼个歌曲形对象供收藏/加歌单复用
function _historySongLike(s) {
  return {
    id: s.id, source: s.source, title: s.title, artist: s.artist,
    album: s.album || '', cover: s.cover || '', duration: s.duration || 0,
  };
}

// 删除单条记录：只清历史行，磁盘文件与「已下载」徽标（assets 索引按文件存在性自愈）不受影响
async function deleteHistoryItem(idx) {
  const s = _historyItems[idx];
  if (!s || s.id == null) { showToast('无法删除：记录缺少标识', 'warn'); return; }
  try {
    const r = await api.removeHistory([{ id: s.id, source: s.source }]);
    if (!r || typeof r.removed !== 'number') { showToast('删除失败', 'error'); return; }
    // 删的是本页最后一条时回退一页，避免停在空页
    if (_historyItems.length <= 1 && historyPage > 0) historyPage--;
    loadHistory();
    showToast('记录已删除（不影响已下载的文件）', 'success');
  } catch (e) {
    logger.warn('[history] 删除失败:', e.message);
    showToast('删除失败：' + e.message, 'error');
  }
}

function historyRowContext(e) {
  const row = e.target && e.target.closest ? e.target.closest('.history-row') : null;
  if (!row || !_historyDom.list || !_historyDom.list.contains(row)) return;
  const idx = Number(row.getAttribute('data-hidx'));
  const s = _historyItems[idx];
  if (!s) return;
  e.preventDefault();
  const items = [];
  if (s.status === 'done' && s.savePath) {
    items.push(
      { icon: '▶', label: '本地播放', onClick: () => playHistoryItem(idx) },
      { icon: '📂', label: '打开文件夹', onClick: () => api.openFolder(s.savePath) },
    );
  }
  items.push({
    icon: s.status === 'error' ? '🔄' : '⬇', label: '重新下载',
    onClick: () => retryFromHistory(String(s.id), String(s.source || ''),
      s.title || '', s.artist || '', s.album || '', s.quality || 'standard'),
  });
  if (s.id != null && s.source) {
    const songLike = _historySongLike(s);
    registerFavSong(songLike); // 让「收藏」切换能带回元数据（历史行没有红心按钮可登记）
    const on = isFavorite(songLike);
    items.push(
      { sep: true },
      { icon: on ? '💔' : '♥', label: on ? '取消收藏' : '收藏',
        onClick: () => toggleFavoriteByKey(favKey(s.source, s.id)) },
      { icon: '📋', label: '添加到歌单', onClick: () => {
        if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(songLike);
      } },
    );
  }
  items.push(
    { sep: true },
    { icon: '🗑', label: '删除记录', onClick: () => deleteHistoryItem(idx) },
  );
  showContextMenu(e.clientX, e.clientY, items);
}
document.addEventListener('contextmenu', historyRowContext);

// 导出到全局
// ── ES Module 导出 ──────────────────────────────────────
export {
  loadHistory,
  filterHistory,
  setHistoryStatusFilter,
  setHistorySourceFilter,
  historyPrevPage,
  historyNextPage,
  clearAllHistory,
  retryFromHistory,
  playHistoryItem,
  exportHistoryM3u,
  deleteHistoryItem,
  retryFailedFromHistory,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.loadHistory = loadHistory;
window.filterHistory = filterHistory;
window.setHistoryStatusFilter = setHistoryStatusFilter;
window.setHistorySourceFilter = setHistorySourceFilter;
window.historyPrevPage = historyPrevPage;
window.historyNextPage = historyNextPage;
window.clearAllHistory = clearAllHistory;
window.retryFromHistory = retryFromHistory;
window.playHistoryItem = playHistoryItem;
window.exportHistoryM3u = exportHistoryM3u;
window.retryFailedFromHistory = retryFailedFromHistory;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheHistoryDom();
