/**
 * 命令面板（Ctrl/⌘+K）—— 键盘一步直达全部核心动作
 *
 * 匹配逻辑 fuzzyScore/rankCommands 为纯函数（node 可单测）：
 * 前缀 > 包含 > ASCII 子序列（中文不做子序列——按字符读音无意义），
 * keywords 兜底拼音/英文/别称。面板本身只是「一个输入框 + 一张表」，
 * 所有动作复用既有 window 桥接，零新增 IPC。
 */

import { logger } from './logger.js';
import { recordRecent, pickRecents } from './paletteRecents.js';

// ── 纯函数 ───────────────────────────────────────────
function fuzzyScore(q, text) {
  if (!q) return 0;
  const t = String(text || '').toLowerCase();
  const s = q.toLowerCase();
  const idx = t.indexOf(s);
  if (idx === 0) return 200;
  if (idx > 0) return 120 - Math.min(50, idx);
  if (/^[\x20-\x7e]+$/.test(s)) {
    let i = 0;
    for (const ch of t) {
      if (ch === s[i]) i++;
      if (i === s.length) return 20;
    }
  }
  return -1;
}

function rankCommands(q, cmds) {
  const query = String(q || '').trim();
  const out = [];
  for (const c of (cmds || [])) {
    if (!c || !c.label) continue;
    let best = fuzzyScore(query, c.label);
    if (best < 0) {
      for (const k of (c.keywords || [])) {
        const s = fuzzyScore(query, k);
        if (s > best) best = s;
      }
    }
    if (query && best < 0) continue;
    out.push({ cmd: c, score: best });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 30).map(x => x.cmd);
}

// ── 命令清单 ─────────────────────────────────────────
function _goto(tab) {
  const btn = document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (btn && typeof window.switchTab === 'function') window.switchTab(tab, btn);
}

function _call(name, ...args) {
  const f = window[name];
  if (typeof f === 'function') return f(...args);
  try { showToast('当前界面不支持该操作', 'warn', 2000); } catch (_e) { /* 无 toast 环境 */ }
}

