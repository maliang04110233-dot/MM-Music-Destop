/**
 * 用户偏好 IPC
 *
 * 注册：get-pref / set-pref / flush-prefs
 *
 * 持久化到 userData/prefs.json（用 utils/prefs.js）
 */

const { ipcMain } = require('electron');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');

// H9: Whitelist of allowed preference keys to prevent arbitrary key injection
// 键全集 = 主进程 prefs.get() 读取的键 ∪ 渲染层 getPref/setPref 使用的键（见 src/renderer/js/）
const ALLOWED_PREF_KEYS = new Set([
  // 目录 / 通用
  'saveDir', 'localDirPath', 'theme', 'language',
  'quality', 'downloadQuality', 'concurrency', 'speedLimit', 'notifications',
  // 命名模板（统一键名：下载页与设置页共用 namingTemplate）
  'namingTemplate',
  // 分平台音质覆盖表：平台 id → standard/hq/lossless，未列出的平台沿用 quality
  'qualityBySource',
  // 播放行为
  'autoPlay', 'showLyrics', 'miniPlayerAlwaysOnTop',
  'lyricFontSize', 'lyricOffset', 'playProgressMemory', 'playerVolume',
  'playbackRate', 'globalShortcuts',
  // 播放状态持久化
  'recentlyPlayed', 'playStats', 'playProgressMap',
  // EQ
  'eqPreset', 'eqGains', 'eqBypass',
  // AI 音乐
  'aiMusicApiKey', 'aiMusicSaveDir',
  // 转码输出目录
  'convertOutputDir',
  // 队列模板 / 搜索历史（主进程内部写入，但导入流程会经 set）
  'downloadTemplates', 'searchHistory',
]);

function register() {
  ipcMain.handle('get-pref', (_, key) => prefs.get(key));
  ipcMain.handle('set-pref', (_, key, value) => {
    if (!ALLOWED_PREF_KEYS.has(key)) {
      logger.warn('[prefs] 拒绝写入未白名单的键:', key);
      return false;
    }
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

module.exports = { register, ALLOWED_PREF_KEYS };
