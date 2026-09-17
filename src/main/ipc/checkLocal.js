/**
 * 本地库比对 IPC
 *
 * 注册：check-local-exists
 *
 * 用法：renderer 传入 { saveDir, items: [{title, artist}] }
 * 返回：[{title, artist, exists: bool, filePath?: string}]
 *
 * 性能优化：先列出目录所有音频文件（一次性 IO），再批量读 ID3 标签
 * （music-metadata 异步并发 + 缓存）。
 */

const { ipcMain } = require('electron');
const { scanDirectory, readAudioMetadata } = require('../../utils/localLibrary');
const logger = require('../../utils/logger');
// 主进程即 UI 线程：文件 IO 必须异步
const fsa = require('../../utils/fsAsync');

const AUDIO_EXTS = new Set(['.mp3', '.m4a', '.flac', '.ogg', '.wav', '.wma']);

/**
 * 标准化字符串用于比较：去括号内容、去空格、统一大小写
 */
function norm(s) {
  return String(s || '')
    .replace(/[（(].*?[)）]/g, '')   // 去除括号内容（"陈奕迅 (Live)" → "陈奕迅"）
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 模糊匹配：title 包含匹配 + artist 包含匹配
 */
function matchSong(item, tag) {
  const t = norm(item.title);
  const a = norm(item.artist);
  const T = norm(tag.title);
  const A = norm(tag.artist);
  if (!t) return false;
  if (!T.includes(t) && !t.includes(T)) return false;
  // artist 必须至少一方包含另一方
  if (a && A) {
    if (!A.includes(a) && !a.includes(A)) return false;
  }
  return true;
}

/**
 * 注册 IPC
 */
function register() {
  // 渲染层传对象：api.checkLocalExists({ saveDir, items })——单对象参数，
  // 兼容位置传参形态以防万一
  ipcMain.handle('check-local-exists', async (_, ...a) => {
    const { saveDir, items } = (a[0] && typeof a[0] === 'object' && !Array.isArray(a[0])) ? a[0] : (a[1] || {});
    try {
      if (!saveDir || !await fsa.exists(saveDir)) {
        return items.map(it => ({ ...it, exists: false }));
      }
      if (!Array.isArray(items) || items.length === 0) return [];

      // 1) 一次性列出目录所有音频文件
      const audioFiles = await scanDirectory(saveDir, null);
      // 2) 批量读 ID3（每 30 并发）
      const fileMetas = [];
      const BATCH = 30;
      for (let i = 0; i < audioFiles.length; i += BATCH) {
        const batch = audioFiles.slice(i, i + BATCH);
        const metas = await Promise.allSettled(
          batch.map(fp => readAudioMetadata(fp))
        );
        for (const r of metas) {
          if (r.status === 'fulfilled' && r.value) fileMetas.push(r.value);
        }
      }
      // 3) 给每个 item 找匹配
      return items.map(item => {
        for (const tag of fileMetas) {
          if (matchSong(item, tag)) {
            return { ...item, exists: true, filePath: tag.filePath };
          }
        }
        return { ...item, exists: false };
      });
    } catch (e) {
      logger.warn('[check-local-exists] 失败:', e.message || e);
      return items.map(it => ({ ...it, exists: false }));
    }
  });
}

module.exports = { register, norm, matchSong, AUDIO_EXTS };
