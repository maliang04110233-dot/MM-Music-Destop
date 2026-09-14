/**
 * MusicDL 音频格式转换页面 - 搜索本地歌曲 + 一键转换
 */

import { logger } from '../logger.js';

// 转换队列
let _convQueue = [];
let _convInit = false;
let _convLocalSongs = [];  // 本地歌曲缓存
let _convOutputDir = null; // 输出目录

// （转换页早期的 EQ 预设/批量重命名预览块已删除：相关容器
// converterEqControls/converterRenamePattern 从未加入 index.html，
// EQ 活实现在 player.js + 设置页 eqPanel）

// ── 初始化 ────────────────────────────────────────────
function initConverter() {
  if (_convInit) return;
  _convInit = true;

  // 加载输出目录
  (async () => {
    const saved = await api.getPref('convertOutputDir');
    if (saved) {
      _convOutputDir = saved;
      updateOutputDirDisplay();
    }
  })();

  // 加载本地歌曲
  loadLocalSongsForConvert();

  // 搜索输入事件
  const searchInput = document.getElementById('converterSearch');
  const _debouncedFilter = debounce(filterConverterSongs, 300);
  if (searchInput) {
    searchInput.addEventListener('input', _debouncedFilter);
  }

  // 全选事件
  const selectAll = document.getElementById('converterSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', toggleSelectAll);
  }

  // 暴露全局方法
  window._converterAddQueue = addSelectedToQueue;
  window._converterStart = startConvert;
  window._converterApplyBatch = applyBatchFormat;
  window._converterSelectSong = toggleSongSelect;
  window._converterScan = scanLocalForConvert;
  window._converterSearch = () => filterConverterSongs();
  window._converterSelectOutputDir = selectOutputDir;
  // 队列行的 ✕ 按钮（renderQueue 模板 onclick）走全局名，需挂 window
  window._converterRemoveFromQueue = removeFromQueue;

  renderConverterSongs();
}

// ── 选择输出目录 ──────────────────────────────────────
async function selectOutputDir() {
  const dir = await api.selectDir();
  if (!dir) return;
  _convOutputDir = dir;
  await api.setPref('convertOutputDir', dir);
  updateOutputDirDisplay();
  showToast(`输出目录已设置: ${dir}`, 'success');
}

function updateOutputDirDisplay() {
  const el = document.getElementById('converterOutputDir');
  if (el) {
    el.textContent = _convOutputDir ? `输出: ${_convOutputDir}` : '未设置输出目录';
  }
}

// ── 扫描本地文件夹 ────────────────────────────────────
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

  if (info) info.textContent = `共 ${localSongs.length} 首歌曲`;
  showToast(`扫描完成，发现 ${localSongs.length} 首歌曲`, 'success');
  renderConverterSongs();
}

