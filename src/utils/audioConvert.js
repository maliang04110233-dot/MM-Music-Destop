/**
 * 音频转码核心（主进程）
 *
 * 从 main/ipc/library.js 拆出：转码是唯一调用 ffmpeg 的链路，
 * 但参数拼装、输出路径、进度解析全埋在 95 行 IPC handler 里，
 * 既无法单测也和「本地音乐库」这个文件的职责无关。
 *
 * 本模块只依赖 child_process/path/fsp，不 require electron——
 * 因此可在 node:test 下直接跑真实 ffmpeg 冒烟测试。
 *
 * 转码有三个入口（转换页批量 / 本地库 / 下载页），全部经
 * convertAudioFile() 收敛到这一处。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ─── 格式定义 ───────────────────────────────────────────────
// ext 必须是播放器认的容器扩展：AAC 输出用 m4a（MP4 容器），
// 裸 ADTS 的 .aac 大量播放器打不开——旧实现把输出写成 .aac 就是坑在这里。
const FORMATS = {
  mp3: { ext: 'mp3', codec: ['-codec:a', 'libmp3lame'], lossy: true },
  flac: { ext: 'flac', codec: ['-codec:a', 'flac'], lossy: false },
  aac: { ext: 'm4a', codec: ['-codec:a', 'aac'], lossy: true },
  ogg: { ext: 'ogg', codec: ['-codec:a', 'libvorbis'], lossy: true },
  wav: { ext: 'wav', codec: ['-codec:a', 'pcm_s16le'], lossy: false },
};

/** 合法比特率白名单：直接拼进 ffmpeg 参数，非白名单一律拒绝 */
const BITRATES = ['64k', '96k', '128k', '192k', '256k', '320k'];

/** 单个文件转码最长耗时，防止 ffmpeg 挂死拖住 IPC handler */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 归一化格式名。'm4a' 归到 'aac'（同一编码器，只是容器扩展不同）。
 * @returns {string|null} 规范化 key，未知返回 null
 */
function normalizeFormat(format) {
  const key = String(format || '').toLowerCase().trim();
  if (key === 'm4a') return 'aac';
  return FORMATS[key] ? key : null;
}

/** 输出文件的容器扩展（aac → m4a） */
function formatExtension(format) {
  const def = FORMATS[normalizeFormat(format)];
  return def ? def.ext : 'mp3';
}

/** 比特率是否可用；无损格式不消费比特率，传入任意值都合法 */
function isBitrate(value) {
  return BITRATES.includes(String(value || ''));
}

/** 源文件扩展名对应的默认目标格式 */
function defaultFormatFor(sourceExt) {
  const ext = String(sourceExt || '').toLowerCase().replace(/^\./, '');
  if (ext === 'mp3') return 'mp3';   // 同格式无需转码，也别把 5MB mp3 膨胀成 20MB flac
  return 'mp3';                       // 无损/其它统一压到通用性最好的 mp3
}

// ─── ffmpeg 定位 ────────────────────────────────────────────
// 探测结果缓存：
//   undefined → 尚未探测
//   string    → 已确认可用的命令（永久缓存）
//   null      → 确认找不到，30s 后允许重试（用户可能刚装好 ffmpeg，不该等到重启）
let _ffmpegCache;
let _ffmpegMissAt = 0;
const FFMPEG_MISS_TTL = 30 * 1000;

const FFMPEG_CANDIDATES = [
  'ffmpeg',
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
];

/**
 * 探测单个 ffmpeg 候选是否可以执行（异步，单次最长 5s）
 * @param {string} cmd
 * @returns {Promise<boolean>}
 */
function _probeFfmpeg(cmd) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let proc;
    try {
      proc = spawn(cmd, ['-version'], { stdio: 'ignore' });
    } catch (_e) {
      return done(false);
    }
    const timer = setTimeout(() => {
      // 超时：杀掉子进程，避免残留
      try { proc.kill(); } catch (_e) { /* 已退出 */ }
      done(false);
    }, 5000);

    proc.on('close', (code) => { clearTimeout(timer); done(code === 0); });
    proc.on('error', () => { clearTimeout(timer); done(false); });
  });
}

