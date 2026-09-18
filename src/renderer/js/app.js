/**
 * MusicDL 渲染进程入口
 * 初始化、页面切换、事件监听
 * 
 * ES Module 入口 — import 所有子模块确保 Vite 打包完整
 */

// ══════════════════════════════════════════════════════════
// ES Module 导入 — 确保所有模块被 Vite 包含
// ══════════════════════════════════════════════════════════
import { logger } from './logger.js';
// 基础工具模块
import './state.js';
import './toast.js';
import './utils.js';
import './router.js';

// 播放器和快捷键
import { updateProgress, onAudioEnded, parseLrc, showNoLyrics } from './player.js';
import { heartBtnHtml } from './favorites.js';
import './shortcuts.js';

// 播放状态外发同步 + 队列恢复（自 init() 内闭包提出，等价迁移）
import {
  syncToTray, syncToMiniPlayer, resetMiniPlayerSong, syncToDesktopLyric, resetDesktopLyricSong,
  restorePlayQueueFromSaved,
} from './player-sync.js';

// 视图模块
import './views/home.js';
import './views/search.js';
import './views/download.js';
import './views/history.js';
import './views/local.js';
import './views/settings.js';
import './views/ai-music.js';
// 转码公共层要在三个视图之前引入：它们 import 其中的弹窗与 runner
import './converter-core.js';
import './views/converter.js';
import './views/playlist.js';
import './views/subscriptions.js';
import './views/clipboard.js';
import './views/welcome.js';
import './views/dragdrop.js';
import { dlObserveQueue, dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener } from './dlStatus.js';
import './favorites.js';
import './player-controls.js';

// 初始化模块（副作用引入：init.js 内部自挂 window.persistPlayQueue）
import './init.js';
import './i18n.js';
import './logger.js';
import './updater.js';

// ── API 代理 / Mock ───────────────────────────────────
// 使用 Object.assign 让 api 动态指向真实 window.musicAPI（如果 preload 已暴露）
// 先声明 mock，然后在 init() 前根据 window.musicAPI 动态覆盖
const mockApi = {
  getVersion: async () => (window.__APP_VERSION__ || '1.0.0') + (window.__APP_COMMIT__ ? ' (' + window.__APP_COMMIT__.slice(0, 7) + ')' : ''),
  searchMusic: async (k, s) => ({ songs: mockSongs(k, s), source: s }),
  searchAlbum: async () => ({ albums: [], total: 0 }),
  searchSinger: async () => ({ singers: [], total: 0 }),
  getSingerSongs: async () => [],
  getSingerAlbums: async () => ({ albums: [], total: 0 }),
  getAlbumSongs: async () => [],
  // 无 musicAPI 时的开发兜底：平台清单为空 → 渲染层走内置兜底表（utils.js）
  getPlatforms: async () => [],
  getDownloadUrl: async () => ({ url: '' }),
  getDownloadUrlSmart: async () => ({ url: '' }),
  getLyrics: async () => ({ lrc: '' }),
  addToQueue: async (s) => { showToast(`已加入队列: ${s.title}`, 'info'); return { queued: true, taskId: 'mock-' + Date.now() }; },
  cancelDownload: () => {},
  retryDownload: async () => ({ ok: true }),
  removeQueueItem: async () => ({ removed: true }),
  reorderQueueItem: async () => ({ ok: true }),
  clearFinishedQueue: async () => ({ removed: 0 }),
  clearAllQueue: async () => ({ removed: 0 }),
  selectDir: async () => null,
  getDefaultDir: async () => 'C:\\Music',
  getPref: async () => null,
  setPref: async () => {},
  openFolder: () => {},
  openExternal: () => {},
  windowMinimize: () => {},
  windowMaximize: () => {},
  windowClose: () => window.close(),
  onQueueUpdated: () => {},
  onQueuePausedChanged: () => {},
  setQueuePaused: async () => ({ ok: true, paused: false }),
  onDownloadProgress: () => {},
  onDownloadError: () => {},
  onLocalLrcFetched: () => {},
  removeAllListeners: () => {},
  getCookies: async () => ({}),
  saveCookie: async () => ({ saved: true }),
  clearCookie: async () => ({ cleared: true }),
  verifyCookie: async () => ({ valid: false }),
  openLoginWindow: async () => ({ success: false, error: '开发模式不支持一键登录' }),
  scanLocalLibrary: async () => ({ songs: mockLocalSongs(), count: 3 }),
  loadLibraryIndex: async () => ({ songs: mockLocalSongs(), dirPath: '', lastScan: 0 }),
  readLocalMetadata: async () => ({}),
  readLocalLrc: async () => ({ lrc: '' }),
  updateId3Tags: async () => ({ success: true }),
  updateId3Cover: async () => ({ success: true }),
  fetchOnlineCover: async () => ({ success: false, error: '开发模式不支持在线封面' }),
  getHomeRecommendations: async () => ({
    netease: {
      tops: Array.from({length: 8}, (_, i) => ({ id: String(i+1), title: `示例歌曲 ${i+1}`, artist: '示例歌手', album: '示例专辑', cover: '', duration: 240000, source: 'netease' })),
      playlists: Array.from({length: 4}, (_, i) => ({ id: String(i+1), name: `推荐歌单 ${i+1}`, cover: '', playCount: 10000, source: 'netease' })),
    },
    qq: { playlists: Array.from({length: 4}, (_, i) => ({ id: String(i+1), name: `QQ歌单 ${i+1}`, cover: '', playCount: 20000, source: 'qq' })) },
  }),
  getPlaylistSongs: async () => Array.from({length: 5}, (_, i) => ({ id: String(i+1), title: `歌单歌曲 ${i+1}`, artist: '歌手', album: '专辑', cover: '', duration: 200000, source: 'netease' })),
  getHomeSection: async () => ({ ok: true, data: [] }),
  addPlaylistToQueue: async () => ({ queued: 0, skipped: 0 }),
  // 订阅更新
  subscribeList: async () => [],
  subscribeAdd: async (t, p, id, name) => ({ success: true, entry: { key: `${t}:${p}:${id}`, type: t, platform: p, targetId: String(id), name: name || '' } }),
  subscribeRemove: async () => ({ success: true }),
  subscribeUpdate: async () => ({ success: true }),
  subscribeCheck: async () => ({ checked: 0, newTotal: 0 }),
  subscribeMarkSeen: async () => ({ success: true }),
  onSubscriptionsUpdated: () => {},
  onClipboardLink: () => {},
  proxyPlay: async () => ({ fileUrl: '' }),
  queryHistory: async () => ({ items: [], total: 0 }),
  getHistoryStats: async () => ({ total: 0, done: 0, error: 0 }),
  clearHistory: async () => true,
  getCacheSize: async () => '0 B',
  clearPlayCache: async () => ({ cleared: true }),
  batchFetchLyrics: async () => [],
  writeLocalLrc: async () => ({ success: true }),
  checkLocalExists: async () => [],
  savePlayQueue: async () => ({ ok: true }),
  loadPlayQueue: async () => ({ queue: [] }),
  convertAudio: async (opts) => ({ success: false, error: '开发模式不支持转码（需要 ffmpeg）', format: opts && opts.outputFormat }),
  cancelConvertAudio: async () => ({ success: true }),
  onConvertAudioProgress: () => {},
  onPlayQueueRestored: () => {},
  checkForUpdate: async () => ({ success: true }),
  restartAndInstall: () => {},
};

