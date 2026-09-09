const { contextBridge, ipcRenderer } = require('electron');
// sandbox preload 只能 require 内置模块与 electron，不能 require 应用内相对路径
// （生产环境会 module not found），日志工具在此内联实现
const logger = {
  warn: (...args) => console.warn('[MusicDL][preload]', ...args),
};

// ── 白名单 ──────────────────────────────────────────
const SAFE_CHANNELS_SEND = new Set([
  'window-minimize', 'window-maximize', 'window-close',
  'mini-next', 'mini-prev', 'mini-toggle-play', 'mini-close', 'mini-player-update',
  'open-mini-player',
  // 补齐：METHOD_MAP 引用但原先不在白名单的 send-only 通道
  'tray-update-play-state',
]);

const SAFE_CHANNELS_RECEIVE = new Set([
  'queue-updated', 'download-progress', 'download-error',
  'play-queue-restored', 'update-available',
  'update-not-available', 'update-download-progress', 'update-downloaded', 'update-error',
  'local-lrc-fetched', 'library-scan-progress', 'sync-mini-player',
  'focus-search', 'sleep-timer',
  'mini-player-update',
  'tray-toggle-play', 'tray-next', 'tray-prev',
  'mini-next', 'mini-prev', 'mini-toggle-play',
]);

const SAFE_CHANNELS_INVOKE = new Set([
  'search-music', 'search-album', 'search-singer',
  'get-singer-songs', 'get-singer-albums', 'get-album-songs',
  'get-home-recommendations', 'get-home-section', 'get-playlist-songs',
  'get-download-url', 'get-download-url-smart', 'add-to-queue', 'cancel-download', 'retry-download',
  'remove-queue-item', 'clear-finished-queue', 'clear-all-queue',
  'get-lyrics', 'get-cookies', 'save-cookie', 'clear-cookie', 'verify-cookie',
  'open-login-window', 'scan-local-library', 'load-library-index',
  'read-local-metadata', 'read-local-lrc', 'update-id3-tags', 'update-id3-cover',
  'fetch-online-cover', 'select-dir', 'get-default-dir', 'open-folder', 'open-external',
  'get-pref', 'set-pref', 'save-play-queue', 'load-play-queue',
  'query-history', 'history-stats', 'clear-history',
  'get-cache-size', 'clear-play-cache', 'batch-fetch-lyrics',
  'write-local-lrc', 'check-local-exists', 'convert-audio',
  'proxy-play', 'add-playlist-to-queue', 'get-version',
  'ai-generate-music', 'ai-generate-lyrics',
  'ai-history', 'ai-add-history', 'ai-clear-history', 'ai-translate-lyrics',
  'export-all-data', 'import-all-data', 'get-download-templates',
  'save-download-template', 'delete-download-template', 'set-active-template',
  'get-search-history', 'set-search-history',
  'get-user-playlists', 'save-user-playlist', 'delete-user-playlist',
  'add-to-user-playlist', 'remove-from-user-playlist',
  'export-playlist', 'delete-file', 'rename-file',
  'check-for-update', 'download-update', 'restart-and-install',
  'flush-prefs', 'flush-history',
]);