/**
 * 定位可用的 ffmpeg
 *
 * 旧实现用 spawnSync 逐个探测 5 个候选、每个超时 5s——未安装 ffmpeg 时
 * 最坏会让主进程（UI 线程）连续冻结 25 秒。改为异步探测 + 缓存，
 * 转码只在这一个入口调用，缓存命中后零开销。
 *
 * @returns {Promise<string|null>}
 */
async function findFfmpeg() {
  if (typeof _ffmpegCache === 'string') return _ffmpegCache;
  if (_ffmpegCache === null && Date.now() - _ffmpegMissAt < FFMPEG_MISS_TTL) return null;

  for (const cmd of FFMPEG_CANDIDATES) {
    if (await _probeFfmpeg(cmd)) {
      _ffmpegCache = cmd;
      return cmd;
    }
  }
  _ffmpegCache = null;
  _ffmpegMissAt = Date.now();
  return null;
}

/** @returns {Promise<boolean>} 系统上有没有 ffmpeg */
async function ffmpegAvailable() {
  return !!(await findFfmpeg());
}

// ─── 输出路径 ───────────────────────────────────────────────

/** 输出目录为空/不可用时退回源文件同目录 */
function resolveOutputDir(outputDir, inputPath) {
  if (outputDir) return outputDir;
  return path.dirname(path.resolve(inputPath));
}

/**
 * 计算不覆盖已有文件的输出路径。
 *
 * 旧实现直接拼 basename.ext + `-y` 强写：批量转 5 首同名歌（扫描目录常见）
 * 会一路覆盖，最后一首赢，前 4 首的数据静默丢失。
 *
 * @param {{inputPath:string, outputDir?:string|null, format:string}} opt
 * @returns {string} 可直接写入的输出绝对路径
 */
function resolveOutputPath({ inputPath, outputDir = null, format }) {
  const dir = resolveOutputDir(outputDir, inputPath);
  const ext = formatExtension(format);
  const base = path.basename(inputPath, path.extname(inputPath));
  let candidate = path.join(dir, base + '.' + ext);
  for (let i = 1; fs.existsSync(candidate); i++) {
    candidate = path.join(dir, `${base}_${i}.${ext}`);
  }
  return candidate;
}

// ─── ffmpeg 参数 ────────────────────────────────────────────

// 单遍 loudnorm 目标参数（-14 LUFS 是流媒体平台通行响度，峰值 -1.5dBTP 防削波）。
// 刻意不走两遍线性模式：那需要对同一文件先探测再编码，转码链路要翻倍复杂；
// 动态模式对"下载后本地听感一致"这个场景足够。
const LOUDNORM_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

/**
 * 拼装 ffmpeg 命令行参数（纯函数，便于单测）。
 * 无损格式不吃 -b:a，传了也会被忽略——这里直接不下发。
 *
 * @returns {string[]}
 */
function buildFfmpegArgs({ inputPath, outputPath, format, bitrate = '320k', loudnorm = false }) {
  const def = FORMATS[normalizeFormat(format)] || FORMATS.mp3;
  // -nostdin：避免 ffmpeg 在读到 stdin 时进入交互式确认
  const args = ['-nostdin', '-i', inputPath, '-y'];
  args.push(def.codec[0], def.codec[1]);
  // 无损格式不吃比特率；有损格式在比特率非法时退回编码器默认值
  if (def.lossy && isBitrate(bitrate)) args.push('-b:a', bitrate);
  if (loudnorm) args.push('-af', LOUDNORM_FILTER);
  args.push(outputPath);
  return args;
}

/**
 * 读源文件时长（秒），用于把 ffmpeg 的 out_time_ms 换算成百分比。
 * 解析失败返回 0——上层据此降级为无百分比的进度展示。
 *
 * @returns {Promise<number>}
 */
function probeDuration(ffmpegPath, inputPath) {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    let proc;
    try {
      proc = spawn(ffmpegPath, ['-i', inputPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (_e) {
      return done(0);
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_e) { /* 已退出 */ }
      done(0);
    }, 5000);

    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (!m) return done(0);
      done(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
    });
    proc.on('error', () => { clearTimeout(timer); done(0); });
  });
}

// ─── 转码执行 ───────────────────────────────────────────────