// 优先使用 preload 暴露的真实 musicAPI，否则回退 mock
// 注意：const api 在模块加载时 window.musicAPI 可能还未就绪（ESM 加载顺序问题）
// 所以用 let，在 init() 开头再确认一次
// 用 Object.assign 合并：真实 musicAPI 的方法优先，缺失的方法回退 mock（防止 is not a function 崩溃）
function buildApi() {
  const real = (typeof window.musicAPI !== 'undefined' && window.musicAPI) ? window.musicAPI : null;
  const merged = Object.assign({}, mockApi, real || {});
  if (real) {
    logger.warn('[app.js] buildApi: 使用 REAL musicAPI, 方法数 =', Object.keys(merged).length);
  } else {
    logger.warn('[app.js] buildApi: musicAPI undefined, 使用 mockApi');
  }
  return merged;
}
let api = buildApi();

/** mock 用的来源 id：优先主进程下发的清单，缺失时用 utils.js 的兜底表 */
function _mockSrcIds() {
  const ids = getPlatforms().map(p => p.id);
  return ids.length ? ids : fallbackPlatformIds();
}

// Mock 数据生成
function mockSongs(k, s) {
  return Array.from({ length: 10 }, (_, i) => ({
    id: String(i + 1),
    title: `${k || '示例歌曲'} ${i + 1}`,
    artist: ['周杰伦', '林俊杰', '薛之谦', '邓紫棋', '张杰'][i % 5],
    album: ['专辑A', '专辑B', '专辑C'][i % 3],
    cover: '',
    duration: (3 + i * 0.5) * 60000,
    // 「全部」聚合搜索时给结果轮流打上来源标记。
    // 不再写死 ['netease','qq','bilibili']：优先用主进程清单，缺失时用 utils.js
    // 的兜底表 —— 平台 id 的字面量清单全仓只允许存在于 utils.js 一处。
    source: s === 'all' ? _mockSrcIds()[i % _mockSrcIds().length] : s,
  }));
}

function mockLocalSongs() {
  return [
    { id: 'local1', title: '示例本地歌曲 1', artist: '本地艺术家 A', album: '本地专辑 A', filePath: 'C:\\Music\\song1.mp3', ext: 'mp3', size: 5242880, duration: 240000 },
    { id: 'local2', title: '示例本地歌曲 2', artist: '本地艺术家 B', album: '本地专辑 B', filePath: 'C:\\Music\\song2.flac', ext: 'flac', size: 31457280, duration: 315000 },
    { id: 'local3', title: '示例本地歌曲 3', artist: '本地艺术家 C', album: '本地专辑 C', filePath: 'C:\\Music\\song3.wav', ext: 'wav', size: 52428800, duration: 280000 },
  ];
}

// ── 音频元素（模块级，init 绑定事件后以实参传给 player-sync.js）──
let _audio = null;
// 25s 加载超时守卫状态（事件绑定区使用）
let _loadWatchSince = 0;
let _loadWatchTimer = null;

