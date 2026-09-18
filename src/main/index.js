const { app, BrowserWindow, session, Menu, Tray, nativeImage, Notification, globalShortcut } = require('electron');
const { handle: ipcHandle, on: ipcOn, assertContractCoverage } = require('./ipc/register');
const { buildContractArg } = require('../shared/ipcContract');
const path = require('path');
const { setCookieStore } = require('../api');
const logger = require('../utils/logger');
const { installRejectionGuard } = require('../utils/rejectionGuard');
const cookieStore = require('../utils/cookieStore');
const { setOnlineLrcNotifier } = require('../utils/onlineLrc');
const { getDownloadUrlSmart, getLyrics } = require('../api');
const { init: initContext, safeSend: ctxSafeSend } = require('./context');
const { createDownloadQueueEngine } = require('./downloadQueue');
const playCache = require('./playCache');
const approvedDirs = require('./approvedDirs');
const history = require('../utils/history');
const prefs = require('../utils/prefs');
const { atomicWriteJson, safeReadJson } = require('../utils/atomicFile');
// 主进程即 UI 线程：文件 IO 走异步封装（见 utils/fsAsync.js）
const fsa = require('../utils/fsAsync');
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
const ipcSubscriptions = require('./ipc/subscriptions');
const subscriptions = require('./subscriptions');
const clipboardWatch = require('./clipboardWatch');

// 修复 B15：使用 context.js 提供的统一 safeSend，避免代码漂移
const safeSend = ctxSafeSend;

// ─── 全局未捕获拒绝归口 ─────────────────────────────────
// 「为什么需要它、为什么按栈帧分流」见 utils/rejectionGuard.js 顶部说明。
installRejectionGuard({ logger });

let mainWindow;
let tray = null;
let isQuitting = false;

// ── 下载队列引擎（Sprint C：已从本文件抽到 main/downloadQueue.js）──
// 队列状态 / 持久化 / 并发调度 / 单曲处理（取流→落盘→ID3→歌词→历史→通知）
// 全部归 downloadQueue.js；本文件只负责组装依赖并接进 context。
let downloadQueueEngine = null;
/** 队列引用：引擎创建后与其内部数组同一引用，供 context / IPC 消费 */
let downloadQueue = [];

// ─── 单实例锁 ──────────────────────────────────────────
// 没有它时每次启动都是一个完全独立的进程：各自的托盘图标、各自的下载队列，
// 且共同读写 userData 下的 queue.json / play-queue.json / history.json ——
// atomicWriteJson 防文件损坏但不防后写覆盖先写，两个窗口的队列会互相清空。
// 全局媒体键也只有一份归属（register 后到的静默失败），按键会打到错误实例。
// 因此第二次启动直接退出，并把焦点还给已开着的窗口。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    // 主窗口平时「关闭」只是 hide 到托盘，这里要把它捞回来
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    if (!mainWindow.isFocused()) mainWindow.focus();
  });
}

// ── 下载队列：状态 / 持久化 / 调度已抽到 main/downloadQueue.js ──
// 本文件只保留「播放队列持久化」与「引擎装配」。
let playQueuePersistTimer = null;
const PLAY_QUEUE_FILE = () => path.join(app.getPath('userData'), 'play-queue.json');

// 启动时加载队列（异常关闭后恢复；损坏文件备份 .bak 后放弃）
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
      atomicWriteJson(PLAY_QUEUE_FILE(), payload);
    } catch (e) {
      logger.warn('播放队列持久化失败:', e.message);
    }
  }, 500);
}

