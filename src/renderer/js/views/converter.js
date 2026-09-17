/**
 * MusicDL 音频格式转换页面 - 搜索本地歌曲 + 一键批量转换
 *
 * 弹窗 / 格式常量 / 批量 runner 都在 ../converter-core.js，本文件只负责
 * 页面自己的搜索、选择、队列状态和进度展示。
 */

import { logger } from '../logger.js';
import {
  CONVERT_FORMATS, CONVERT_BITRATES, DEFAULT_FORMAT, DEFAULT_BITRATE,
  OUTPUT_DIR_PREF, isLossless, debounce,
  initConvertOutputDir, pickConvertOutputDir,
  runConvertBatch, cancelConvert,
} from '../converter-core.js';

// ── 状态 ────────────────────────────────────────────────
let _convQueue = [];
let _convInit = false;
let _convLocalSongs = [];  // 本地歌曲缓存
let _convOutputDir = null; // 输出目录
const _convSelected = new Set();   // 选中歌曲的 filePath（旧版直接改 song._selected，
let _convRunning = false;          // 会污染 state.localSongs 里被多个视图共享的对象）

// 转换页早期的 EQ 预设/批量重命名预览块已删除：相关容器
// converterEqControls/converterRenamePattern 从未加入 index.html，
// EQ 活实现在 player.js + 设置页 eqPanel

// ── 初始化 ──────────────────────────────────────────────
function initConverter() {
  if (_convInit) return;
  _convInit = true;

  initConvertOutputDir().then(dir => {
    _convOutputDir = dir;
    updateOutputDirDisplay();
  });

  loadLocalSongsForConvert();

  const searchInput = document.getElementById('converterSearch');
  if (searchInput) searchInput.addEventListener('input', debounce(filterConverterSongs, 300));

  const selectAll = document.getElementById('converterSelectAll');
  if (selectAll) selectAll.addEventListener('change', toggleSelectAll);

  // 格式/比特率下拉：按共享常量生成，保证与弹窗一致
  _convPopulateOptions('converterBatchFormat', CONVERT_FORMATS);
  _convPopulateOptions('converterBatchBitrate', CONVERT_BITRATES);
  const batchFormat = document.getElementById('converterBatchFormat');
  if (batchFormat) batchFormat.value = DEFAULT_FORMAT;
  const batchBitrate = document.getElementById('converterBatchBitrate');
  if (batchBitrate) batchBitrate.value = DEFAULT_BITRATE;

  // 进度事件：主进程按 inputPath 上报 0-100%
  if (typeof api.onConvertAudioProgress === 'function') {
    api.onConvertAudioProgress(({ path, pct }) => _onConvertProgress(path, pct));
  }

  // 暴露全局方法
  window._converterAddQueue = addSelectedToQueue;
  window._converterStart = startConvert;
  window._converterCancel = cancelConvertPage;
  window._converterApplyBatch = applyBatchFormat;
  window._converterScan = scanLocalForConvert;
  window._converterSearch = () => filterConverterSongs();
  window._converterSelectOutputDir = selectOutputDir;
  // 队列行的 ✕ 按钮（renderQueue 模板 onclick）走全局名，需挂 window
  window._converterRemoveFromQueue = removeFromQueue;

  renderConverterSongs();
}

function _convPopulateOptions(selectId, options) {
  const el = document.getElementById(selectId);
  if (!el) return;
  const cur = el.value;
  el.innerHTML = options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
  el.value = cur;
}

// ── 选择输出目录 ────────────────────────────────────────
async function selectOutputDir() {
  if (await pickConvertOutputDir()) updateOutputDirDisplay();
}

function updateOutputDirDisplay() {
  const el = document.getElementById('converterOutputDir');
  if (el) {
    el.textContent = _convOutputDir ? `输出: ${_convOutputDir}` : '未设置输出目录';
    el.title = _convOutputDir || '';
  }
}

// ── 扫描本地文件夹 ──────────────────────────────────────
async function scanLocalForConvert() {
  const dir = await api.selectDir();
  if (!dir) return;

  setState('localDirPath', dir);
  await api.setPref('localDirPath', dir);

  const info = document.getElementById('converterInfo');
  if (info) info.textContent = '正在扫描...';

  const result = await api.scanLocalLibrary(dir);
  if (result.error) {
    showConverterEmpty('扫描失败: ' + result.error);
    return;
  }

  const localSongs = result.songs || [];
  setState('localSongs', localSongs);
  _convLocalSongs = localSongs;
  _convSelected.clear();

  if (info) info.textContent = `共 ${localSongs.length} 首歌曲`;
  showToast(`扫描完成，发现 ${localSongs.length} 首歌曲`, 'success');
  renderConverterSongs();
}

