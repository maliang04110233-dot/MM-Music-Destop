/**
 * 用户偏好 IPC
 *
 * 注册：get-pref / set-pref / flush-prefs
 *
 * 持久化到 userData/prefs.json（用 utils/prefs.js）
 */

const { ipcMain } = require('electron');
const prefs = require('../../utils/prefs');

// H9: Whitelist of allowed preference keys to prevent arbitrary key injection
const ALLOWED_PREF_KEYS = new Set([
  'saveDir', 'localDirPath', 'theme', 'language',
  'downloadQuality', 'autoPlay', 'showLyrics', 'miniPlayerAlwaysOnTop',
  'concurrency', 'downloadTemplates', 'searchHistory',
]);

function register() {
  ipcMain.handle('get-pref', (_, key) => prefs.get(key));
  ipcMain.handle('set-pref', (_, key, value) => {
    if (!ALLOWED_PREF_KEYS.has(key)) return false;
    prefs.set(key, value);
    return true;
  });
  ipcMain.handle('flush-prefs', () => { prefs.flush(); return true; });
  // 修复 B8：搜索历史通过 IPC 持久化到主进程 prefs.json（而非渲染端 localStorage）
  ipcMain.handle('get-search-history', () => prefs.get('searchHistory') || []);
  ipcMain.handle('set-search-history', (_, history) => {
    if (!Array.isArray(history)) return false;
    prefs.set('searchHistory', history.slice(0, 20)); // 上限 20 条
    return true;
  });
}

module.exports = { register };
