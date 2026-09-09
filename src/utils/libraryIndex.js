/**
 * 本地音乐库持久化索引
 *
 * 功能：
 *   - 扫描结果缓存到 userData/library-index.json
 *   - 启动时秒加载，避免全量扫描
 *   - 增量扫描：只重新扫描新增/修改的文件
 *   - 自动清理已删除文件的索引条目
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const logger = require('./logger');

const INDEX_FILE = () => path.join(app.getPath('userData'), 'library-index.json');

/**
 * 加载索引
 * @returns {{ dirPath: string, songs: Array, lastScan: number, fileMap: Object }}
 */
function loadIndex() {
  try {
    const data = fs.readFileSync(INDEX_FILE(), 'utf-8');
    const index = JSON.parse(data);
    // 重建 fileMap（文件路径 → 索引位置）用于快速查找
    index.fileMap = {};
    if (Array.isArray(index.songs)) {
      index.songs.forEach((s, i) => {
        if (s.filePath) index.fileMap[s.filePath] = i;
      });
    }
    return index;
  } catch (_e) {
    return { dirPath: '', songs: [], lastScan: 0, fileMap: {} };
  }
}

/**
 * 保存索引
 */
function saveIndex(index) {
  try {
    // 不保存 fileMap（它是运行时重建的）
    const { fileMap, ...rest } = index;
    void fileMap;
    fs.writeFileSync(INDEX_FILE(), JSON.stringify(rest, null, 2), 'utf-8');
  } catch (e) {
    logger.warn('[LibraryIndex] 保存索引失败:', e.message);
  }
}

/**
 * 增量扫描：对比现有索引，只处理新增/修改的文件
 * @param {string} dirPath - 扫描目录
 * @param {Function} scanDirectory - 扫描目录函数
 * @param {Function} readAudioMetadata - 读取元数据函数
 * @param {Function} onProgress - 进度回调
 * @returns {{ songs: Array, added: number, removed: number, updated: number }}
 */
async function incrementalScan(dirPath, scanDirectory, readAudioMetadata, onProgress) {
  const index = loadIndex();
  const existingSongs = index.dirPath === dirPath ? (index.songs || []) : [];
  const existingFileMap = {};
  existingSongs.forEach((s, i) => { if (s.filePath) existingFileMap[s.filePath] = i; });

  // 扫描当前目录所有文件
  const currentFiles = await scanDirectory(dirPath, onProgress);
  const currentFileSet = new Set(currentFiles);

  // 找出新增和修改的文件
  const toUpdate = [];
  const existingTracks = [...existingSongs]; // 复制一份

  for (const fp of currentFiles) {
    const existingIdx = existingFileMap[fp];
    if (existingIdx !== undefined) {
      // 文件已存在，检查是否修改（通过 mtime）
      try {
        const stat = fs.statSync(fp);
        const existingSong = existingTracks[existingIdx];
        if (existingSong && existingSong.mtime && stat.mtimeMs > existingSong.mtime) {
          toUpdate.push({ filePath: fp, idx: existingIdx, isNew: false });
        }
        // 保留已有数据（不重新读取元数据）
      } catch (_e) { /* 文件可能已被删除 */ }
    } else {
      // 新文件
      toUpdate.push({ filePath: fp, idx: -1, isNew: true });
    }
  }

  // 找出已删除的文件
  const removedFiles = Object.keys(existingFileMap).filter(fp => !currentFileSet.has(fp));

  // 读取新增/修改文件的元数据
  const BATCH = 20;
  let updatedCount = 0;
  let addedCount = 0;

  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async ({ filePath, idx, isNew }) => {
        try {
          const meta = await readAudioMetadata(filePath);
          const stat = fs.statSync(filePath);
          meta.mtime = stat.mtimeMs;
          return { meta, idx, isNew };
        } catch (e) {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const { meta, idx, isNew } = r.value;
      if (isNew) {
        existingTracks.push(meta);
        addedCount++;
      } else {
        existingTracks[idx] = meta;
        updatedCount++;
      }
    }

    // 通知进度
    if (onProgress) {
      onProgress({
        current: Math.min(i + BATCH, toUpdate.length),
        total: toUpdate.length,
        phase: 'metadata',
      });
    }

    await new Promise(r => setImmediate(r));
  }

  // 移除已删除的文件
  const removedCount = removedFiles.length;
  const finalSongs = existingTracks.filter((s) => {
    if (!s || !s.filePath) return false;
    return currentFileSet.has(s.filePath);
  });

  // 保存索引
  const newIndex = {
    dirPath,
    songs: finalSongs,
    lastScan: Date.now(),
  };
  saveIndex(newIndex);

  logger.log(`[LibraryIndex] 增量扫描完成: +${addedCount} ~${updatedCount} -${removedCount}, 共 ${finalSongs.length} 首`);

  return {
    songs: finalSongs,
    added: addedCount,
    removed: removedCount,
    updated: updatedCount,
  };
}

module.exports = { loadIndex, saveIndex, incrementalScan };