// ── 加载本地歌曲 ────────────────────────────────────────
async function loadLocalSongsForConvert() {
  let localSongs = getState('localSongs');
  if (localSongs && localSongs.length > 0) {
    _convLocalSongs = localSongs;
    renderConverterSongs();
    return;
  }

  let localDirPath = getState('localDirPath');
  if (!localDirPath) {
    const saved = await api.getPref('localDirPath');
    if (saved) localDirPath = saved;
  }

  // 扫描目录（即使没有 localDirPath，mock 也会返回数据）
  const result = await api.scanLocalLibrary(localDirPath || null);
  if (result.error) {
    logger.warn('[converter] 扫描失败:', result.error);
    showConverterEmpty('扫描失败: ' + result.error);
    return;
  }
  localSongs = result.songs || [];
  setState('localSongs', localSongs);
  _convLocalSongs = localSongs;
  renderConverterSongs();
}

// ── 过滤歌曲 ────────────────────────────────────────────
function filterConverterSongs() {
  const kw = (document.getElementById('converterSearch')?.value || '').trim().toLowerCase();
  if (!kw) {
    setState('convFiltered', [..._convLocalSongs]);
  } else {
    setState('convFiltered', _convLocalSongs.filter(s =>
      (s.title || '').toLowerCase().includes(kw) ||
      (s.artist || '').toLowerCase().includes(kw) ||
      (s.album || '').toLowerCase().includes(kw)
    ));
  }
  renderConverterSongs();
}

// ── 渲染歌曲列表 ────────────────────────────────────────
function renderConverterSongs() {
  const container = document.getElementById('converterSongList');
  const info = document.getElementById('converterInfo');
  const filtered = getState('convFiltered') || _convLocalSongs;

  if (!_convLocalSongs.length) {
    showConverterEmpty('暂无本地歌曲，请先扫描本地音乐文件夹');
    return;
  }

  if (info) {
    info.textContent = `共 ${filtered.length} 首歌曲` +
      (_convQueue.length ? `，已选择 ${_convQueue.length} 首待转换` : '');
  }

  if (container) {
    container.innerHTML = filtered.map(song => {
      const fp = song.filePath;
      const inQueue = _convQueue.some(q => q.path === fp);
      return `
        <div class="converter-song-item ${inQueue ? 'in-queue' : ''}">
          <input type="checkbox" class="converter-song-check" ${_convSelected.has(fp) ? 'checked' : ''}
                 onchange="_convSongToggle('${escAttr(fp)}')">
          <div class="converter-song-info">
            <div class="converter-song-title">${esc(song.title || '未知标题')}</div>
            <div class="converter-song-sub">${esc(song.artist || '未知艺术家')} · ${esc(song.album || '未知专辑')} · ${(song.ext || '').toUpperCase()}</div>
          </div>
          <div class="converter-song-actions">
            ${inQueue
              ? `<button class="btn-sm converter-btn-disabled" disabled>已添加</button>`
              : `<button class="btn-sm converter-btn-add" onclick="_convSongAdd('${escAttr(fp)}')">+ 添加</button>`
            }
          </div>
        </div>
      `;
    }).join('');
  }

  updateSelectAllState();
}

// ── 单个歌曲选择（按路径，不按列表索引）──────────────────
function _convSongToggle(filePath) {
  if (_convSelected.has(filePath)) _convSelected.delete(filePath);
  else _convSelected.add(filePath);
}

// ── 添加到队列 ──────────────────────────────────────────
function _convQueueAdd(song) {
  if (_convQueue.some(q => q.path === song.filePath)) {
    showToast('这首歌曲已在转换队列中', 'warn');
    return false;
  }

  // 扫描器给的 ext 可能带点号（.mp3），统一成不带点的格式名
  const ext = (song.ext || song.filePath.split('.').pop() || 'mp3')
    .replace(/^\./, '').toLowerCase() || 'mp3';
  _convQueue.push({
    id: _convNextId(),
    name: song.title || song.filePath,
    path: song.filePath,
    size: song.size || 0,
    ext,
    // 无损输入默认压成 mp3，有损输入默认升成 flac
    format: ['flac', 'wav'].includes(ext) ? 'mp3' : 'flac',
    bitrate: DEFAULT_BITRATE,
    status: 'pending',
    selected: true,
    pct: 0,
    error: '',
  });
  return true;
}

