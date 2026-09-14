const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const { Transform } = require('stream');
const childProcess = require('child_process');
const logger = require('./logger');

/**
 * 限速 Transform 流（令牌桶 + 正确背压）
 *
 * 原实现的三个问题：
 *   1. push() 返回值被忽略 → 下游写不动时数据在内存里无限堆积（背压失效）
 *   2. 每个超限 chunk 一个独立 setTimeout，多 chunk 并发重置令牌桶 → 速率计算失真
 *   3. 流被提前销毁时，滞留在 setTimeout 里的 rest 数据可能永久丢失
 *
 * 新实现：
 *   - 令牌桶：tokens 以 bytesPerSec 速率恢复（按真实流逝时间计算，非固定 1s 窗口）
 *   - 背压：push() 返回 false 时不调 callback（上游暂停），等 'drain' 后继续；
 *     chunk 超出当前令牌的部分缓存为 pending，由单一定时器按节奏冲刷
 *   - 销毁安全：实现 _destroy，清掉定时器并放弃 pending（下游是文件流，
 *     销毁即意味着下载被取消）
 */
function createThrottleStream(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return null;

  // 桶容量 = 单个冲刷周期（100ms）的配额：避免初始满桶造成 1 秒配额的突发
  const FLUSH_INTERVAL_MS = 100;
  const MAX_TOKENS = Math.max(1, Math.floor(bytesPerSec * (FLUSH_INTERVAL_MS / 1000)));
  let tokens = 0;
  let lastRefill = Date.now();
  let pending = null;   // { buffer } 超额部分
  let flushTimer = null;
  let draining = false; // 下游 drain 事件未到时不再 push

  function refillTokens() {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed > 0) {
      tokens = Math.min(MAX_TOKENS, tokens + (elapsed / 1000) * bytesPerSec);
      lastRefill = now;
    }
  }

  // 尝试把 pending 冲刷出去；清空时调 done（transform 的 callback）
  function tryFlush(stream, done) {
    if (!pending) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (done) done();
      return true;
    }
    while (pending && !draining) {
      refillTokens();
      const take = Math.min(pending.buffer.length, Math.floor(tokens));
      if (take <= 0) break; // 令牌耗尽，等下一轮
      tokens -= take;
      const piece = pending.buffer.slice(0, take);
      pending.buffer = pending.buffer.slice(take);
      if (pending.buffer.length === 0) pending = null;
      if (!stream.push(piece)) {
        draining = true;
        break;
      }
    }
    if (!pending) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (done) done();
      return true;
    }
    // 还有剩余：安排下一轮（unref：不阻塞进程退出）
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        tryFlush(stream, done);
      }, FLUSH_INTERVAL_MS);
      if (flushTimer.unref) flushTimer.unref();
    }
    return false;
  }

  const stream = new Transform({
    transform(chunk, encoding, callback) {
      if (pending) {
        pending.buffer = Buffer.concat([pending.buffer, chunk]);
      } else {
        pending = { buffer: chunk };
      }
      const flushed = tryFlush(this, callback);
      if (!flushed && draining) {
        this.once('drain', () => {
          draining = false;
          tryFlush(this, callback);
        });
      }
    },
    _destroy(err, cb) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      pending = null;
      cb(err);
    },
  });
  return stream;
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
  // SSRF 防护（含重定向链每一跳）：URL 来自音乐平台 API 响应，虽非渲染层
  // 直传，但被劫持的平台响应/恶意重定向可指向内网（云元数据等）。
  // options.skipSsrfCheck 仅供已在上层校验过的调用方关闭（测试用）。
  if (!options.skipSsrfCheck) {
    const { assertPublicHttpUrl } = require('./urlGuard');
    return assertPublicHttpUrl(url).then(check => {
      if (!check.ok) {
        return Promise.reject(new Error('下载地址被 SSRF 防护拒绝: ' + (check.reason || url)));
      }
      return _downloadFileInner(url, savePath, onProgress, extraHeaders, redirectCount, options);
    });
  }
  return _downloadFileInner(url, savePath, onProgress, extraHeaders, redirectCount, options);
}