// ── 初始化 ─────────────────────────────────────────────
async function init() {
  // 如果 init 时 window.musicAPI 还没就绪（理论上 preload 已先执行），动态覆盖
  api = buildApi();
  // 订阅事件接线：视图模块 import 期拿不到 api，只能在 buildApi 之后
  if (typeof wireSubscriptionEvents === 'function') wireSubscriptionEvents();
  if (typeof wireClipboardEvents === 'function') wireClipboardEvents();
  // 启动即拉一次订阅列表：导航红点不依赖用户先访问订阅页
  if (typeof loadSubscriptions === 'function') loadSubscriptions();
  // 首启动新手引导（prefs.welcomeSeen 已设则静默跳过）
  if (typeof maybeShowWelcome === 'function') maybeShowWelcome();

  // 用 setTimeout(0) 确保不阻塞渲染管线
  await new Promise(r => setTimeout(r, 0));

  // 调试：定位 init 哪一步抛错
  try {
    const savedSaveDir = await api.getPref('saveDir');
    if (savedSaveDir) setState('saveDir', savedSaveDir);
    // 未设置过下载目录时显示主进程默认目录（音乐\MusicDownloader），
    // 避免首页路径栏空白让用户误以为必须手动选目录
    document.getElementById('saveDirText').textContent = getState('saveDir') || (await api.getDefaultDir()) || '';

    // 恢复音质选择（此前仅设置页变更时同步，启动时从未恢复）
    try {
      const savedQuality = await api.getPref('quality');
      if (savedQuality) {
        const qs = document.getElementById('qualitySelect');
        if (qs) qs.value = savedQuality;
      }
    } catch (_e) { /* 音质恢复失败使用默认 */ }

    // 恢复主题（尽早应用，避免闪烁）
    try {
      const savedTheme = await api.getPref('theme');
      if (savedTheme && typeof applyTheme === 'function') applyTheme(savedTheme);
    } catch (_e) { /* 主题恢复失败使用默认 */ }

    // 平台清单（v3）：源下拉 / 平台名 / 徽标配色的唯一来源，来自主进程 registry。
    // ⚠️ 必须在 applyTranslations() **之前** —— 本步会重建源下拉 DOM，
    //    若放在之后，新插入的「全部」选项拿不到翻译（设计稿 §4.4 的顺序陷阱）。
    try {
      const platforms = await api.getPlatforms();
      setPlatforms(platforms);
      renderSourceSelect(platforms);
    } catch (_e) {
      logger.warn('[init] 获取平台清单失败，降级到内置兜底表:', _e && _e.message);
      renderSourceSelect(getPlatforms());
    }

    // 加载语言包并应用翻译（applyTranslations 内部自会读一次 language pref）
    try {
      if (window.i18n) await window.i18n.applyTranslations();
    } catch (_e) { /* 忽略 */ }

    // 显示版本号 + commit
    try {
      const versionEl = document.getElementById('appVersion');
      const commitEl = document.getElementById('appCommit');
      const ver = await api.getVersion();
      if (versionEl) versionEl.textContent = ver;
      if (window.__APP_COMMIT__ && commitEl) {
        commitEl.textContent = 'commit ' + window.__APP_COMMIT__.slice(0, 7);
      }
    } catch (_e) { /* 忽略 */ }

    // 恢复命名模板（编辑入口在设置页，这里只同步 state）
    const savedTemplate = await api.getPref('namingTemplate');
    if (savedTemplate) {
      setState('namingTemplate', savedTemplate);
    }

    const savedLocalDir = await api.getPref('localDirPath');
    if (savedLocalDir) setState('localDirPath', savedLocalDir);

    api.onQueueUpdated((queue) => {
      state.set('queueSnapshot', queue);
      renderQueue(queue);
      dlObserveQueue(queue); // 下载状态徽标：吸收 done + 通知列表刷新
    });

    // 托盘切换暂停 → 同步下载页按钮（views/download.js 提供 UI 钩子）
    if (typeof api.onQueuePausedChanged === 'function') {
      api.onQueuePausedChanged((payload) => {
        if (typeof window.applyQueuePausedUi === 'function') {
          window.applyQueuePausedUi(!!(payload && payload.paused));
        }
      });
    }

    api.onDownloadProgress((info) => {
      const { id, progress } = info || {};
      const el = document.getElementById('prog-' + id);
      if (el) el.style.width = progress + '%';
      const meta = document.getElementById('progmeta-' + id);
      if (meta && typeof dlProgressText === 'function') meta.textContent = dlProgressText(info);
    });

    api.onDownloadError(({ title, error, fatal }) => {
      showDownloadError(title, error, fatal);
    });

  api.onLocalLrcFetched(({ filePath, lrc, source }) => {
    if (filePath !== getState('_currentLocalFilePath')) return;
    if (lrc && lrc.trim()) {
      parseLrc(lrc);
      showToast('已在线获取歌词（已保存为同名 .lrc）', 'success', 2200);
    } else {
      showNoLyrics();
      if (source === 'error') showToast('在线拉歌词失败：网络或接口异常', 'error', 2500);
      else showToast('在线未找到该歌曲的歌词', 'info', 2000);
    }
  });

  // 音频事件（独立 try-catch，不被前面的 getPref 失败影响）
  try {
    _audio = document.getElementById('audioPlayer');
    if (_audio) {
      // timeupdate 只注册一次：同时驱动进度条和迷你播放器同步
      // （此前注册了两个 timeupdate，updateProgress 每帧跑两遍）
      _audio.addEventListener('timeupdate', () => {
        updateProgress();
        syncToMiniPlayer(_audio);
        syncToDesktopLyric(_audio);
      });
      _audio.addEventListener('ended', onAudioEnded);
      // 音源加载/解码出错（URL 失效、代理文件损坏）：toast + 跳下一曲，避免静默卡死
      _audio.addEventListener('error', () => {
        const cur = getState('currentPlaying');
        if (!cur || !_audio.error) return;
        showToast('⚠️ 音源播放出错，自动播放下一曲', 'warn', 3000);
        if (typeof window.nextSong === 'function') window.nextSong();
      });
      // 25s 加载超时守卫（借鉴 lx usePlayEvent）：一直没等到可播数据则跳下一曲，
      // 避免 CDN 半开连接导致播放器永久卡死
      _loadWatchTimer = setInterval(() => {
        const cur = getState('currentPlaying');
        const isStuck = cur && _audio.readyState < 2 && !_audio.paused;
        if (isStuck) {
          const now = Date.now();
          if (!_loadWatchSince) _loadWatchSince = now;
          if (now - _loadWatchSince > 25000) {
            _loadWatchSince = 0;
            showToast('⚠️ 音源加载超时，自动播放下一曲', 'warn', 3000);
            if (typeof window.nextSong === 'function') window.nextSong();
          }
        } else {
          _loadWatchSince = 0;
        }
      }, 1000);
      // 页面卸载时停掉守卫定时器，避免遗留 interval
      window.addEventListener('beforeunload', () => {
        if (_loadWatchTimer) clearInterval(_loadWatchTimer);
      });
      _audio.addEventListener('playing', () => { _loadWatchSince = 0; });
      _audio.addEventListener('pause', () => { _loadWatchSince = 0; });
      _audio.addEventListener('pause', () => {
        const icon = document.getElementById('btnPlayIcon');
        if (icon) icon.innerHTML = '<path d="M8 5v14l11-7z" fill="currentColor"/>';
        document.getElementById('btnPlay')?.setAttribute('aria-pressed', 'false');
        document.getElementById('btnPlay')?.classList.remove('buffering');
        document.getElementById('playerCard')?.classList.remove('playing');
        // 暂停姿态：明确表达"是暂停不是卡死"（封面降饱和 + ⏸ 角标）
        if (getState('currentPlaying')) document.getElementById('playerCard')?.classList.add('paused');
        // 状态文案统一按 audio 真实状态推导（不再用 currentPlaying 当判据，
        // 换歌时它可能仍指向旧歌 → 误显示「已暂停」）
        if (typeof refreshPlayerState === 'function') refreshPlayerState();
        if (typeof stopSpectrum === 'function') stopSpectrum();
        syncToMiniPlayer(_audio);
        syncToTray(_audio);
      });
      _audio.addEventListener('play', () => {
        const icon = document.getElementById('btnPlayIcon');
        if (icon) icon.innerHTML = '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>';
        document.getElementById('btnPlay')?.setAttribute('aria-pressed', 'true');
        document.getElementById('playerCard')?.classList.remove('paused');
        document.getElementById('playerCard')?.classList.add('playing');
        if (typeof refreshPlayerState === 'function') refreshPlayerState();
        if (typeof startSpectrum === 'function') startSpectrum();
        syncToMiniPlayer(_audio);
        syncToTray(_audio);
      });
      // 缓冲反馈：waiting/stalled → 播放按钮转圈呼吸；playing/canplay → 恢复
      // （此前缓冲与暂停视觉上无法区分，用户分不清"正在缓冲"还是"出错"）
      _audio.addEventListener('waiting', () => {
        if (getState('currentPlaying')) document.getElementById('btnPlay')?.classList.add('buffering');
      });
      _audio.addEventListener('stalled', () => {
        if (getState('currentPlaying')) document.getElementById('btnPlay')?.classList.add('buffering');
      });
      _audio.addEventListener('playing', () => {
        document.getElementById('btnPlay')?.classList.remove('buffering');
      });
      _audio.addEventListener('canplay', () => {
        document.getElementById('btnPlay')?.classList.remove('buffering');
      });
      _audio.addEventListener('loadedmetadata', () => {
        document.getElementById('timeTotal').textContent = fmtTime(_audio.duration);
      });
    } else {
      // audio 元素不存在，跳过
    }
  } catch (e) {
    logger.warn('[init] 音频事件绑定失败:', e.message);
  }

  // ── 迷你播放器 IPC 监听 ──────────────────────────────
  if (typeof api.openMiniPlayer === 'function') {
    api.onMiniTogglePlay(() => { if (typeof togglePlay === 'function') togglePlay(); });
    api.onMiniNext(() => { if (typeof nextSong === 'function') nextSong(); });
    api.onMiniPrev(() => { if (typeof prevSong === 'function') prevSong(); });
    if (typeof api.onSyncMiniPlayer === 'function') {
      // 歌词窗口/迷你窗口刚打开时要全量状态：清换曲标记强制重推元信息。
      // （原实现直接传 syncToMiniPlayer，回调收不到 audio 参数被 !audio 短路，
      //  迷你窗口首帧永远空白，直到下一次 timeupdate）
      api.onSyncMiniPlayer(() => { resetMiniPlayerSong(); syncToMiniPlayer(_audio); });
    }
  }

  // ── 桌面歌词 IPC 监听（歌词窗口启动时来要一次全量状态）──
  if (typeof api.onSyncDesktopLyric === 'function') {
    api.onSyncDesktopLyric(() => {
      // 强制重推整份歌词（换歌标记重置）
      resetDesktopLyricSong();
      syncToDesktopLyric(_audio);
    });
  }

  // ── 系统托盘 IPC 监听 ──────────────────────────────
  if (typeof api.onTrayTogglePlay === 'function') {
    api.onTrayTogglePlay(() => { if (typeof togglePlay === 'function') togglePlay(); });
    api.onTrayPrev(() => { if (typeof prevSong === 'function') prevSong(); });
    api.onTrayNext(() => { if (typeof nextSong === 'function') nextSong(); });
  }

  // ── 应用菜单 IPC 监听（主进程菜单项经 webContents.send 下发）──
  // 此前渲染层从未注册这两个监听：菜单的「聚焦搜索」「定时停止」是断链的。
  if (window.ipcRenderer && typeof window.ipcRenderer.on === 'function') {
    window.ipcRenderer.on('focus-search', () => {
      const el = document.getElementById('searchInput');
      if (el) { el.focus(); el.select?.(); }
    });
    window.ipcRenderer.on('sleep-timer', (minutes) => {
      if (typeof window.setSleepTimer === 'function') window.setSleepTimer(minutes);
    });
  }

  // ── 播放状态外发同步 / 队列恢复 ──────────────────────
  // 这四个函数已外提到 player-sync.js（等价迁移）：它们原先定义在此处，
  // 仅被 init 调用、彼此互调，故可整体外提；_audio 改为显式传参。
  // 见 src/renderer/js/player-sync.js 与 test/player-sync.test.js。

  // 监听 playQueueRestored 事件（主进程启动时推送）
  api.onPlayQueueRestored((saved) => {
    restorePlayQueueFromSaved(saved);
  });

  // 订阅 playQueue 变化自动持久化
  state.subscribe('playQueue', (queue) => {
    if (Array.isArray(queue)) {
      const playIdx = getState('playIdx');
      const loopMode = getState('loopMode');
      const isShuffled = getState('isShuffled');
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[playQueue] 保存失败:', e));
    }
  });

  // 订阅 playIdx 变化自动持久化
  state.subscribe('playIdx', (playIdx) => {
    const queue = getState('playQueue');
    const loopMode = getState('loopMode');
    const isShuffled = getState('isShuffled');
    if (Array.isArray(queue) && queue.length) {
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[playIdx] 保存失败:', e));
    }
  });

  // 订阅 loopMode 变化自动持久化
  state.subscribe('loopMode', (loopMode) => {
    const queue = getState('playQueue');
    const playIdx = getState('playIdx');
    const isShuffled = getState('isShuffled');
    if (Array.isArray(queue) && queue.length) {
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[loopMode] 保存失败:', e));
    }
  });

  // 订阅 isShuffled 变化自动持久化
  state.subscribe('isShuffled', (isShuffled) => {
    const queue = getState('playQueue');
    const playIdx = getState('playIdx');
    const loopMode = getState('loopMode');
    if (Array.isArray(queue) && queue.length) {
      api.savePlayQueue({ queue, playIdx, loopMode, isShuffled }).catch(e => logger.warn('[isShuffled] 保存失败:', e));
    }
  });

  // 加载已持久化的播放队列（兜底）
  try {
    const saved = await api.loadPlayQueue();
    restorePlayQueueFromSaved(saved);
  } catch (e) {
    logger.warn('[init] 加载播放队列失败:', e.message);
  }

  // 加载首页推荐（失败不阻断主流程）
  loadHomeRecommendations().catch(e => logger.warn('首页推荐加载失败:', e.message));

  // 首页统计概览（本地曲库/已下载/累计收听/最常播放）
  if (typeof window.loadHomeStats === 'function') {
    window.loadHomeStats();
  }

  // 启动时从 prefs 恢复最近播放记录（此前无人调用，刷新后清零）
  if (typeof window.loadRecentlyPlayed === 'function') {
    window.loadRecentlyPlayed()
      .then(() => { if (typeof window.renderRecentlyPlayed === 'function') window.renderRecentlyPlayed(); })
      .catch(e => logger.warn('[init] 最近播放恢复失败:', e.message));
  }

  // 焦点到搜索框
  const searchInput = document.getElementById('searchInput');
  if (searchInput) searchInput.focus();

  showToast('✅ 初始化完成', 'success', 1500);
  } catch (e) {
    logger.error('[init] FATAL:', e);
    if (typeof showToast === 'function') {
      showToast('❌ init 失败 step: ' + (e.message || e), 'error', 8000);
    }
    throw e;
  }
}

