const { app, BrowserWindow, ipcMain, session, Menu, Tray, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { setCookieStore } = require('../api');
const logger = require('../utils/logger');
const { downloadFileWithRetry, embedId3Tags } = require('../utils/downloader');
const cookieStore = require('../utils/cookieStore');
const { setOnlineLrcNotifier } = require('../utils/onlineLrc');
const { getDownloadUrl, getLyrics } = require('../api');
const { renderFileName } = require('../utils/naming');
const { init: initContext, safeSend: ctxSafeSend } = require('./context');
const playCache = require('./playCache');
const history = require('../utils/history');
const prefs = require('../utils/prefs');
const ipcWindow  = require('./ipc/window');
const ipcSearch  = require('./ipc/search');
const ipcDownload= require('./ipc/download');
const ipcCookie  = require('./ipc/cookie');
const ipcLibrary = require('./ipc/library');
const ipcPrefs   = require('./ipc/prefs');
const ipcCheckLocal = require('./ipc/checkLocal');
const ipcHistory = require('./ipc/history');
const ipcAiMusic = require('./ipc/ai-music');
const ipcPlaylist = require('./ipc/playlist');
const ipcDownloadTemplates = require('./ipc/downloadTemplates');
const ipcCloudSync = require('./ipc/cloudSync');

// 修复 B15：使用 context.js 提供的统一 safeSend，避免代码漂移
const safeSend = ctxSafeSend;

let mainWindow;
let tray = null;
let isQuitting = false;
const downloadQueue = [];
// 修复 P1-8：用 activeDownloads 计数替代旧的 isDownloading 标志
// 旧实现是 1 首歌下完才下 1 首；现在最多并发 3 首，5MB 歌曲不用等 50MB 视频
let activeDownloads = 0;
let MAX_CONCURRENT_DOWNLOADS = 3;
// 从 prefs 读取已保存的并发数
try {
  const saved = prefs.get('concurrency');
  if (saved && saved >= 1 && saved <= 10) MAX_CONCURRENT_DOWNLOADS = saved;
} catch (_e) { /* prefs 读取失败使用默认值 */ }
let processTimer = null;
let _processQueueRunning = false; // 防止 processQueue 重入
let queuePersistTimer = null;
let playQueuePersistTimer = null;
const QUEUE_FILE = () => path.join(app.getPath('userData'), 'queue.json');
const PLAY_QUEUE_FILE = () => path.join(app.getPath('userData'), 'play-queue.json');

// 持久化队列（防抖：500ms 内多次变更合并写入）
function persistQueue() {
  if (queuePersistTimer) return;
  queuePersistTimer = setTimeout(() => {
    queuePersistTimer = null;
    const data = JSON.stringify(downloadQueue, null, 2);
    fs.promises.writeFile(QUEUE_FILE(), data, 'utf8').catch(e => {
      logger.warn('队列持久化失败:', e.message);
    });
  }, 500);
}

// 启动时加载队列（异常关闭后恢复）
async function loadPersistedQueue() {
  try {
    const fp = QUEUE_FILE();
    const stat = await fs.promises.stat(fp).catch(() => null);
    if (!stat) return;
    const raw = await fs.promises.readFile(fp, 'utf8');
    if (!raw.trim()) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return;
    // 重启时：downloading 视为异常关闭 -> error
    //           pending 超过 1 天没动 -> error（避免阻塞"加入新歌单"）
    //           pending 不到 1 天 -> 保留
    //           error 保留
    //           done 保留
    const STALE_PENDING_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const item of list) {
      if (item.status === 'downloading') {
        item.status = 'error';
        item.error = '应用异常关闭，请重试';
      } else if (item.status === 'pending' && item.addedAt && (now - item.addedAt > STALE_PENDING_MS)) {
        item.status = 'error';
        item.error = '排队超过 24 小时未启动，已标记失败（可重试）';
      }
      downloadQueue.push(item);
    }
    if (downloadQueue.length) {
      logger.log(`[Queue] 从磁盘恢复 ${downloadQueue.length} 个任务`);
    }
  } catch (e) {
    logger.warn('队列加载失败:', e.message);
  }
}

