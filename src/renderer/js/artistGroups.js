/**
 * 本地曲库「按歌手/专辑分组」弹层（增量68/72）
 *
 * groupArtists / groupAlbums 为纯函数（node 直测）；弹层沿用 historyTrend 的
 * edit-overlay + createElement 模式（textContent 填行，无 innerHTML 注入面）。
 * 点击分组行 = 把名称写进本地过滤框并应用（过滤框本就匹配 artist/album 子串）。
 */

export const UNKNOWN_ARTIST = '未知歌手';
export const UNKNOWN_ALBUM = '未知专辑';

function _groupField(songs, field, unknown) {
  if (!Array.isArray(songs)) return [];
  const map = new Map();
  for (const s of songs) {
    if (!s) continue;
    const name = String(s[field] || '').trim() || unknown;
    let g = map.get(name);
    if (!g) { g = { [field]: name, count: 0, size: 0 }; map.set(name, g); }
    g.count++;
    g.size += +s.fileSize || 0;
  }
  const out = Array.from(map.values());
  out.sort((a, b) => b.count - a.count || a[field].localeCompare(b[field], 'zh'));
  return out;
}

/**
 * @param {Array} songs 本地曲库歌曲（{artist, fileSize} 宽松取数）
 * @returns {Array<{artist:string,count:number,size:number}>} 数量降序、同数按歌手 zh 拼音序
 */
export function groupArtists(songs) {
  return _groupField(songs, 'artist', UNKNOWN_ARTIST);
}

/** 同 groupArtists，按专辑聚合 */
export function groupAlbums(songs) {
  return _groupField(songs, 'album', UNKNOWN_ALBUM);
}

/** 柱宽百分比：非零最少 8%（与趋势面板 barPct 同手感） */
export function groupBarPct(count, max) {
  if (!count || !max || max <= 0) return 0;
  return Math.max(8, Math.round((count / max) * 100));
}

function _fmtBytes(n) {
  if (typeof formatBytes === 'function') return formatBytes(n);
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function _closePanel(id) {
  const el = document.getElementById(id);
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

function _applyLocalFilter(panelId, unknownLabel, value) {
  const input = document.getElementById('localFilter');
  if (input) {
    // 「未知×」桶不对应任何真实字符串：清空过滤看全库
    input.value = value === unknownLabel ? '' : value;
    if (typeof window !== 'undefined' && typeof window.filterLocalSongs === 'function') {
      window.filterLocalSongs();
    }
  }
  if (typeof window !== 'undefined' && typeof window.switchTab === 'function') {
    window.switchTab('local');
  }
  _closePanel(panelId);
}

function _renderPanel({ id, heading, groups, field, unknownLabel }) {
  _closePanel(id);
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'edit-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) _closePanel(id); });

  const panel = document.createElement('div');
  panel.className = 'edit-panel';

  const header = document.createElement('div');
  header.className = 'edit-header';
  const title = document.createElement('span');
  title.className = 'edit-title';
  const totalSongs = groups.reduce((a, g) => a + g.count, 0);
  title.textContent = `${heading} · ${groups.length} 组 / ${totalSongs} 首`;
  const close = document.createElement('button');
  close.className = 'edit-close';
  close.textContent = '✕';
  close.addEventListener('click', () => _closePanel(id));
  header.appendChild(title);
  header.appendChild(close);

  const body = document.createElement('div');
  body.className = 'edit-body';
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;opacity:.6;margin-bottom:8px;';
  hint.textContent = '点击分组 = 用该名称过滤本地曲库';
  body.appendChild(hint);

  const max = groups.reduce((a, g) => Math.max(a, g.count), 0);
  for (const g of groups) {
    const label = g[field];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 4px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,.05);';
    row.title = `过滤：${label}`;
    const name = document.createElement('span');
    name.style.cssText = 'flex:0 0 30%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    name.textContent = label;
    const barWrap = document.createElement('span');
    barWrap.style.cssText = 'flex:1;height:8px;border-radius:4px;background:rgba(255,255,255,.07);overflow:hidden;';
    const bar = document.createElement('span');
    bar.style.cssText = `display:block;height:100%;width:${groupBarPct(g.count, max)}%;background:var(--accent, #4f8cff);border-radius:4px;`;
    barWrap.appendChild(bar);
    const meta = document.createElement('span');
    meta.style.cssText = 'flex:0 0 auto;font-size:11px;opacity:.75;white-space:nowrap;';
    meta.textContent = `${g.count} 首 · ${_fmtBytes(g.size)}`;
    row.appendChild(name);
    row.appendChild(barWrap);
    row.appendChild(meta);
    row.addEventListener('click', () => _applyLocalFilter(id, unknownLabel, label));
    body.appendChild(row);
  }

  panel.appendChild(header);
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
}

function _showGroups(opts) {
  try {
    const songs = (typeof getState === 'function' && getState('localSongs')) || [];
    if (!songs.length) {
      showToast('本地曲库为空，先扫描曲库目录', 'warn', 2500);
      return;
    }
    const groups = opts.groups(songs);
    if (!groups.length) { showToast('暂无可分组的歌曲', 'info'); return; }
    _renderPanel({ ...opts, groups });
  } catch (e) {
    showToast('分组统计失败：' + (e.message || e), 'error');
  }
}

function showArtistGroups() {
  _showGroups({
    id: 'artistOverlay', field: 'artist', unknownLabel: UNKNOWN_ARTIST,
    heading: '🎤 歌手分组', groups: groupArtists,
  });
}

function showAlbumGroups() {
  _showGroups({
    id: 'albumOverlay', field: 'album', unknownLabel: UNKNOWN_ALBUM,
    heading: '💿 专辑分组', groups: groupAlbums,
  });
}

if (typeof document !== 'undefined') {
  window.showArtistGroups = showArtistGroups;
  window.closeArtistGroups = () => _closePanel('artistOverlay');
  window.showAlbumGroups = showAlbumGroups;
  window.closeAlbumGroups = () => _closePanel('albumOverlay');
}
