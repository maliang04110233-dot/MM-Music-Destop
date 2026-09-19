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
const { handle } = require('./ipc/register');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');
const { getMirrorFeeds, useMirrorFeed } = require('./updateMirror');

// ── 配置 ──────────────────────────────────────────────
// 更新源固定为本仓库 GitHub Releases，但**不在这里写 URL**。
//
// electron-builder 打包时会按 build/config.cjs 的 publish 段生成
// resources/app-update.yml（repo: 'MM-Music-Destop'），electron-updater 运行时
// 自动读取它。曾经这里有一句按旧仓库名硬编码的 feedURL 覆盖调用（字面量形态
// 被 test/retry.test.js 守卫禁止，此处刻意不复述）：
//
//   · setFeedURL 会**覆盖** app-update.yml，让 build/config.cjs 成为假真源；
//   · 仓库 2026-09-10 从 MusicDL 改名为 MM-Music-Destop 后这句没跟着改，
//     于是每次检查更新都要先在 github.com 上吃一个改名 301 再重试——
//     在 github.com 连接本就不稳的网络下（实测同一时刻约 80% 连接超时），
//     这个多出来的 hop 是白白增加失败概率；
//   · GitHub 的改名重定向可以随时撤销，到那时自动更新会直接 404 消失。
//
// 结论：删掉这一句，单一真源回到 build/config.cjs。
// test/retry.test.js 里有守卫，不许这套字面量回来。

// ── 重试 ──────────────────────────────────────────────
// electron-updater 的 HttpExecutor.retryOnServerError 只在 5xx / EPIPE 上重试，
// 网络超时（net::ERR_TIMED_OUT、socket 超时、ECONNRESET）**不在其列**——一次
// 失败就直接抛给调用方，UI 上显示「更新失败：net::ERR_TIMED_OUT」。
// GitHub 控制面在部分网络下会间歇性丢 TCP，所以调用方必须自己包一层退避。
//
// 次数别贪多：HttpExecutor 的 socket 超时是 60s，挂满最坏情况 3 次就是 3 分钟。
// 实测 github.com 单次成功率约 20%，3 次尝试 ≈ 49%，20% 的网络从 20% 提到
// 49% 已经是这个缺陷的实质修复。
const CHECK_DELAYS = [2000, 5000];
const DOWNLOAD_DELAYS = [3000];

function checkForUpdatesWithRetry() {
  return withRetry(() => autoUpdater.checkForUpdates(), {
    delays: CHECK_DELAYS,
    onAttempt: (err, attempt, total) => {
      logger.warn(`[Updater] 检查更新失败（${attempt}/${total}）: ${err.message}`);
    },
  });
}

/**
 * 把裸的 Node 网络错误码翻译成用户能行动的文案。
 * 渲染层直接拼进弹窗，所以这里必须说人话。
 */
function describeUpdateError(err) {
  const msg = (err && err.message) || String(err);
  if (/ERR_TIMED_OUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN/i.test(msg)) {
    return '网络暂时连不上 GitHub（已自动重试多次），请稍后再试，' +
      '或到 GitHub Releases 页面手动下载最新版本';
  }
  return msg;
}

// ── 事件绑定 ──────────────────────────────────────────
autoUpdater.autoDownload = false; // 用户确认后下载
autoUpdater.autoInstallOnAppQuit = false; // 用户确认后安装

autoUpdater.on('checking-for-update', () => {
  logger.log('[Updater] Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
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
    win.webContents.send('update-error', { message: describeUpdateError(err) });
  }
});

// ── 镜像兜底 ──────────────────────────────────────────
// GitHub 直连在部分网络下间歇性全灭（实测检查更新 3 连败）。
// 直连耗尽重试后，逐个尝试镜像 feed（派生自 app-update.yml，见 updateMirror.js）。
// 镜像路径每次只做一次尝试：镜像本身是兜底，多试只会让用户等更久。
async function tryMirrorFeeds(label) {
  const feeds = getMirrorFeeds();
  for (let i = 0; i < feeds.length; i++) {
    try {
      logger.warn(`[Updater] ${label}：直连失败，尝试镜像源 ${i + 1}/${feeds.length}`);
      useMirrorFeed(autoUpdater, feeds[i]);
      await autoUpdater.checkForUpdates();
      return true;
    } catch (err) {
      logger.warn(`[Updater] 镜像源 ${i + 1} 失败: ${err.message}`);
    }
  }
  return false;
}

// ── IPC 端点（直连失败自动落镜像）──────────────────────
handle('check-for-update', async () => {
  _userInitiated = true;
  try {
    try {
      await checkForUpdatesWithRetry();
    } catch (err) {
      if (!(await tryMirrorFeeds('检查更新'))) throw err;
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: describeUpdateError(err) };
  } finally {
    _userInitiated = false;
  }
});

handle('download-update', async () => {
  try {
    try {
      await withRetry(() => autoUpdater.downloadUpdate(), {
        delays: DOWNLOAD_DELAYS,
        onAttempt: (err, attempt, total) => {
          logger.warn(`[Updater] 下载更新失败（${attempt}/${total}）: ${err.message}`);
        },
      });
    } catch (err) {
      // 切镜像 feed 后必须重新 check 一次：downloadUpdate 用的是最近一次
      // check 解析出的 provider，只换 feed 不重查会继续走旧的 GitHub 通道
      if (!(await tryMirrorFeeds('下载更新'))) throw err;
      await autoUpdater.downloadUpdate();
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: describeUpdateError(err) };
  }
});

handle('restart-and-install', async () => {
  autoUpdater.quitAndInstall();
  return { success: true };
});

/**
 * 初始化自动更新
 * 启动时检查一次（不自动下载），后续用户手动触发
 */
function initUpdater() {
  checkForUpdatesWithRetry().catch((err) => {
    logger.warn('[Updater] Initial check failed:', err.message);
  });
}

module.exports = { initUpdater };
