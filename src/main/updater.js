/**
 * 自动更新模块
 * GitHub Releases 更新（electron-builder publish: always）
 *
 * 工作流：
 * 1. 主进程检查更新（可选指定版本号）
 * 2. 更新可用时通过 ipc 通知渲染层
 * 3. 渲染层弹窗让用户确认下载
 * 4. 下载完成后通过 ipc 触发重启安装
 */
const { autoUpdater } = require('electron-updater');
const { ipcMain } = require('electron');
const logger = require('../utils/logger');

let _updateAvailable = false;

// ── 配置 ──────────────────────────────────────────────
// 更新源固定为本仓库 GitHub Releases（electron-builder publish: always）
autoUpdater.setFeedURL({ provider: 'github', repo: 'MusicDL', owner: 'maliang04110233-dot', releaseType: 'release' });

// ── 事件绑定 ──────────────────────────────────────────
autoUpdater.autoDownload = false; // 用户确认后下载
autoUpdater.autoInstallOnAppQuit = false; // 用户确认后安装

autoUpdater.on('checking-for-update', () => {
  logger.log('[Updater] Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  _updateAvailable = true;
  logger.log('[Updater] Update available:', info.version);
  // 通知所有窗口
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-available', { version: info.version, releaseNotes: info.releaseNotes });
  }
});

autoUpdater.on('update-not-available', () => {
  logger.log('[Updater] No updates available');
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-not-available');
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-download-progress', {
      percent: Math.round(progressObj.percent),
      bytesPerSecond: progressObj.bytesPerSecond,
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  logger.log('[Updater] Downloaded:', info.version);
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-downloaded', { version: info.version });
  }
});

// 用户主动触发标志：初始静默自检的失败只写日志，不打扰用户；
// 仅用户手动"检查更新"失败时才弹窗提示
let _userInitiated = false;

autoUpdater.on('error', (err) => {
  logger.warn('[Updater] Error:', err.message);
  if (!_userInitiated) return;
  const { BrowserWindow } = require('electron');
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update-error', { message: err.message });
  }
});

// ── IPC 端点 ──────────────────────────────────────────
ipcMain.handle('check-for-update', async () => {
  _userInitiated = true;
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    _userInitiated = false;
  }
});

ipcMain.handle('download-update', async () => {
  try {
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('restart-and-install', async () => {
  autoUpdater.quitAndInstall();
  return { success: true };
});

/**
 * 初始化自动更新
 * 启动时检查一次（不自动下载），后续用户手动触发
 */
function initUpdater() {
  autoUpdater.checkForUpdates().catch((err) => {
    logger.warn('[Updater] Initial check failed (expected if no release yet):', err.message);
  });
}

module.exports = { initUpdater };
