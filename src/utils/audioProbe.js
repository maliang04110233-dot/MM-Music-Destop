/**
 * 音频实测（伪无损检测）—— 用 ffprobe 读出真实编码/码率/采样率
 *
 * 「FLAC 文件名 + MP3 内核」是下载站常见挂羊头卖狗肉：扩展名与标称音质
 * 都不可信，唯一可信的是容器里实际音频流。ffprobe 路径从已定位的
 * ffmpeg 同目录推导（ffmpeg 在 PATH 时假设 ffprobe 也在）。
 * analyzeProbe 为纯函数（feed ffprobe JSON → 判定），node 可直接单测；
 * spawn 部分保持与 audioConvert 相同的超时杀进程口径。
 */

const { spawn } = require('child_process');
const path = require('path');

/** 无损系编码前缀/名单（pcm_* 覆盖 wav 容器里的各类位深） */
const LOSSLESS_RE = /^(flac|alac|pcm_|truehd|tta|ape|shorten)/;

/**
 * ffmpeg 路径 → ffprobe 路径；无法推导返回 null
 * （如 ffmpeg 是用户改过名的怪名字，宁可不探也不瞎猜）
 */
function ffprobePathFrom(ffmpegPath, platform = process.platform) {
  if (!ffmpegPath || typeof ffmpegPath !== 'string') return null;
  const P = platform === 'win32' ? path.win32 : path.posix;
  const exe = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const base = P.basename(ffmpegPath).toLowerCase();
  if (base === 'ffmpeg' || base === 'ffmpeg.exe') {
    // 裸名说明走 PATH 解析，ffprobe 同样交给 PATH
    return ffmpegPath.toLowerCase() === base ? exe : P.join(P.dirname(ffmpegPath), exe);
  }
  if (/^ffmpeg(\.exe)?$/.test(base)) return P.join(P.dirname(ffmpegPath), exe);
  return null;
}

/**
 * 纯函数：ffprobe -show_streams -show_format 的 JSON → 音质判定
 * @returns {{ok:true, codec:string, bitrateKbps:number|null, sampleRate:number|null, verdict:'lossless'|'suspicious'|'lossy'}
 *          | {ok:false, error:string}}
 */
function analyzeProbe(out) {
  const streams = out && Array.isArray(out.streams) ? out.streams : [];
  const audio = streams.find(s => s && s.codec_type === 'audio');
  if (!audio) return { ok: false, error: 'NO_AUDIO_STREAM' };
  const codec = String(audio.codec_name || '').toLowerCase();
  const rawBps = Number(audio.bit_rate || (out.format && out.format.bit_rate) || 0);
  const bitrateKbps = Number.isFinite(rawBps) && rawBps > 0 ? Math.round(rawBps / 1000) : null;
  const sampleRate = Number(audio.sample_rate) > 0 ? Number(audio.sample_rate) : null;
  let verdict;
  if (!LOSSLESS_RE.test(codec)) verdict = 'lossy';
  else if (bitrateKbps !== null && bitrateKbps < 400) verdict = 'suspicious';
  else verdict = 'lossless';
  return { ok: true, codec, bitrateKbps, sampleRate, verdict };
}

/**
 * 实测单个文件。resolveFfprobe 注入以便单测换假实现。
 * @param {string} filePath
 * @param {{resolveFfprobe?: Function, timeoutMs?: number}} [deps]
 */
async function probeAudioFile(filePath, deps = {}) {
  const { timeoutMs = 8000 } = deps;
  let ffprobe = deps.ffprobePath;
  if (!ffprobe) {
    const resolve = deps.resolveFfprobe || (async () => {
      const { findFfmpeg } = require('./audioConvert');
      const ff = await findFfmpeg();
      return ff ? ffprobePathFrom(ff) || 'ffprobe' : null;
    });
    ffprobe = await resolve();
  }
  if (!ffprobe) return { error: '未找到 ffprobe，无法检测' };

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: 'ffprobe 启动失败: ' + e.message });
      return;
    }
    let stdout = '';
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_e) { /* 已退出 */ }
      done({ error: '检测超时' });
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d; });
    proc.on('error', e => done({ error: 'ffprobe 启动失败: ' + e.message }));
    proc.on('close', (code) => {
      if (code !== 0 && !stdout.trim()) { done({ error: 'ffprobe 无法读取该文件' }); return; }
      let json = null;
      try { json = JSON.parse(stdout); } catch (_e) { /* 非 JSON 输出按失败处理 */ }
      if (!json) { done({ error: 'ffprobe 输出解析失败' }); return; }
      const r = analyzeProbe(json);
      done(r.ok ? r : { error: '文件中没有音频流' });
    });
  });
}

module.exports = { ffprobePathFrom, analyzeProbe, probeAudioFile };
