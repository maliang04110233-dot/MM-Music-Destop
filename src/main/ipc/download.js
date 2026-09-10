/**
 * 下载 / 队列 IPC
 *
 * 注册：get-download-url / proxy-play / add-to-queue / cancel-download /
 *      retry-download / remove-queue-item / clear-finished-queue / clear-all-queue
 *
 * 队列管理 + processQueue/processOneSong 留在 main/index.js（共享状态多）
 */

const { ipcMain } = require('electron');
const api = require('../../api');
const { getDownloadQueue, safeSend } = require('../context');
const { proxyPlay } = require('../playCache');
const logger = require('../../utils/logger');

function register() {
  // 关键：downloadQueue / app / persistQueue / processQueue 都通过 getter 拿，
  // 避免 register 时（createWindow 之前）解构到 undefined

  // 获取下载 URL（渲染层位置参数调用：api.getDownloadUrl(id, source, quality)）
  ipcMain.handle('get-download-url', async (_, ...a) => {
    const [id, source, quality] = (Array.isArray(a) && a.length) ? a : (a[0] || {});
    try {
      return await api.getDownloadUrl(id, source, quality);
    } catch (e) {
      logger.warn('获取下载URL失败:', e.message || e);
      return { error: e.message || e };
    }
  });

  // 智能取流（换源）：渲染层播放链路用——本源失败自动跨源找同曲
  ipcMain.handle('get-download-url-smart', async (_, ...a) => {
    const [song, quality] = (Array.isArray(a) && a.length) ? a : (a[0] || []);
    try {
      return await api.getDownloadUrlSmart(song, quality);
    } catch (e) {
      logger.warn('智能取流失败:', e.message || e);
      return { error: e.message || e };
    }
  });

  // 在线播放：把跨域音频代理到本地临时文件
  const { app } = require('electron');
  const { assertPublicHttpUrl } = require('../../utils/urlGuard');
  ipcMain.handle('proxy-play', async (_, ...a) => {
    const [url, referer] = (Array.isArray(a) && a.length) ? a : (a[0] || {});
    // C10: SSRF protection — full guard via urlGuard:
    //   scheme/userinfo 校验 + DNS 全记录解析 + 内网 IP 判定（含
    //   2130706433 / 0x7f.0.0.1 / 0177.0.0.1 / [::ffff:127.0.0.1] 等编码绕过）
    //   原正则黑名单已删除（可被 IP 编码与 DNS rebinding 绕过）
    const check = await assertPublicHttpUrl(url);
    if (!check.ok) {
      return { error: `URL 校验失败: ${check.reason}` };
    }
    try {
      return await proxyPlay(url, referer, app.getPath('userData'));
    } catch (e) {
      return { error: e.message || 'proxy-play failed' };
    }
  });

  // 添加到下载队列
  ipcMain.handle('add-to-queue', async (_, song) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, processQueue } = require('../context').getCtx();
    // 查重：同 id+source 且未完成的任务已在队列 → 拒绝，避免重复下载同一首
    const dup = downloadQueue.find(s =>
      s && s.id === song.id && s.source === song.source && s.status !== 'done');
    if (dup) {
      return { queued: false, duplicated: true, taskId: dup.taskId };
    }
    const taskId = makeTaskId();
    downloadQueue.push({ ...song, taskId, status: 'pending', progress: 0, addedAt: Date.now() });
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    processQueue();
    return { queued: true, taskId };
  });

  // 取消下载（仅可取消 pending）
  ipcMain.handle('cancel-download', (_, taskId) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../context').getCtx();
    const idx = downloadQueue.findIndex(s => s.taskId === taskId && s.status === 'pending');
    if (idx === -1) return { canceled: false };
    downloadQueue.splice(idx, 1);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { canceled: true };
  });

  // 重试失败的下载任务
  ipcMain.handle('retry-download', (_, taskId) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue, processQueue } = require('../context').getCtx();
    const idx = downloadQueue.findIndex(s => s.taskId === taskId);
    if (idx === -1) return { ok: false, error: '任务不存在' };
    const song = downloadQueue[idx];
    if (song.status !== 'error') return { ok: false, error: '该任务不在失败状态' };
    song.status = 'pending';
    song.error = null;
    song.errorCode = null;
    song.progress = 0;
    downloadQueue.splice(idx, 1);
    const insertAt = downloadQueue.findIndex(s => s.status === 'downloading');
    if (insertAt === -1) downloadQueue.unshift(song);
    else downloadQueue.splice(insertAt + 1, 0, song);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    processQueue();
    return { ok: true };
  });

  // 移除队列项
  ipcMain.handle('remove-queue-item', (_, taskId) => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../context').getCtx();
    const idx = downloadQueue.findIndex(s => s.taskId === taskId);
    if (idx === -1) return { removed: false };
    downloadQueue.splice(idx, 1);
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { removed: true };
  });

  // 清空已完成
  ipcMain.handle('clear-finished-queue', () => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../context').getCtx();
    const before = downloadQueue.length;
    for (let i = downloadQueue.length - 1; i >= 0; i--) {
      if (downloadQueue[i].status === 'done') downloadQueue.splice(i, 1);
    }
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { removed: before - downloadQueue.length };
  });

  // 清空全部
  ipcMain.handle('clear-all-queue', () => {
    const downloadQueue = getDownloadQueue();
    const { persistQueue } = require('../context').getCtx();
    const before = downloadQueue.length;
    downloadQueue.length = 0;
    safeSend('queue-updated', downloadQueue);
    persistQueue();
    return { removed: before };
  });

  // 批量加入队列（歌单详情页用）
  ipcMain.handle('add-playlist-to-queue', async (_, payload) => {
    try {
      const songs = (payload && payload.songs) || [];
      if (!Array.isArray(songs) || songs.length === 0) {
        return { queued: 0, skipped: 0 };
      }
      const downloadQueue = getDownloadQueue();
      const { persistQueue, processQueue } = require('../context').getCtx();

      // 1. 收集"真正在跑"的任务 key
      //    downloading: 算重复
      //    pending: 算重复（防止用户连点多次按钮重复入队）
      //    error: 不算（让用户能重试失败的歌）
      //    done: 不算（已下完，避免重复入队）
      //    但 ——
      //    用户场景：重启后 queue.json 里 42 个 pending 任务会"挡住"新歌单 20 首歌
      //    所以策略修正：pending 算重复，但用户可以先用 UI 上的"清空"按钮
      const existingIds = new Set();
      for (const s of downloadQueue) {
        if (!s) continue;
        if (s.status === 'done' || s.status === 'error') continue;
        if (s.id == null || s.id === '' || !s.source) continue;
        existingIds.add(`${s.source}:${s.id}`);
      }

      // 2. 逐首入队
      let queued = 0, skippedDup = 0, skippedNoId = 0;
      for (const s of songs) {
        if (!s || s.id == null || s.id === '' || !s.source) {
          skippedNoId++;
          continue;
        }
        const key = `${s.source}:${s.id}`;
        if (existingIds.has(key)) {
          skippedDup++;
          continue;
        }
        downloadQueue.push({
          ...s,
          taskId: makeTaskId(),
          status: 'pending',
          progress: 0,
          addedAt: Date.now(),
        });
        existingIds.add(key);
        queued++;
      }

      // 修复 B21：DEBUG 模式下才打 stderr，避免污染日志
      if (process.env.DEBUG) {
        process.stderr.write(`[add-playlist-to-queue] queued=${queued} skippedDup=${skippedDup} skippedNoId=${skippedNoId} queueLen=${downloadQueue.length}\n`);
      }
    
      if (queued > 0) {
        safeSend('queue-updated', downloadQueue);
        persistQueue();
        processQueue();
      }
    return { queued, skipped: skippedDup };
    } catch (e) {
      logger.warn('[add-playlist-to-queue] 失败:', e);
      return { queued: 0, skipped: 0, error: e.message || String(e) };
    }
  });

  // ── 导出播放列表 ──────────────────────────────────────────
  ipcMain.handle('export-playlist', async (_, params) => {
    const { dialog } = require('electron');
    const fs = require('fs');

    try {
      const { songs, format = 'm3u', name = 'MusicDL' } = params;
      if (!songs || !songs.length) return { error: '没有可导出的歌曲' };

      const ext = format === 'pls' ? 'pls' : 'm3u';
      const filters = [
        { name: '播放列表', extensions: [ext] },
        { name: '所有文件', extensions: ['*'] },
      ];

      const result = await dialog.showSaveDialog({
        defaultPath: `${name}.${ext}`,
        filters,
      });

      if (result.canceled) return { canceled: true };

      let content = '';
      if (ext === 'm3u') {
        content = '#EXTM3U\n';
        for (const song of songs) {
          const duration = Math.round((song.duration || 0) / 1000);
          content += `#EXTINF:${duration},${song.artist || 'Unknown'} - ${song.title || 'Unknown'}\n`;
          content += `${song.filePath || song.url || ''}\n`;
        }
      } else {
        content = '[playlist]\n';
        songs.forEach((song, i) => {
          content += `File${i + 1}=${song.filePath || song.url || ''}\n`;
          content += `Title${i + 1}=${song.artist || 'Unknown'} - ${song.title || 'Unknown'}\n`;
          content += `Length${i + 1}=${Math.round((song.duration || 0) / 1000)}\n`;
        });
        content += `NumberOfEntries=${songs.length}\n`;
      }

      fs.writeFileSync(result.filePath, content, 'utf-8');
      return { success: true, path: result.filePath };
    } catch (e) {
      return { error: e.message };
    }
  });
}

function makeTaskId() {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = { register, makeTaskId };
