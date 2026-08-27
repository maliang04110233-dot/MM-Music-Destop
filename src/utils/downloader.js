const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { Transform } = require('stream');
const childProcess = require('child_process');
const logger = require('./logger');

/**
 * 限速 Transform 流
 * 按字节/秒限速，超过时暂停读取
 */
function createThrottleStream(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return null;
  let allowed = bytesPerSec;
  let lastCheck = Date.now();
  return new Transform({
    transform(chunk, encoding, callback) {
      const now = Date.now();
      const elapsed = now - lastCheck;
      if (elapsed > 100) {
        allowed = bytesPerSec;
        lastCheck = now;
      }
      if (chunk.length > allowed) {
        // 超限：先发送允许的量，剩余延迟
        const part = chunk.slice(0, allowed);
        const rest = chunk.slice(allowed);
        allowed = 0;
        this.push(part);
        setTimeout(() => {
          allowed = bytesPerSec;
          lastCheck = Date.now();
          this.push(rest);
          callback();
        }, 1000);
      } else {
        allowed -= chunk.length;
        callback();
      }
    }
  });
}

/**
 * 找到可用的 Python 解释器（带 mutagen 库）
 * 优化：启动时探测一次，缓存结果，避免每次 embedId3Tags 都 spawnSync
 */
let _cachedPythonCmd = null;
let _pythonDetected = false;

function findPythonWithMutagen() {
  if (_pythonDetected) return _cachedPythonCmd;

  const candidates = [
    'py',
    'python3',
    'python',
  ];
  for (const cmd of candidates) {
    try {
      const r = childProcess.spawnSync(cmd, ['-c', 'import mutagen; print(1)'], {
        timeout: 3000,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status === 0 && r.stdout.toString().trim() === '1') {
        _cachedPythonCmd = cmd;
        _pythonDetected = true;
        logger.log('[Python] 检测到 mutagen:', cmd);
        return cmd;
      }
    } catch (e) {
      // continue trying
    }
  }
  _cachedPythonCmd = null;
  _pythonDetected = true;
  return null;
}

/**
 * 通过 Python mutagen 脚本写入音频标签
 * 优化：缓存 write_tags.py 路径，避免每次调用都执行 fs.existsSync
 */
let _cachedScriptPath = null;
let _scriptPathDetected = false;

async function embedTagsWithPython(filePath, meta) {
  const pythonCmd = findPythonWithMutagen();
  if (!pythonCmd) {
    logger.warn('[embedTags] 找不到带 mutagen 的 Python，跳过标签写入:', filePath);
    return false;
  }

  if (!_scriptPathDetected) {
    const candidates = [
      path.join(__dirname, '..', '..', 'scripts', 'write_tags.py'),
      path.join(process.resourcesPath || '', 'scripts', 'write_tags.py'),
      path.join(__dirname, '..', '..', '..', 'scripts', 'write_tags.py'),
    ];
    _cachedScriptPath = candidates.find(p => p && fs.existsSync(p));
    _scriptPathDetected = true;
  }

  const scriptPath = _cachedScriptPath;
  if (!scriptPath) {
    logger.warn('[embedTags] write_tags.py 不存在');
    return false;
  }

  const metaJson = JSON.stringify(meta);

  return new Promise((resolve) => {
    const py = childProcess.spawn(pythonCmd, [scriptPath, filePath, metaJson], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (d) => { stdout += d.toString(); });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('close', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          const result = JSON.parse(stdout);
          if (result.success) {
            resolve(true);
          } else {
            logger.warn('[embedTags] Python 返回错误:', result.error);
            resolve(false);
          }
        } catch (e) {
          logger.warn('[embedTags] 解析 Python 输出失败:', e.message, stdout.slice(0, 200));
          resolve(false);
        }
      } else {
        logger.warn('[embedTags] Python 退出 code=', code, stderr.slice(0, 200));
        resolve(false);
      }
    });
    py.on('error', (e) => {
      logger.warn('[embedTags] Python 启动失败:', e.message);
      resolve(false);
    });
  });
}

/**
 * 下载文件，带进度回调
 *
 * 关键设计：
 * 1. 先写到 .tmp 文件，成功后 rename 为正式文件 —— 避免半成品污染下载目录
 * 2. 任何失败路径（req error / req timeout / writeStream error / rename error）都会清理 .tmp
 * 3. 重定向时携带 extraHeaders（用于 B 站 CDN 跨域防盗链）
 * 4. rename 成功后清理 tmpPath 变量标记
 * 5. 修复 B4：增加 maxRedirects 计数器，避免 CDN 跳转链过长时栈溢出
 *    先 cleanupTmp 再递归；显式关闭当前 res 释放 socket
 */