function _downloadFileInner(url, savePath, onProgress, extraHeaders = {}, redirectCount = 0, options = {}) {
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
        const nextUrl = new URL(res.headers.location, url).toString(); // 支持相对路径
        const { assertPublicHttpUrl } = require('./urlGuard');
        return assertPublicHttpUrl(nextUrl).then(check => {
          if (!check.ok) {
            reject(new Error('重定向目标被 SSRF 防护拒绝: ' + nextUrl));
            return;
          }
          return downloadFile(
            nextUrl,
            savePath,
            onProgress,
            extraHeaders,
            redirectCount + 1,
            options
          ).then(resolve).catch(reject);
        }).catch(e => reject(e));
      }

      // 200 = 全量下载；206 = 服务器支持 Range 续传（此前 206 会落到下方的
      // !==200 分支被当错误拒绝，续传从未真正工作过）
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        cleanupTmp();  // 修复 P1-9：HTTP 错误也清理 .tmp
        return reject(new Error(`HTTP ${res.statusCode}: 下载失败`));
      }
      const isResume = res.statusCode === 206 && resumeOffset > 0;

      const totalSize = parseInt(res.headers['content-length'] || '0', 10);
      // 206 = 本次响应只含剩余部分（content-length 是剩余大小）；200 + Range 头
      // = 服务器不支持续传、全量重发，此时进度基线必须归零
      const isFullResend = res.statusCode === 200 && resumeOffset > 0;
      const startOffset = isResume && !isFullResend ? resumeOffset : 0;
      let downloaded = startOffset;
      const fullSize = totalSize > 0 ? totalSize + startOffset : 0;

      // 防"200 + HTML 错误页"陷阱：部分 CDN 出错时不回 4xx/5xx 而是回 200 +
      // 一段小体积错误页（text/html），不拦截的话会写库成功、嵌完 ID3 才发现
      // 歌曲损坏。音频/图片二进制响应不会是 text/html，故按 Content-Type 拦截。
      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('text/html')) {
        cleanupTmp();
        return reject(new Error(`服务端返回 HTML 而非音频数据（Content-Type: ${contentType.slice(0, 40)}），疑似 CDN 错误页`));
      }

      const writeStream = fs.createWriteStream(tmpPath, { flags: isResume ? 'a' : 'w' });

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
function downloadBuffer(url, extraHeaders = {}, redirectCount = 0, _ssrfChecked = false) {
  const MAX_REDIRECTS = 5;
  // 首跳 SSRF 校验（重定向跳已由内部递归前逐跳校验）
  if (!_ssrfChecked && url) {
    const { assertPublicHttpUrl } = require('./urlGuard');
    return assertPublicHttpUrl(url).then(check => {
      if (!check.ok) {
        logger.warn('[downloadBuffer] 下载地址被 SSRF 防护拒绝:', url);
        return null; // 与本函数容错语义一致：失败返回 null
      }
      return downloadBuffer(url, extraHeaders, redirectCount, true);
    }).catch(() => null);
  }
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
          const nextUrl = new URL(res.headers.location, url).toString();
          const { assertPublicHttpUrl } = require('./urlGuard');
          // downloadBuffer 容错语义（失败 resolve(null)）：SSRF 拒绝也按失败处理
          return assertPublicHttpUrl(nextUrl).then(check => {
            if (!check.ok) {
              logger.warn('[downloadBuffer] 重定向目标被 SSRF 防护拒绝:', nextUrl);
              return resolve(null);
            }
            return downloadBuffer(nextUrl, extraHeaders, redirectCount + 1, true).then(resolve).catch(reject);
          }).catch(() => resolve(null));
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
 * 瞬时错误中断后 .tmp 里已有部分数据，重试自动带上 resumeOffset 断点续传。
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
  let resumeOffset = 0; // 瞬时错误重试时带上已落盘的 .tmp 偏移，从断点续传而非从零重下
  const tryOnce = async () => {
    try {
      const opts = { ...options, resumeOffset };
      const result = await downloadFile(url, savePath, onProgress, extraHeaders, 0, opts);
      return result;
    } catch (e) {
      attempt++;
      const isTransient = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EPIPE|socket hang up|下载超时|network/i.test(e.message || '');
      if (attempt <= maxRetry && isTransient) {
        // 只有成功写入过部分数据才值得续传；用已落盘 .tmp 大小作为偏移
        try {
          resumeOffset = fs.existsSync(savePath + '.tmp') ? fs.statSync(savePath + '.tmp').size : 0;
        } catch (_e) { resumeOffset = 0; }
        if (resumeOffset > 0) {
          logger.info(`[downloadFileWithRetry] 检测到已下载 ${resumeOffset} 字节，将尝试断点续传`);
        }
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

module.exports = { createThrottleStream, downloadFile, downloadFileWithRetry, downloadBuffer, embedId3Tags, embedTagsWithPython, findPythonWithMutagen, formatSize, formatDuration };