// ── 方法名映射：渲染层 camelCase → IPC kebab-case ──
const METHOD_MAP = {
  // 窗口（send-only：主进程只注册了 ipcMain.on，走 invoke 会无人应答）
  windowClose: 'window-close',
  windowMinimize: 'window-minimize',
  windowMaximize: 'window-maximize',
  windowToggleFullscreen: 'window-maximize',
  // 搜索
  searchMusic: 'search-music',
  searchAlbum: 'search-album',
  searchSinger: 'search-singer',
  getSingerSongs: 'get-singer-songs',
  getSingerAlbums: 'get-singer-albums',
  getAlbumSongs: 'get-album-songs',
  // 推荐
  getHomeSection: 'get-home-section',
  getHomeRecommendations: 'get-home-recommendations',
  getPlaylistSongs: 'get-playlist-songs',
  // 下载
  getDownloadUrl: 'get-download-url',
  getDownloadUrlSmart: 'get-download-url-smart',
  addToQueue: 'add-to-queue',
  proxyPlay: 'proxy-play',
  cancelDownload: 'cancel-download',
  retryDownload: 'retry-download',
  removeQueueItem: 'remove-queue-item',
  clearFinishedQueue: 'clear-finished-queue',
  clearAllQueue: 'clear-all-queue',
  addPlaylistToQueue: 'add-playlist-to-queue',
  exportPlaylist: 'export-playlist',
  getDownloadTemplates: 'get-download-templates',
  saveDownloadTemplate: 'save-download-template',
  deleteDownloadTemplate: 'delete-download-template',
  setActiveDownloadTemplate: 'set-active-template',
  // 歌词
  getLyrics: 'get-lyrics',
  // Cookie
  getCookies: 'get-cookies',
  saveCookie: 'save-cookie',
  clearCookie: 'clear-cookie',
  verifyCookie: 'verify-cookie',
  openLoginWindow: 'open-login-window',
  // 本地
  scanLocalLibrary: 'scan-local-library',
  loadLibraryIndex: 'load-library-index',
  readLocalMetadata: 'read-local-metadata',
  readLocalLrc: 'read-local-lrc',
  writeLocalLrc: 'write-local-lrc',
  checkLocalExists: 'check-local-exists',
  updateId3Tags: 'update-id3-tags',
  updateId3Cover: 'update-id3-cover',
  fetchOnlineCover: 'fetch-online-cover',
  batchFetchLyrics: 'batch-fetch-lyrics',
  convertAudio: 'convert-audio',
  deleteFile: 'delete-file',
  renameFile: 'rename-file',
  // 文件
  selectDir: 'select-dir',
  getDefaultDir: 'get-default-dir',
  openFolder: 'open-folder',
  openExternal: 'open-external',
  // 设置
  getPref: 'get-pref',
  setPref: 'set-pref',
  getSearchHistory: 'get-search-history',
  setSearchHistory: 'set-search-history',
  // 播放队列
  savePlayQueue: 'save-play-queue',
  loadPlayQueue: 'load-play-queue',
  // 历史
  queryHistory: 'query-history',
  getHistoryStats: 'history-stats',  clearHistory: 'clear-history',
  // 缓存
  getCacheSize: 'get-cache-size',
  clearPlayCache: 'clear-play-cache',
  // 播放
  getVersion: 'get-version',
  // AI
  aiGenerateMusic: 'ai-generate-music',
  aiGenerateLyrics: 'ai-generate-lyrics',
  aiTranslateLyrics: 'ai-translate-lyrics',
  aiGetHistory: 'ai-history',
  aiAddHistory: 'ai-add-history',
  aiClearHistory: 'ai-clear-history',
  // 用户歌单
  getUserPlaylists: 'get-user-playlists',
  saveUserPlaylist: 'save-user-playlist',
  deleteUserPlaylist: 'delete-user-playlist',
  addToUserPlaylist: 'add-to-user-playlist',
  removeFromUserPlaylist: 'remove-from-user-playlist',
  // 云
  exportAllData: 'export-all-data',
  importAllData: 'import-all-data',
  // 更新
  checkForUpdate: 'check-for-update',
  downloadUpdate: 'download-update',
  restartAndInstall: 'restart-and-install',
  // mini
  openMiniPlayer: 'open-mini-player',
  syncMiniPlayer: 'mini-player-update',
  trayUpdatePlayState: 'tray-update-play-state',
};