const COMMANDS = [
  { id: 'nav-home', icon: '🏠', group: '导航', label: '前往 首页', keywords: ['home', '首页'], run: () => _goto('home') },
  { id: 'nav-search', icon: '🔍', group: '导航', label: '前往 搜歌', keywords: ['search', '搜索'], run: () => _goto('search') },
  { id: 'nav-download', icon: '⬇', group: '导航', label: '前往 下载', keywords: ['download', '队列'], run: () => _goto('download') },
  { id: 'nav-local', icon: '📂', group: '导航', label: '前往 本地曲库', keywords: ['local', '本地'], run: () => _goto('local') },
  { id: 'nav-playlist', icon: '💿', group: '导航', label: '前往 歌单', keywords: ['playlist', '收藏'], run: () => _goto('playlist') },
  { id: 'nav-sub', icon: '🔔', group: '导航', label: '前往 订阅', keywords: ['subscription', '更新'], run: () => _goto('subscription') },
  { id: 'sub-check', icon: '📡', group: '下载', label: '立即检查订阅更新（新歌提醒）', keywords: ['subscription check', '订阅', '检查', '新歌'], run: () => _call('subscriptionCheckNow') },
  { id: 'nav-ai', icon: '✨', group: '导航', label: '前往 AI 创作', keywords: ['ai', '生成'], run: () => _goto('ai-music') },
  { id: 'nav-conv', icon: '🎛', group: '导航', label: '前往 格式转换', keywords: ['convert', '转码'], run: () => _goto('converter') },

  { id: 'pl-toggle', icon: '▶⏸', group: '播放', label: '播放 / 暂停', keywords: ['play', 'pause', '暂停'], run: () => _call('togglePlay') },
  { id: 'pl-next', icon: '⏭', group: '播放', label: '下一首', keywords: ['next'], run: () => _call('nextSong') },
  { id: 'pl-prev', icon: '⏮', group: '播放', label: '上一首', keywords: ['prev', 'previous'], run: () => _call('prevSong') },
  { id: 'pl-fav', icon: '♥', group: '播放', label: '收藏 / 取消收藏当前播放的歌', keywords: ['favorite', 'fav', 'heart', '收藏', '红心', '当前播放'], run: () => _call('toggleFavoriteCurrent') },
  { id: 'pl-report', icon: '📈', group: '播放', label: '听歌报告（播放统计）', keywords: ['report', 'stats', '统计'], run: () => _call('generatePlayReport') },
  { id: 'pq-dedupe', icon: '🧹', group: '播放', label: '播放队列去重（保留首次出现）', keywords: ['dedupe', 'queue', '队列', '去重'], run: () => _call('dedupePlayQueue') },
  { id: 'pq-save', icon: '💾', group: '播放', label: '播放队列存为歌单', keywords: ['save', 'queue', 'playlist', '队列', '歌单', '保存'], run: () => _call('saveQueueAsPlaylist') },
  { id: 'pl-lyradv', icon: '⏪', group: '播放', label: '歌词提前 0.5s（偏移 -500ms）', keywords: ['lyric offset', '歌词', '偏移'], run: () => _call('nudgeLyricOffset', -500) },
  { id: 'pl-lyrdly', icon: '⏩', group: '播放', label: '歌词延后 0.5s（偏移 +500ms）', keywords: ['lyric offset', '歌词', '偏移'], run: () => _call('nudgeLyricOffset', 500) },
  { id: 'pl-abloop', icon: '🔁', group: '播放', label: 'A-B 循环：设 A 点 / 设 B 点 / 清除', keywords: ['ab loop', '循环', '片段', '副歌'], run: () => _call('abLoopClick') },
  { id: 'pl-lyedit', icon: '✏️', group: '播放', label: '编辑当前歌曲歌词（本地 .lrc / 在线覆写）', keywords: ['lyric', '歌词', '编辑', 'edit'], run: () => _call('openLyricEditor') },
  { id: 'pl-addsong', icon: '➕', group: '播放', label: '搜索并添加歌曲到当前打开的歌单', keywords: ['playlist', '歌单', '加歌', '添加', 'add song'], run: () => _call('openPlaylistAddSongs') },
  { id: 'pl-psort', icon: '↕', group: '播放', label: '歌单详情排序：默认 / 标题 / 歌手 / 添加时间', keywords: ['playlist', 'sort', '歌单', '排序'], run: () => _call('cyclePlaylistSort') },
  { id: 'pl-cfilter', icon: '🔍', group: '播放', label: '搜索我的歌单（名称/描述过滤卡片）', keywords: ['playlist filter', '歌单', '搜索'], run: () => { _goto('playlist'); const el = document.getElementById('playlistCardFilter'); if (el) setTimeout(() => el.focus(), 80); } },
  { id: 'pl-export', icon: '⤴', group: '播放', label: '导出当前打开的歌单为 m3u', keywords: ['export', 'm3u', '歌单', '导出'], run: () => _call('exportCurrentPlaylistM3u') },
  { id: 'pl-msave', icon: '📥', group: '播放', label: '把平台歌单/专辑弹层勾选歌存为我的歌单（在线引用不下载）', keywords: ['save', '平台歌单', '弹层', '存为歌单', '专辑'], run: () => _call('savePlModalAsPlaylist') },
  { id: 'pl-bulkrm', icon: '☑', group: '播放', label: '歌单详情多选模式：勾选后批量移出歌单', keywords: ['bulk remove', '多选', '批量', '移除', '歌单'], run: () => _call('togglePlBulkMode') },
  { id: 'pl-dlfilt', icon: '⬇', group: '下载', label: '歌单详情切换下载状态过滤（全部/未下载/已下载）', keywords: ['playlist downloaded filter', '未下载', '已下载', '过滤', '歌单'], run: () => _call('cyclePlDlFilter') },
  { id: 'loc-fmt', icon: '🎞', group: '下载', label: '本地曲库格式过滤循环（全部 / 曲库实际存在的格式）', keywords: ['local', 'format', '格式', '本地', 'flac', 'mp3', '过滤'], run: () => { _goto('local'); _call('cycleLocalFmt'); } },
  { id: 'loc-copylist', icon: '📋', group: '下载', label: '复制本地曲库当前视图的曲名清单（一行一首）', keywords: ['copy', 'local', '曲单', '清单', '本地', '复制'], run: () => { _goto('local'); _call('copyLocalListText'); } },
  { id: 'pl-merge', icon: '📥', group: '播放', label: '把其他歌单合并进当前打开的歌单（去重）', keywords: ['merge', '歌单', '合并', '去重'], run: () => _call('openPlaylistMergePicker') },
  { id: 'pl-dedupe', icon: '🧹', group: '播放', label: '清理当前歌单内的重复歌曲（保留首次出现）', keywords: ['dedupe', 'duplicate', '重复', '清理', '歌单'], run: () => _call('dedupeCurrentPlaylist') },
  { id: 'pl-dup', icon: '📋', group: '播放', label: '当前歌单另存副本（整单复制建新歌单，撞名自动让位）', keywords: ['duplicate playlist', 'copy', '副本', '另存', '备份', '歌单'], run: () => _call('duplicateCurrentPlaylist') },
  { id: 'pl-copylist', icon: '📋', group: '播放', label: '复制当前歌单曲名清单（一行一首：歌名 - 歌手）', keywords: ['copy', 'playlist', '曲单', '清单', '复制', '歌单'], run: () => _call('copyPlaylistListText') },
  { id: 'pl-locate', icon: '🎯', group: '播放', label: '在歌单详情中定位正在播放的歌', keywords: ['locate', '定位', '正在播放', '歌单'], run: () => _call('locatePlayingInDetail') },
  { id: 'pq-locate', icon: '🎯', group: '播放', label: '在播放队列面板中定位正在播放的歌（未开自动展开）', keywords: ['queue', 'locate', '定位', '队列', '正在播放'], run: () => _call('locatePlayingInQueue') },
  { id: 'pq-bulkrm', icon: '☑', group: '播放', label: '播放队列多选模式：勾选后批量移出队列', keywords: ['queue', 'bulk remove', '多选', '批量', '移除', '队列'], run: () => _call('togglePqSelMode') },
  { id: 'pl-csort', icon: '↕', group: '播放', label: '歌单卡片排序：默认 / 名称 / 曲数 / 最近更新', keywords: ['playlist', 'card', 'sort', '歌单排序'], run: () => _call('cyclePlCardSort') },
  { id: 'pl-fade', icon: '🌊', group: '播放', label: '播放淡入档位：关 / 0.5s / 1s / 2s', keywords: ['fade', '淡入', '音量', '渐变'], run: () => _call('cycleFadeIn') },
  { id: 'viz-toggle', icon: '📊', group: '播放', label: '频谱可视化开关（进度条下方实时频谱）', keywords: ['visualizer', 'spectrum', '频谱', '可视化'], run: () => _call('toggleVisualizer') },

  { id: 'dl-batch', icon: '📥', group: '下载', label: '批量导入链接', keywords: ['batch', '粘贴'], run: () => _call('openBatchImport') },
  { id: 'dl-namebatch', icon: '🎤', group: '下载', label: '按歌名批量导入（歌手 - 歌名清单）', keywords: ['name batch', '歌名', '文本清单'], run: () => _call('openNameBatch') },
  { id: 'dl-m3u', icon: '📁', group: '下载', label: '导入 m3u 歌单文件（解析后匹配入队）', keywords: ['m3u', 'playlist import', '歌单'], run: () => _call('openM3uImport') },
  { id: 'pl-m3uimp', icon: '📥', group: '下载', label: '导入 m3u 为用户歌单（匹配本地曲库，导入即可播）', keywords: ['m3u', 'playlist', '导入', '歌单', '本地'], run: () => _call('pickM3uForPlaylist') },
  { id: 'dl-retry-failed', icon: '🔁', group: '下载', label: '重试全部失败的历史记录（≤200 条）', keywords: ['retry', '失败', '历史'], run: () => _call('retryFailedFromHistory') },
  { id: 'dl-sched', icon: '⏰', group: '下载', label: '新建定时下载', keywords: ['schedule', '错峰', '夜间'], run: () => _call('openScheduledPanel') },
  { id: 'dl-pause', icon: '⏸', group: '下载', label: '暂停 / 继续下载队列', keywords: ['pause queue'], run: () => _call('toggleQueuePause') },
  { id: 'dl-clear', icon: '🧹', group: '下载', label: '清空已完成任务', keywords: ['clear done'], run: () => _call('clearFinishedDownloads') },
  { id: 'dl-after', icon: '🏁', group: '下载', label: '设置「完成后动作」', keywords: ['shutdown', '关机', '退出'], run: () => _call('openAfterQueueMenu') },
  { id: 'set-search', icon: '🔍', group: '通用', label: '搜索设置项（打开设置面板并聚焦搜索框）', keywords: ['settings', 'search', '设置', '搜索', '限速', '主题'], run: () => _call('focusSettingsSearch') },
  { id: 'dl-trend', icon: '📊', group: '下载', label: '下载趋势（近 14 天）', keywords: ['trend', '趋势', 'history stats'], run: () => _call('showTrendPanel') },
  { id: 'dl-diag', icon: '🆘', group: '下载', label: '诊断最近一个失败任务', keywords: ['diagnose', '失败', 'error'], run: () => _call('diagnoseLatestFailure') },
  { id: 'dl-diagall', icon: '🩹', group: '下载', label: '失败诊断报告（全部失败按原因聚合）', keywords: ['failure report', '批量诊断', '报告'], run: () => _call('openFailureReport') },
  { id: 'dl-summary', icon: '⚡', group: '下载', label: '队列总览（下载中/排队/总速/剩余）', keywords: ['queue summary', '总览', '速度'], run: () => _call('showQueueSummaryToast') },

  { id: 'lc-refresh', icon: '🔄', group: '本地库', label: '刷新本地曲库', keywords: ['rescan', '扫描'], run: () => _call('refreshLocalLibrary') },
  { id: 'lc-stats', icon: '📊', group: '本地库', label: '曲库统计', keywords: ['stats', '统计'], run: () => _call('showLibraryStats') },
  { id: 'lc-dup', icon: '🧬', group: '本地库', label: '查重相同歌曲', keywords: ['duplicate', '重复'], run: () => _call('detectDuplicateSongs') },
  { id: 'lc-cdup', icon: '🧬', group: '本地库', label: '内容级查重（字节哈希找相同副本）', keywords: ['content duplicate', '哈希', '副本'], run: () => _call('detectContentDuplicates') },
  { id: 'lc-locate', icon: '🎯', group: '本地库', label: '定位正在播放的歌（滚动+闪烁）', keywords: ['locate', '定位', '正在播放'], run: () => _call('locatePlayingLocal') },
  { id: 'lc-favonly', icon: '♥', group: '本地库', label: '本地曲库仅看收藏开关', keywords: ['favorite', 'fav', '收藏', '本地', '过滤'], run: () => _call('toggleLocalFavOnly') },
  { id: 'lc-probe', icon: '🔬', group: '本地库', label: '全库音质扫描（查伪无损）', keywords: ['probe', '音质', 'lossless'], run: () => _call('batchProbeQuality') },
  { id: 'lc-m3u', icon: '⤴', group: '本地库', label: '导出曲库为 m3u 歌单（勾选优先）', keywords: ['export', 'm3u', '导出', 'playlist'], run: () => _call('exportLocalM3u') },
  { id: 'lc-agroups', icon: '🎤', group: '本地库', label: '按歌手分组统计曲库（点击即过滤）', keywords: ['artist', '歌手', '分组', 'group'], run: () => _call('showArtistGroups') },
  { id: 'lc-albums', icon: '💿', group: '本地库', label: '按专辑分组统计曲库（点击即过滤）', keywords: ['album', '专辑', '分组', 'group'], run: () => _call('showAlbumGroups') },

  { id: 'misc-sleep', icon: '⏾', group: '其他', label: '睡眠定时（N 分钟后暂停）', keywords: ['sleep timer'], run: () => _call('openSleepTimerMenu') },
  { id: 'misc-sort', icon: '↕', group: '其他', label: '切换搜索结果排序（时长/来源）', keywords: ['sort', '排序', 'duration'], run: () => _call('cycleSearchSort') },
  { id: 'misc-groups', icon: '🔗', group: '其他', label: '查看跨平台同名分组', keywords: ['cross platform', '分组', '同名', '聚合'], run: () => _call('showSongGroupsModal') },
  { id: 'misc-dism', icon: '🚫', group: '其他', label: '已屏蔽管理（不感兴趣列表，可恢复/清空）', keywords: ['dismiss', '屏蔽', '不感兴趣', 'blacklist'], run: () => _call('showDismissedManager') },
  { id: 'misc-artist', icon: '🔍', group: '其他', label: '搜索当前播放歌曲的歌手', keywords: ['artist', '歌手', '搜索'], run: () => {
    const s = typeof window.getState === 'function' ? window.getState('currentPlaying') : null;
    if (s && s.artist) _call('searchArtistSongs', s.artist);
    else showToast('暂无正在播放歌曲的歌手信息', 'warn');
  } },
  { id: 'misc-lsort', icon: '↕', group: '其他', label: '切换本地曲库排序（标题/歌手/时长/大小/播放）', keywords: ['local sort', '本地排序', 'play count'], run: () => _call('cycleLocalSort') },
  { id: 'misc-focus', icon: '🎯', group: '其他', label: '聚焦搜索框', keywords: ['focus', '输入'], run: () => { _goto('search'); const el = document.getElementById('searchInput'); if (el) setTimeout(() => el.focus(), 80); } },
  { id: 'misc-cache', icon: '🗑', group: '其他', label: '清理播放缓存', keywords: ['cache', '缓存'], run: () => _call('clearPlayCache') },
];

