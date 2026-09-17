/**
 * 本地音乐库持久化索引
 *
 * 功能：
 *   - 扫描结果缓存到 userData/library-index.json
 *   - 启动时秒加载，避免全量扫描
 *   - 增量扫描：只重新扫描新增/修改的文件
 *   - 自动清理已删除文件的索引条目
 *
 * 性能约定（重要）：
 *   本模块跑在 Electron 主进程，也就是 UI 线程。扫描时会对「每个音频文件」
 *   做一次 stat 判断 mtime，同步 statSync 会让这段时间的窗口完全冻结
 *   （5000 首 ≈ 5000 次同步磁盘调用）。因此本模块所有 IO 一律走
 *   utils/fsAsync（fs.promises），禁止出现 fs.*Sync——
 *   test/libraryIndex.test.js 里有同步调用守卫做回归闸门。
 *
 * 索引路径解析：
 *   优先用 init(userDataPath) 注入的目录；未注入时惰性向 electron 取
 *   app.getPath('userData')。惰性 + 可注入让本模块能脱离 electron 单测。
 */

const path = require('path');
const logger = require('./logger');
const fsa = require('./fsAsync');
const { atomicWriteJsonAsync, safeReadJsonAsync } = require('./atomicFile');

let _userDataPath = null;

/**
 * 注入 userData 目录（生产环境可选，测试必用）
 * @param {string} userDataPath
 */
function init(userDataPath) {
  _userDataPath = userDataPath;
}

function _userDataDir() {
  if (_userDataPath) return _userDataPath;
  // 惰性 require：既避免测试环境顶层加载 electron 抛错，也让构建期的
  // external electron 不参与模块初始化
  const { app } = require('electron');
  return app.getPath('userData');
}

function _indexFile() {
  return path.join(_userDataDir(), 'library-index.json');
}

/**
 * 加载索引
 * @returns {Promise<{ dirPath: string, songs: Array, lastScan: number, fileMap: Object }>}
 */
async function loadIndex() {
  try {
    const res = await safeReadJsonAsync(_indexFile());
    if (!res.ok || res.empty) {
      return { dirPath: '', songs: [], lastScan: 0, fileMap: {} };
    }
    const index = res.data || {};
    if (!Array.isArray(index.songs)) index.songs = [];
    // 重建 fileMap（文件路径 → 索引位置）用于快速查找；它不入盘
    index.fileMap = {};
    index.songs.forEach((s, i) => {
      if (s && s.filePath) index.fileMap[s.filePath] = i;
    });
    if (typeof index.dirPath !== 'string') index.dirPath = '';
    if (typeof index.lastScan !== 'number') index.lastScan = 0;
    return index;
  } catch (e) {
    logger.warn('[LibraryIndex] 读取索引失败，按空索引处理:', e.message);
    return { dirPath: '', songs: [], lastScan: 0, fileMap: {} };
  }
}

/**
 * 保存索引（原子写：先写 .tmp 再 rename，避免进程被杀时留下半个 JSON）
 * @param {{ dirPath: string, songs: Array, lastScan: number }} index
 * @returns {Promise<boolean>} 是否写入成功
 */
async function saveIndex(index) {
  try {
    // 不保存 fileMap（它是运行时重建的）
    const { fileMap, ...rest } = index;
    void fileMap;
    await atomicWriteJsonAsync(_indexFile(), rest);
    return true;
  } catch (e) {
    logger.warn('[LibraryIndex] 保存索引失败:', e.message);
    return false;
  }
}

/**
 * 增量扫描：对比现有索引，只处理新增/修改的文件
 * @param {string} dirPath - 扫描目录
 * @param {Function} scanDirectory - 扫描目录函数
 * @param {Function} readAudioMetadata - 读取元数据函数
 * @param {Function} [onProgress] - 进度回调
 * @returns {Promise<{ songs: Array, added: number, removed: number, updated: number }>}
 */
async function incrementalScan(dirPath, scanDirectory, readAudioMetadata, onProgress) {
  const index = await loadIndex();
  const existingSongs = index.dirPath === dirPath ? (index.songs || []) : [];
  const existingFileMap = {};
  existingSongs.forEach((s, i) => { if (s && s.filePath) existingFileMap[s.filePath] = i; });

  // 扫描当前目录所有文件
  const currentFiles = await scanDirectory(dirPath, onProgress);
  const currentFileSet = new Set(currentFiles);

  // 找出新增和修改的文件
  const toUpdate = [];
  const existingTracks = [...existingSongs]; // 复制一份

  for (const fp of currentFiles) {
    const existingIdx = existingFileMap[fp];
    if (existingIdx !== undefined) {
      // 文件已存在，检查是否修改（通过 mtime）。stat 失败说明文件已被删除，
      // 交给下面的「已删除」逻辑处理，这里保持索引原样。
      const stat = await fsa.statOrNull(fp);
      if (stat) {
        const existingSong = existingTracks[existingIdx];
        if (existingSong && existingSong.mtime && stat.mtimeMs > existingSong.mtime) {
          toUpdate.push({ filePath: fp, idx: existingIdx, isNew: false });
        }
      }
      // 保留已有数据（不重新读取元数据）
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
          const stat = await fsa.statOrNull(filePath);
          if (stat) meta.mtime = stat.mtimeMs;
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

    // 让出事件循环：每批之间释放一次，保证扫描期间 UI 仍可响应
    await new Promise(r => setImmediate(r));
  }

  // 移除已删除的文件
  const removedCount = removedFiles.length;
  const finalSongs = existingTracks.filter((s) => {
    if (!s || !s.filePath) return false;
    return currentFileSet.has(s.filePath);
  });

  // 保存索引
  await saveIndex({
    dirPath,
    songs: finalSongs,
    lastScan: Date.now(),
  });

  logger.log(`[LibraryIndex] 增量扫描完成: +${addedCount} ~${updatedCount} -${removedCount}, 共 ${finalSongs.length} 首`);

  return {
    songs: finalSongs,
    added: addedCount,
    removed: removedCount,
    updated: updatedCount,
  };
}

module.exports = { init, loadIndex, saveIndex, incrementalScan };