let _convIdSeq = 0;
function _convNextId() { return ++_convIdSeq; }

function _convSongAdd(filePath) {
  const song = (_convLocalSongs || []).find(s => s.filePath === filePath);
  if (!song) return;
  if (_convQueueAdd(song)) {
    showToast(`已添加: ${song.title || '未知'}`, 'success');
    renderConverterSongs();
    renderQueue();
  }
}

// ── 批量添加选中 ────────────────────────────────────────
function addSelectedToQueue() {
  if (!_convSelected.size) {
    showToast('请先选择要转换的歌曲', 'warn');
    return;
  }

  let added = 0;
  for (const song of _convLocalSongs) {
    if (_convSelected.has(song.filePath) && _convQueueAdd(song)) added++;
  }

  showToast(`已添加 ${added} 首歌曲到转换队列`, added > 0 ? 'success' : 'warn');
  _convSelected.clear();
  renderConverterSongs();
  renderQueue();
}

// ── 全选/取消全选 ───────────────────────────────────────
function toggleSelectAll() {
  const checked = document.getElementById('converterSelectAll')?.checked;
  const filtered = getState('convFiltered') || _convLocalSongs;
  if (checked) filtered.forEach(s => _convSelected.add(s.filePath));
  else filtered.forEach(s => _convSelected.delete(s.filePath));
  renderConverterSongs();
}

function updateSelectAllState() {
  const filtered = getState('convFiltered') || _convLocalSongs;
  const selectAll = document.getElementById('converterSelectAll');
  if (selectAll) {
    const allSelected = filtered.length > 0 && filtered.every(s => _convSelected.has(s.filePath));
    const someSelected = filtered.some(s => _convSelected.has(s.filePath));
    selectAll.checked = allSelected;
    selectAll.indeterminate = someSelected && !allSelected;
  }
}

// ── 渲染转换队列 ────────────────────────────────────────
function renderQueue() {
  const container = document.getElementById('converterQueue');
  const actions = document.getElementById('converterActions');
  if (!container) return;

  if (!_convQueue.length) {
    container.innerHTML = `
      <div class="conv-queue-empty">
        <div class="conv-queue-empty-icon">📋</div>
        <div>转换队列为空</div>
        <div class="conv-queue-empty-hint">从上方列表添加歌曲</div>
      </div>`;
    if (actions) actions.style.display = 'none';
    return;
  }

  if (actions) actions.style.display = 'flex';

  const formatOpts = CONVERT_FORMATS.map(f =>
    `<option value="${f.value}"${f.value === DEFAULT_FORMAT ? ' selected' : ''}>${f.label}</option>`).join('');

  container.innerHTML = `
    <div class="conv-queue-list">
      ${_convQueue.map((item, idx) => {
        // 只有正在转的不能动：已完成/失败的行允许移除和改格式
        const busy = item.status === 'converting';
        return `
        <div class="conv-queue-item conv-status-${item.status}">
          <input type="checkbox" class="conv-queue-check" ${item.selected ? 'checked' : ''}
                 ${busy ? 'disabled' : ''} onchange="_convQueue[${idx}].selected=this.checked">
          <div class="conv-queue-info">
            <div class="conv-queue-name">${esc(item.name)}</div>
            <div class="conv-queue-meta">
              ${item.ext.toUpperCase()} → ${item.format.toUpperCase()}${isLossless(item.format) ? '' : ' ' + item.bitrate}
              ${item.status === 'done' ? ' ✅' : ''}
              ${item.status === 'error' ? ' ❌' : ''}
              ${item.status === 'converting' ? ` 🔄 ${item.pct | 0}%` : ''}
            </div>
            ${item.status === 'converting' ? `<div class="conv-progress"><div class="conv-progress-bar" style="width:${item.pct | 0}%;"></div></div>` : ''}
            ${item.status === 'error' ? `<div class="conv-error">${esc(item.error || '转换失败')}</div>` : ''}
          </div>
          <select class="conv-queue-format" onchange="_convQueue[${idx}].format=this.value" ${busy ? 'disabled' : ''}>
            ${formatOpts}
          </select>
          <button class="conv-queue-remove" onclick="_converterRemoveFromQueue(${idx})" ${busy ? 'disabled' : ''} title="移除">✕</button>
        </div>`;
      }).join('')}
    </div>`;
}

