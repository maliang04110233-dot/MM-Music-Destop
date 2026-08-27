/**
 * 本地歌词在线拉取（网易云兜底）
 *
 * 用法：
 *   const { scheduleOnlineLrcFetch } = require('./utils/onlineLrc');
 *   scheduleOnlineLrcFetch(filePath);  // 不阻塞，异步后台拉取
 *
 * 设计要点：
 *   1. 不阻塞 UI：scheduleOnlineLrcFetch 立即返回，异步后台拉
 *   2. 单例去重：同 filePath 不会并发拉取
 *   3. 失败缓存：拉到空结果 30 分钟内不再尝试（避免反复失败重试）
 *   4. 并发限制：最多 2 路并发拉取（避免网易云 API 限流）
 *   5. 超时控制：单次 10s 超时
 *   6. 副作用：拉到后写 sidecar `.lrc`（UTF-8 + BOM 兼容 Windows 旧播放器）
 *   7. 事件推送：通过回调通知 renderer（`local-lrc-fetched` 事件）
 */

const fs = require('fs');
const path = require('path');

const ONLINE_LRC_TTL_MS = 30 * 60 * 1000;     // 失败结果缓存 30 分钟
const ONLINE_LRC_TIMEOUT_MS = 10 * 1000;       // 单次拉取超时
const ONLINE_LRC_MAX_PARALLEL = 2;             // 最大并发

const _inflight = new Set();
const _done = new Map();                        // filePath → timestamp
const _queue = [];
let _running = 0;
let _notify = null;  // (filePath, lrc) => void  通知回调

/**
 * 配置通知回调（在主进程启动时设置一次）
 * @param {(payload: {filePath: string, lrc: string, source: string}) => void} fn
 */
function setOnlineLrcNotifier(fn) {
  _notify = typeof fn === 'function' ? fn : null;
}

/**
 * 调度一次拉取任务
 * 立即返回，实际拉取在后台异步进行
 */
function scheduleOnlineLrcFetch(filePath, deps = {}) {
  if (!filePath || typeof filePath !== 'string') return;
  if (_inflight.has(filePath)) return;
  const last = _done.get(filePath);
  if (last && (Date.now() - last) < ONLINE_LRC_TTL_MS) return;
  _inflight.add(filePath);
  _queue.push({ filePath, deps });
  _drain();
}

function _drain() {
  while (_running < ONLINE_LRC_MAX_PARALLEL && _queue.length > 0) {
    const job = _queue.shift();
    _run(job).catch(() => {});
  }
}

async function _run({ filePath, deps }) {
  _running++;
  try {
    // 1) 解析元数据拿 title/artist（依赖注入便于测试）
    const readMeta = deps.readAudioMetadata || (require('./localLibrary').readAudioMetadata);
    const getLrc = deps.getLyrics || (require('../api/music').getLyrics);

    let title = '', artist = '';
    try {
      const meta = await readMeta(filePath);
      title = (meta && meta.title) || '';
      artist = (meta && meta.artist) || '';
    } catch (e) {
      // 修复 B18：文件已删 / 读失败 → 同样标记 done，避免反复尝试
      _done.set(filePath, Date.now());
      throw e;
    }

    if (!title) {
      // 没标题放弃（如纯数字命名的 .mp3）
      _done.set(filePath, Date.now());
      return;
    }

    // 2) 调网易云拉歌词（带搜索兜底），加 10s 硬超时
    const lrc = await Promise.race([
      getLrc(null, 'netease', title, artist).then(r => r && r.lrc ? r.lrc : ''),
      new Promise(resolve => setTimeout(() => resolve(''), ONLINE_LRC_TIMEOUT_MS)),
    ]);

    if (lrc && lrc.trim()) {
      // 3) 写 sidecar .lrc 文件（UTF-8 + BOM 兼容 Windows 旧播放器）
      try {
        const parsed = path.parse(filePath);
        const lrcPath = parsed.ext ? filePath.replace(/\.[^.]+$/, '.lrc') : filePath + '.lrc';
        const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
        const body = Buffer.from(lrc, 'utf8');
        await fs.promises.writeFile(lrcPath, Buffer.concat([bom, body]));
      } catch (_e) {
        // 写文件失败不致命，UI 至少能立即用
      }

      // 4) 通知 renderer（成功）
      if (_notify) {
        try { _notify({ filePath, lrc, source: 'fetched' }); } catch (_e) { /* 回调失败忽略 */ }
      }
    } else {
      // 拉到空：30 分钟内不再尝试
      _done.set(filePath, Date.now());
      // 仍然通知 renderer 一次（空结果），让 UI 从"正在获取"切到"暂无歌词"
      // 修复：否则 UI 会卡在 "🎵 正在在线获取歌词…" 占位
      if (_notify) {
        try { _notify({ filePath, lrc: '', source: 'empty' }); } catch (_e) { /* 回调失败忽略 */ }
      }
    }
  } catch (e) {
    // 异常路径：同样通知 renderer，避免 UI 永远卡在"正在获取"占位
    _done.set(filePath, Date.now());
    if (_notify) {
      try { _notify({ filePath, lrc: '', source: 'error', error: String(e && e.message || e) }); } catch (_e) { /* 回调失败忽略 */ }
    }
  } finally {
    _inflight.delete(filePath);
    _running--;
    _drain();
  }
}

/**
 * 测试用：重置内部状态
 */
function _reset() {
  _inflight.clear();
  _done.clear();
  _queue.length = 0;
  _running = 0;
  _notify = null;
}

module.exports = {
  scheduleOnlineLrcFetch,
  setOnlineLrcNotifier,
  _reset,
  ONLINE_LRC_TTL_MS,
  ONLINE_LRC_TIMEOUT_MS,
  ONLINE_LRC_MAX_PARALLEL,
};