// ── 面板 UI ──────────────────────────────────────────
let _open = false;
let _items = [];
let _active = 0;

// 最近使用持久化：localStorage 异常（隐私模式/透明窗禁存储）一律静默
const RECENTS_KEY = 'cmdkRecents';
function _loadRecents() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter(x => typeof x === 'string') : [];
  } catch (_e) { return []; }
}
function _saveRecents(list) {
  try { localStorage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (_e) { /* 存不了就不记 */ }
}

function _ensureOverlay() {
  let el = document.getElementById('cmdkOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cmdkOverlay';
  el.className = 'edit-overlay hidden';
  el.innerHTML = `
    <div class="cmdk-panel">
      <input id="cmdkInput" class="cmdk-input" autocomplete="off" spellcheck="false"
        placeholder="输入命令名 / 拼音 / 别称，回车执行…">
      <div id="cmdkList" class="cmdk-list"></div>
      <div class="cmdk-hint">↑↓ 选择 · Enter 执行 · Esc 关闭 · 随时 Ctrl+K 呼出</div>
    </div>`;
  el.addEventListener('click', (e) => { if (e.target === el) closeCommandPalette(); });
  document.body.appendChild(el);
  const input = el.querySelector('#cmdkInput');
  input.addEventListener('input', () => _refresh(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); _execActive(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeCommandPalette(); }
  });
  return el;
}

function _renderList() {
  const box = document.getElementById('cmdkList');
  if (!box) return;
  box.textContent = '';
  _items.forEach((c, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cmdk-item' + (i === _active ? ' cmdk-active' : '');
    const icon = document.createElement('span');
    icon.className = 'cmdk-icon';
    icon.textContent = c.icon || '·';
    const label = document.createElement('span');
    label.className = 'cmdk-label';
    label.textContent = c.label;
    const group = document.createElement('span');
    group.className = 'cmdk-group';
    group.textContent = c.group || '';
    row.appendChild(icon);
    row.appendChild(label);
    row.appendChild(group);
    row.addEventListener('click', () => _exec(c));
    row.addEventListener('mousemove', () => { if (_active !== i) { _active = i; _highlight(); } });
    box.appendChild(row);
  });
}

function _highlight() {
  const box = document.getElementById('cmdkList');
  if (!box) return;
  [...box.children].forEach((el, i) => el.classList.toggle('cmdk-active', i === _active));
}

function _move(delta) {
  if (!_items.length) return;
  _active = (_active + delta + _items.length) % _items.length;
  _highlight();
  const box = document.getElementById('cmdkList');
  const el = box && box.children[_active];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function _refresh(query) {
  _items = rankCommands(query, COMMANDS);
  if (!String(query || '').trim()) {
    // 空查询（刚呼出）：最近使用置顶，其余保持原序跟在后面
    const rec = pickRecents(_loadRecents(), COMMANDS);
    if (rec.length) {
      const taken = new Set(rec.map(c => c.id));
      _items = rec.concat(_items.filter(c => !taken.has(c.id))).slice(0, 30);
    }
  }
  _active = 0;
  _renderList();
}

function _exec(cmd) {
  _saveRecents(recordRecent(_loadRecents(), cmd && cmd.id));
  closeCommandPalette();
  setTimeout(() => {
    try { cmd.run(); } catch (e) { logger.warn('[cmdk] 命令执行失败:', cmd.id, e && e.message); }
  }, 0);
}

function _execActive() {
  const c = _items[_active];
  if (c) _exec(c);
}

function openCommandPalette() {
  const el = _ensureOverlay();
  el.classList.remove('hidden');
  _open = true;
  const input = document.getElementById('cmdkInput');
  if (input) {
    input.value = '';
    _refresh('');
    setTimeout(() => input.focus(), 30);
  }
}

function closeCommandPalette() {
  if (!_open) return;
  const el = document.getElementById('cmdkOverlay');
  if (el) el.classList.add('hidden');
  _open = false;
}

function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && String(e.key).toLowerCase() === 'k') {
    e.preventDefault();
    if (_open) closeCommandPalette(); else openCommandPalette();
  }
}

if (typeof document !== 'undefined') document.addEventListener('keydown', onGlobalKey);

window.openCommandPalette = openCommandPalette;
window.closeCommandPalette = closeCommandPalette;

export { fuzzyScore, rankCommands, COMMANDS, openCommandPalette, closeCommandPalette };