// ── 页面切换 ───────────────────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  // btn 缺省时按 data-tab 兜底（程序化/CDP 调用不传事件按钮），找不到不阻断切换
  const navBtn = btn || document.querySelector(`.nav-item[data-tab="${tab}"]`);
  if (navBtn) navBtn.classList.add('active');

  const homePage = document.getElementById('homePage');
  const searchPage = document.getElementById('searchPage');
  const downloadPage = document.getElementById('downloadPage');
  const localPage = document.getElementById('localPage');
  const historyPage = document.getElementById('historyPage');
  const aiMusicPage = document.getElementById('aiMusicPage');
  const converterPage = document.getElementById('converterPage');
  const playlistPage = document.getElementById('playlistPage');
  const subscriptionPage = document.getElementById('subscriptionPage');

  homePage.style.display = 'none';
  searchPage.style.display = 'none';
  downloadPage.style.display = 'none';
  localPage.classList.remove('active');
  // historyPage 已并入 downloadPage 作为子页，路由上 'history' 视为 'download' 的历史子 tab
  if (historyPage) historyPage.style.display = 'none';
  if (aiMusicPage) aiMusicPage.style.display = 'none';
  if (converterPage) converterPage.style.display = 'none';
  if (playlistPage) playlistPage.style.display = 'none';
  if (subscriptionPage) subscriptionPage.style.display = 'none';

  if (tab === 'home') {
    homePage.style.display = 'flex';
    if (!getState('homeRecommendations')) loadHomeRecommendations();
  } else if (tab === 'search') {
    searchPage.style.display = 'flex';
  } else if (tab === 'download' || tab === 'history') {
    downloadPage.style.display = 'flex';
    // 合并页：download → 队列子页；history → 历史子页（Ctrl+H 等旧入口兼容）
    switchDlSubTab(tab === 'history' ? 'history' : 'queue');
  } else if (tab === 'local') {
    localPage.classList.add('active');
    const localSongs = getState('localSongs');
    if (!localSongs || !localSongs.length) scanLocalDir();
  } else if (tab === 'playlist') {
    if (playlistPage) {
      playlistPage.style.display = 'flex';
      if (typeof initPlaylistView === 'function') initPlaylistView();
    }
  } else if (tab === 'subscription') {
    if (subscriptionPage) {
      subscriptionPage.style.display = 'flex';
      if (typeof initSubscriptionView === 'function') initSubscriptionView();
    }
  } else if (tab === 'ai-music') {
    if (aiMusicPage) {
      aiMusicPage.style.display = 'flex';
      if (typeof initAiMusic === 'function') initAiMusic();
    }
  } else if (tab === 'converter') {
    if (converterPage) {
      converterPage.style.display = 'flex';
      if (typeof initConverter === 'function') initConverter();
    }
  }
}