async function loadPersistedPlayQueue() {
  try {
    const fp = PLAY_QUEUE_FILE();
    const res = safeReadJson(fp);
    if (!res.ok) {
      logger.warn('播放队列文件损坏，已备份为 play-queue.json.bak，忽略恢复');
      return null;
    }
    if (res.empty) return null;
    const obj = res.data;
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
      // sandbox preload 不能 require 应用文件：IPC 契约经 argv 序列化注入
      additionalArguments: [buildContractArg('main')],
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

  // 导航防护：主窗口只加载本地内容，任何远程/file 导航一律拒绝
  // （渲染层一旦有脚本注入，window.open / location 跳转可把窗口导向
  // 钓鱼页或本地文件协议，此处统一拦截）
  const denyNav = (url) => {
    logger.warn('[main] 拒绝主窗口导航:', url);
  };
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const u = (() => { try { return new URL(url); } catch (_) { return null; } })();
    if (!u) { denyNav(url); event.preventDefault(); return; }
    // M1: file: 导航只放行应用自身包内文件 —— 原先任意本机 HTML 都能载入
    // 这个挂着全量特权 IPC 的窗口（与下载目录写入组合即完整攻击链）
    const { fileURLToPath } = require('url');
    const isLocal = (() => {
      if (u.protocol !== 'file:') return false;
      try {
        const fp = fileURLToPath(u);
        const rel = path.relative(path.resolve(app.getAppPath()), path.resolve(fp));
        return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
      } catch (_) { return false; }
    })();
    // 同源 http(s) 导航放行（dev 模式下 vite 服务器整页刷新）。
    // 不能直接比 u.origin === current.origin：file: 页的 origin 恒为
    // 字符串 'null'，会把所有 file: 导航误判成同源。
    const cur = (() => {
      try { return new URL(mainWindow.webContents.getURL()); } catch (_) { return null; }
    })();
    const sameHttpOrigin = !!cur
      && (cur.protocol === 'http:' || cur.protocol === 'https:')
      && u.protocol === cur.protocol && u.host === cur.host;
    if (!isLocal && !sameHttpOrigin) {
      denyNav(url);
      event.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    denyNav(url);
    return { action: 'deny' };
  });

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
      label: '🖼 桌面歌词',
      click: () => {
        try { ipcWindow.createDesktopLyric(); } catch (e) { logger.warn('[tray] 打开桌面歌词失败:', e.message); }
      },
    },
    {
      label: '📐 迷你播放器',
      click: () => {
        try { ipcWindow.createMiniPlayer(); } catch (e) { logger.warn('[tray] 打开迷你播放器失败:', e.message); }
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

// ── 全局快捷键（系统媒体键）──────────────────────────
// 复用托盘的 tray-* 通道：渲染层已有对应监听（togglePlay/prevSong/nextSong），
// 不新增 IPC。prefs.globalShortcuts 开关（默认开），设置页实时切换。
function sendToMainWindow(channel) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel);
  }
}

function registerGlobalShortcuts() {
  if (prefs.get('globalShortcuts') === false) return; // 默认开
  const accels = [
    ['MediaPlayPause', 'tray-toggle-play'],
    ['MediaNextTrack', 'tray-next'],
    ['MediaPreviousTrack', 'tray-prev'],
    ['MediaStop', 'tray-toggle-play'],
  ];
  let registered = 0;
  for (const [accel, channel] of accels) {
    try {
      // MediaStop 也映射到暂停：多数键盘只有这四个键，停止语义≈暂停
      if (globalShortcut.register(accel, () => sendToMainWindow(channel))) registered++;
    } catch (e) {
      logger.warn(`[shortcuts] 注册 ${accel} 失败:`, e.message);
    }
  }
  if (registered > 0) logger.log(`[shortcuts] 全局媒体键已注册 ${registered}/${accels.length}`);
}

function unregisterGlobalShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (_e) { /* 退出路径忽略 */ }
}

