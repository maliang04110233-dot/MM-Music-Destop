/**
 * MusicDL 本地音乐库视图 + ID3 编辑器 + 批量操作
 *
 * v2: 集成虚拟滚动 + 响应式状态
 */

import { logger } from '../logger.js';

import { VirtualScroller } from '../virtualList.js';

// ── 状态 ─────────────────────────────────────────────
let _localSelectionMode = false;
const _selectedLocal = new Set(); // 存 filePath
let _localVirtualScroller = null; // 虚拟滚动实例

// ── 批量补封面 ────────────────────────────────────────
let _batchCancelled = false;

async function batchFetchCovers() {
  const localSongs = getState('localSongs');
  const needCover = localSongs.filter(s => !s.cover && s.title && s.artist);
  if (!needCover.length) {
    showToast('✅ 所有歌曲都已有封面，无需补全', 'info');
    return;
  }
  _batchCancelled = false;
  const total = needCover.length;
  let done = 0, ok = 0, fail = 0;

  const progressWrap = document.getElementById('batchProgressWrap');
  const progressBar = document.getElementById('batchProgressBar');
  const progressLabel = document.getElementById('batchProgressLabel');
  if (progressWrap) progressWrap.style.display = 'flex';
  if (progressLabel) progressLabel.textContent = `正在补全封面 (0/${total})`;

  for (const s of needCover) {
    if (_batchCancelled) break;
    try {
      const result = await api.fetchOnlineCover(s.title || '', s.artist || '');
      if (result && result.coverBase64) {
        const wr = await api.updateId3Cover(s.filePath, result.coverBase64);
        if (wr && wr.success) {
          s.cover = result.coverBase64;
          const localFiltered = getState('localFiltered');
          const fi = localFiltered.findIndex(x => x.filePath === s.filePath);
          if (fi >= 0) localFiltered[fi].cover = result.coverBase64;
          ok++;
        } else { fail++; }
      } else { fail++; }
    } catch (e) { fail++; }
    done++;
    const pct = Math.round((done / total) * 100);
    progressBar.style.width = pct + '%';
    progressLabel.textContent = `正在补全封面 (${done}/${total})`;
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  renderLocalSongs();
  showToast(`批量补封面完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

function cancelBatchFetch() { _batchCancelled = true; }

// ── 扫描 ──────────────────────────────────────────────
async function scanLocalDir() {
  let localDirPath = getState('localDirPath');
  if (!localDirPath) {
    const saved = await api.getPref('localDirPath');
    if (saved) localDirPath = saved;
  }
  if (!localDirPath) {
    const dir = await api.selectDir();
    if (!dir) return;
    localDirPath = dir;
    setState('localDirPath', dir);
    await api.setPref('localDirPath', dir);
  }

  const list = document.getElementById('localList');
  list.innerHTML = '<div class="loading"><div class="spinner"></div> 扫描中...</div>';

  try {
    const result = await api.scanLocalLibrary(localDirPath);
    if (result.error === '目录不存在') {
      setState('localDirPath', null);
      await api.setPref('localDirPath', null);
      list.innerHTML = `<div class="empty-state" style="flex:1">
        <div class="empty-icon">📂</div>
        <div class="empty-text">目录不存在</div>
        <div class="empty-hint">请重新选择音乐文件夹</div>
      </div>`;
      document.getElementById('localInfo').textContent = '目录不存在，请重新扫描';
      const dir = await api.selectDir();
      if (!dir) return;
      localDirPath = dir;
      setState('localDirPath', dir);
      await api.setPref('localDirPath', dir);
      const retry = await api.scanLocalLibrary(localDirPath);
      if (retry.error) { showToast('扫描失败: ' + retry.error, 'error'); return; }
      setState('localSongs', retry.songs || []);
      setState('localFiltered', [...(retry.songs || [])]);
      document.getElementById('localInfo').textContent = `共 ${(retry.songs || []).length} 首 · ${localDirPath}`;
      if (_localGridView) renderLocalGrid();
      else renderLocalSongs();
      showToast(`扫描完成，发现 ${(retry.songs || []).length} 首歌曲`, 'success');
      return;
    }
    const localSongs = result.songs || [];
    setState('localSongs', localSongs);
    setState('localFiltered', [...localSongs]);
    document.getElementById('localInfo').textContent = `共 ${localSongs.length} 首 · ${localDirPath}`;
    if (_localGridView) renderLocalGrid();
    else renderLocalSongs();
    showToast(`扫描完成，发现 ${localSongs.length} 首歌曲`, 'success');
  } catch (e) {
    showToast('扫描失败: ' + e.message, 'error');
  }
}

// ── 过滤 ──────────────────────────────────────────────
function filterLocalSongs() {
  const kw = document.getElementById('localFilter').value.trim().toLowerCase();
  const localSongs = getState('localSongs');
  if (!kw) {
    setState('localFiltered', [...localSongs]);
  } else {
    setState('localFiltered', localSongs.filter(s =>
      (s.title || '').toLowerCase().includes(kw) ||
      (s.artist || '').toLowerCase().includes(kw) ||
      (s.album || '').toLowerCase().includes(kw)
    ));
  }
  if (_localGridView) renderLocalGrid();
  else renderLocalSongs();
}

// ── 选择模式 ─────────────────────────────────────────
function enterLocalSelectionMode() {
  _localSelectionMode = true;
  _selectedLocal.clear();
  renderLocalSongs();
  updateLocalSelectionBar();
}

function exitLocalSelectionMode() {
  _localSelectionMode = false;
  _selectedLocal.clear();
  renderLocalSongs();
  updateLocalSelectionBar();
}

function toggleLocalSelect(filePathOrEncoded, idx) {
  // 兼容处理：新版传入 base64 编码路径，旧版传入明文路径
  const filePath = filePathOrEncoded.length > 200
    ? decodeFilePath(filePathOrEncoded) // 新版：base64 编码的路径
    : filePathOrEncoded; // 旧版：明文路径（向后兼容）
  if (_selectedLocal.has(filePath)) {
    _selectedLocal.delete(filePath);
  } else {
    _selectedLocal.add(filePath);
  }
  // 更新 checkbox 状态
  const cb = document.getElementById('localcb_' + idx);
  if (cb) cb.checked = _selectedLocal.has(filePath);
  updateLocalSelectionBar();
  renderLocalSongs(); // 重新高亮
}

function selectAllLocal() {
  const localFiltered = getState('localFiltered');
  localFiltered.forEach(s => _selectedLocal.add(s.filePath));
  renderLocalSongs();
  updateLocalSelectionBar();
}

function deselectAllLocal() {
  _selectedLocal.clear();
  renderLocalSongs();
  updateLocalSelectionBar();
}

function updateLocalSelectionBar() {
  const bar = document.getElementById('localSelectionBar');
  const count = document.getElementById('localSelectionCount');
  if (!bar) return;
  const n = _selectedLocal.size;
  if (!_localSelectionMode) {
    bar.style.display = 'none';
    return;
  }
  count.textContent = n;
  bar.style.display = 'flex';
}

// ── 渲染列表（虚拟滚动版）─────────────────────────────
function _renderLocalRow(s, i) {
  const selected = _selectedLocal.has(s.filePath);
  const rowClass = selected && _localSelectionMode ? 'local-row selected' : 'local-row';
  const encodedPath = btoa(encodeURIComponent(s.filePath));
  return `
  <div class="${rowClass}" data-idx="${i}" onclick="playLocalSong(${i})" style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border-subtle);cursor:pointer;">
    ${_localSelectionMode ? `
    <div class="local-row-cb" onclick="event.stopPropagation();toggleLocalSelect('${encodedPath}',${i})">
      <input type="checkbox" id="localcb_${i}" ${selected ? 'checked' : ''} onchange="event.stopPropagation();toggleLocalSelect('${encodedPath}',${i})">
    </div>` : ''}
    ${s.cover
      ? `<img class="local-row-cover" src="${s.cover.replace(/"/g, '&quot;')}" alt="" style="width:40px;height:40px;border-radius:4px;object-fit:cover;" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : ''}
    <div class="local-row-cover-ph" style="width:40px;height:40px;border-radius:4px;display:flex;align-items:center;justify-content:center;background:var(--bg-tertiary);font-size:18px;${s.cover ? 'display:none' : ''}">🎵</div>
    <div class="local-row-info" style="flex:1;min-width:0;">
      <div class="local-row-title" style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.title)}</div>
      <div class="local-row-artist" style="font-size:11px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.artist || '未知艺术家')}${s.album ? ' · ' + esc(s.album) : ''}</div>
    </div>
    <span class="local-row-duration" style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${fmtDuration(s.durationMs)}</span>
    <span class="local-row-size" style="font-size:11px;color:var(--text-muted);white-space:nowrap;">${formatBytes(s.fileSize)}</span>
    <div class="local-row-actions" style="display:flex;gap:4px;">
      <button class="action-btn" title="播放" onclick="event.stopPropagation();playLocalSong(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">▶</button>
      <button class="action-btn" title="编辑" onclick="event.stopPropagation();openEdit(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">✏️</button>
      <button class="action-btn" title="拉取在线封面" onclick="event.stopPropagation();refetchCover(${i})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">🖼️</button>
      <button class="action-btn download-btn" title="打开文件夹" data-action="open-folder" data-path="${encodedPath}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:4px;">📂</button>
    </div>
  </div>`;
}

function renderLocalSongs() {
  const list = document.getElementById('localList');
  const localFiltered = getState('localFiltered');

  if (!localFiltered || !localFiltered.length) {
    list.innerHTML = `<div class="empty-state" style="flex:1">
      <div class="empty-icon">📂</div>
      <div class="empty-text">暂无本地歌曲</div>
      <div class="empty-hint">点击"扫描目录"选择音乐文件夹</div>
    </div>`;
    if (_localVirtualScroller) { _localVirtualScroller.destroy(); _localVirtualScroller = null; }
    return;
  }

  // 少于 50 首用普通渲染，超过用虚拟滚动
  if (localFiltered.length < 50) {
    if (_localVirtualScroller) { _localVirtualScroller.destroy(); _localVirtualScroller = null; }
    list.innerHTML = localFiltered.map((s, i) => _renderLocalRow(s, i)).join('');
    return;
  }

  // 虚拟滚动
  if (!_localVirtualScroller) {
    list.innerHTML = '';
    _localVirtualScroller = new VirtualScroller(list, {
      itemHeight: 52,
      buffer: 10,
      renderItem: (item, idx) => _renderLocalRow(item, idx),
      onItemClick: (item, idx, e) => {
        // 点击行播放（按钮的 onclick 已单独处理）
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
        playLocalSong(idx);
      },
    });
  }
  _localVirtualScroller.setData(localFiltered);
}

// ── 播放 ──────────────────────────────────────────────
async function playLocalSong(idx) {
  try {
    const localFiltered = getState('localFiltered');
    const s = localFiltered[idx];
    if (!s) return;
    setState('playQueue', localFiltered.slice());
    setState('playIdx', idx);
    setState('_currentLocalFilePath', s.filePath);
    // audio error / 25s 加载超时守卫依赖 currentPlaying 真值，缺失会静默卡死
    setState('currentPlaying', s);
    await loadAndPlay(s, 'file://' + s.filePath);
    renderLocalSongs();
  } catch (e) {
    logger.error(`[playLocalSong] error:`, e);
  }
}

// ── 单曲编辑 ─────────────────────────────────────────
// ── 编辑弹窗 document 级 click 监听管理 ──────────────
let _editDocClickHandler = null;

function _addEditDocClickListener() {
  _removeEditDocClickListener();
  _editDocClickHandler = (e) => {
    const overlay = document.getElementById('editOverlay');
    if (overlay && e.target === overlay) closeEdit();
  };
  document.addEventListener('click', _editDocClickHandler);
}

function _removeEditDocClickListener() {
  if (_editDocClickHandler) {
    document.removeEventListener('click', _editDocClickHandler);
    _editDocClickHandler = null;
  }
}

function openEdit(idx) {
  const localFiltered = getState('localFiltered');
  const s = localFiltered[idx];
  if (!s) return;
  setState('editingSong', s);
  setState('editingCoverBase64', s.cover || null);

  document.getElementById('editTitle').value = s.title || '';
  document.getElementById('editArtist').value = s.artist || '';
  document.getElementById('editAlbum').value = s.album || '';
  document.getElementById('editYear').value = s.year || '';
  document.getElementById('editGenre').value = s.genre || '';

  const preview = document.getElementById('editCoverPreview');
  if (s.cover) {
    // s.cover 应为 data:image/*;base64 形态（来自内嵌标签或在线封面）。
    // 白名单校验后再插值：非 data:image 前缀的一律当无封面处理，
    // 防止把外部输入直接塞进 innerHTML 的 src 属性。
    const isDataImage = typeof s.cover === 'string' && /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/.test(s.cover);
    preview.innerHTML = isDataImage
      ? `<img src="${s.cover}" style="width:100%;height:100%;object-fit:cover">`
      : '<span style="font-size:28px">🎵</span>';
  } else {
    preview.innerHTML = '<span style="font-size:28px">🎵</span>';
  }

  document.getElementById('editBatchHint').style.display = 'none';
  document.getElementById('editOverlay').classList.remove('hidden');
  _addEditDocClickListener();
}

function closeEditOnBg(e) {
  if (e.target === document.getElementById('editOverlay')) closeEdit();
}

function onEditCoverSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    setState('editingCoverBase64', e.target.result);
    document.getElementById('editCoverPreview').innerHTML = `<img src="${e.target.result}" style="width:100%;height:100%;object-fit:cover">`;
  };
  reader.readAsDataURL(file);
}