// ── 下载页子 tab（下载队列 / 下载历史 合并页）────────
function switchDlSubTab(sub) {
  const queuePane = document.getElementById('dlQueuePane');
  const historyPane = document.getElementById('historyPage');
  const tabQueue = document.getElementById('dlSubTabQueue');
  const tabHistory = document.getElementById('dlSubTabHistory');
  if (!queuePane || !historyPane) return;
  const showHistory = sub === 'history';
  queuePane.style.display = showHistory ? 'none' : 'flex';
  historyPane.style.display = showHistory ? 'flex' : 'none';
  if (tabQueue) tabQueue.classList.toggle('active', !showHistory);
  if (tabHistory) tabHistory.classList.toggle('active', showHistory);
  // 历史子页首开时拉数据；回队列子页无需刷新（renderQueue 由事件驱动）
  if (showHistory && typeof loadHistory === 'function') loadHistory();
}

async function changeSaveDir() {
  const d = await api.selectDir();
  if (d) {
    setState('saveDir', d);
    document.getElementById('saveDirText').textContent = d;
    await api.setPref('saveDir', d);
  }
}

// ── 命名模板 ──────────────────────────────────────────
// 编辑入口在设置页（settingFilenameTmpl）；此函数保留供设置页保存路径使用
async function saveNamingTemplate(template) {
  await api.setPref('namingTemplate', template);
  setState('namingTemplate', template);
}

// ── 歌单弹层 ──────────────────────────────────────────
async function openPlaylistModal(platform, id, name) {
  document.getElementById('playlistModalTitle').textContent = '📀 ' + name;
  document.getElementById('playlistModal').classList.remove('hidden');
  const body = document.getElementById('playlistModalBody');
  body.innerHTML = '<div class="loading"><div class="spinner"></div> 加载中...</div>';

  state.setPlaylistMeta({ platform, id, name });
  state.setPlaylistSongs([]);

  try {
    const songs = await api.getPlaylistSongs(platform, id, 200);
    if (!songs.length) {
      body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center;">暂无歌曲</div>';
      return;
    }
    state.setPlaylistSongs(songs);
    state.setPlaylistChecked(new Set(songs.map((_, i) => i)));
    state.setPlaylistLocalExists(new Map());
    renderPlaylistModal(songs);

    // 后台检测本地已下载
    const saveDir = getState('saveDir');
    if (saveDir) {
      api.checkLocalExists({
        saveDir,
        items: songs.map(s => ({ title: s.title, artist: s.artist })),
      }).then(results => {
        if (!Array.isArray(results)) return;
        const existsMap = state.getPlaylistLocalExists();
        for (const r of results) {
          const idx = songs.findIndex(s =>
            (s.title || '').trim() === (r.title || '').trim() &&
            (s.artist || '').trim() === (r.artist || '').trim()
          );
          if (idx >= 0) existsMap.set(idx, r.exists);
        }
        const info = document.getElementById('plToolbarInfo');
        if (info) updatePlToolbarInfo();
      }).catch(e => logger.warn('检测本地已下载失败:', e.message));
    }
  } catch (e) {
    body.innerHTML = '<div style="color:var(--red);font-size:12px;padding:16px;text-align:center;">加载失败: ' + esc(e.message) + '</div>';
  }
}

