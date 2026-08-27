/**
 * 云同步 IPC - 导出/导入所有用户数据
 *
 * 注册: export-all-data / import-all-data
 */

const { ipcMain, dialog } = require('electron');
const prefs = require('../../utils/prefs');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

function register() {
  // 导出所有数据
  ipcMain.handle('export-all-data', async () => {
    try {
      const result = await dialog.showSaveDialog({
        title: '导出音乐下载器数据',
        defaultPath: `music-downloader-backup-${Date.now()}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }

      // 收集所有数据
      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        app: 'music-downloader',
        data: {
          prefs: prefs.getAll ? prefs.getAll() : getAllPrefs(),
          userPlaylists: prefs.get('userPlaylists') || [],
          downloadTemplates: prefs.get('downloadTemplates') || [],
          activeTemplate: prefs.get('activeDownloadTemplate') || null,
          // 下载历史
          downloadHistory: prefs.get('downloadHistory') || [],
          // 听歌历史
          playHistory: prefs.get('playHistory') || [],
          // EQ 设置
          eqSettings: prefs.get('eqSettings') || null,
        },
      };

      fs.writeFileSync(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8');
      return { success: true, path: result.filePath };
    } catch (e) {
      logger.warn('导出失败:', e);
      return { success: false, error: e.message };
    }
  });

  // 导入数据
  ipcMain.handle('import-all-data', async () => {
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
      const content = fs.readFileSync(filePath, 'utf-8');
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

      // 恢复各项数据
      if (data.userPlaylists) {
        prefs.set('userPlaylists', data.userPlaylists);
        results.push(`歌单: ${data.userPlaylists.length} 个`);
      }

      if (data.downloadTemplates) {
        prefs.set('downloadTemplates', data.downloadTemplates);
        results.push(`下载模板: ${data.downloadTemplates.length} 个`);
      }

      if (data.activeTemplate !== undefined) {
        prefs.set('activeDownloadTemplate', data.activeTemplate);
      }

      if (data.downloadHistory) {
        prefs.set('downloadHistory', data.downloadHistory);
        results.push(`下载历史: ${data.downloadHistory.length} 条`);
      }

      if (data.playHistory) {
        prefs.set('playHistory', data.playHistory);
        results.push(`播放历史: ${data.playHistory.length} 条`);
      }

      if (data.eqSettings) {
        prefs.set('eqSettings', data.eqSettings);
        results.push('EQ 设置');
      }

      // 通用设置
      if (data.prefs) {
        for (const [key, value] of Object.entries(data.prefs)) {
          // 跳过敏感的 cookie 等
          if (!['cookies', 'session'].includes(key)) {
            prefs.set(key, value);
          }
        }
        results.push('通用设置');
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

function getAllPrefs() {
  // prefs.js 可能没有 getAll，尝试直接读取
  try {
    const prefsPath = path.join(require('electron').app.getPath('userData'), 'prefs.json');
    if (fs.existsSync(prefsPath)) {
      return JSON.parse(fs.readFileSync(prefsPath, 'utf-8'));
    }
  } catch (_) {
    // 忽略非 JSON 格式或文件缺失
  }
  return {};
}

module.exports = { register };
