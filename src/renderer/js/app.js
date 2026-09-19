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
import { updateProgress, onAudioEnded, parseLrc, showNoLyrics, loadAndPlay, playQueueIdx } from './player.js';
import { initMediaSession } from './player/mediaSession.js';
import { heartBtnHtml, queueFavSong } from './favorites.js';
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
import './views/batchImport.js';
import './views/nameBatch.js';
import './views/welcome.js';
import './views/dragdrop.js';
import { dlObserveQueue, dlBadgeHtml, dlEnsureHistoryLoaded, addDlChangeListener } from './dlStatus.js';
import { openSongRowMenu } from './songMenu.js';
import './favorites.js';
import './player-controls.js';
import './sleepTimer.js';
import './playQueueSort.js';
import { removeQueueItem, removeQueueItemsByIdentity, dedupeQueue } from './playQueueEdit.js';
import { queueToSongs, defaultQueuePlaylistName, pickPlSavableRows } from './queuePlaylist.js';
import './afterQueueDone.js';
import './autoLyricOnDone.js';
import './autoCoverOnDone.js';
import './m3uToPlaylist.js';
import { sanitizeSavedQueue } from './dropPlay.js';
import { pickCheckedSongs, toPlaylistRows, buildSavedPlaylist } from './plModalSave.js';
import './scheduledDownload.js';
import './commandPalette.js';
import './historyTrend.js';
import './artistGroups.js';
import './dismissed.js';
import './diagnose.js';
import './queueSummary.js';
import './lyricNudge.js';
import './abLoop.js';
import './player/fade.js';
import './player/visualizer.js';
import { resolvePlayingIndex, flashRow } from './locatePlaying.js';
import './songGroups.js';

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
  getSongByLink: async () => ({ song: null, link: null }),
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
  onLocalLibraryChanged: () => {},
  setQueuePaused: async () => ({ ok: true, paused: false }),
  systemPower: async () => ({ ok: true }),
  probeAudio: async () => ({ error: '开发模式不支持实测' }),
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
// 用 Object.assign 合并：真实 musicAPI 的方法优先；仅浏览器预览环境缺失的方法回退 mock
function buildApi() {
  const real = (typeof window.musicAPI !== 'undefined' && window.musicAPI) ? window.musicAPI : null;
  // mock 只服务于纯浏览器预览（vite http）场景；打包/Electron 是 file://，
  // 桥接缺失时必须明确失败（checkAPI 会提示"音乐API未加载"），
  // 绝不允许静默假成功（审计发现：mock 兜底让 preload 故障整体隐身）
  const allowMock = location.protocol.startsWith('http');
  const merged = allowMock ? Object.assign({}, mockApi, real || {}) : Object.assign({}, real || {});
  if (real) {
    logger.warn('[app.js] buildApi: 使用 REAL musicAPI, 方法数 =', Object.keys(merged).length);
  } else if (allowMock) {
    logger.warn('[app.js] buildApi: musicAPI undefined（浏览器预览，使用 mockApi）');
  } else {
    logger.error('[app.js] buildApi: musicAPI undefined 且非预览环境，桥接加载失败');
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
      if (typeof window.afterQueueObserve === 'function') window.afterQueueObserve(queue); // 完成后动作检测
      if (typeof window.autoLyricObserve === 'function') window.autoLyricObserve(queue); // 自动补歌词存 .lrc（autoLyric 开关）
      if (typeof window.autoCoverObserve === 'function') window.autoCoverObserve(queue); // 自动嵌封面（autoCover 开关，探测不覆写）
    });

    // 托盘切换暂停 → 同步下载页按钮（views/download.js 提供 UI 钩子）
    if (typeof api.onQueuePausedChanged === 'function') {
      api.onQueuePausedChanged((payload) => {
        if (typeof window.applyQueuePausedUi === 'function') {
          window.applyQueuePausedUi(!!(payload && payload.paused));
        }
      });
    }

    // 本地曲库目录变动（主进程 fs.watch 防抖推送）→ 静默增量重扫
    if (typeof api.onLocalLibraryChanged === 'function') {
      api.onLocalLibraryChanged(() => {
        if (typeof window.refreshLocalLibrary === 'function') {
          window.refreshLocalLibrary();
        }
      });
    }

    api.onDownloadProgress((info) => {
      const { id, progress } = info || {};
      const el = document.getElementById('prog-' + id);
      if (el) el.style.width = progress + '%';
      const meta = document.getElementById('progmeta-' + id);
      if (meta && typeof dlProgressText === 'function') meta.textContent = dlProgressText(info);
      if (typeof window.recordDlProgress === 'function') window.recordDlProgress(info);
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

  // ── 系统级「正在播放」（Media Session：音量浮窗/锁屏曲目 + 媒体键 actionHandler）──
  try { initMediaSession(); } catch (e) { logger.warn('[init] mediaSession 初始化失败:', e.message); }

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
    restorePlayQueueFromSaved(sanitizeSavedQueue(saved));
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
    restorePlayQueueFromSaved(sanitizeSavedQueue(saved));
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
        <button class="btn-sm" onclick="playPlaylistModalAll()">▶ 播放全部</button>
        <button class="btn-sm" onclick="invertSelection()">反选</button>
        <button class="btn-sm" id="plSubscribeBtn" title="新歌发布时提醒我" onclick="subscribeCurrentPlaylist()">📡 订阅</button>
        <button class="btn-sm" onclick="addPlaylistToQueueClick(false)">加入队列</button>
        <button class="btn-sm" onclick="addPlaylistToQueueClick(true)">仅未下载</button>
        <button class="btn-sm" title="把勾选的歌新建为「我的歌单」（在线引用，不下载）" onclick="savePlModalAsPlaylist()">📥 存为歌单</button>
        <button class="btn-sm" title="把勾选的歌加入某个已有歌单（引擎端自动去重）" onclick="addPlModalToPlaylist()">➕ 加进歌单</button>
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
      <button class="top-song-action" title="播放" onclick="event.stopPropagation();playPlaylistModalSong(${i})">▶</button>
      ${heartBtnHtml(s, 'top-song-action')}
      <button class="top-song-action" title="下载" onclick="event.stopPropagation();addSingleToQueue(${i})">⬇</button>
    </div>
  `;
  }).join('');

  body.innerHTML = toolbar + list;
  updatePlToolbarInfo();
}

// ── 弹层整单连播 ──────────────────────────────────────
// 语义对齐 playlist.js 的 playPlaylistSong：智能取流换源回写 _altSource、
// proxyPlay 本地化流量、整单进 playQueue 从点击曲连播（而非孤播一首）。
// 请求序号做竞态守卫，快速连点只认最后一次。
let _plModalPlayRequestId = 0;
async function playPlaylistModalSong(idx) {
  const songs = state.getPlaylistSongs();
  const song = songs[idx];
  if (!song) { showToast('未找到歌曲', 'warn'); return; }
  const quality = resolveQuality(song.source);
  showToast(`正在准备音源：${song.title}`, 'info');
  const reqId = ++_plModalPlayRequestId;
  try {
    const result = await api.getDownloadUrlSmart(song, quality);
    if (reqId !== _plModalPlayRequestId) return;
    if (!result || !result.url) {
      if (result && result.code === 'VIP_REQUIRED') {
        showToast('⚠️ 该歌曲为 VIP 专享，请登录后重试', 'warn', 5000);
      } else {
        showToast('⚠️ 暂无法获取音源，请稍后重试', 'warn', 5000);
      }
      return;
    }
    if (result.matchedSong) {
      showToast(`🎵 本源不可用，已切换到${result.matchedSong.source}音源`, 'info', 3000);
      song._altSource = { source: result.matchedSong.source, id: String(result.matchedSong.id) };
    }
    song._playedQuality = quality;
    const playSource = result.matchedSong?.source || song.source;
    const referer = playReferer(playSource, result);
    const proxied = await api.proxyPlay(result.url, referer);
    if (reqId !== _plModalPlayRequestId) return;
    if (!proxied || !proxied.fileUrl) {
      showToast('⚠️ 音源获取失败', 'error', 5000);
      return;
    }
    setState('playQueue', songs.slice());
    setState('playIdx', idx);
    setState('currentPlaying', song);
    await loadAndPlay(song, proxied.fileUrl, true);
    showToast('▶ 正在播放：' + song.title, 'success', 2500);
  } catch (e) {
    if (reqId === _plModalPlayRequestId) {
      logger.warn('弹层播放失败:', e);
      showToast('⚠️ 播放失败：' + (e.message || e), 'error', 4000);
    }
  }
}

/** 「▶ 播放全部」：整单进队列从第一首连播 */
async function playPlaylistModalAll() {
  const songs = state.getPlaylistSongs();
  if (!songs.length) { showToast('歌单为空', 'warn'); return; }
  await playPlaylistModalSong(0);
}

// ── 弹层行右键菜单（业务项在 ./songMenu.js 共享）──────
document.addEventListener('contextmenu', (e) => {
  const body = document.getElementById('playlistModalBody');
  const row = e.target && e.target.closest ? e.target.closest('.pl-row') : null;
  if (!body || !row || !body.contains(row)) return;
  const idx = Number(row.getAttribute('data-idx'));
  const song = state.getPlaylistSongs()[idx];
  if (!song) return;
  openSongRowMenu(e, song, {
    play: () => playPlaylistModalSong(idx),
    download: () => addSingleToQueue(idx),
  });
});

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

// ── 弹层勾选 → 我的歌单（增量98，plModalSave 纯函数的接线层）──────
async function savePlModalAsPlaylist() {
  const modal = document.getElementById('playlistModal');
  if (!modal || modal.classList.contains('hidden')) {
    showToast('先打开平台歌单/专辑弹层再保存', 'info');
    return;
  }
  const picked = pickCheckedSongs(state.getPlaylistSongs(), state.getPlaylistChecked());
  if (!picked.length) { showToast('请先勾选要保存的歌曲', 'warn'); return; }
  const m = state.getPlaylistMeta() || {};
  const rows = toPlaylistRows(picked);
  const payload = buildSavedPlaylist(
    { name: m.name, src: typeof srcLabel === 'function' ? srcLabel(m.platform) : (m.platform || '平台') },
    rows
  );
  try {
    const r = await api.saveUserPlaylist(payload);
    if (r && r.success) {
      if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
      showToast(`📥 已保存歌单「${payload.name}」：${rows.length} 首`, 'success', 3000);
    } else {
      showToast((r && r.error) || '保存失败', 'error');
    }
  } catch (e) {
    logger.error('[savePlModalAsPlaylist] 失败:', e);
    showToast('保存失败: ' + (e.message || e), 'error');
  }
}

function addPlModalToPlaylist() {
  const picked = pickCheckedSongs(state.getPlaylistSongs(), state.getPlaylistChecked());
  if (!picked.length) { showToast('请先勾选要加入的歌曲', 'warn'); return; }
  if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(toPlaylistRows(picked));
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
  playPlaylistModalSong,
  playPlaylistModalAll,
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
window.playPlaylistModalSong = playPlaylistModalSong;
window.playPlaylistModalAll = playPlaylistModalAll;
window.addPlaylistToQueueClick = addPlaylistToQueueClick;
window.savePlModalAsPlaylist = savePlModalAsPlaylist;
window.addPlModalToPlaylist = addPlModalToPlaylist;
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

// 🎯 队列面板定位正在播放：面板未开先展开；playIdx 漂移时退回全量匹配
function locatePlayingInQueue() {
  const queue = getState('playQueue') || [];
  const cur = getState('currentPlaying');
  const idx = resolvePlayingIndex(queue, cur, getState('playIdx') || 0);
  if (idx < 0) { showToast('正在播放的歌不在当前队列', 'info', 2500); return; }
  if (!_pqVisible) window.togglePlayQueue();
  const row = document.querySelector(`#pqList .pq-item[data-pqidx="${idx}"]`);
  if (row) flashRow(row);
}
window.locatePlayingInQueue = locatePlayingInQueue;

function renderPlayQueueUI() {
  const list = document.getElementById('pqList');
  const count = document.getElementById('pqCount');
  const badge = document.getElementById('pqBadge');
  const thumbs = document.getElementById('pcQueueThumbs');
  if (!list) return;
  const queue = getState('playQueue') || [];
  const playIdx = getState('playIdx') || 0;
  _syncPqSelBtns(); // 多选按钮计数/显隐跟着每次重绘走
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
      const favS = queueFavSong(s);
      const cover = s.cover
        ? '<img class="pq-thumb" src="' + escAttr(s.cover) + '" alt="" loading="lazy" draggable="false">'
        : '<span class="pq-thumb-ph">' + NOTE_SVG + '</span>';
      const cb = _pqSelMode
        ? '<input type="checkbox" class="pq-sel-chk" ' + (_pqSel.has(s) ? 'checked ' : '')
          + 'onclick="event.stopPropagation()" onchange="togglePqSel(' + i + ')" title="勾选后批量移出队列" style="width:14px;height:14px;flex-shrink:0;cursor:pointer;margin:0 4px 0 2px;">'
        : '';
      return '<div class="pq-item' + (isCur ? ' playing' : '') + '" draggable="' + (_pqSelMode ? 'false' : 'true') + '" data-pqidx="' + i + '" onclick="' + (_pqSelMode ? 'togglePqSel(' + i + ')' : 'window._playQueueIdx(' + i + ')') + '">'
        + cb
        + '<span class="pq-idx">' + (i + 1) + '</span>'
        + cover
        + '<span class="pq-item-main">'
        + '<span class="pq-item-title">' + esc(s.title || '') + '</span>'
        + '<span class="pq-item-artist">' + esc(s.artist || '') + '</span>'
        + '</span>'
        + '<span class="pq-dur">' + fmtDuration(s.duration) + '</span>'
        + (favS ? heartBtnHtml(favS, 'pq-fav') : '')
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
  // 队列行对象不携带已解析的播放地址，点击即走 playSongByIdx 取流链路
  //（旧实现直接读行上的 url 字段——该字段恒不存在，点击只挪高亮不发声）
  playQueueIdx(idx);
};

window.clearPlayQueue = () => {
  // setState 订阅会自动刷新 UI（playQueue + playIdx 各触发一次），
  // 原先这里再显式 renderPlayQueueUI() 是第三次重绘，删除
  setState('playQueue', []);
  setState('playIdx', 0);
  setState('currentPlaying', null);
  showToast('播放队列已清空', 'info');
};

// ── 队列单行移除 / 一键去重（playQueueEdit 纯函数的接线层）──────
window.removePqItem = (idx) => {
  const r = removeQueueItem(getState('playQueue') || [], getState('playIdx') || 0, idx);
  if (!r) return;
  setState('playQueue', r.queue);
  if (r.removedCurrent) {
    if (!r.queue.length) {
      const audio = document.getElementById('audioPlayer');
      if (audio) audio.pause();
      setState('playIdx', 0);
      setState('currentPlaying', null);
    } else {
      // 删的是当前播放曲 → 让补位曲接着播，连播语义不断
      setState('playIdx', r.playIdx);
      window._playQueueIdx(r.playIdx);
    }
  } else {
    setState('playIdx', r.playIdx);
  }
  showToast('已从播放队列移除', 'info');
};

window.dedupePlayQueue = () => {
  const r = dedupeQueue(getState('playQueue') || [], getState('playIdx') || 0);
  if (!r.removed) { showToast('队列里没有重复曲目', 'info'); return; }
  setState('playQueue', r.queue);
  setState('playIdx', Math.max(0, r.playIdx));
  showToast(`🧹 已移除 ${r.removed} 首重复`, 'success');
};

// ── 队列多选批量移除（增量101）：选态装行对象引用，下标漂移不误伤 ──
let _pqSelMode = false;
const _pqSel = new Set();

function _syncPqSelBtns() {
  const btn = document.getElementById('pqSelBtn');
  const rm = document.getElementById('pqSelRmBtn');
  if (btn) btn.textContent = _pqSelMode ? '⬚ 退出' : '☑ 多选';
  if (rm) {
    rm.classList.toggle('hidden', !_pqSelMode);
    rm.textContent = `🗑 移除 ${_pqSel.size}`;
  }
  const pl = document.getElementById('pqSelPlBtn');
  if (pl) {
    pl.classList.toggle('hidden', !_pqSelMode);
    pl.textContent = `🎼 歌单 ${_pqSel.size}`;
  }
}

window.togglePqSelMode = () => {
  _pqSelMode = !_pqSelMode;
  if (!_pqSelMode) _pqSel.clear();
  renderPlayQueueUI();
};

window.togglePqSel = (idx) => {
  const item = (getState('playQueue') || [])[idx];
  if (!item) return;
  if (_pqSel.has(item)) _pqSel.delete(item);
  else _pqSel.add(item);
  renderPlayQueueUI();
};

window.removeCheckedFromQueue = () => {
  if (!_pqSel.size) { showToast('先勾选要移除的行', 'warn'); return; }
  if (!confirm(`确认把勾选的 ${_pqSel.size} 首移出播放队列？`)) return;
  const r = removeQueueItemsByIdentity(getState('playQueue') || [], getState('playIdx') || 0, _pqSel);
  _pqSel.clear();
  if (!r.removed) { renderPlayQueueUI(); return; }
  setState('playQueue', r.queue);
  if (r.removedCurrent) {
    if (!r.queue.length) {
      const audio = document.getElementById('audioPlayer');
      if (audio) audio.pause();
      setState('playIdx', 0);
      setState('currentPlaying', null);
    } else {
      // 删掉了正在播的行 → 补位曲顶上，连播语义不断（与单行移除一致）
      setState('playIdx', r.playIdx);
      window._playQueueIdx(r.playIdx);
    }
  } else if (r.playIdx >= 0) {
    setState('playIdx', r.playIdx);
  }
  showToast(`🗑 已移出 ${r.removed} 首`, 'success');
};

// 队列多选「🎼 加歌单」（增量115）：勾选行按队列原序投影成可持久行，
// 喂 quickAddToPlaylist 既有批量链（引擎端 id+source 去重）。drop 行是
// 临时 blob、本地行缺 filePath 播不动 —— 都被纯函数挡在门外。
window.pqSelAddPlaylist = () => {
  if (!_pqSel.size) { showToast('先勾选要加歌单的行', 'warn'); return; }
  const picked = (getState('playQueue') || []).filter(s => _pqSel.has(s));
  const rows = pickPlSavableRows(picked);
  if (!rows.length) {
    showToast('勾到的行都不能持久（拖入即播/缺路径的播不了），换正常的歌试试', 'warn', 2600);
    return;
  }
  if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(rows);
};

// 播放队列一键存为歌单（queuePlaylist 纯函数的接线层）：
// 名称自动生成「播放队列 · MM-DD HH:mm」，建好后可在歌单编辑器改名/换封面
window.saveQueueAsPlaylist = async () => {
  const songs = queueToSongs(getState('playQueue') || []);
  if (!songs.length) { showToast('播放队列为空，先把歌曲加入队列', 'warn', 2500); return; }
  try {
    const r = await api.saveUserPlaylist({
      name: defaultQueuePlaylistName(new Date()),
      desc: `由播放队列保存 · ${songs.length} 首`,
      cover: songs.find((s) => typeof s.cover === 'string' && s.cover.startsWith('http'))?.cover || '',
      songs,
    });
    if (r && r.success) {
      if (typeof window.loadUserPlaylists === 'function') await window.loadUserPlaylists();
      showToast(`💾 已存为歌单「${r.playlist?.name || defaultQueuePlaylistName(new Date())}」（${songs.length} 首）`, 'success', 3000);
    } else {
      showToast((r && r.error) || '保存歌单失败', 'error');
    }
  } catch (e) {
    showToast('保存失败: ' + (e.message || e), 'error');
  }
};

async function downloadPqSong(s) {
  try {
    const task = { ...s, saveDir: getState('saveDir'), quality: resolveQuality(s.source) };
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

document.addEventListener('contextmenu', (e) => {
  const row = e.target && e.target.closest ? e.target.closest('.pq-item') : null;
  if (!row) return;
  const idx = Number(row.getAttribute('data-pqidx'));
  const song = (getState('playQueue') || [])[idx];
  if (!song) return;
  openSongRowMenu(e, song, {
    play: () => window._playQueueIdx(idx),
    download: () => downloadPqSong(song),
    extra: [{ icon: '✕', label: '从队列移除', onClick: () => window.removePqItem(idx) }],
  });
});

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