function closePlaylistModal() {
  document.getElementById('playlistModal').classList.add('hidden');
  state.setPlaylistChecked(new Set());
  state.setPlaylistLocalExists(new Map());
}

function closePlaylistModalOnBg(e) {
  if (e.target === document.getElementById('playlistModal')) closePlaylistModal();
}

// ── 歌单弹层渲染 ──────────────────────────────────────
function renderPlaylistModal(songs) {
  const body = document.getElementById('playlistModalBody');
  const checkedCount = state.getPlaylistChecked().size;
  const localCount = Array.from(state.getPlaylistLocalExists().values()).filter(Boolean).length;
  const dlQueue = getState('queueSnapshot') || [];
  dlEnsureHistoryLoaded(); // 跨会话"已下载"懒回填，加载完成后经监听器重渲染

  const toolbar = `
    <div class="pl-toolbar">
      <label class="pl-toolbar-item">
        <input type="checkbox" id="plSelectAll" ${checkedCount === songs.length && songs.length > 0 ? 'checked' : ''} onchange="toggleSelectAll(this.checked)">
        <span>全选</span>
      </label>
      <span class="pl-toolbar-info" id="plToolbarInfo">已选 ${checkedCount} / ${songs.length}，本地已存在 ${localCount}</span>
      <div class="pl-toolbar-actions">
        <button class="btn-sm" onclick="invertSelection()">反选</button>
        <button class="btn-sm" id="plSubscribeBtn" title="新歌发布时提醒我" onclick="subscribeCurrentPlaylist()">📡 订阅</button>
        <button class="btn-sm" onclick="addPlaylistToQueueClick(false)">加入队列</button>
        <button class="btn-sm" onclick="addPlaylistToQueueClick(true)">仅未下载</button>
      </div>
    </div>
  `;

  const list = songs.map((s, i) => {
    const localExists = state.getPlaylistLocalExists().get(i) === true;
    const isChecked = state.getPlaylistChecked().has(i);
    return `
    <div class="top-song-row pl-row ${localExists ? 'pl-row-exists' : ''}" data-idx="${i}">
      <input type="checkbox" class="pl-checkbox" data-idx="${i}" ${isChecked ? 'checked' : ''} onchange="toggleSongCheck(${i}, this.checked)">
      <span class="top-song-rank">${i + 1}</span>
      <div class="top-song-info">
        <div class="top-song-title">${esc(s.title)} ${localExists ? '<span class="pl-tag-local">本地</span>' : ''}</div>
        <div class="top-song-artist">${esc(s.artist)}${s.album ? ' · ' + (s.albumMid
          ? `<span class="album-link" onclick="openAlbumView('${escQ(s.albumMid)}','${escQ(s.source)}','${escQ(s.album)}')">${esc(s.album)}</span>`
          : esc(s.album)) : ''}</div>
      </div>
      <span class="source-badge badge-${badgeCls(s.source)}">${esc(srcLabel(s.source))}</span>
      ${dlBadgeHtml(s, dlQueue)}
      <button class="top-song-action" title="播放" onclick="event.stopPropagation();playRecommendSong(state.getPlaylistSongs()[${i}])">▶</button>
      ${heartBtnHtml(s, 'top-song-action')}
      <button class="top-song-action" title="下载" onclick="event.stopPropagation();addSingleToQueue(${i})">⬇</button>
    </div>
  `;
  }).join('');

  body.innerHTML = toolbar + list;
  updatePlToolbarInfo();
}

// 弹层打开期间队列/历史变化 → 防抖重渲染徽标（勾选与本地检测结果均从 state 还原，不丢失）
let _plDlTimer = null;
addDlChangeListener(() => {
  const modal = document.getElementById('playlistModal');
  if (!modal || modal.classList.contains('hidden') || _plDlTimer) return;
  _plDlTimer = setTimeout(() => {
    _plDlTimer = null;
    const songs = state.getPlaylistSongs();
    if (songs.length) renderPlaylistModal(songs);
  }, 300);
});

function updatePlToolbarInfo() {
  const el = document.getElementById('plToolbarInfo');
  if (!el) return;
  const total = state.getPlaylistSongs().length;
  const checked = state.getPlaylistChecked().size;
  const localCount = Array.from(state.getPlaylistLocalExists().values()).filter(Boolean).length;
  el.textContent = `已选 ${checked} / ${total}，本地已存在 ${localCount}`;
}

function toggleSelectAll(checked) {
  const checkedSet = state.getPlaylistChecked();
  checkedSet.clear();
  if (checked) {
    for (let i = 0; i < state.getPlaylistSongs().length; i++) checkedSet.add(i);
  }
  document.querySelectorAll('#playlistModalBody .pl-checkbox').forEach(cb => { cb.checked = checked; });
  updatePlToolbarInfo();
}

function toggleSongCheck(idx, checked) {
  const checkedSet = state.getPlaylistChecked();
  if (checked) checkedSet.add(idx);
  else checkedSet.delete(idx);
  const all = document.getElementById('plSelectAll');
  if (all) all.checked = checkedSet.size === state.getPlaylistSongs().length;
  updatePlToolbarInfo();
}

function invertSelection() {
  const checkedSet = state.getPlaylistChecked();
  const songs = state.getPlaylistSongs();
  for (let i = 0; i < songs.length; i++) {
    if (checkedSet.has(i)) checkedSet.delete(i);
    else checkedSet.add(i);
  }
  document.querySelectorAll('#playlistModalBody .pl-checkbox').forEach((cb, idx) => {
    cb.checked = checkedSet.has(idx);
  });
  const all = document.getElementById('plSelectAll');
  if (all) all.checked = checkedSet.size === songs.length;
  updatePlToolbarInfo();
}

// 歌单来源歌曲的额外命名元数据，供 {trackNo}/{trackTotal}/{playlist} 模板变量取值
function playlistTaskMeta(idx) {
  const meta = state.getPlaylistMeta();
  const songs = state.getPlaylistSongs();
  return {
    playlistName: (meta && meta.name) || '',
    trackNo: idx + 1,
    trackTotal: songs.length,
  };
}

