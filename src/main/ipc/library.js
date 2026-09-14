/**
 * 本地音乐库 IPC
 *
 * 注册：scan-local-library / read-local-metadata / read-local-lrc /
 *      update-id3-tags / update-id3-cover
 */

const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
  scanDirectory,
  readAudioMetadata,
  writeAudioMetadata,
  writeAudioCover,
  readEmbeddedLyrics,
} = require('../../utils/localLibrary');
const { incrementalScan, loadIndex } = require('../../utils/libraryIndex');
const { fetchOnlineCover } = require('../../utils/onlineCover');
const logger = require('../../utils/logger');
const { scheduleOnlineLrcFetch } = require('../../utils/onlineLrc');
const { safeSend } = require('../context');
const prefs = require('../../utils/prefs');

// ── C9: 路径沙箱 ───────────────────────────────────────────
function isValidPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (/^(file|https?|data|javascript|ftp|smb|ms-|mailto):/i.test(p)) return false;
  return true;
}

/**
 * 路径是否在允许目录内。
 * 用 path.relative 而非 startsWith 判定：startsWith 会把
 * "C:\MusicX" 误判在 "C:\Music" 沙箱内（前缀碰撞），relative
 * 返回以 .. 开头或为绝对路径则一定在沙箱外。
 */
function isInsideDir(base, target) {
  try {
    const rel = path.relative(path.resolve(base), path.resolve(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch { return false; }
}

function isInAllowedDir(filePath) {
  try {
    const resolved = path.resolve(filePath);
    const localDir = prefs.get('localDirPath') || '';
    if (localDir && isInsideDir(localDir, resolved)) return true;
    const saveDir = prefs.get('saveDir') || '';
    if (saveDir && isInsideDir(saveDir, resolved)) return true;
    return isInsideDir(app.getPath('music'), resolved);
  } catch { return false; }
}

function register() {
  // 扫描本地目录（增量扫描：缓存索引 + 只处理变更文件）
  ipcMain.handle('scan-local-library', async (_, dirPath) => {
    try {
      if (!isValidPath(dirPath)) return { error: '非法路径', songs: [] };
      if (!fs.existsSync(dirPath)) return { error: '目录不存在', songs: [] };

      // 尝试增量扫描
      const result = await incrementalScan(
        dirPath,
        scanDirectory,
        readAudioMetadata,
        (progress) => safeSend('library-scan-progress', progress)
      );

      return { songs: result.songs, count: result.songs.length, incremental: true };
    } catch (e) {
      logger.warn('[Library] 增量扫描失败，回退全量扫描:', e.message);

      // 回退到全量扫描
      try {
        const filePaths = await scanDirectory(dirPath, (progress) => {
          safeSend('library-scan-progress', progress);
        });
        const songs = [];
        const BATCH = 20;
        for (let i = 0; i < filePaths.length; i += BATCH) {
          const batch = filePaths.slice(i, i + BATCH);
          const metas = await Promise.allSettled(batch.map(fp => readAudioMetadata(fp)));
          for (const r of metas) {
            if (r.status === 'fulfilled') songs.push(r.value);
            else logger.warn('读取元数据失败:', r.reason?.message);
          }
          await new Promise(r => setImmediate(r));
        }
        return { songs, count: songs.length, incremental: false };
      } catch (e2) {
        return { error: e2.message, songs: [] };
      }
    }
  });

  // 读取缓存索引（启动时秒加载）
  ipcMain.handle('load-library-index', async () => {
    try {
      const index = loadIndex();
      return { songs: index.songs || [], dirPath: index.dirPath, lastScan: index.lastScan };
    } catch (e) {
      return { songs: [], dirPath: '', lastScan: 0 };
    }
  });

  // 读取单首歌曲元数据
  ipcMain.handle('read-local-metadata', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { error: '路径不可访问' };
      return await readAudioMetadata(filePath);
    } catch (e) {
      return { error: e.message };
    }
  });

  // 读取本地 LRC 歌词
  ipcMain.handle('read-local-lrc', async (_, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { lrc: '', source: '' };
      if (!/\.(mp3|flac|m4a|aac|ogg|wav)$/i.test(filePath)) return { lrc: '', source: '' };
      if (!isInAllowedDir(filePath)) return { lrc: '', error: '路径不可访问' };

      // 1) 同目录 .lrc 优先
      const lrcPath = path.parse(filePath).ext
        ? filePath.replace(/\.[^.]+$/, '.lrc')
        : filePath + '.lrc';
      if (fs.existsSync(lrcPath)) {
        const stat = fs.statSync(lrcPath);
        if (stat.size > 0 && stat.size <= 1024 * 1024) {
          const buf = fs.readFileSync(lrcPath);
          const text = _decodeLrcBuffer(buf);
          if (text && text.trim()) return { lrc: text, source: 'sidecar' };
        }
      }

      // 2) 音频内嵌
      try {
        const embedded = await readEmbeddedLyrics(filePath);
        if (embedded && embedded.trim()) {
          return { lrc: embedded, source: 'embedded' };
        }
      } catch (_e) { /* fallback to online */ }

      // 3) 在线拉
      scheduleOnlineLrcFetch(filePath);
      return { lrc: '', source: '', fetching: true };
    } catch (e) {
      return { lrc: '', error: e.message, source: '' };
    }
  });

  // 更新 ID3 标签（渲染层位置参数：api.updateId3Tags(filePath, tags)）
  ipcMain.handle('update-id3-tags', async (_, ...a) => {
    const [filePath, tags] = (Array.isArray(a) && a.length) ? a : (a[0] || {});
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      return await writeAudioMetadata(filePath, tags);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 更新封面（渲染层位置参数：api.updateId3Cover(filePath, imageBase64)）
  ipcMain.handle('update-id3-cover', async (_, ...a) => {
    const [filePath, imageBase64] = (Array.isArray(a) && a.length) ? a : (a[0] || {});
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
        return { success: false, error: '无效的封面数据' };
      }
      // writeAudioCover 期望 data URL 字符串（内部 split(',') 取 base64 段）；
      // 此前先解码成 Buffer 再传入，Buffer 没有 split，功能必然失败。
      return await writeAudioCover(filePath, imageBase64);
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 在线拉取封面（渲染层位置参数：api.fetchOnlineCover(title, artist)）
  ipcMain.handle('fetch-online-cover', async (_, ...a) => {
    const [title, artist] = (Array.isArray(a) && a.length) ? a : (a[0] || {});
    try {
      const result = await fetchOnlineCover(title || '', artist || '');
      if (!result) return { success: false, error: '未找到匹配的封面' };
      return { success: true, ...result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 写入 LRC 歌词到同目录 sidecar 文件（渲染层位置参数：api.writeLocalLrc(filePath, lrc)）
  ipcMain.handle('write-local-lrc', async (_, ...a) => {
    const [filePath, lrc] = (Array.isArray(a) && a.length) ? a : (a[0] || {});
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      const lrcPath = path.parse(filePath).ext
        ? filePath.replace(/\.[^.]+$/, '.lrc')
        : filePath + '.lrc';
      const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
      const body = Buffer.from(lrc, 'utf8');
      fs.writeFileSync(lrcPath, Buffer.concat([bom, body]));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 批量获取歌词（按 title/artist 搜索网易云，写入 sidecar）
  ipcMain.handle('batch-fetch-lyrics', async (_, songs) => {
    const results = [];
    for (const s of songs) {
      try {
        await scheduleOnlineLrcFetch(s.filePath, { readAudioMetadata, getLyrics: require('../../api').getLyrics });
        results.push({ filePath: s.filePath, ok: true });
      } catch (e) {
        results.push({ filePath: s.filePath, ok: false, error: e.message });
      }
    }
    return results;
  });

  // 删除文件（回收站或永久删除）
  ipcMain.handle('delete-file', async (_, filePath) => {
    try {
      if (!isValidPath(filePath) || !isInAllowedDir(filePath)) return { success: false, error: '路径不可访问' };
      if (!fs.existsSync(filePath)) {
        return { success: false, error: '文件不存在' };
      }
      const { shell } = require('electron');
      await shell.trashItem(filePath);
      return { success: true };
    } catch (e) {
      logger.warn('[delete-file] 删除失败:', e.message);
      return { success: false, error: e.message };
    }
  });

  // 重命名文件
  ipcMain.handle('rename-file', async (_, oldPath, newPath) => {
    try {
      if (!isValidPath(oldPath) || !isValidPath(newPath)) return { success: false, error: '非法路径' };
      if (!isInAllowedDir(oldPath) || !isInAllowedDir(newPath)) return { success: false, error: '路径不可访问' };
      if (!fs.existsSync(oldPath)) {
        return { success: false, error: '源文件不存在' };
      }
      if (fs.existsSync(newPath)) {
        return { success: false, error: '目标文件已存在' };
      }
      fs.renameSync(oldPath, newPath);
      return { success: true };
    } catch (e) {
      logger.warn('[rename-file] 重命名失败:', e.message);
      return { success: false, error: e.message };
    }
  });

  // ── 多格式转码 ──────────────────────────────────────────
  ipcMain.handle('convert-audio', async (_, params) => {
    const { dialog, shell } = require('electron');

    try {
      const { inputPath, outputFormat = 'mp3', bitrate = '192k', outputDir = null } = params;

      if (!isValidPath(inputPath) || !isInAllowedDir(inputPath)) {
        return { error: '路径不可访问' };
      }
      if (!fs.existsSync(inputPath)) {
        return { error: '源文件不存在' };
      }

      const ffmpegPath = findFfmpeg();
      if (!ffmpegPath) {
        return { error: '未找到 ffmpeg，请安装后重试' };
      }

      // 输出路径
      if (outputDir && !isInAllowedDir(outputDir)) {
        return { error: '输出目录不可访问' };
      }
      const ext = outputFormat.toLowerCase();
      let outputPath;

      if (outputDir) {
        // 自动保存到指定目录
        const defaultName = path.basename(inputPath, path.extname(inputPath)) + '.' + ext;
        outputPath = path.join(outputDir, defaultName);
      } else {
        // 弹出保存对话框
        const filters = [
          { name: `${outputFormat.toUpperCase()} 文件`, extensions: [ext] },
          { name: '所有文件', extensions: ['*'] },
        ];
        const defaultName = path.basename(inputPath, path.extname(inputPath)) + '.' + ext;
        const result = await dialog.showSaveDialog({
          defaultPath: defaultName,
          filters,
        });
        if (result.canceled) return { canceled: true };
        outputPath = result.filePath;
      }

      // 构建 ffmpeg 命令
      const args = ['-i', inputPath, '-y'];

      // 根据格式设置编码参数
      switch (ext) {
        case 'mp3':
          args.push('-codec:a', 'libmp3lame', '-b:a', bitrate);
          break;
        case 'flac':
          args.push('-codec:a', 'flac');
          break;
        case 'aac':
        case 'm4a':
          args.push('-codec:a', 'aac', '-b:a', bitrate);
          break;
        case 'ogg':
          args.push('-codec:a', 'libvorbis', '-b:a', bitrate);
          break;
        case 'wav':
          args.push('-codec:a', 'pcm_s16le');
          break;
        default:
          args.push('-codec:a', 'copy');
      }

      args.push(outputPath);

      // 执行转换
      return new Promise((resolve) => {
        const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });
        let stderr = '';

        proc.stderr.on('data', (data) => { stderr += data.toString(); });

        proc.on('close', (code) => {
          if (code === 0) {
            shell.showItemInFolder(outputPath);
            resolve({ success: true, path: outputPath });
          } else {
            resolve({ error: `转换失败: ${stderr.slice(0, 200)}` });
          }
        });

        proc.on('error', (err) => {
          resolve({ error: `转换失败: ${err.message}` });
        });
      });
    } catch (e) {
      return { error: e.message };
    }
  });
}

// ─── LRC 解码（保留在 main 进程，因为只有 main 读本地文件） ─────────
function _decodeLrcBuffer(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xFE && buf[1] === 0xFF) return _swapBytes16(buf.slice(2)).toString('utf16le');
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  const utf8Text = buf.toString('utf8');
  if (!_hasReplacementChar(utf8Text)) return utf8Text;
  try {
    const iconv = require('iconv-lite');
    return iconv.decode(buf, 'gbk');
  } catch {
    // ★ 兜底：移除乱码替换字符 (U+FFFD)，至少保证不显示 �
    return utf8Text.replace(/[\uFFFD]+/g, '');
  }
}

function _hasReplacementChar(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0xFFFD) return true;
  }
  return false;
}

function _swapBytes16(buf) {
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out[i] = buf[i + 1];
    out[i + 1] = buf[i];
  }
  return out;
}

// ── 多格式转码辅助 ──────────────────────────────────────────
const { spawn, spawnSync } = require('child_process');

function findFfmpeg() {
  // 尝试常见路径
  const candidates = [
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['-version'], { timeout: 5000, stdio: 'ignore' });
      if (r.status === 0) return cmd;
    } catch (_e) { /* continue */ }
  }
  return null;
}

module.exports = { register };
