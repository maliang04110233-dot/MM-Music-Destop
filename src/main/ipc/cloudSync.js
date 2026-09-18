/**
 * 云同步 IPC - 导出/导入所有用户数据
 *
 * 注册: export-all-data / import-all-data
 */

const { dialog } = require('electron');
const { handle } = require('./register');
const prefs = require('../../utils/prefs');
const history = require('../../utils/history');
const approvedDirs = require('../approvedDirs');
const { DIR_PREF_KEYS } = approvedDirs;
const path = require('path');
const logger = require('../../utils/logger');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../utils/fsAsync');

// 导入允许写入的 prefs 键（与 ipc/prefs.js 的 ALLOWED_PREF_KEYS 保持一致，
// 另加仅主进程内部使用的键）。导入文件内容不可信，未列出的键一律丢弃。
const IMPORTABLE_PREF_KEYS = new Set([
  'saveDir', 'localDirPath', 'theme', 'language',
  'quality', 'downloadQuality', 'concurrency', 'speedLimit', 'notifications',
  'namingTemplate', 'qualityBySource',
  'autoPlay', 'showLyrics', 'miniPlayerAlwaysOnTop',
  'lyricFontSize', 'lyricOffset', 'playProgressMemory',
  'recentlyPlayed', 'playStats', 'playProgressMap',
  'eqPreset', 'eqGains', 'eqBypass',
  'aiMusicApiKey', 'aiMusicSaveDir', 'convertOutputDir',
  'downloadTemplates', 'searchHistory',
  // 主进程内部维护的数据键（导出时单独收集，导入时回写）
  'userPlaylists', 'activeDownloadTemplate',
]);

function register() {
  // 导出所有数据
  handle('export-all-data', async () => {
    try {
      const result = await dialog.showSaveDialog({
        title: '导出音乐下载器数据',
        defaultPath: `music-downloader-backup-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      // 收集所有数据（键名与真实存储对齐：历史在 history.json，EQ 是 eqPreset/eqGains）
      const historyStats = history.stats();
      const exportData = {
        version: 2,
        exportedAt: new Date().toISOString(),
        app: 'music-downloader',
        data: {
          prefs: prefs.getAll ? prefs.getAll() : await getAllPrefs(),
          userPlaylists: prefs.get('userPlaylists') || [],
          downloadTemplates: prefs.get('downloadTemplates') || [],
          activeTemplate: prefs.get('activeDownloadTemplate') || null,
          // 真实下载/播放历史（history.json，此前导出的是永无人读的 prefs 废键）
          downloadHistory: history.query({ limit: history.MAX_ENTRIES }).items,
          historyTotal: historyStats.total,
          // EQ 设置（真实键名）
          eqPreset: prefs.get('eqPreset') || null,
          eqGains: prefs.get('eqGains') || null,
        },
      };

      await fsa.writeText(result.filePath, JSON.stringify(exportData, null, 2));
      return { success: true, path: result.filePath };
    } catch (e) {
      logger.warn('导出失败:', e);
      return { success: false, error: e.message };
    }
  });

  // 导入数据
  handle('import-all-data', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: '导入音乐下载器数据',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });

      if (result.canceled || !result.filePaths?.length) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const content = await fsa.tryReadText(filePath);
      if (content === null) {
        return { success: false, error: '无法读取所选文件' };
      }
      const importData = JSON.parse(content);

      // 验证格式
      if (!importData.app || !importData.data) {
        return { success: false, error: '文件格式无效，不是有效的备份文件' };
      }

      if (importData.app !== 'music-downloader') {
        return { success: false, error: '该文件来自其他应用，不匹配' };
      }

      const { data } = importData;
      const results = [];

      // 恢复歌单 / 模板 / 活动模板（真实存储键）
      if (Array.isArray(data.userPlaylists)) {
        prefs.set('userPlaylists', data.userPlaylists);
        results.push(`歌单: ${data.userPlaylists.length} 个`);
      }

      if (Array.isArray(data.downloadTemplates)) {
        prefs.set('downloadTemplates', data.downloadTemplates);
        results.push(`下载模板: ${data.downloadTemplates.length} 个`);
      }

      if (data.activeTemplate !== undefined) {
        prefs.set('activeDownloadTemplate', data.activeTemplate);
      }

      // 恢复下载历史（真实存储在 history.json；旧版备份里存在 prefs 里的
      // downloadHistory 键是废数据，此处只接受数组）
      if (Array.isArray(data.downloadHistory) && data.downloadHistory.length) {
        const imported = history.importEntries(data.downloadHistory);
        results.push(`下载历史: 导入 ${imported} 条`);
      }

      // 恢复 EQ 设置（真实键名 eqPreset/eqGains；兼容旧备份的 eqSettings 对象）
      if (data.eqPreset !== undefined || data.eqGains !== undefined) {
        if (data.eqPreset !== undefined) prefs.set('eqPreset', data.eqPreset);
        if (data.eqGains !== undefined) prefs.set('eqGains', data.eqGains);
        results.push('EQ 设置');
      } else if (data.eqSettings && typeof data.eqSettings === 'object') {
        prefs.set('eqPreset', data.eqSettings.preset);
        prefs.set('eqGains', data.eqSettings.gains);
        results.push('EQ 设置');
      }

      // 通用设置：只接受白名单键（导入文件内容不可信，防止注入未知键）
      if (data.prefs && typeof data.prefs === 'object') {
        let applied = 0;
        let droppedDirs = 0;
        for (const [key, value] of Object.entries(data.prefs)) {
          if (!IMPORTABLE_PREF_KEYS.has(key)) continue;
          // C1: 目录键来自不可信备份 —— 只接受已批准目录，否则丢弃，
          // 让用户在设置里重新选一次（导入不应等于授予任意目录读写权）
          if (DIR_PREF_KEYS.has(key) && value && !approvedDirs.isApprovedDir(value)) {
            droppedDirs++;
            continue;
          }
          prefs.set(key, value);
          applied++;
        }
        if (applied) results.push(`通用设置: ${applied} 项`);
        if (droppedDirs) results.push(`目录设置: ${droppedDirs} 项被忽略（需在设置中重新选择）`);
      }

      return {
        success: true,
        message: `导入成功:\n${results.join('\n')}`,
      };
    } catch (e) {
      logger.warn('导入失败:', e);
      return { success: false, error: e.message };
    }
  });
}

async function getAllPrefs() {
  // prefs.js 可能没有 getAll，尝试直接读取
  try {
    const prefsPath = path.join(require('electron').app.getPath('userData'), 'prefs.json');
    const raw = await fsa.tryReadText(prefsPath);
    if (raw) return JSON.parse(raw);
  } catch (_) {
    // 忽略非 JSON 格式或文件缺失
  }
  return {};
}

module.exports = { register, IMPORTABLE_PREF_KEYS };