function clearEditCover() {
  setState('editingCoverBase64', null);
  document.getElementById('editCoverPreview').innerHTML = '<span style="font-size:28px">🎵</span>';
}

async function saveEdit() {
  const editingSong = getState('editingSong');
  if (!editingSong) return;

  const tags = {
    title: document.getElementById('editTitle').value.trim(),
    artist: document.getElementById('editArtist').value.trim(),
    album: document.getElementById('editAlbum').value.trim(),
    year: document.getElementById('editYear').value.trim(),
    genre: document.getElementById('editGenre').value.trim(),
  };

  try {
    const result = await api.updateId3Tags(editingSong.filePath, tags);
    if (result.success) {
      const editingCoverBase64 = getState('editingCoverBase64');
      if (editingCoverBase64 !== editingSong.cover) {
        if (editingCoverBase64) {
          await api.updateId3Cover(editingSong.filePath, editingCoverBase64);
        }
      }
      Object.assign(editingSong, tags);
      editingSong.cover = editingCoverBase64;
      renderLocalSongs();
      closeEdit();
      showToast('歌曲信息已保存', 'success');
    } else {
      showToast('保存失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('保存出错: ' + e.message, 'error');
  }
}

// ── 批量编辑 ─────────────────────────────────────────
function openBatchEdit() {
  const count = _selectedLocal.size;
  if (!count) { showToast('请先选择要编辑的歌曲', 'warn'); return; }

  document.getElementById('editTitle').value = '';
  document.getElementById('editArtist').value = '';
  document.getElementById('editAlbum').value = '';
  document.getElementById('editYear').value = '';
  document.getElementById('editGenre').value = '';
  document.getElementById('editCoverPreview').innerHTML = '<span style="font-size:28px">🎵</span>';
  setState('editingCoverBase64', null);
  setState('editingSong', null);

  document.getElementById('editTitleLabel').textContent = `✏️ 批量编辑 ${count} 首`;
  document.getElementById('editBatchHint').style.display = 'block';
  document.getElementById('editBatchHint').textContent = `已选 ${count} 首歌曲。只填写的字段会批量写入，留空则跳过该字段。`;
  document.getElementById('editSaveBtn').textContent = '批量保存';
  document.getElementById('editSaveBtn').setAttribute('onclick', 'saveBatchEdit()');
  document.getElementById('editOverlay').classList.remove('hidden');
  _addEditDocClickListener();
}

function closeEdit() {
  _removeEditDocClickListener();
  document.getElementById('editOverlay').classList.add('hidden');
  setState('editingSong', null);
  setState('editingCoverBase64', null);
  document.getElementById('editTitleLabel').textContent = '✏️ 编辑歌曲信息';
  document.getElementById('editBatchHint').style.display = 'none';
  document.getElementById('editSaveBtn').textContent = '保存更改';
  document.getElementById('editSaveBtn').setAttribute('onclick', 'saveEdit()');
}

async function saveBatchEdit() {
  const count = _selectedLocal.size;
  if (!count) return;

  const tags = {
    title: document.getElementById('editTitle').value.trim(),
    artist: document.getElementById('editArtist').value.trim(),
    album: document.getElementById('editAlbum').value.trim(),
    year: document.getElementById('editYear').value.trim(),
    genre: document.getElementById('editGenre').value.trim(),
  };
  // 过滤掉空字段
  const filledTags = Object.fromEntries(Object.entries(tags).filter(([, v]) => v !== ''));
  if (!Object.keys(filledTags).length) {
    showToast('请至少填写一个字段', 'warn');
    return;
  }

  const localSongs = getState('localSongs');
  const localFiltered = getState('localFiltered');
  let ok = 0, fail = 0;
  const editingCoverBase64 = getState('editingCoverBase64');

  for (const fp of _selectedLocal) {
    try {
      const result = await api.updateId3Tags(fp, filledTags);
      if (result && result.success) {
        if (editingCoverBase64) {
          await api.updateId3Cover(fp, editingCoverBase64);
        }
        // 回填状态
        const s = localSongs.find(x => x.filePath === fp);
        if (s) { Object.assign(s, filledTags); if (editingCoverBase64) s.cover = editingCoverBase64; }
        const fi = localFiltered.findIndex(x => x.filePath === fp);
        if (fi >= 0) { Object.assign(localFiltered[fi], filledTags); if (editingCoverBase64) localFiltered[fi].cover = editingCoverBase64; }
        ok++;
      } else { fail++; }
    } catch (e) { fail++; }
  }

  renderLocalSongs();
  closeEdit();
  exitLocalSelectionMode();
  showToast(`批量编辑完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ── 拖拽上传封面（编辑器） ───────────────────────────
// H7/H8 修复：存储 handler 引用，支持清理
const _dragCoverHandlers = {
  dragover: null,
  dragleave: null,
  drop: null,
};

function setupDragCover() {
  const preview = document.getElementById('editCoverPreview');
  if (!preview) return;
  // 先清理旧监听器，避免重复绑定
  teardownDragCover();
  _dragCoverHandlers.dragover = (e) => { e.preventDefault(); preview.style.borderColor = 'var(--neon-cyan-dim)'; };
  _dragCoverHandlers.dragleave = () => { preview.style.borderColor = 'var(--neon-blue-dim)'; };
  _dragCoverHandlers.drop = (e) => {
    e.preventDefault();
    preview.style.borderColor = 'var(--neon-blue-dim)';
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setState('editingCoverBase64', ev.target.result);
      preview.innerHTML = `<img src="${ev.target.result}" style="width:100%;height:100%;object-fit:cover">`;
    };
    reader.readAsDataURL(file);
  };
  preview.addEventListener('dragover', _dragCoverHandlers.dragover);
  preview.addEventListener('dragleave', _dragCoverHandlers.dragleave);
  preview.addEventListener('drop', _dragCoverHandlers.drop);
}

function teardownDragCover() {
  const preview = document.getElementById('editCoverPreview');
  if (!preview) return;
  if (_dragCoverHandlers.dragover) preview.removeEventListener('dragover', _dragCoverHandlers.dragover);
  if (_dragCoverHandlers.dragleave) preview.removeEventListener('dragleave', _dragCoverHandlers.dragleave);
  if (_dragCoverHandlers.drop) preview.removeEventListener('drop', _dragCoverHandlers.drop);
  _dragCoverHandlers.dragover = null;
  _dragCoverHandlers.dragleave = null;
  _dragCoverHandlers.drop = null;
}

// 初始化拖拽监听
setupDragCover();

// ── 打开文件夹事件代理（修复 XSS，使用 data 属性传递路径）─────────
(function setupOpenFolderDelegate() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="open-folder"]');
    if (!btn) return;
    e.stopPropagation();
    const encoded = btn.dataset.path;
    if (!encoded) return;
    try {
      const filePath = decodeURIComponent(atob(encoded));
      api.openFolder(filePath);
    } catch (err) {
      logger.warn('[openFolder] 解码路径失败:', err.message);
    }
  });
})();

// ── 辅助：解码 base64 编码的文件路径 ───────────────────────────
function decodeFilePath(encoded) {
  try {
    return decodeURIComponent(atob(encoded));
  } catch (e) {
    return encoded; // 降级：如果是旧版明文路径，直接返回
  }
}

// ── 批量歌词 ─────────────────────────────────────────
async function batchFetchLyrics() {
  const localSongs = getState('localSongs');
  // 只选有 title + artist 的歌
  const candidates = localSongs.filter(s => s.title && s.artist);
  if (!candidates.length) {
    showToast('本地库中没有带标题和艺术家的歌曲', 'warn');
    return;
  }

  _batchCancelled = false;
  const total = candidates.length;
  let done = 0, ok = 0, fail = 0;

  const progressWrap = document.getElementById('batchProgressWrap');
  const progressBar = document.getElementById('batchProgressBar');
  const progressLabel = document.getElementById('batchProgressLabel');
  if (progressWrap) progressWrap.style.display = 'flex';
  if (progressBar) progressBar.style.width = '0%';
  if (progressLabel) progressLabel.textContent = `正在补全歌词 (0/${total})`;

  try {
    const results = await api.batchFetchLyrics(
      candidates.map(s => ({ filePath: s.filePath, title: s.title, artist: s.artist }))
    );

    // results 是 { filePath, ok, error } 数组
    for (const r of results) {
      if (_batchCancelled) break;
      done++;
      if (r.ok) ok++; else fail++;
      const pct = Math.round((done / total) * 100);
      progressBar.style.width = pct + '%';
      progressLabel.textContent = `正在补全歌词 (${done}/${total})`;
    }
  } catch (e) {
    showToast('批量歌词获取失败: ' + e.message, 'error');
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  showToast(`批量补歌词完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ── 拉取单曲封面 ─────────────────────────────────────
async function refetchCover(idx) {
  const localFiltered = getState('localFiltered');
  const s = localFiltered[idx];
  if (!s) return;
  if (!s.title || !s.artist) {
    showToast('需要歌曲名和歌手才能在线拉取封面', 'warn');
    return;
  }
  showToast(`🔍 正在搜索《${s.title}》的封面...`, 'info', 1500);
  try {
    const result = await api.fetchOnlineCover(s.title, s.artist);
    if (result && result.success && result.coverBase64) {
      const ok = await api.updateId3Cover(s.filePath, result.coverBase64);
      s.cover = ok && ok.success ? result.coverBase64 : null;
      const localSongs = getState('localSongs');
      const idx2 = localSongs.findIndex(x => x.filePath === s.filePath);
      if (idx2 >= 0) localSongs[idx2].cover = s.cover;
      renderLocalSongs();
      if (s.cover) {
        showToast(`✅ 封面已拉取并写入文件（${result.source}）`, 'success');
      } else {
        showToast('❌ 封面写入文件失败，请重试', 'warn', 3000);
      }
    } else {
      showToast('❌ 未找到匹配的封面：' + (result?.error || '请检查歌名/歌手'), 'warn', 3500);
    }
  } catch (e) {
    showToast('拉取失败: ' + e.message, 'error');
  }
}

// ── 工具 ──────────────────────────────────────────────
// esc()、fmtDuration()、formatBytes() 已由 utils.js 全局导出，此处不再重复定义

// ── 视图切换 ─────────────────────────────────────────
let _localGridView = false;

function toggleLocalView() {
  _localGridView = !_localGridView;
  const list = document.getElementById('localList');
  const grid = document.getElementById('localGrid');
  const btn = document.getElementById('localViewToggleBtn');
  if (_localGridView) {
    list.style.display = 'none';
    grid.style.display = 'grid';
    btn.textContent = '☰ 列表';
    renderLocalGrid();
  } else {
    grid.style.display = 'none';
    list.style.display = 'flex';
    btn.textContent = '▦ 网格';
  }
}

function renderLocalGrid() {
  const grid = document.getElementById('localGrid');
  const localFiltered = getState('localFiltered');
  if (!localFiltered || !localFiltered.length) {
    grid.innerHTML = `<div class="empty-state" style="flex:1;width:100%">
      <div class="empty-icon">📂</div>
      <div class="empty-text">暂无本地歌曲</div>
      <div class="empty-hint">点击"扫描目录"选择音乐文件夹</div>
    </div>`;
    return;
  }
  grid.innerHTML = localFiltered.map((s, i) => `
    <div class="grid-cell" onclick="playLocalSong(${i})">
      <div class="grid-cover">
        ${s.cover
          ? `<img src="${s.cover.replace(/"/g, '&quot;')}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
          : ''}
        <div class="grid-cover-ph" ${s.cover ? 'style="display:none"' : ''}>🎵</div>
        <div class="grid-play-overlay">▶</div>
      </div>
      <div class="grid-info">
        <div class="grid-title">${esc(s.title || '未知')}</div>
        <div class="grid-artist">${esc(s.artist || '未知艺术家')}</div>
      </div>
    </div>`).join('');
}

// ── 一键补全元数据（封面+歌词）────────────────────────
async function batchAutoMeta() {
  const localSongs = getState('localSongs');
  const needMeta = localSongs.filter(s => s.title && s.artist);
  if (!needMeta.length) {
    showToast('没有带标题和艺术家的歌曲可供补全', 'warn');
    return;
  }

  const progressWrap = document.getElementById('batchProgressWrap');
  const progressBar = document.getElementById('batchProgressBar');
  const progressLabel = document.getElementById('batchProgressLabel');
  progressWrap.style.display = 'flex';
  _batchCancelled = false;

  // 第一步：补封面
  const needCover = needMeta.filter(s => !s.cover);
  let coverOk = 0, coverFail = 0;
  if (needCover.length) {
    progressLabel.textContent = `步骤 1/2：补全封面 (0/${needCover.length})`;
    for (let di = 0; di < needCover.length; di++) {
      if (_batchCancelled) break;
      const s = needCover[di];
      try {
        const result = await api.fetchOnlineCover(s.title || '', s.artist || '');
        if (result && result.coverBase64) {
          const wr = await api.updateId3Cover(s.filePath, result.coverBase64);
          if (wr && wr.success) {
            s.cover = result.coverBase64;
            const lf = getState('localFiltered');
            const fi = lf.findIndex(x => x.filePath === s.filePath);
            if (fi >= 0) lf[fi].cover = result.coverBase64;
            coverOk++;
          } else { coverFail++; }
        } else { coverFail++; }
      } catch { coverFail++; }
      progressBar.style.width = ((di + 1) / needCover.length * 50) + '%';
      progressLabel.textContent = `步骤 1/2：补全封面 (${di + 1}/${needCover.length})`;
    }
  }

  // 第二步：补歌词
  let lyricOk = 0, lyricFail = 0;
  if (!_batchCancelled) {
    progressLabel.textContent = '步骤 2/2：补全歌词...';
    try {
      const results = await api.batchFetchLyrics(
        needMeta.map(s => ({ filePath: s.filePath, title: s.title, artist: s.artist }))
      );
      for (const r of results) {
        if (_batchCancelled) break;
        if (r.ok) lyricOk++; else lyricFail++;
      }
    } catch { lyricFail = needMeta.length; }
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  renderLocalSongs();
  showToast(`一键补全完成：封面 ✅${coverOk} ❌${coverFail} | 歌词 ✅${lyricOk} ❌${lyricFail}`, coverOk + lyricOk > 0 ? 'success' : 'warn', 5000);
}

// ══════════════════════════════════════════════════════════
// 功能 2：音乐库统计
// ══════════════════════════════════════════════════════════

function showLibraryStats() {
  const localSongs = getState('localSongs');
  if (!localSongs || !localSongs.length) {
    showToast('请先扫描本地音乐库', 'warn');
    return;
  }

  // 计算统计数据
  const stats = {
    total: localSongs.length,
    totalSize: 0,
    totalDuration: 0,
    formatCount: {},
    artistCount: {},
    albumCount: {},
    hasCover: 0,
    hasLyrics: 0,
  };

  for (const s of localSongs) {
    // 文件大小
    stats.totalSize += s.fileSize || 0;
    // 时长
    stats.totalDuration += s.durationMs || 0;
    // 格式统计
    const ext = (s.ext || '').toLowerCase();
    stats.formatCount[ext] = (stats.formatCount[ext] || 0) + 1;
    // 艺术家统计
    if (s.artist) {
      stats.artistCount[s.artist] = (stats.artistCount[s.artist] || 0) + 1;
    }
    // 专辑统计
    if (s.album) {
      stats.albumCount[s.album] = (stats.albumCount[s.album] || 0) + 1;
    }
    // 封面/歌词
    if (s.cover) stats.hasCover++;
    if (s.embeddedLyrics) stats.hasLyrics++;
  }

  // 格式分布
  const formatList = Object.entries(stats.formatCount)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `<span class="stat-tag">${ext.toUpperCase()}: ${count}</span>`)
    .join('');

  // Top 艺术家
  const topArtists = Object.entries(stats.artistCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `<span class="stat-item">${esc(name)} (${count})</span>`)
    .join('');

  // Top 专辑
  const topAlbums = Object.entries(stats.albumCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `<span class="stat-item">${esc(name)} (${count})</span>`)
    .join('');

  // 格式化时长
  const totalHours = Math.floor(stats.totalDuration / 3600000);
  const totalMinutes = Math.floor((stats.totalDuration % 3600000) / 60000);
  const durationStr = totalHours > 0 ? `${totalHours}小时${totalMinutes}分钟` : `${totalMinutes}分钟`;

  // 构建 HTML
  const html = `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.total}</div>
        <div class="stat-label">歌曲总数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${formatBytes(stats.totalSize)}</div>
        <div class="stat-label">总大小</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${durationStr}</div>
        <div class="stat-label">总时长</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${Object.keys(stats.artistCount).length}</div>
        <div class="stat-label">艺术家数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${Object.keys(stats.albumCount).length}</div>
        <div class="stat-label">专辑数</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.hasCover}/${stats.total}</div>
        <div class="stat-label">封面覆盖率</div>
      </div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">格式分布</div>
      <div class="stats-tags">${formatList}</div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Top 艺术家</div>
      <div class="stats-list">${topArtists || '<span class="stat-empty">暂无数据</span>'}</div>
    </div>

    <div class="stats-section">
      <div class="stats-section-title">Top 专辑</div>
      <div class="stats-list">${topAlbums || '<span class="stat-empty">暂无数据</span>'}</div>
    </div>
  `;

  // 显示统计弹窗
  showStatsModal(html);
}

function showStatsModal(html) {
  let overlay = document.getElementById('statsModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'statsModal';
  overlay.className = 'stats-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel">
      <div class="stats-header">
        <span>📊 音乐库统计</span>
        <button onclick="document.getElementById('statsModal').remove()">✕</button>
      </div>
      <div class="stats-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

// ══════════════════════════════════════════════════════════
// 功能 3：重复歌曲检测 + 删除
// ══════════════════════════════════════════════════════════

// 重复歌曲状态
const _dupState = {
  groups: [],      // 重复组数据
  selected: new Set(), // 选中的文件路径
};

function detectDuplicateSongs() {
  const localSongs = getState('localSongs');
  if (!localSongs || !localSongs.length) {
    showToast('请先扫描本地音乐库', 'warn');
    return;
  }

  // 按 标题+艺术家 分组
  const groups = {};
  for (const s of localSongs) {
    const title = (s.title || '').toLowerCase().trim();
    const artist = (s.artist || '').toLowerCase().trim();
    if (!title) continue;
    const key = `${title}|||${artist}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  }

  // 找出重复组
  const duplicates = Object.values(groups).filter(arr => arr.length > 1);
  _dupState.groups = duplicates;
  _dupState.selected.clear();

  if (!duplicates.length) {
    showToast('🎉 没有发现重复歌曲', 'success');
    return;
  }

  // 自动选中每组中"较差"的版本（优先保留无损 > 高品质 > 标准）
  const QUALITY_ORDER = { flac: 0, ape: 0, wav: 0, aac: 1, m4a: 1, mp3: 2, ogg: 2, wma: 3 };
  for (const group of duplicates) {
    // 按音质排序（好的在前）
    group.sort((a, b) => {
      const qa = QUALITY_ORDER[(a.ext || '').toLowerCase()] ?? 2;
      const qb = QUALITY_ORDER[(b.ext || '').toLowerCase()] ?? 2;
      if (qa !== qb) return qa - qb;
      // 音质相同，保留文件大的（通常码率更高）
      return (b.fileSize || 0) - (a.fileSize || 0);
    });
    // 选中除第一个以外的所有（保留最好的）
    for (let i = 1; i < group.length; i++) {
      _dupState.selected.add(group[i].filePath);
    }
  }

  renderDuplicateModal();
}

