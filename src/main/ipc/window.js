/**
 * 窗口控制 / 文件系统 / 迷你播放器 IPC
 *
 * 注册：window-minimize / window-maximize / window-close / select-dir /
 *      get-default-dir / open-folder / open-external /
 *      open-mini-player / mini-toggle-play / mini-next / mini-prev / mini-close
 */

const { ipcMain, BrowserWindow, dialog, shell, app } = require('electron');
const path = require('path');
const { getMainWindow } = require('../context');
const playCache = require('../playCache');

let miniPlayerWin = null;

function createMiniPlayer() {
  if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
    miniPlayerWin.focus();
    return;
  }
  const main = getMainWindow();
  const [mx, my] = main ? main.getPosition() : [100, 100];
  miniPlayerWin = new BrowserWindow({
    width: 320, height: 72,
    x: mx, y: my,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    transparent: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload.js'),
    },
  });
  miniPlayerWin.loadFile(path.join(__dirname, '../../renderer/mini-player.html'));
  miniPlayerWin.webContents.on('did-finish-load', () => {
    // 通知主窗口推送当前播放状态到迷你播放器
    const main = getMainWindow();
    if (main && !main.isDestroyed()) {
      main.webContents.send('sync-mini-player');
    }
  });
  miniPlayerWin.on('closed', () => { miniPlayerWin = null; });
}

/** 向迷你播放器推送当前播放状态 */
function syncMiniPlayer(data) {
  if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
    miniPlayerWin.webContents.send('mini-player-update', data);
  }
}

function register() {
  ipcMain.on('window-minimize', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.minimize();
  });
  ipcMain.on('window-maximize', () => {
    const w = getMainWindow();
    if (!w || w.isDestroyed()) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on('window-close', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.close();
  });

  // ── 迷你播放器 ──────────────────────────────────────
  ipcMain.on('open-mini-player', () => createMiniPlayer());

  // 渲染器推送状态到迷你播放器
  ipcMain.on('mini-player-update', (_, data) => syncMiniPlayer(data));

  ipcMain.on('mini-toggle-play', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mini-toggle-play');
  });
  ipcMain.on('mini-next', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mini-next');
  });
  ipcMain.on('mini-prev', () => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send('mini-prev');
  });
  ipcMain.on('mini-close', () => {
    if (miniPlayerWin && !miniPlayerWin.isDestroyed()) {
      miniPlayerWin.close();
    }
  });

  // 选择下载目录
  ipcMain.handle('select-dir', async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // 默认下载目录
  ipcMain.handle('get-default-dir', () => {
    return path.join(app.getPath('music'), 'MusicDownloader');
  });

  // 打开目录 / 外部链接（渲染层经 musicAPI invoke 调用，需 handle）
  const openFolderImpl = (folder) => {
    if (!folder || typeof folder !== 'string') return { ok: false };
    // H11: Validate path is a local filesystem path (no protocol handlers)
    if (/^[a-zA-Z]+:/.test(folder) || folder.startsWith('\\') || folder.startsWith('/')) {
      // Resolve to real path and ensure it exists
      const fs = require('fs');
      try {
        const resolved = path.resolve(folder);
        if (fs.existsSync(resolved)) {
          shell.showItemInFolder(resolved);
        }
      } catch (_) { /* ignore invalid paths */ }
    }
    return { ok: true };
  };
  const openExternalImpl = (url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { ok: true };
  };
  ipcMain.handle('open-folder', (_, folder) => openFolderImpl(folder));
  ipcMain.handle('open-external', (_, url) => openExternalImpl(url));

  // 缓存管理
  ipcMain.handle('get-cache-size', () => {
    const size = playCache.getCacheSize(app.getPath('userData'));
    return playCache.formatCacheSize(size);
  });
  ipcMain.handle('clear-play-cache', () => {
    playCache.clearAllCache(app.getPath('userData'));
    return { cleared: true };
  });
}

module.exports = { register, syncMiniPlayer };