// ── 核心 musicAPI（渲染层 → 主进程的 IPC 桥）────────────
// 用工厂函数从 METHOD_MAP 生成所有方法，保证所有 renderer 调用的方法都有对应
function makeApiMethod(ipcChannel) {
  // send-only 通道（主进程只有 ipcMain.on，无 handle）：走 send。
  // 原实现一律 invoke，导致这些通道 invoke 后无人应答（Promise 永远 pending
  // 或返回 undefined，窗口控制/托盘同步静默失效）。
  if (!SAFE_CHANNELS_INVOKE.has(ipcChannel) && SAFE_CHANNELS_SEND.has(ipcChannel)) {
    return (...args) => ipcRenderer.send(ipcChannel, ...args);
  }
  return (...args) => ipcRenderer.invoke(ipcChannel, ...args);
}

const _musicApiBase = {
  invoke(channel, ...args) {
    if (SAFE_CHANNELS_INVOKE.has(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    logger.warn('[preload] 未授权的 IPC 通道:', channel);
  },
  get version() { return ipcRenderer.invoke('get-version'); },
  // on 事件注册
  onQueueUpdated(cb) { ipcRenderer.on('queue-updated', (_, d) => cb(d)); },
  onDownloadProgress(cb) { ipcRenderer.on('download-progress', (_, d) => cb(d)); },
  onDownloadError(cb) { ipcRenderer.on('download-error', (_, d) => cb(d)); },
  onPlayQueueRestored(cb) { ipcRenderer.on('play-queue-restored', (_, d) => cb(d)); },
  onLocalLrcFetched(cb) { ipcRenderer.on('local-lrc-fetched', (_, d) => cb(d)); },
  onSyncMiniPlayer(cb) { ipcRenderer.on('sync-mini-player', () => cb()); },
  onMiniNext(cb) { ipcRenderer.on('mini-next', (_, d) => cb(d)); },
  onMiniPrev(cb) { ipcRenderer.on('mini-prev', (_, d) => cb(d)); },
  onMiniTogglePlay(cb) { ipcRenderer.on('mini-toggle-play', (_, d) => cb(d)); },
  onTrayNext(cb) { ipcRenderer.on('tray-next', (_, d) => cb(d)); },
  onTrayPrev(cb) { ipcRenderer.on('tray-prev', (_, d) => cb(d)); },
  onTrayTogglePlay(cb) { ipcRenderer.on('tray-toggle-play', (_, d) => cb(d)); },
};

// 从 METHOD_MAP 批量生成方法
Object.keys(METHOD_MAP).forEach(name => {
  const ch = METHOD_MAP[name];
  _musicApiBase[name] = makeApiMethod(ch);
});

contextBridge.exposeInMainWorld('musicAPI', _musicApiBase);

// ── ipcRenderer 向后兼容（供 updater.js / settings.js 使用）────────
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(channel, callback) {
    if (SAFE_CHANNELS_RECEIVE.has(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  invoke(channel, ...args) {
    if (SAFE_CHANNELS_INVOKE.has(channel)) {
      return ipcRenderer.invoke(channel, ...args);
    }
    logger.warn('[preload] 未授权的 IPC 通道:', channel);
  },
  send(channel) {
    if (SAFE_CHANNELS_SEND.has(channel)) {
      ipcRenderer.send(channel);
    } else {
      logger.warn('[preload] 未授权的 IPC 通道:', channel);
    }
  },
});

contextBridge.exposeInMainWorld('miniAPI', {
  send(channel) {
    if (SAFE_CHANNELS_SEND.has(channel)) {
      ipcRenderer.send(channel);
    }
  },
  on(channel, callback) {
    if (SAFE_CHANNELS_RECEIVE.has(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },
  windowClose() { ipcRenderer.send('window-close'); },
  windowMinimize() { ipcRenderer.send('window-minimize'); },
  windowMaximize() { ipcRenderer.send('window-maximize'); },
  windowToggleFullscreen() { ipcRenderer.send('window-maximize'); },
  get version() { return ipcRenderer.invoke('get-version'); },
  getVersion() { return ipcRenderer.invoke('get-version'); },
});