function updateGlobalShortcutsEnabled(enabled) {
  try {
    globalShortcut.unregisterAll();
    if (enabled !== false) registerGlobalShortcuts();
  } catch (e) {
    logger.warn('[shortcuts] 切换失败:', e.message);
  }
}


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

  // C1: seed 目录授权注册表 —— prefs 里的目录键是历史会话经原生选器
  // 选定的结果，默认音乐子目录随应用始终可用
  for (const k of approvedDirs.DIR_PREF_KEYS) {
    const v = prefs.get(k);
    if (v) approvedDirs.approve(v);
  }
  approvedDirs.approve(path.join(app.getPath('music'), 'MusicDownloader'));
  approvedDirs.approve(path.join(app.getPath('userData'), 'MusicDownloader'));

  // 初始化下载历史持久化
  history.init(app.getPath('userData'));

  // ── 装配下载队列引擎（Sprint C：实现见 main/downloadQueue.js）──
  // 必须在 registerAllIpcHandlers 之前：IPC handler 通过 context.getDownloadQueue()
  // 拿队列引用，而该引用来自引擎。
  downloadQueueEngine = createDownloadQueueEngine({
    userDataDir: () => app.getPath('userData'),
    safeSend,
    getDownloadUrlSmart,
    getLyrics,
    // C1: 渲染层传入的 saveDir 必须在用户批准目录内，否则回落默认目录
    isSaveDirAllowed: (p) => approvedDirs.isApprovedDir(p),
    onQueueChanged: () => {
      // 队列变更时同步托盘菜单（下载进度/数量展示）
      try { updateTrayMenu(); } catch (_e) { /* 托盘未就绪可忽略 */ }
    },
    notifier: {
      notifyDownloadDone: (song, savePath) => {
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
      },
    },
  });
  // 让共享引用指向引擎内部数组（context / IPC 用的是同一个数组）
  downloadQueue = downloadQueueEngine.getQueue();

  // 确保默认下载目录存在（如果有用户自定义的 saveDir 则用之，否则用系统默认）
  const defaultDir = prefs.get('saveDir') || path.join(app.getPath('music'), 'MusicDownloader');
  await fsa.ensureDir(defaultDir); // mkdir recursive 本身幂等，无需先探测

  // 初始化 play_cache 目录 + 清理上次进程遗留的陈旧临时文件
  // 不 await：清理是尽力而为，不该拖慢启动
  playCache.cleanupStaleFiles(app.getPath('userData')).catch((e) => {
    logger.warn('[playCache] 清理陈旧缓存失败:', e.message);
  });

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
    await downloadQueueEngine.loadPersistedQueue();
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

  // 契约 ↔ 注册对账：契约声明却无人注册的通道在此现形（update-* 由上面的 updater 注册）
  try { assertContractCoverage(); } catch (e) {
    logger.warn('[ipc] 契约覆盖检查失败:', e.message);
  }

  // 定期 GC play_cache（10 分钟一次，.unref() 不阻塞进程退出）
  // cleanupExpired 是异步的：setInterval 不接收返回值，需自带 catch 防未处理拒绝
  const gcTimer = setInterval(() => {
    playCache.cleanupExpired().catch((e) => logger.warn('[playCache] GC 失败:', e.message));
  }, playCache.PLAY_CACHE_GC_INTERVAL);
  if (gcTimer.unref) gcTimer.unref();

  // 订阅更新周期检查（同为 unref 定时器；首查延迟 30s 避开启动峰值）
  subscriptions.startScheduler();

  // 剪贴板音乐链接嗅探（unref；prefs.clipboardWatch 每次 tick 现读，设置页即时生效）
  clipboardWatch.start();

  // 安装自定义应用菜单（屏蔽开发者工具菜单项及其加速键）
  buildAppMenu();

  // CORS 白名单：本地来源 + 各平台 manifest 声明的域名（派生）
  // ⚠️ 这是本工程唯一的安全边界 —— 它决定哪些源能拿到非 null 的
  //    Access-Control-Allow-Origin。改动后必须与历史枚举逐条相等，
  //    由 .preview/verify-platform-v3.cjs 的集合相等断言守住（不允许新增项）。
  const LOCAL_ORIGINS = ['http://localhost', 'http://127.0.0.1'];
  const { origins: platformOrigins, suffixes: platformSuffixes } =
    require('../api').registry.getAllowedOrigins();
  const ALLOWED_ORIGINS = new Set([...LOCAL_ORIGINS, ...platformOrigins]);
  // 部分平台的 CDN 子域是动态的（douyinvod 按地域/节点变化、kugou 音频域有多个前缀），
  // 精确匹配枚举不完，故额外做后缀匹配。后缀带前导点，
  // `evil-douyinvod.com` 这类不会以 `.douyinvod.com` 结尾，不会被误放行。
  const ALLOWED_ORIGIN_SUFFIXES = [...platformSuffixes];
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    // M5 修正：原实现拿 details.url 自身的 origin 判定并回填，等于给每个
    // 响应写上"它自己"，对本应用（file:// 页 origin 为 null）完全无效，
    // 还会覆盖上游正确的 ACAO。正确语义：目标是白名单平台源时，把
    // 「发起方」反射回去 —— 打包后发起方是 file://（null），dev 是本地端口。
    let targetOrigin = '';
    try { targetOrigin = new URL(details.url).origin; } catch (_e) { /* noop */ }
    const isAllowed = ALLOWED_ORIGINS.has(targetOrigin)
      || ALLOWED_ORIGIN_SUFFIXES.some((sfx) => targetOrigin.endsWith(sfx));
    const headers = { ...details.responseHeaders };
    const hasACAO = Object.keys(headers).some(k => k.toLowerCase() === 'access-control-allow-origin');
    if (isAllowed && !hasACAO) {
      const initiator = details.initiator && /^https?:\/\//.test(details.initiator)
        ? new URL(details.initiator).origin
        : 'null';
      headers['Access-Control-Allow-Origin'] = [initiator];
      headers['Access-Control-Allow-Methods'] = ['GET', 'HEAD', 'OPTIONS'];
      headers['Access-Control-Allow-Headers'] = ['Range', 'Referer'];
    }
    callback({ responseHeaders: headers });
  });

  createWindow();
  createTray();
  registerGlobalShortcuts();
});