// ── 从队列移除 ──────────────────────────────────────────
function removeFromQueue(idx) {
  _convQueue.splice(idx, 1);
  renderQueue();
  renderConverterSongs();
}

// ── 清空已完成 ──────────────────────────────────────────
function clearDone() {
  _convQueue = _convQueue.filter(q => q.status !== 'done');
  renderQueue();
}

// ── 应用批量设置 ────────────────────────────────────────
function applyBatchFormat() {
  const batchFormat = document.getElementById('converterBatchFormat')?.value || DEFAULT_FORMAT;
  const batchBitrate = document.getElementById('converterBatchBitrate')?.value || DEFAULT_BITRATE;
  _convQueue.forEach(q => {
    if (q.status === 'pending') {
      q.format = batchFormat;
      q.bitrate = batchBitrate;
    }
  });
  renderQueue();
  showToast(`已应用: ${batchFormat.toUpperCase()}${isLossless(batchFormat) ? '' : ' / ' + batchBitrate}`, 'info');
}

// ── 进度事件 ────────────────────────────────────────────
function _onConvertProgress(filePath, pct) {
  const item = _convQueue.find(q => q.path === filePath);
  if (!item || item.status !== 'converting') return;
  item.pct = pct;
  const bar = document.querySelector(`#converterQueue .conv-status-converting .conv-progress-bar`);
  // 逐条串行，一次只有一个在转——直接改 DOM 避免整表重绘
  if (bar) bar.style.width = `${pct | 0}%`;
}

// ── 开始转换 ────────────────────────────────────────────
async function startConvert() {
  if (_convRunning) return;
  const pending = _convQueue.filter(q => q.status === 'pending' && q.selected);
  if (!pending.length) {
    showToast('请先添加要转换的歌曲', 'warn');
    return;
  }
  if (!_convOutputDir) {
    showToast('请先设置输出目录', 'warn');
    return;
  }

  _convRunning = true;
  _setRunningUI(true);

  const byPath = new Map(pending.map(q => [q.path, q]));
  const { ok, fail, canceled } = await runConvertBatch({
    items: pending,
    outputDir: _convOutputDir,
    onItem: (item, phase, _pct, msg) => {
      const q = byPath.get(item.path);
      if (!q) return;
      if (phase === 'start') {
        q.status = 'converting';
        q.pct = 0;
        q.error = '';
        renderQueue();
      } else if (phase === 'done') {
        q.status = 'done';
        q.pct = 100;
        renderQueue();
      } else {
        q.status = 'error';
        q.pct = 0;
        q.error = msg || '转换失败';
        renderQueue();
      }
    },
  });

  _convRunning = false;
  _setRunningUI(false);

  if (ok > 0 || fail > 0 || canceled > 0) {
    showToast(
      `转码结束：✅ ${ok} 成功${fail > 0 ? ` ❌ ${fail} 失败` : ''}${canceled > 0 ? ' ⏹ 已取消' : ''}`,
      ok > 0 ? 'success' : 'warn',
      4000,
    );
  }
}

function cancelConvertPage() {
  _convRunning = false;
  _setRunningUI(false);
  cancelConvert();
  // 把还挂在 converting 上的行标成取消
  _convQueue.forEach(q => {
    if (q.status === 'converting') {
      q.status = 'error';
      q.error = '已取消';
      q.pct = 0;
    }
  });
  renderQueue();
  showToast('正在取消转码…', 'info', 2000);
}

function _setRunningUI(running) {
  const startBtn = document.getElementById('converterStartBtn');
  const cancelBtn = document.getElementById('converterCancelBtn');
  if (startBtn) {
    startBtn.textContent = running ? '转换中...' : '开始转换';
    startBtn.disabled = running;
  }
  if (cancelBtn) cancelBtn.hidden = !running;
}

// ── 显示空状态 ──────────────────────────────────────────
function showConverterEmpty(msg) {
  const container = document.getElementById('converterSongList');
  const info = document.getElementById('converterInfo');
  if (info) info.textContent = msg || '暂无数据';
  if (container) {
    container.innerHTML = `
      <div class="empty-state" style="flex:1;padding:40px;">
        <div class="empty-icon">📂</div>
        <div class="empty-text">${esc(msg || '暂无歌曲')}</div>
      </div>`;
  }
}

// ── 暴露 init ───────────────────────────────────────────
export { initConverter, OUTPUT_DIR_PREF };

// ── 全局桥接 ────────────────────────────────────────────
Object.assign(window, {
  initConverter,
  _convSongToggle,
  _convSongAdd,
  clearDone,
});