function renderDuplicateModal() {
  const { groups, selected } = _dupState;

  const groupsHtml = groups.map((group, _i) => {
    const songsHtml = group.map((s, j) => {
      const isSelected = selected.has(s.filePath);
      const isBest = j === 0;
      return `
        <div class="dup-song ${isSelected ? 'dup-selected' : ''} ${isBest ? 'dup-best' : ''}">
          <label class="dup-checkbox">
            <input type="checkbox" ${isSelected ? 'checked' : ''}
              onchange="toggleDupSelect('${esc(s.filePath.replace(/'/g, "\\'"))}')">
          </label>
          <span class="dup-title">${esc(s.title || '未知')}</span>
          <span class="dup-artist">${esc(s.artist || '未知')}</span>
          <span class="dup-format">${(s.ext || '').toUpperCase()}</span>
          <span class="dup-size">${formatBytes(s.fileSize)}</span>
          ${isBest ? '<span class="dup-best-tag">保留</span>' : ''}
        </div>
      `;
    }).join('');
    return `
      <div class="dup-group">
        <div class="dup-group-header">
          <span class="dup-group-title">${esc(group[0].title || '未知')}</span>
          <span class="dup-group-count">${group.length} 个版本</span>
        </div>
        <div class="dup-songs">${songsHtml}</div>
      </div>
    `;
  }).join('');

  const html = `
    <div class="stats-summary">
      发现 <strong>${groups.length}</strong> 组重复歌曲，已选中 <strong>${selected.size}</strong> 个待删除
    </div>
    <div class="dup-actions">
      <button class="dup-action-btn" onclick="selectAllDups()">全选</button>
      <button class="dup-action-btn" onclick="deselectAllDups()">取消全选</button>
      <div style="flex:1"></div>
      <button class="dup-action-btn dup-delete-btn" onclick="deleteSelectedDups()" ${selected.size === 0 ? 'disabled' : ''}>
        🗑 删除选中 (${selected.size})
      </button>
    </div>
    <div class="dup-list">${groupsHtml}</div>
  `;

  showDuplicateModal(html);
}