/**
 * 转码单个文件。
 *
 * @param {object} opt
 * @param {string} opt.inputPath    源文件
 * @param {string|null} opt.outputDir 输出目录，null 表示调用方另走保存对话框
 * @param {string} opt.format       mp3|flac|aac|m4a|ogg|wav
 * @param {string} opt.bitrate      128k~320k，非法值降级为编码器默认
 * @param {boolean} [opt.loudnorm]  true 时输出前做响度归一（-14 LUFS）
 * @param {(p:number)=>void} [opt.onProgress] 进度回调 0~100
 * @param {()=>boolean} [opt.shouldStop]      返回 true 时中止
 * @param {number} [opt.timeoutMs]            超时毫秒
 * @returns {Promise<{success?:boolean, path?:string, error?:string, canceled?:boolean}>}
 */
async function convertAudioFile({
  inputPath,
  outputDir = null,
  format = 'mp3',
  bitrate = '320k',
  loudnorm = false,
  onProgress,
  shouldStop,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) return { error: '未找到 ffmpeg，请安装后重试' };

  const outputPath = resolveOutputPath({ inputPath, outputDir, format });
  const duration = await probeDuration(ffmpegPath, inputPath);
  const args = buildFfmpegArgs({ inputPath, outputPath, format, bitrate, loudnorm });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; resolve(v); } };

    // 中止原因先记下，等子进程真正退出（close）再 resolve。
    // 直接在 kill() 后 resolve 会让调用方以为文件已可用，但 Windows 上
    // ffmpeg 的文件句柄要等进程结束才释放——随后删目录/读输出会 EPERM。
    let aborted = null;
    let poll = null;

    const cleanup = () => {
      if (poll) { clearInterval(poll); poll = null; }
    };

    let proc;
    try {
      // -progress pipe:1 让进度以机器可读行输出到 stdout（out_time_ms=...）
      proc = spawn(ffmpegPath, ['-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return settle({ error: `启动 ffmpeg 失败: ${e.message}` });
    }

    let stderr = '';
    let stdoutBuf = '';

    const abort = (reason) => {
      if (aborted || settled) return;
      aborted = reason;
      try { proc.kill(); } catch (_e) { /* 已退出 */ }
      // 子进程不理会 kill 时不能把 Promise 挂死
      setTimeout(() => { if (aborted && !settled) settle(aborted); }, 3000);
    };

    const timer = setTimeout(
      () => abort({ error: `转换超时（${Math.round(timeoutMs / 60000)} 分钟），已中止` }),
      timeoutMs,
    );

    proc.stdout.on('data', (data) => {
      stdoutBuf += data.toString();
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const m = /^out_time_ms=(\d+)/.exec(line);
        if (m && duration > 0 && onProgress) {
          onProgress(Math.min(100, Math.round((Number(m[1]) / 1000 / duration) * 100)));
        }
      }
    });

    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    // 每个 tick 检查中止信号（150ms 粒度足够，不必逐行解析）
    if (typeof shouldStop === 'function') {
      poll = setInterval(() => {
        if (shouldStop()) abort({ canceled: true });
      }, 150);
    }

    proc.on('close', (code) => {
      clearTimeout(timer);
      cleanup();
      if (aborted) return settle(aborted);
      if (code === 0 && fs.existsSync(outputPath)) {
        return settle({ success: true, path: outputPath });
      }
      settle({ error: `转换失败: ${stderr.slice(0, 200) || `ffmpeg 退出码 ${code}`}` });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      settle({ error: `转换失败: ${err.message}` });
    });
  });
}

module.exports = {
  FORMATS,
  BITRATES,
  FFMPEG_CANDIDATES,
  DEFAULT_TIMEOUT_MS,
  normalizeFormat,
  formatExtension,
  isBitrate,
  defaultFormatFor,
  findFfmpeg,
  ffmpegAvailable,
  resolveOutputDir,
  resolveOutputPath,
  buildFfmpegArgs,
  probeDuration,
  convertAudioFile,
  _probeFfmpeg,
  _resetFfmpegCacheForTest,
};

/** 测试用：清空 ffmpeg 探测缓存 */
function _resetFfmpegCacheForTest() {
  _ffmpegCache = undefined;
  _ffmpegMissAt = 0;
}