async function addSingleToQueue(idx) {
  const s = state.getPlaylistSongs()[idx];
  if (!s) return;
  try {
    const saveDir = getState('saveDir');
    const task = { ...s, ...playlistTaskMeta(idx), saveDir, quality: resolveQuality(s.source) };
    const r = await api.addToQueue(task);
    if (r && r.duplicated) {
      showToast(`「${s.title}」已在下载队列中`, 'warn', 2500);
      return;
    }
    if (r && r.alreadyDownloaded) {
      showRedownloadToast(s.title, r.finishedAt, () => {
        api.addToQueue({ ...task, forceRedownload: true })
          .then(() => showToast(`「${s.title}」已加入下载队列`, 'success'))
          .catch(e => showToast('加入失败: ' + e.message, 'error'));
      });
      return;
    }
    showToast(`「${s.title}」已加入下载队列`, 'success');
  } catch (e) {
    showToast('加入失败: ' + e.message, 'error');
  }
}

async function addPlaylistToQueueClick(skipExisting) {
  const checkedSet = state.getPlaylistChecked();
  if (checkedSet.size === 0) {
    showToast('请先勾选要下载的歌曲', 'warn');
    return;
  }
  let toAdd = Array.from(checkedSet).sort((a, b) => a - b)
    .map(idx => ({ s: state.getPlaylistSongs()[idx], idx }))
    .filter(x => x.s);
  let skipped = 0;
  if (skipExisting) {
    const filtered = [];
    const existsMap = state.getPlaylistLocalExists();
    for (const { s, idx } of toAdd) {
      if (existsMap.get(idx) === true) skipped++;
      else filtered.push({ s, idx });
    }
    toAdd = filtered;
  }
  if (!toAdd.length) {
    showToast('没有可加入的歌曲（全部已下载）', 'info');
    return;
  }
  try {
    const saveDir = getState('saveDir');
    // 每首歌按自身平台解析：分平台模板优先，未定制的平台沿用搜索栏选择
    const payload = { songs: toAdd.map(({ s, idx }) => ({ ...s, ...playlistTaskMeta(idx), saveDir, quality: resolveQuality(s.source) })) };
    const r = await api.addPlaylistToQueue(payload);
    const dlSkipped = r && r.skippedDownloaded ? r.skippedDownloaded : 0;
    let msg = `已加入 ${r.queued} 首`;
    const skippedParts = [];
    if (skipped) skippedParts.push(`跳过 ${skipped} 首队内重复`);
    if (dlSkipped) skippedParts.push(`跳过 ${dlSkipped} 首已下载过`);
    if (skippedParts.length) msg += `（${skippedParts.join('，')}）`;
    showToast(msg, 'success');
    checkedSet.clear();
    renderPlaylistModal(state.getPlaylistSongs());
  } catch (e) {
    logger.error('[addPlaylistToQueue] 失败:', e);
    showToast('批量加入失败: ' + (e.message || e), 'error');
  }
}

async function downloadSongFromList(s) {
  showToast(`⏳ 正在获取 ${s.title} 的下载链接...`, 'info', 2000);
  try {
    const result = await api.getDownloadUrl(s.id, s.source, 'standard');
    if (result && result.url) {
      showToast(`✅ 已获取下载链接`, 'success', 4000);
      document.getElementById('searchInput').value = `${s.title} ${s.artist}`;
      const searchNav = document.querySelector('.nav-item[data-tab="search"]');
      if (searchNav) switchTab('search', searchNav);
    } else {
      showToast('⚠️ 暂无法获取下载链接', 'warn', 3000);
    }
  } catch (e) {
    logger.warn('获取下载链接失败:', e);
    showToast('⚠️ 获取下载链接失败', 'warn', 3000);
  }
}

// ── 事件委托架设 ──────────────────────────────────────
(function setupPlaylistModalDelegate() {
  const body = document.getElementById('playlistModalBody');
  if (!body) return;
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="play-recommend"], [data-action="download-recommend"]');
    if (!btn) return;
    e.stopPropagation();
    const songs = state.getPlaylistSongs();
    const s = songs[Number(btn.dataset.idx)];
    if (!s) return;
    if (btn.dataset.action === 'play-recommend') playRecommendSong(s);
    else downloadSongFromList(s);
  });
})();