app.on('window-all-closed', () => {
  // 下载队列引擎：立即落盘待写队列 + 停定时器（防抖窗口内的最后一次变更会丢）
  try { if (downloadQueueEngine) downloadQueueEngine.dispose(); } catch (e) {
    logger.warn('[index] 队列引擎清理失败:', e.message);
  }
  if (playQueuePersistTimer) { clearTimeout(playQueuePersistTimer); playQueuePersistTimer = null; }
  subscriptions.stopScheduler();
  clipboardWatch.stop();
  unregisterGlobalShortcuts();
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
    persistQueue:     () => downloadQueueEngine.persistQueue(),
    persistPlayQueue,
    loadPersistedPlayQueue,
    processQueue:     () => downloadQueueEngine.processQueue(),
    requestCancelDownload: (taskId) => downloadQueueEngine.requestCancel(taskId),
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
  ipcSubscriptions.register();

  // ── 播放队列持久化 IPC ─────────────────────────────
  ipcHandle('save-play-queue', (_, data) => {
    persistPlayQueue(data);
    return { ok: true };
  });
  ipcHandle('load-play-queue', () => {
    return loadPersistedPlayQueue() || { queue: [] };
  });

  // ── 系统托盘 IPC ───────────────────────────────────
  ipcOn('tray-update-play-state', (_, playState) => {
    updateTrayMenu(playState);
  });

  // ── 全局快捷键开关（设置页实时切换）─────────────────
  ipcOn('set-global-shortcuts', (_, enabled) => {
    updateGlobalShortcutsEnabled(!!enabled);
    logger.log(`[shortcuts] 全局媒体键: ${enabled ? '已启用' : '已停用'}`);
  });

  // ── 版本查询 IPC ───────────────────────────────────
  ipcHandle('get-version', () => {
    const pkg = require('../../package.json');
    const version = pkg.version || '1.0.0';
    const commit = process.env.npm_config_git_commit || '';
    return commit ? `${version} (${commit.slice(0, 7)})` : version;
  });
}

// ⚠️ 新增 IPC 请写进 src/main/ipc/*.js 并通过 register.js 的 handle/on 注册：
// 通道与参数规格统一声明在 src/shared/ipcContract.js（契约未声明会启动即抛，
// test/ipc-contract.test.js 常驻对账，勿再裸用 ipcMain）

// ─── 下载队列调度（Sprint C：已抽到 main/downloadQueue.js）───────────────────
// processQueue / processOneSong / sanitizeFilename 的完整实现见
// src/main/downloadQueue.js（引擎在 bootstrap 处装配并接进 context）。
// 这样「下载」这条核心链路可被独立阅读与测试，不再与窗口/托盘/生命周期混居。

// ⚠️ 此处下方的旧本地音乐库 IPC（scan-local-library / read-local-metadata /
//   read-local-lrc / update-id3-tags / update-id3-cover）+ LRC 解码函数
// 已在 P2-1 拆分到 src/main/ipc/library.js
// 此处不再重复定义，避免 IPC handler channel 重复注册