// ── 播放队列持久化 ────────────────────────────────────
let _pendingPlayQueueData = null;
function persistPlayQueue(data) {
  _pendingPlayQueueData = data;
  if (playQueuePersistTimer) return;
  playQueuePersistTimer = setTimeout(() => {
    playQueuePersistTimer = null;
    const latest = _pendingPlayQueueData;
    _pendingPlayQueueData = null;
    try {
      // latest = { queue: [...], playIdx: number }
      const queue = Array.isArray(latest?.queue) ? latest.queue : [];
      // 剔除 data: 协议的 cover（base64 数据极大，恢复后 player loadAndPlay 会重新获取）
      const clean = queue.map(song => {
        if (!song) return song;
        const s = { ...song };
        if (typeof s.cover === 'string' && s.cover.startsWith('data:')) {
          delete s.cover;
        }
        return s;
      });
      const payload = {
        queue: clean,
        playIdx: typeof latest?.playIdx === 'number' ? latest.playIdx : -1,
        loopMode: typeof latest?.loopMode === 'number' ? latest.loopMode : 0,
        isShuffled: !!latest?.isShuffled,
        updatedAt: Date.now(),
      };
      fs.promises.writeFile(PLAY_QUEUE_FILE(), JSON.stringify(payload, null, 2), 'utf8').catch(e => {
        logger.warn('播放队列持久化失败:', e.message);
      });
    } catch (e) {
      logger.warn('播放队列持久化失败:', e.message);
    }
  }, 500);
}

async function loadPersistedPlayQueue() {
  try {
    const fp = PLAY_QUEUE_FILE();
    const stat = await fs.promises.stat(fp).catch(() => null);
    if (!stat) return null;
    const raw = await fs.promises.readFile(fp, 'utf8');
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.queue)) return null;
    logger.log(`[PlayQueue] 从磁盘恢复 ${obj.queue.length} 首歌曲`);
    return { queue: obj.queue, playIdx: obj.playIdx, loopMode: obj.loopMode, isShuffled: obj.isShuffled, updatedAt: obj.updatedAt };
  } catch (e) {
    logger.warn('播放队列加载失败:', e.message);
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true, // 启用安全策略，CORS 通过 session.defaultSession.webRequest 头部处理
      preload: path.join(__dirname, '../preload/preload.js'),
    },
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, '../../assets/icon.png'),
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html')).then(() => {
    logger.log('[main] loadFile done');
  }).catch(err => {
    logger.warn('[main] loadFile failed:', err);
    // 开发模式下可能 dist/renderer 还没构建好
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl) {
      logger.log('[main] trying dev server URL:', devUrl);
      mainWindow.loadURL(devUrl).catch(e => logger.warn('[main] loadURL also failed:', e));
    }
  });

  // 关闭开发者工具自动开启（按需通过菜单 → 视图 → 开发者工具 手动打开）

  // 拦截 F12 / Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+U 防止误开
  const blockList = new Set(['F12']);
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (blockList.has(input.key)) {
      event.preventDefault();
      return;
    }
    if (input.control && input.shift && ['I', 'i', 'J', 'j', 'C', 'c'].includes(input.key)) {
      event.preventDefault();
      return;
    }
    if (input.control && ['U', 'u'].includes(input.key)) {
      event.preventDefault();
      return;
    }
    // Ctrl+R 刷新页面（保留）
    if (input.key === 'r' && (input.control || input.meta)) {
      event.preventDefault();
      mainWindow.webContents.reload();
    }
  });

  // 窗口关闭时最小化到托盘（不是真的关闭）
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (tray) {
        tray.displayBalloon({ title: '音乐下载器', content: '已最小化到托盘，点击恢复' });
      }
    }
  });
}