function downloadFile(url, savePath, onProgress, extraHeaders = {}, redirectCount = 0, options = {}) {
  const MAX_REDIRECTS = 5;
  const speedLimit = options.speedLimit || 0; // bytes/sec, 0 = unlimited
  const resumeOffset = options.resumeOffset || 0; // 断点续传偏移量
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error('重定向次数过多（' + MAX_REDIRECTS + '）'));
    }
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win6; x64)',
      'Accept': '*/*',
      ...extraHeaders,
    };
    // 断点续传：添加 Range 头
    if (resumeOffset > 0) {
      headers['Range'] = `bytes=${resumeOffset}-`;
    }

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      timeout: 60000,
    };

    const tmpPath = savePath + '.tmp';
    // 统一的 .tmp 清理函数（任何一个失败路径都调用）
    const cleanupTmp = () => {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); }
      catch (e) { logger.warn('清理 .tmp 失败:', tmpPath, e.message); }
    };

    const req = lib.request(reqOptions, (res) => {
      // 处理重定向（修复 B4：覆盖 301/302/303/307/308，关闭当前 res 后递归）
      if (
        (res.statusCode >= 300 && res.statusCode < 400) &&
        res.headers.location
      ) {
        res.resume();   // 释放 socket，避免泄漏
        cleanupTmp();   // 重定向前清理 .tmp
        return downloadFile(
          res.headers.location,
          savePath,
          onProgress,
          extraHeaders,
          redirectCount + 1
        ).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        cleanupTmp();  // 修复 P1-9：HTTP 错误也清理 .tmp
        return reject(new Error(`HTTP ${res.statusCode}: 下载失败`));
      }

      const totalSize = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = resumeOffset; // 断点续传：从偏移量开始计数
      const fullSize = totalSize > 0 ? totalSize + resumeOffset : 0;

      // 断点续传：206 Partial Content 表示服务器支持
      const isResume = res.statusCode === 206;
      const writeFlags = (isResume && resumeOffset > 0) ? 'a' : 'w'; // 追加模式
      const writeStream = fs.createWriteStream(tmpPath, { flags: writeFlags });

      // 限速流
      const throttle = speedLimit > 0 ? createThrottleStream(speedLimit) : null;
      const dataStream = throttle ? res.pipe(throttle) : res;

      dataStream.on('data', (chunk) => {
        downloaded += chunk.length;
        if (fullSize > 0 && onProgress) {
          onProgress(Math.round((downloaded / fullSize) * 100));
        }
      });

      dataStream.on('error', (e) => { cleanupTmp(); reject(e); });
      dataStream.pipe(writeStream);

      writeStream.on('finish', () => {
        fs.rename(tmpPath, savePath, (err) => {
          if (err) { cleanupTmp(); reject(err); }
          else resolve(savePath);
        });
      });

      // 修复 P1-9：writeStream 出错时清理 .tmp
      writeStream.on('error', (e) => { cleanupTmp(); reject(e); });
    });

    req.on('error', (e) => { cleanupTmp(); reject(e); });
    req.on('timeout', () => { req.destroy(); cleanupTmp(); reject(new Error('下载超时')); });
    req.end();
  });
}

/**
 * 下载图片到 Buffer
 * 优化：覆盖 301/302/303/307/308 重定向，与 downloadFile 保持一致
 */
function downloadBuffer(url, extraHeaders = {}, redirectCount = 0) {
  const MAX_REDIRECTS = 5;
  return new Promise((resolve, reject) => {
    if (!url) return resolve(null);
    if (redirectCount > MAX_REDIRECTS) return resolve(null);
    try {
      const parsedUrl = new URL(url);
      const lib = parsedUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          ...extraHeaders,
        },
        timeout: 15000,
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return downloadBuffer(res.headers.location, extraHeaders, redirectCount + 1).then(resolve).catch(reject);
        }
        const chunks = [];
        let totalBytes = 0;
        const MAX_RESPONSE_BYTES = 100 * 1024 * 1024; // 100MB limit
        res.on('data', c => {
          totalBytes += c.length;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            res.destroy();
            return resolve(null);
          }
          chunks.push(c);
        });
        res.on('error', (e) => { logger.warn('[downloadBuffer] res error:', e.message); resolve(null); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', (e) => { logger.warn('[downloadBuffer] error:', e.message); resolve(null); });
      req.on('timeout', () => { req.destroy(); logger.warn('[downloadBuffer] timeout:', url); resolve(null); });
      req.end();
    } catch (e) {
      resolve(null);
    }
  });
}