// ── 专辑详情（复用歌单弹窗）───────────────────────────
async function openAlbumView(albumMid, source, albumName) {
  document.getElementById('playlistModalTitle').textContent = '💿 ' + (albumName || '专辑');
  document.getElementById('playlistModal').classList.remove('hidden');
  const body = document.getElementById('playlistModalBody');
  body.innerHTML = '<div class="loading"><div class="spinner"></div> 加载专辑中...</div>';

  state.setPlaylistMeta({ platform: source, id: albumMid, name: albumName || '专辑' });
  state.setPlaylistSongs([]);

  try {
    const songs = await api.getAlbumSongs(source || 'qq', albumMid, 200);
    if (!songs.length) {
      body.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:16px;text-align:center;">暂无歌曲</div>';
      return;
    }
    state.setPlaylistSongs(songs);
    state.setPlaylistChecked(new Set(songs.map((_, i) => i)));
    state.setPlaylistLocalExists(new Map());
    renderPlaylistModal(songs);

    const saveDir = getState('saveDir');
    if (saveDir) {
      api.checkLocalExists({
        saveDir,
        items: songs.map(s => ({ title: s.title, artist: s.artist })),
      }).then(results => {
        if (!Array.isArray(results)) return;
        const existsMap = state.getPlaylistLocalExists();
        for (const r of results) {
          const idx = songs.findIndex(s =>
            (s.title || '').trim() === (r.title || '').trim() &&
            (s.artist || '').trim() === (r.artist || '').trim()
          );
          if (idx >= 0) existsMap.set(idx, r.exists);
        }
        const info = document.getElementById('plToolbarInfo');
        if (info) updatePlToolbarInfo();
      }).catch(e => logger.warn('检测本地已下载失败:', e.message));
    }
  } catch (e) {
    body.innerHTML = `<div style="color:var(--accent);font-size:12px;padding:16px;text-align:center;">⚠️ 加载失败: ${esc(e.message)}</div>`;
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  init,
  switchTab,
  switchDlSubTab,
  changeSaveDir,
  openPlaylistModal,
  closePlaylistModal,
  closePlaylistModalOnBg,
  renderPlaylistModal,
  updatePlToolbarInfo,
  toggleSelectAll,
  toggleSongCheck,
  invertSelection,
  addSingleToQueue,
  addPlaylistToQueueClick,
  downloadSongFromList,
  openAlbumView,
  api,
}

// ── 全局桥接（HTML onclick 兼容）─────────────────────
// 使用 getter 让 window.api 始终指向当前 api（可能已被真实 musicAPI 替换）
Object.defineProperty(window, 'api', {
  get() { return api; },
  configurable: true,
});
window.init = init;
window.switchTab = switchTab;
window.switchDlSubTab = switchDlSubTab;
window.changeSaveDir = changeSaveDir;
window.openPlaylistModal = openPlaylistModal;
window.closePlaylistModal = closePlaylistModal;
window.closePlaylistModalOnBg = closePlaylistModalOnBg;
window.renderPlaylistModal = renderPlaylistModal;
window.updatePlToolbarInfo = updatePlToolbarInfo;
window.toggleSelectAll = toggleSelectAll;
window.toggleSongCheck = toggleSongCheck;
window.invertSelection = invertSelection;
window.addSingleToQueue = addSingleToQueue;
window.addPlaylistToQueueClick = addPlaylistToQueueClick;
window.downloadSongFromList = downloadSongFromList;
window.openAlbumView = openAlbumView;
window.saveNamingTemplate = saveNamingTemplate;

// ── 播放队列面板 ────────────────────────────────────
let _pqVisible = false;
window.togglePlayQueue = () => {
  const panel = document.getElementById('pqPanel');
  const btn = document.getElementById('btnQueueToggle');
  const bar = document.getElementById('pcQueueBar');
  const chev = document.getElementById('pcQueueChev');
  if (!panel) return;
  _pqVisible = !_pqVisible;
  // 用 .open 类而非内联 display：过渡动画与 :has(.open) 的卡片让位都依赖它
  panel.classList.toggle('open', _pqVisible);
  panel.style.display = '';
  if (btn) btn.classList.toggle('active', _pqVisible);
  if (bar) bar.setAttribute('aria-expanded', String(_pqVisible));
  if (chev) chev.textContent = _pqVisible ? '收起' : '展开';
  renderPlayQueueUI();
};

function renderPlayQueueUI() {
  const list = document.getElementById('pqList');
  const count = document.getElementById('pqCount');
  const badge = document.getElementById('pqBadge');
  const thumbs = document.getElementById('pcQueueThumbs');
  if (!list) return;
  const queue = getState('playQueue') || [];
  const playIdx = getState('playIdx') || 0;
  const NOTE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">'
    + '<path d="M9 19a3 3 0 1 1-2-2.83V7l10-2v7.17A3 3 0 1 0 19 15V3L7 5v12.17Z"/></svg>';
  if (queue.length === 0) {
    list.innerHTML = '<div class="pq-empty">'
      + '<div class="pq-empty-icon"><svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor">'
      + '<path d="M9 19a3 3 0 1 1-2-2.83V7l10-2v7.17A3 3 0 1 0 19 15V3L7 5v12.17Z"/></svg></div>'
      + '暂无播放歌曲<br><span class="pq-empty-hint">点击歌曲播放以添加</span></div>';
  } else {
    list.innerHTML = queue.map((s, i) => {
      const isCur = i === playIdx;
      const cover = s.cover
        ? '<img class="pq-thumb" src="' + escAttr(s.cover) + '" alt="" loading="lazy">'
        : '<span class="pq-thumb-ph">' + NOTE_SVG + '</span>';
      return '<div class="pq-item' + (isCur ? ' playing' : '') + '" onclick="window._playQueueIdx(' + i + ')">'
        + '<span class="pq-idx">' + (i + 1) + '</span>'
        + cover
        + '<span class="pq-item-main">'
        + '<span class="pq-item-title">' + esc(s.title || '') + '</span>'
        + '<span class="pq-item-artist">' + esc(s.artist || '') + '</span>'
        + '</span>'
        + '<span class="pq-dur">' + fmtDuration(s.duration) + '</span>'
        + '</div>';
    }).join('');
  }
  if (count) count.textContent = queue.length;
  if (badge) badge.textContent = queue.length > 0 ? String(queue.length) : '';
  // 常驻条缩略图：队列前 3 首里有封面的（叠放展示）
  if (thumbs) {
    thumbs.innerHTML = queue.filter((s) => s.cover).slice(0, 3).map((s) =>
      '<img class="pc-queue-thumb" src="' + escAttr(s.cover) + '" alt="">').join('');
  }
}

window._playQueueIdx = (idx) => {
  const queue = getState('playQueue') || [];
  if (idx < 0 || idx >= queue.length) return;
  setState('playIdx', idx);
  const audio = document.getElementById('audioPlayer');
  if (audio && queue[idx].url) {
    audio.src = queue[idx].url;
    audio.play().catch(e => logger.warn('[pq] play failed:', e));
    setState('currentPlaying', queue[idx]);
  }
};

window.clearPlayQueue = () => {
  // setState 订阅会自动刷新 UI（playQueue + playIdx 各触发一次），
  // 原先这里再显式 renderPlayQueueUI() 是第三次重绘，删除
  setState('playQueue', []);
  setState('playIdx', 0);
  setState('currentPlaying', null);
  showToast('播放队列已清空', 'info');
};

// 监听 playQueue 变化自动刷新 UI
state.subscribe('playQueue', () => renderPlayQueueUI());
state.subscribe('playIdx', () => renderPlayQueueUI());

// ── 启动入口（ES Module 自动 defer，DOM 已就绪）───────
// ESM 脚本默认 defer，DOMContentLoaded 触发时脚本已执行完毕
// 但为确保兼容性依然监听
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setTimeout(() => {
    if (typeof init === 'function' && !window._initCalled) {
      window._initCalled = true;
      init().catch(e => logger.error('[init] 异常:', e));
    }
  }, 0);
}

document.addEventListener('DOMContentLoaded', () => {
  if (!window._initCalled) {
    window._initCalled = true;
    init().catch(e => logger.error('[init] 异常:', e));
  }
});