// ── 加载本地歌曲 ──────────────────────────────────────
async function loadLocalSongsForConvert() {
  // 先检查 state 中是否已有歌曲
  let localSongs = getState('localSongs');
  if (localSongs && localSongs.length > 0) {
    _convLocalSongs = localSongs;
    renderConverterSongs();
    return;
  }

  // 尝试获取保存的本地目录
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

// ── 过滤歌曲 ──────────────────────────────────────────
function filterConverterSongs() {
  const kw = document.getElementById('converterSearch')?.value.trim().toLowerCase() || '';
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

// ── 渲染歌曲列表 ──────────────────────────────────────
function renderConverterSongs() {
  const container = document.getElementById('converterSongList');
  const info = document.getElementById('converterInfo');
  const filtered = getState('convFiltered') || _convLocalSongs;

  if (!_convLocalSongs.length) {
    showConverterEmpty('暂无本地歌曲，请先扫描本地音乐文件夹');
    return;
  }

  if (info) {
    const selected = _convQueue.length;
    info.textContent = `共 ${filtered.length} 首歌曲${selected ? `，已选择 ${selected} 首待转换` : ''}`;
  }

  if (container) {
    container.innerHTML = filtered.map((song, idx) => {
      const inQueue = _convQueue.some(q => q.path === song.filePath);
      return `
        <div class="converter-song-item ${inQueue ? 'in-queue' : ''}" data-idx="${idx}">
          <input type="checkbox" ${song._selected ? 'checked' : ''} onchange="_convSongToggle(${idx})" style="accent-color:var(--neon-cyan);">
          <div class="converter-song-info">
            <div class="converter-song-title">${esc(song.title || '未知标题')}</div>
            <div class="converter-song-sub">${esc(song.artist || '未知艺术家')} · ${esc(song.album || '未知专辑')} · ${(song.ext || '').toUpperCase()}</div>
          </div>
          <div class="converter-song-actions">
            ${inQueue
              ? `<button class="btn-sm" style="background:var(--neon-dim);cursor:not-allowed;" disabled>已添加</button>`
              : `<button class="btn-sm" style="background:var(--neon-cyan);color:#000;" onclick="_convSongAdd(${idx})">+ 添加</button>`
            }
          </div>
        </div>
      `;
    }).join('');
  }

  updateSelectAllState();
}

// ── 单个歌曲选择 ──────────────────────────────────────
function _convSongToggle(idx) {
  const filtered = getState('convFiltered') || _convLocalSongs;
  const song = filtered[idx];
  if (!song) return;
  song._selected = !song._selected;
}

// ── 添加到队列 ────────────────────────────────────────
function _convSongAdd(idx) {
  const filtered = getState('convFiltered') || _convLocalSongs;
  const song = filtered[idx];
  if (!song) return;

  if (_convQueue.some(q => q.path === song.filePath)) {
    showToast('这首歌曲已在转换队列中', 'warn');
    return;
  }

  const ext = (song.ext || song.filePath.split('.').pop() || 'mp3').toLowerCase();
  _convQueue.push({
    id: Date.now() + Math.random(),
    name: song.title || song.filePath,
    path: song.filePath,
    size: song.size || 0,
    ext: ext,
    format: ['flac', 'wav'].includes(ext) ? 'mp3' : 'flac',
    bitrate: '320k',
    status: 'pending',
    selected: true,
  });

  showToast(`已添加: ${song.title || '未知'}`, 'success');
  renderConverterSongs();
  renderQueue();
}

// ── 批量添加选中 ──────────────────────────────────────
function addSelectedToQueue() {
  const filtered = getState('convFiltered') || _convLocalSongs;
  const selected = filtered.filter(s => s._selected);
  if (!selected.length) {
    showToast('请先选择要转换的歌曲', 'warn');
    return;
  }

  let added = 0;
  for (const song of selected) {
    if (!_convQueue.some(q => q.path === song.filePath)) {
      const ext = (song.ext || song.filePath.split('.').pop() || 'mp3').toLowerCase();
      _convQueue.push({
        id: Date.now() + Math.random(),
        name: song.title || song.filePath,
        path: song.filePath,
        size: song.size || 0,
        ext: ext,
        format: ['flac', 'wav'].includes(ext) ? 'mp3' : 'flac',
        bitrate: '320k',
        status: 'pending',
        selected: true,
      });
      added++;
    }
  }

  showToast(`已添加 ${added} 首歌曲到转换队列`, 'success');
  renderConverterSongs();
  renderQueue();
}

// ── 全选/取消全选 ─────────────────────────────────────
function toggleSelectAll() {
  const checked = document.getElementById('converterSelectAll')?.checked;
  const filtered = getState('convFiltered') || _convLocalSongs;
  filtered.forEach(s => s._selected = checked);
  renderConverterSongs();
}

function updateSelectAllState() {
  const filtered = getState('convFiltered') || _convLocalSongs;
  const selectAll = document.getElementById('converterSelectAll');
  if (selectAll) {
    const allSelected = filtered.length > 0 && filtered.every(s => s._selected);
    const someSelected = filtered.some(s => s._selected);
    selectAll.checked = allSelected;
    selectAll.indeterminate = someSelected && !allSelected;
  }
}

// ── 渲染转换队列 ──────────────────────────────────────
function renderQueue() {
  const container = document.getElementById('converterQueue');
  const actions = document.getElementById('converterActions');
  if (!container) return;

  if (!_convQueue.length) {
    container.innerHTML = `
      <div style="text-align:center;padding:20px;color:var(--neon-dim);font-size:13px;">
        <div style="font-size:20px;margin-bottom:6px;">📋</div>
        <div>转换队列为空</div>
        <div style="margin-top:4px;font-size:11px;">从上方列表添加歌曲</div>
      </div>`;
    if (actions) actions.style.display = 'none';
    return;
  }

  if (actions) actions.style.display = 'flex';

  container.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr;gap:6px;max-height:250px;overflow-y:auto;">
      ${_convQueue.map((item, idx) => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg-secondary);border-radius:6px;opacity:${item.status === 'done' ? '0.5' : '1'};">
          <input type="checkbox" ${item.selected ? 'checked' : ''} onchange="_convQueue[${idx}].selected=this.checked" ${item.status !== 'pending' ? 'disabled' : ''} style="accent-color:var(--neon-cyan);">
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(item.name)}</div>
            <div style="font-size:10px;color:var(--neon-dim);margin-top:1px;">
              ${item.ext.toUpperCase()} → ${item.format.toUpperCase()} ${item.bitrate}
              ${item.status === 'done' ? ' ✅' : ''}
              ${item.status === 'error' ? ' ❌' : ''}
              ${item.status === 'converting' ? ' 🔄' : ''}
            </div>
          </div>
          <select onchange="_convQueue[${idx}].format=this.value" ${item.status !== 'pending' ? 'disabled' : ''} style="background:var(--bg-input);border:1px solid var(--border);border-radius:4px;padding:3px 6px;color:var(--text);font-size:11px;min-width:60px;">
            <option value="mp3" ${item.format==='mp3'?'selected':''}>MP3</option>
            <option value="flac" ${item.format==='flac'?'selected':''}>FLAC</option>
            <option value="aac" ${item.format==='aac'?'selected':''}>AAC</option>
            <option value="ogg" ${item.format==='ogg'?'selected':''}>OGG</option>
          </select>
          <button onclick="_converterRemoveFromQueue(${idx})" ${item.status !== 'pending' ? 'disabled' : ''} style="background:transparent;border:none;color:var(--neon-dim);font-size:14px;cursor:pointer;padding:2px 4px;" title="移除">✕</button>
        </div>
      `).join('')}
    </div>`;
}

// ── 从队列移除 ────────────────────────────────────────
function removeFromQueue(idx) {
  _convQueue.splice(idx, 1);
  renderQueue();
  renderConverterSongs();
}

// ── 清空已完成 ────────────────────────────────────────
function clearDone() {
  _convQueue = _convQueue.filter(q => q.status !== 'done');
  renderQueue();
}

// ── 应用批量设置 ──────────────────────────────────────
function applyBatchFormat() {
  const batchFormat = document.getElementById('converterBatchFormat')?.value || 'mp3';
  const batchBitrate = document.getElementById('converterBatchBitrate')?.value || '320k';
  _convQueue.forEach(q => {
    if (q.status === 'pending') {
      q.format = batchFormat;
      q.bitrate = batchBitrate;
    }
  });
  renderQueue();
  showToast(`已应用: ${batchFormat.toUpperCase()} / ${batchBitrate}`, 'info');
}

// ── 开始转换 ──────────────────────────────────────────
async function startConvert() {
  const pending = _convQueue.filter(q => q.status === 'pending' && q.selected);
  if (!pending.length) {
    showToast('请先添加要转换的歌曲', 'warn');
    return;
  }

  if (!_convOutputDir) {
    showToast('请先设置输出目录', 'warn');
    return;
  }

  const startBtn = document.getElementById('converterStartBtn');
  if (startBtn) {
    startBtn.textContent = '转换中...';
    startBtn.disabled = true;
  }

  let ok = 0, fail = 0;
  for (const item of pending) {
    item.status = 'converting';
    renderQueue();
    try {
      const result = await api.convertAudio({
        inputPath: item.path,
        outputFormat: item.format,
        bitrate: item.bitrate,
        outputDir: _convOutputDir,
      });
      if (result.error) {
        item.status = 'error';
        fail++;
      } else {
        item.status = 'done';
        ok++;
      }
    } catch (e) {
      item.status = 'error';
      fail++;
    }
    renderQueue();
  }

  if (startBtn) {
    startBtn.textContent = '开始转换';
    startBtn.disabled = false;
  }

  if (ok > 0) {
    showToast(`✅ 成功转换 ${ok} 首${fail > 0 ? `，${fail} 首失败` : ''}`, 'success');
  } else if (fail > 0) {
    showToast(`转换失败 ${fail} 首`, 'error');
  }
}

// ── 显示空状态 ────────────────────────────────────────
function showConverterEmpty(msg) {
  const container = document.getElementById('converterSongList');
  const info = document.getElementById('converterInfo');
  if (info) info.textContent = msg || '暂无数据';
  if (container) {
    container.innerHTML = `
      <div class="empty-state" style="flex:1;padding:40px;">
        <div class="empty-icon">📂</div>
        <div class="empty-text">${msg || '暂无歌曲'}</div>
      </div>`;
  }
}

// ── 防抖 ──────────────────────────────────────────────
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

// ── 暴露 init ─────────────────────────────────────────
export { initConverter };

// ── 全局桥接 ──────────────────────────────────────────
Object.assign(window, {
initConverter,
_convSongToggle,
_convSongAdd,
clearDone,
});
