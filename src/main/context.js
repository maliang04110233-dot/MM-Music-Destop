/**
 * 主进程共享上下文
 *
 * 关键：mainWindow / downloadQueue 是 main/index.js 的 let 变量，
 * createWindow() 之后才赋值。子模块通过 getter 访问，确保拿到最新值。
 */

let _ctx = null;
let _getMainWindow = () => null;
let _getDownloadQueue = () => [];

const taskbarProgress = require('./taskbarProgress');

function safeSend(channel, payload) {
  try {
    if (!_ctx) return;
    const w = _getMainWindow();
    if (w && !w.isDestroyed() && w.webContents && !w.webContents.isDestroyed()) {
      w.webContents.send(channel, payload);
    }
    if (channel === 'queue-updated' || channel === 'download-progress') {
      taskbarProgress.refresh(_getDownloadQueue);
    }
  } catch (e) {
    // swallow
  }
}

function init(opts) {
  _getMainWindow    = opts.getMainWindow    || (() => null);
  _getDownloadQueue = opts.getDownloadQueue || (() => []);
  _ctx = {
    app:           opts.app,
    persistQueue:  opts.persistQueue,
    processQueue:  opts.processQueue,
    requestCancelDownload: opts.requestCancelDownload,
    setQueuePaused: opts.setQueuePaused,
    queueIsPaused: opts.queueIsPaused,
    setLibraryWatchDir: opts.setLibraryWatchDir,
  };
  return _ctx;
}

function getCtx() {
  if (!_ctx) throw new Error('main context not initialized; call init() in app.whenReady()');
  return _ctx;
}

/**
 * 拿 mainWindow（永远返回最新值）
 */
function getMainWindow() { return _getMainWindow(); }

/**
 * 拿 downloadQueue（永远返回最新值）
 */
function getDownloadQueue() { return _getDownloadQueue(); }

module.exports = { init, getCtx, safeSend, getMainWindow, getDownloadQueue };