function showDuplicateModal(html) {
  let overlay = document.getElementById('dupModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'dupModal';
  overlay.className = 'stats-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel dup-panel">
      <div class="stats-header">
        <span>🔍 重复歌曲检测</span>
        <button onclick="document.getElementById('dupModal').remove()">✕</button>
      </div>
      <div class="stats-body">${html}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function toggleDupSelect(filePath) {
  if (_dupState.selected.has(filePath)) {
    _dupState.selected.delete(filePath);
  } else {
    _dupState.selected.add(filePath);
  }
  renderDuplicateModal();
}

function selectAllDups() {
  const { groups } = _dupState;
  for (const group of groups) {
    for (let i = 1; i < group.length; i++) {
      _dupState.selected.add(group[i].filePath);
    }
  }
  renderDuplicateModal();
}

function deselectAllDups() {
  _dupState.selected.clear();
  renderDuplicateModal();
}

async function deleteSelectedDups() {
  const { selected } = _dupState;
  if (!selected.size) return;

  const count = selected.size;
  if (!confirm(`确认删除 ${count} 个重复文件？\n\n此操作不可撤销！`)) return;

  let deleted = 0;
  let failed = 0;
  const localSongs = getState('localSongs');
  const localFiltered = getState('localFiltered');

  for (const filePath of selected) {
    try {
      // 调用主进程删除文件
      const result = await api.deleteFile(filePath);
      if (result && result.success) {
        // 从状态中移除
        const idx = localSongs.findIndex(s => s.filePath === filePath);
        if (idx >= 0) localSongs.splice(idx, 1);
        const fidx = localFiltered.findIndex(s => s.filePath === filePath);
        if (fidx >= 0) localFiltered.splice(fidx, 1);
        deleted++;
      } else {
        failed++;
        logger.warn('删除失败:', filePath, result?.error);
      }
    } catch (e) {
      failed++;
      logger.warn('删除异常:', filePath, e.message);
    }
  }

  // 更新状态
  setState('localSongs', localSongs);
  setState('localFiltered', localFiltered);
  renderLocalSongs();

  // 关闭弹窗并刷新检测
  const overlay = document.getElementById('dupModal');
  if (overlay) overlay.remove();

  showToast(`删除完成：✅ ${deleted} 成功  ❌ ${failed} 失败`, deleted > 0 ? 'success' : 'warn', 4000);

  // 重新检测
  if (deleted > 0) {
    setTimeout(() => detectDuplicateSongs(), 500);
  }
}

// ══════════════════════════════════════════════════════════
// 批量重命名
// ══════════════════════════════════════════════════════════

function openBatchRename() {
  const count = _selectedLocal.size;
  if (!count) { showToast('请先选择要重命名的歌曲', 'warn'); return; }

  let overlay = document.getElementById('renameModal');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'renameModal';
  overlay.className = 'stats-overlay';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="stats-panel rename-panel">
      <div class="stats-header">
        <span>📝 批量重命名 ${count} 首</span>
        <button onclick="document.getElementById('renameModal').remove()">✕</button>
      </div>
      <div class="stats-body">
        <div class="rename-section">
          <div class="rename-section-title">命名模板</div>
          <div class="rename-hint">
            可用变量：<code>{title}</code> <code>{artist}</code> <code>{album}</code> <code>{track}</code> <code>{num}</code>
          </div>
          <input class="rename-input" id="renameTemplate" value="{artist} - {title}" placeholder="{artist} - {title}">
          <div class="rename-preview-title">预览</div>
          <div class="rename-preview" id="renamePreview"></div>
        </div>
        <div class="rename-section">
          <div class="rename-section-title">选项</div>
          <label class="rename-option">
            <input type="checkbox" id="renameKeepExt" checked> 保留原文件扩展名
          </label>
          <label class="rename-option">
            <input type="checkbox" id="renameSanitize" checked> 自动清理非法字符
          </label>
        </div>
        <div class="rename-actions">
          <button class="rename-cancel" onclick="document.getElementById('renameModal').remove()">取消</button>
          <button class="rename-confirm" onclick="executeBatchRename()">确认重命名</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // 绑定预览更新（先移除旧监听器，避免重复绑定）
  const templateInput = document.getElementById('renameTemplate');
  templateInput.removeEventListener('input', updateRenamePreview);
  templateInput.addEventListener('input', updateRenamePreview);
  updateRenamePreview();
}

function updateRenamePreview() {
  const template = document.getElementById('renameTemplate')?.value || '{artist} - {title}';
  const previewEl = document.getElementById('renamePreview');
  if (!previewEl) return;

  const localSongs = getState('localSongs');
  const selected = Array.from(_selectedLocal).slice(0, 5);
  const previews = selected.map(fp => {
    const song = localSongs.find(s => s.filePath === fp);
    if (!song) return fp;
    const ext = document.getElementById('renameKeepExt')?.checked
      ? path.extname(fp)
      : '';
    return renderRenameTemplate(template, song, 1) + ext;
  });

  previewEl.innerHTML = previews.map(p => `<div class="rename-preview-item">${esc(p)}</div>`).join('');
  if (selected.length < _selectedLocal.size) {
    previewEl.innerHTML += `<div class="rename-preview-more">...还有 ${_selectedLocal.size - selected.length} 首</div>`;
  }
}

function renderRenameTemplate(template, song, num) {
  return template
    .replace(/\{title\}/g, song.title || '未知')
    .replace(/\{artist\}/g, song.artist || '未知艺术家')
    .replace(/\{album\}/g, song.album || '未知专辑')
    .replace(/\{track\}/g, String(num).padStart(2, '0'))
    .replace(/\{num\}/g, String(num));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().substring(0, 200) || '_';
}

async function executeBatchRename() {
  const template = document.getElementById('renameTemplate')?.value;
  if (!template) { showToast('请输入命名模板', 'warn'); return; }

  const keepExt = document.getElementById('renameKeepExt')?.checked;
  const sanitize = document.getElementById('renameSanitize')?.checked;
  const count = _selectedLocal.size;
  if (!count) return;

  const localSongs = getState('localSongs');
  const localFiltered = getState('localFiltered');
  let ok = 0, fail = 0;

  const progressWrap = document.getElementById('batchProgressWrap');
  const progressBar = document.getElementById('batchProgressBar');
  const progressLabel = document.getElementById('batchProgressLabel');
  progressWrap.style.display = 'flex';
  progressBar.style.width = '0%';
  progressLabel.textContent = `正在重命名 (0/${count})`;

  let idx = 0;
  for (const fp of _selectedLocal) {
    idx++;
    const song = localSongs.find(s => s.filePath === fp);
    if (!song) { fail++; continue; }

    try {
      const ext = keepExt ? path.extname(fp) : '';
      let newName = renderRenameTemplate(template, song, idx);
      if (sanitize) newName = sanitizeFilename(newName);
      newName += ext;

      const dir = path.dirname(fp);
      const newPath = path.join(dir, newName);

      if (fp === newPath) { ok++; continue; }

      const result = await api.renameFile(fp, newPath);
      if (result && result.success) {
        // 更新状态
        const s = localSongs.find(x => x.filePath === fp);
        if (s) s.filePath = newPath;
        const fi = localFiltered.findIndex(x => x.filePath === fp);
        if (fi >= 0) localFiltered[fi].filePath = newPath;
        ok++;
      } else {
        fail++;
        logger.warn('重命名失败:', fp, result?.error);
      }
    } catch (e) {
      fail++;
      logger.warn('重命名异常:', fp, e.message);
    }

    progressBar.style.width = Math.round(idx / count * 100) + '%';
    progressLabel.textContent = `正在重命名 (${idx}/${count})`;
  }

  _selectedLocal.clear();
  renderLocalSongs();
  exitLocalSelectionMode();
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';

  const overlay = document.getElementById('renameModal');
  if (overlay) overlay.remove();

  showToast(`重命名完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ══════════════════════════════════════════════════════════
// 批量封面下载（增强：显示进度）
// ══════════════════════════════════════════════════════════

async function batchDownloadCovers() {
  const localSongs = getState('localSongs');
  const needCover = localSongs.filter(s => !s.cover && s.title && s.artist);
  if (!needCover.length) {
    showToast('✅ 所有歌曲都已有封面', 'info');
    return;
  }

  _batchCancelled = false;
  const total = needCover.length;
  let done = 0, ok = 0, fail = 0;

  const progressWrap = document.getElementById('batchProgressWrap');
  const progressBar = document.getElementById('batchProgressBar');
  const progressLabel = document.getElementById('batchProgressLabel');
  progressWrap.style.display = 'flex';
  progressBar.style.width = '0%';
  progressLabel.textContent = `正在下载封面 (0/${total})`;

  for (const s of needCover) {
    if (_batchCancelled) break;
    try {
      const result = await api.fetchOnlineCover(s.title || '', s.artist || '');
      if (result && result.coverBase64) {
        const wr = await api.updateId3Cover(s.filePath, result.coverBase64);
        if (wr && wr.success) {
          s.cover = result.coverBase64;
          const localFiltered = getState('localFiltered');
          const fi = localFiltered.findIndex(x => x.filePath === s.filePath);
          if (fi >= 0) localFiltered[fi].cover = result.coverBase64;
          ok++;
        } else { fail++; }
      } else { fail++; }
    } catch (_e) { fail++; }
    done++;
    progressBar.style.width = Math.round(done / total * 100) + '%';
    progressLabel.textContent = `正在下载封面 (${done}/${total})`;
  }

  _batchCancelled = false;
  progressWrap.style.display = 'none';
  progressBar.style.width = '0%';
  renderLocalSongs();
  showToast(`批量封面下载完成：✅ ${ok} 成功  ❌ ${fail} 失败`, ok > 0 ? 'success' : 'warn', 4000);
}

// ── 多格式转码 ──────────────────────────────────────────
async function convertSelectedAudio() {  try {
    
    const localFiltered = getState('localFiltered');
    const selected = getState('selectedSongs');
    
    let songsToConvert = [];
    if (selected && selected.size > 0) {
    // 使用选中的歌曲
    songsToConvert = Array.from(selected).map(i => localFiltered[i]).filter(Boolean);
    } else if (localFiltered && localFiltered.length > 0) {
    // 使用第一首歌曲
    songsToConvert = [localFiltered[0]];
    }
    
    if (!songsToConvert.length) {
    showToast('请先选择要转换的歌曲', 'warn');
    return;
    }
    
    // 显示格式选择弹窗
    let overlay = document.getElementById('convertModal');
    if (overlay) overlay.remove();
    
    overlay = document.createElement('div');
    overlay.id = 'convertModal';
    overlay.className = 'edit-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
    <div class="edit-panel">
    <div class="edit-header">
    <span class="edit-title">🔄 音频转码</span>
    <button class="edit-close" onclick="document.getElementById('convertModal').remove()">✕</button>
    </div>
    <div class="edit-body">
    <div class="edit-field">
    <label class="edit-label">选择歌曲 (${songsToConvert.length} 首)</label>
    <div style="max-height:120px;overflow-y:auto;margin-top:6px;">
    ${songsToConvert.map((s, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;">
    <input type="checkbox" checked data-convert-idx="${i}" class="convert-checkbox">
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(s.title || '未知')} - ${esc(s.artist || '')}</span>
    <span style="color:var(--neon-dim);font-size:11px;">${(s.ext || '').toUpperCase()}</span>
    </div>
    `).join('')}
    </div>
    </div>
    <div class="edit-field">
    <label class="edit-label">输出格式</label>
    <select class="edit-input" id="convertFormat">
    <option value="mp3">MP3 (通用)</option>
    <option value="flac">FLAC (无损)</option>
    <option value="aac">AAC/M4A</option>
    <option value="ogg">OGG Vorbis</option>
    <option value="wav">WAV (无压缩)</option>
    </select>
    </div>
    <div class="edit-field">
    <label class="edit-label">比特率</label>
    <select class="edit-input" id="convertBitrate">
    <option value="128k">128 kbps</option>
    <option value="192k" selected>192 kbps</option>
    <option value="256k">256 kbps</option>
    <option value="320k">320 kbps</option>
    </select>
    </div>
    </div>
    <div class="edit-footer">
    <button class="edit-btn-cancel" onclick="document.getElementById('convertModal').remove()">取消</button>
    <button class="edit-btn-save" onclick="executeConvert()">开始转换</button>
    </div>
    </div>
    `;
    document.body.appendChild(overlay);
    
  } catch (e) {
    logger.error(`[convertSelectedAudio] error:`, e);
  }
}

async function executeConvert() {
  const format = document.getElementById('convertFormat')?.value || 'mp3';
  const bitrate = document.getElementById('convertBitrate')?.value || '192k';
  const checkboxes = document.querySelectorAll('.convert-checkbox:checked');
  
  if (!checkboxes.length) {
    showToast('请至少选择一首歌曲', 'warn');
    return;
  }

  const localFiltered = getState('localFiltered');
  const songsToConvert = Array.from(checkboxes).map(cb => {
    const idx = parseInt(cb.dataset.convertIdx);
    return localFiltered[idx];
  }).filter(Boolean);

  document.getElementById('convertModal')?.remove();

  let ok = 0, fail = 0;
  for (const song of songsToConvert) {
    try {
      const result = await api.convertAudio({
        inputPath: song.filePath,
        outputFormat: format,
        bitrate,
      });
      if (result.error) {
        showToast(`转换失败: ${result.error}`, 'error');
        fail++;
      } else if (result.canceled) {
        break;
      } else {
        ok++;
      }
    } catch (e) {
      showToast(`转换异常: ${e.message}`, 'error');
      fail++;
    }
  }

  if (ok > 0) {
    showToast(`✅ 成功转换 ${ok} 首${fail > 0 ? `，${fail} 首失败` : ''}`, 'success');
  }
}

// ── 本地库视图清理（切换页面时调用）─────────────────────
function localCleanup() {
  // 关闭编辑弹窗并清理 document click 监听器
  if (document.getElementById('editOverlay') &&
      !document.getElementById('editOverlay').classList.contains('hidden')) {
    closeEdit();
  }
  // 清理拖拽监听器
  teardownDragCover();
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  scanLocalDir,
  filterLocalSongs,
  renderLocalSongs,
  renderLocalGrid,
  toggleLocalView,
  playLocalSong,
  refetchCover,
  batchFetchCovers,
  batchFetchLyrics,
  batchAutoMeta,
  cancelBatchFetch,
  enterLocalSelectionMode,
  exitLocalSelectionMode,
  toggleLocalSelect,
  selectAllLocal,
  deselectAllLocal,
  openBatchEdit,
  openEdit,
  closeEdit,
  closeEditOnBg,
  onEditCoverSelect,
  clearEditCover,
  saveEdit,
  saveBatchEdit,
  showLibraryStats,
  detectDuplicateSongs,
  convertSelectedAudio,
  executeConvert,
  toggleDupSelect,
  selectAllDups,
  deselectAllDups,
  deleteSelectedDups,
  openBatchRename,
  executeBatchRename,
  batchDownloadCovers,
  localCleanup,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.scanLocalDir = scanLocalDir;
window.filterLocalSongs = filterLocalSongs;
window.renderLocalSongs = renderLocalSongs;
window.renderLocalGrid = renderLocalGrid;
window.toggleLocalView = toggleLocalView;
window.playLocalSong = playLocalSong;
window.refetchCover = refetchCover;
window.batchFetchCovers = batchFetchCovers;
window.batchFetchLyrics = batchFetchLyrics;
window.batchAutoMeta = batchAutoMeta;
window.cancelBatchFetch = cancelBatchFetch;
window.enterLocalSelectionMode = enterLocalSelectionMode;
window.exitLocalSelectionMode = exitLocalSelectionMode;
window.toggleLocalSelect = toggleLocalSelect;
window.selectAllLocal = selectAllLocal;
window.deselectAllLocal = deselectAllLocal;
window.openBatchEdit = openBatchEdit;
window.openEdit = openEdit;
window.closeEdit = closeEdit;
window.closeEditOnBg = closeEditOnBg;
window.onEditCoverSelect = onEditCoverSelect;
window.clearEditCover = clearEditCover;
window.saveEdit = saveEdit;
window.saveBatchEdit = saveBatchEdit;
window.showLibraryStats = showLibraryStats;
window.detectDuplicateSongs = detectDuplicateSongs;
window.convertSelectedAudio = convertSelectedAudio;
window.executeConvert = executeConvert;
window.toggleDupSelect = toggleDupSelect;
window.selectAllDups = selectAllDups;
window.deselectAllDups = deselectAllDups;
window.deleteSelectedDups = deleteSelectedDups;
window.openBatchRename = openBatchRename;
window.executeBatchRename = executeBatchRename;
window.batchDownloadCovers = batchDownloadCovers;
window.localCleanup = localCleanup;