/**
 * 嵌入音频标签（支持 MP3/M4A/FLAC/OGG）
 *
 * - MP3: 使用 node-id3（ID3v2.4）
 * - M4A/FLAC/OGG/其他: 使用 Python mutagen（子进程调用）
 *
 * 修复 B5：非 MP3 格式（FLAC/M4A/OGG）写封面时，先用 downloadBuffer 把 URL
 * 下载到 .tmp 文件，再把 tmp 路径作为 cover_path 传给 Python，避免：
 *   1) Python 端网络超时（urllib 默认无超时）阻塞整个写入流程
 *   2) 封面下载失败但 tags 仍被写入，导致半成品元数据
 */
async function embedId3Tags(filePath, { title, artist, album, coverUrl, lrc } = {}) {
  try {
    const ext = path.extname(filePath).toLowerCase();

    // MP3: 用 node-id3（快速，无子进程开销）
    if (ext === '.mp3') {
      const NodeID3 = require('node-id3');
      const tags = {};
      if (title) tags.title = title;
      if (artist) tags.artist = artist;
      if (album) tags.album = album;
      if (lrc) {
        tags.unsynchronisedLyrics = { language: 'chi', text: lrc };
      }
      if (coverUrl) {
        const coverBuffer = await downloadBuffer(coverUrl);
        if (coverBuffer) {
          tags.image = {
            mime: 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: 'Album Cover',
            imageBuffer: coverBuffer,
          };
        }
      }
      const result = NodeID3.update(tags, filePath);
      if (result !== true) {
        logger.warn('ID3 写入失败（文件可能不是有效 MP3）:', filePath);
      }
      return;
    }

    // M4A/FLAC/OGG: 用 Python mutagen 写入
    // 修复 B5：先下载封面到 .tmp 文件，传 cover_path 给 Python
    logger.log('[embedTags] 使用 Python mutagen 写入标签:', ext, filePath);
    const meta = { title, artist, album, lrc };
    if (coverUrl) {
      try {
        const coverBuffer = await downloadBuffer(coverUrl);
        if (coverBuffer && coverBuffer.length > 0) {
          const tmpCoverPath = filePath + '.cover.tmp';
          await fs.promises.writeFile(tmpCoverPath, coverBuffer);
          meta.cover_path = tmpCoverPath;
          try {
            await embedTagsWithPython(filePath, meta);
          } finally {
            try { await fs.promises.unlink(tmpCoverPath); } catch (_e) { /* 清理失败忽略 */ }
          }
          return;
        }
      } catch (e) {
        logger.warn('[embedTags] 封面下载失败，跳过封面写入:', e.message);
      }
    }
    // 没有封面或封面下载失败：只写基础元数据
    await embedTagsWithPython(filePath, meta);
  } catch (e) {
    logger.warn('标签写入失败:', e.message);
  }
}

/**
 * 格式化文件大小
 */
function formatSize(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

/**
 * 格式化时长 ms → mm:ss
 */
function formatDuration(ms) {
  if (!ms) return '--:--';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * 带重试的文件下载（传输层容错）
 *
 * 背景：downloadFile 在 req error / 超时时会直接 reject，而 processOneSong 的
 * MAX_RETRY 只覆盖「URL 解析」阶段，传输中途的网络抖动（ECONNRESET / ETIMEDOUT /
 * 下载超时）不会被重试，导致本可成功的下载直接判失败。
 *
 * 这里对传输失败做指数退避重试（默认 2 次），仅在「瞬时网络错误」时重试，
 * HTTP 业务错误（由上层 processOneSong 处理）不在此重试。
 *
 * @param {string} url
 * @param {string} savePath
 * @param {function} onProgress
 * @param {object} extraHeaders
 * @param {object} options  { maxRetry=2, timeout? }
 */
function downloadFileWithRetry(url, savePath, onProgress, extraHeaders = {}, options = {}) {
  const maxRetry = (typeof options.maxRetry === 'number' && options.maxRetry >= 0) ? options.maxRetry : 2;
  let attempt = 0;
  const tryOnce = async () => {
    try {
      return await downloadFile(url, savePath, onProgress, extraHeaders, 0, options);
    } catch (e) {
      attempt++;
      const isTransient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|下载超时|network/i.test(e.message || '');
      if (attempt <= maxRetry && isTransient) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        logger.warn(`[downloadFileWithRetry] 第 ${attempt} 次传输失败（瞬时错误），${delay}ms 后重试:`, e.message);
        await new Promise(r => setTimeout(r, delay));
        return tryOnce();
      }
      throw e;
    }
  };
  return tryOnce();
}

module.exports = { downloadFile, downloadFileWithRetry, downloadBuffer, embedId3Tags, embedTagsWithPython, findPythonWithMutagen, formatSize, formatDuration };