// ─── 系统托盘 ──────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) {
      // 如果图标加载失败，使用空白图标
      trayIcon = nativeImage.createEmpty();
    } else {
      trayIcon = trayIcon.resize({ width: 16, height: 16 });
    }
  } catch (e) {
    logger.warn('[tray] 图标加载失败:', e.message);
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('音乐下载器');

  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  tray.on('balloon-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu(playState = { isPlaying: false, title: '', artist: '' }) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: playState.title ? `🎵 ${playState.title}` : '🎵 音乐下载器',
      enabled: false,
    },
    {
      label: playState.artist ? `   ${playState.artist}` : '',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: playState.isPlaying ? '⏸ 暂停' : '▶ 播放',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-toggle-play');
        }
      },
    },
    {
      label: '⏮ 上一首',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-prev');
        }
      },
    },
    {
      label: '⏭ 下一首',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('tray-next');
        }
      },
    },
    { type: 'separator' },
    {
      label: '📋 显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '❌ 退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
}

// 导出供其他模块调用
module.exports = { updateTrayMenu };

function buildAppMenu() {
  // 自定义菜单，移除所有「开发者工具」相关项（默认菜单的 Ctrl+Shift+I 加速键也无法触发）
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow && mainWindow.webContents.reload() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '聚焦搜索 🔍', accelerator: 'CmdOrCtrl+K', click: () => { mainWindow?.webContents.send('focus-search'); } },
        { type: 'separator' },
        { label: '⏰ 定时停止', submenu: [
          { label: '🛑 取消定时', click: () => mainWindow?.webContents.send('sleep-timer', null) },
          { type: 'separator' },
          { label: '⏰ 15 分钟后', click: () => mainWindow?.webContents.send('sleep-timer', 15) },
          { label: '⏰ 30 分钟后', click: () => mainWindow?.webContents.send('sleep-timer', 30) },
          { label: '⏰ 60 分钟后', click: () => mainWindow?.webContents.send('sleep-timer', 60) },
          { label: '⏰ 90 分钟后', click: () => mainWindow?.webContents.send('sleep-timer', 90) },
        ]},
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [{ role: 'minimize', label: '最小化' }, { role: 'close', label: '关闭' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // 初始化 cookieStore
  cookieStore.init(app.getPath('userData'));
  setCookieStore(cookieStore);

  // 初始化 prefs（用户偏好持久化）
  prefs.init(app.getPath('userData'));

  // 初始化下载历史持久化
  history.init(app.getPath('userData'));

  // 确保默认下载目录存在（如果有用户自定义的 saveDir 则用之，否则用系统默认）
  const defaultDir = prefs.get('saveDir') || path.join(app.getPath('music'), 'MusicDownloader');
  if (!fs.existsSync(defaultDir)) fs.mkdirSync(defaultDir, { recursive: true });

  // 初始化 play_cache 目录 + 启动清理陈旧临时文件
  playCache.cleanupStaleFiles(app.getPath('userData'));

  // 设置在线拉歌词完成后的 renderer 通知回调
  setOnlineLrcNotifier(({ filePath, lrc, source }) => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        safeSend('local-lrc-fetched', { filePath, lrc, source });
      }
    } catch (e) {
      logger.warn('[online-lrc] 推送事件失败:', e.message);
    }
  });

  // 启动时恢复队列
  try {
    await loadPersistedQueue();
  } catch (e) {
    logger.warn('[index] 恢复队列失败:', e.message);
  }

  // 启动时恢复播放队列
  try {
    const saved = await loadPersistedPlayQueue();
    if (saved && saved.queue && saved.queue.length) {
      safeSend('play-queue-restored', saved);
    }
  } catch (e) {
    logger.warn('[PlayQueue] 恢复播放队列失败:', e.message);
  }

  // 注册所有 IPC handler（按职责拆分到 src/main/ipc/*.js）
  registerAllIpcHandlers();

  // 初始化自动更新（GitHub Releases）
  try {
    const { initUpdater } = require('./updater');
    initUpdater();
  } catch (_e) {
    logger.warn('[Updater] init failed:', _e.message);
  }

  // 定期 GC play_cache（10 分钟一次，.unref() 不阻塞进程退出）
  const gcTimer = setInterval(playCache.cleanupExpired, playCache.PLAY_CACHE_GC_INTERVAL);
  if (gcTimer.unref) gcTimer.unref();

  // 安装自定义应用菜单（屏蔽开发者工具菜单项及其加速键）
  buildAppMenu();

  // CORS 白名单：仅允许本地和已知音乐 CDN 域名
  const ALLOWED_ORIGINS = new Set([
    'http://localhost',
    'http://127.0.0.1',
    'https://music.163.com',
    'https://y.qq.com',
    'https://www.bilibili.com',
    'https://www.kugou.com',
  ]);
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const origin = details.url ? new URL(details.url).origin : '';
    const isAllowed = ALLOWED_ORIGINS.has(origin);
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Access-Control-Allow-Origin': [isAllowed ? origin : 'null'],
        'Access-Control-Allow-Methods': ['GET', 'HEAD', 'OPTIONS'],
        'Access-Control-Allow-Headers': ['Range', 'Referer'],
      },
    });
  });

  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  if (processTimer) { clearTimeout(processTimer); processTimer = null; }
  if (queuePersistTimer) { clearTimeout(queuePersistTimer); queuePersistTimer = null; }
  if (playQueuePersistTimer) { clearTimeout(playQueuePersistTimer); playQueuePersistTimer = null; }
  try { prefs.flush(); } catch (e) { logger.warn('prefs.flush 失败:', e.message); }
  try { history.flush(); } catch (e) { logger.warn('history.flush 失败:', e.message); }
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── IPC 处理（按职责拆到 ipc/*.js）──────────────────────────────────────────
function registerAllIpcHandlers() {
  // 必须先 init context，再 register（各 handler 通过 getCtx() 拿共享状态）
  // 关键：传 getter 而不是值，否则 mainWindow / downloadQueue 在 createWindow 之后
  // 才赋值时，子模块里永远是 undefined。
  initContext({
    getMainWindow:    () => mainWindow,
    app,
    getDownloadQueue: () => downloadQueue,
    persistQueue,
    persistPlayQueue,
    loadPersistedPlayQueue,
    processQueue,
  });
  ipcWindow.register();
  ipcSearch.register();
  ipcDownload.register();
  ipcCookie.register();
  ipcLibrary.register();
  ipcPrefs.register();
  ipcCheckLocal.register();
  ipcHistory.register();
  ipcAiMusic.register();
  ipcPlaylist.register();
  ipcDownloadTemplates.register();
  ipcCloudSync.register();

  // ── 播放队列持久化 IPC ─────────────────────────────
  ipcMain.handle('save-play-queue', (_, data) => {
    persistPlayQueue(data);
    return { ok: true };
  });
  ipcMain.handle('load-play-queue', () => {
    return loadPersistedPlayQueue() || { queue: [] };
  });

  // ── 系统托盘 IPC ───────────────────────────────────
  ipcMain.on('tray-update-play-state', (_, playState) => {
    updateTrayMenu(playState);
  });

  // ── 版本查询 IPC ───────────────────────────────────
  ipcMain.handle('get-version', () => {
    const pkg = require('../../package.json');
    const version = pkg.version || '1.0.0';
    const commit = process.env.npm_config_git_commit || '';
    return commit ? `${version} (${commit.slice(0, 7)})` : version;
  });
}

// ⚠️ 此处下方整段（30+ 个 ipcMain.handle/on + proxy-play/play_cache/LRC 解码）
// 已在 P2-1 拆分到 src/main/ipc/{window,search,download,cookie,library}.js
// 下面只保留 processQueue / processOneSong / sanitizeFilename（共享状态太多，未拆）


// 调度下载队列（修复 P1-8：最多并发 3 首）
// 修复：添加 _processQueueRunning 防止重入，避免多线程同时调度导致 activeDownloads 计数混乱
async function processQueue() {
  if (_processQueueRunning) return;
  _processQueueRunning = true;
  // 动态读取并发数（设置变更后实时生效）
  const concurrency = (() => { try { const v = prefs.get('concurrency'); return (v >= 1 && v <= 10) ? v : 3; } catch (_e) { return 3; } })();
  try {
    while (activeDownloads < concurrency) {
      const song = downloadQueue.find(s => s.status === 'pending');
      if (!song) break;
      song.status = 'downloading';
      song.error = null;
      song.progress = 0;
      activeDownloads++;
      safeSend('queue-updated', downloadQueue);
      persistQueue();
      // 异步处理（不阻塞调度）
      processOneSong(song).finally(() => {
        activeDownloads--;
        safeSend('queue-updated', downloadQueue);
        persistQueue();
        // 还有 pending 时调度下一批（统一使用 processTimer，避免重复 setTimeout）
        if (downloadQueue.some(s => s.status === 'pending')) {
          if (processTimer) clearTimeout(processTimer);
          processTimer = setTimeout(() => {
            processTimer = null;
            _processQueueRunning = false;
            processQueue();
          }, 100);
        } else {
          _processQueueRunning = false;
        }
      });
    }
  } finally {
    // 如果循环正常结束（没有 pending 歌曲），重置标志
    if (activeDownloads < concurrency) {
      _processQueueRunning = false;
    }
  }
}

// 处理单个下载任务（包含重试循环 + 致命错误短路）
// 修复 B7：urlInfo.fatal=true 时直接退出，不浪费 MAX_RETRY 配额
// 修复 B8：extraHeaders 通过 downloadFile 内部重定向递归传递
async function processOneSong(song) {
  const MAX_RETRY = 2;
  let lastError = null;
  let isFatal = false;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      logger.log(`[processOneSong] ▶ ${song.source} "${song.title}" - "${song.artist}" id=${song.id} quality=${song.quality || 'standard'}`);
      const urlInfo = await getDownloadUrl(song.id, song.source, song.quality || 'standard');
      logger.log(`[processOneSong]   urlInfo keys =`, urlInfo ? Object.keys(urlInfo).join(',') : 'null', 'hasUrl =', !!(urlInfo && urlInfo.url));
      if (!urlInfo || !urlInfo.url) {
        // 修复 B7：fatal 错误（VIP/Auth/Audio 流缺失）直接退出，不进重试循环
        if (urlInfo?.fatal) {
          isFatal = true;
          lastError = new Error(urlInfo.error || '无法获取下载链接');
          song.errorCode = urlInfo.code || 'UNKNOWN';
          logger.warn(`[processOneSong] ✗ ${song.source} ${song.title} - ${song.artist} 失败: ${lastError.message} (code=${urlInfo.code})`);
          break;
        }
        throw new Error(urlInfo?.error || '无法获取下载链接');
      }

      const ext = (urlInfo.ext || 'mp3').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10) || 'mp3';
      // 命名模板：从 preferences 读取，支持 {title} {artist} {album} {source} {id}
      const { get: getPref } = require('../utils/prefs');
      const namingTemplate = getPref('namingTemplate') || '{artist} - {title}';
      const savePath = path.join(song.saveDir, sanitizeFilename(renderFileName(namingTemplate, song, ext)));

      await fs.promises.mkdir(song.saveDir, { recursive: true }).catch(e => {
        logger.warn('[processOneSong] 创建下载目录失败:', song.saveDir, e.message);
      });

      // 修复 B8：携带 extraHeaders（Referer 等），downloadFile 内部重定向会递归传递
      // B 站 DASH CDN 要求 Referer: https://www.bilibili.com/，否则可能 403
      // 修复 B2：用 taskId 而非 id 推送进度（前端 DOM id="prog-${taskId}"）
      const extraHeaders = urlInfo.referer ? { 'Referer': urlInfo.referer } : {};
      // 读取限速设置（KB/s → bytes/s）
      const speedLimitKB = prefs.get('speedLimit') || 0;
      const speedLimit = speedLimitKB > 0 ? speedLimitKB * 1024 : 0;
      await downloadFileWithRetry(urlInfo.url, savePath, (progress) => {
        song.progress = progress;
        safeSend('download-progress', { id: song.taskId, progress });
      }, extraHeaders, { speedLimit });

      // 歌词
      let lrc = '';
      try {
        const lyricsResult = await getLyrics(song.id, song.source, song.title, song.artist);
        lrc = lyricsResult.lrc || '';
      } catch (_e) { /* 歌词获取失败不影响下载 */ }

      // ID3 标签（修复 B6：embedId3Tags 内部只对 mp3 生效，跳过 m4a/flac）
      await embedId3Tags(savePath, {
        title: song.title,
        artist: song.artist,
        album: song.album || '',
        coverUrl: song.cover,
        lrc,
      });

      // LRC 歌词文件（独立 try-catch：写歌词失败不应覆盖已成功的下载）
      if (lrc) {
        const lrcPath = savePath.replace(/\.[^.]+$/, '.lrc');
        fs.promises.writeFile(lrcPath, lrc, 'utf8').catch(lrcErr => {
          logger.warn('[processOneSong] LRC 写入失败（不影响下载结果）:', lrcErr.message);
        });
      }

      song.status = 'done';
      song.progress = 100;
      song.savePath = savePath;
      song.error = null;
      lastError = null;

      // 下载完成通知
      const notifEnabled = prefs.get('notifications');
      if (notifEnabled !== false) { // 默认开启
        try {
          const n = new Notification({
            title: '下载完成',
            body: `${song.title} - ${song.artist || '未知艺术家'}`,
            silent: false,
          });
          n.on('click', () => {
            const { shell } = require('electron');
            shell.showItemInFolder(savePath);
          });
          n.show();
        } catch (e) {
          logger.warn('[Notification] 显示失败:', e.message);
        }
      }

      // 写入下载历史
      try {
        const stat = fs.existsSync(savePath) ? fs.statSync(savePath) : null;
        history.add({
          id: String(song.id),
          source: song.source,
          title: song.title,
          artist: song.artist || '',
          album: song.album || '',
          savePath,
          ext,
          quality: song.quality || 'standard',
          size: stat ? stat.size : 0,
          duration: song.duration || 0,
          status: 'done',
          finishedAt: Date.now(),
        });
      } catch (e) {
        logger.warn('[history.add] 写历史失败:', e.message);
      }
      return; // 成功，退出函数
    } catch (e) {
      lastError = e;
      const msg = e.message || String(e);
      const isRetriable = /HTTP\s*(403|404|410)/i.test(msg);
      logger.warn(`下载失败 (尝试 ${attempt}/${MAX_RETRY}):`, msg);

      // 只对 403/404/410 重试（CDN URL 签名过期，重拿 URL 再下），其他错误直接放弃
      if (attempt < MAX_RETRY && isRetriable) {
        song.status = 'pending';
        song.progress = 0;
        safeSend('queue-updated', downloadQueue);
        persistQueue();
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      break; // 不可重试或重试用尽
    }
  }

  if (lastError) {
    song.status = 'error';
    song.error = lastError.message;
    // 写历史：失败
    try {
      history.add({
        id: String(song.id),
        source: song.source,
        title: song.title,
        artist: song.artist || '',
        album: song.album || '',
        savePath: '',
        ext: '',
        quality: song.quality || 'standard',
        size: 0,
        duration: song.duration || 0,
        status: 'error',
        error: lastError.message,
        finishedAt: Date.now(),
      });
    } catch (e) {
      logger.warn('[history.add] 写历史失败:', e.message);
    }
    // 修复 B7：通知前端标记为 fatal，前端可选择弹更友好的 toast（如"该歌曲需要 VIP"）
    safeSend('download-error', {
      id: song.taskId || song.id,
      title: song.title,
      artist: song.artist,
      error: lastError.message,
      fatal: isFatal,
    });
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').substring(0, 200);
}

// ⚠️ 此处下方的旧本地音乐库 IPC（scan-local-library / read-local-metadata /
//   read-local-lrc / update-id3-tags / update-id3-cover）+ LRC 解码函数
// 已在 P2-1 拆分到 src/main/ipc/library.js
// 此处不再重复定义，避免 IPC handler channel 重复注册
