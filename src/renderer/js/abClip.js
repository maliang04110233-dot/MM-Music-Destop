/**
 * A-B 片段导出 —— 「这段循环听够了，把它取出来当铃声」
 *
 * 复用既有 convert-audio 通道（ffmpeg 侧加 -ss/-t），不新建 IPC。
 * 顶层不 import state/logger（那两个模块在加载期就触碰 window，node 侧导不进来），
 * 运行时统一走全局桥 —— 与 abLoop.js 同款写法。
 *
 * 导出的是一段**新文件**，不是覆盖原曲：主进程按 `原名_片段1m20s-2m45s.ext`
 * 递增避让命名，源文件永不受影响。
 */

import { errBrief } from './errBrief.js';
import { mmss, getAbRegion } from './abLoop.js';

/** 与主进程 normalizeClip 同口径：短于这个长度的片段多半是误点 */
const MIN_CLIP_SEC = 0.2;

/** 主进程 FORMATS 白名单在渲染层的镜像（漂移由 test/ab-clip.test.js 对账钉住） */
const CLIP_FORMATS = ['mp3', 'flac', 'aac', 'ogg', 'wav'];

/**
 * 片段格式跟随源文件容器：flac 截一段没必要被压成 mp3，
 * 源容器不在白名单（如 .opus/.wma）时退回通用性最好的 mp3。
 */
function clipFormatFor(filePath) {
  const ext = String(filePath || '').split(/[?#]/)[0].split('.').pop().toLowerCase();
  if (ext === 'm4a') return 'aac';
  return CLIP_FORMATS.includes(ext) ? ext : 'mp3';
}

/**
 * 出片前的全部判定（纯函数）：缺本地文件 / 没点区间 / 区间过短都在这里挡。
 * @param {{region?:{a:number,b:number}|null, filePath?:string, duration?:number}} src
 * @returns {{ok:true, inputPath:string, start:number, end:number, outputFormat:string}|{ok:false, msg:string}}
 */
function planClipExport({ region, filePath, duration } = {}) {
  const p = String(filePath || '');
  if (!p) return { ok: false, msg: '当前曲目不是本地文件，先把它下载下来再截取' };
  if (!region || region.a == null || region.b == null) {
    return { ok: false, msg: '先用播放器「A-B 循环」点出起止点，再导出片段' };
  }
  const a = Number(region.a);
  const bRaw = Number(region.b);
  if (!Number.isFinite(a) || !Number.isFinite(bRaw)) return { ok: false, msg: 'A-B 区间无效，重新点一次' };
  const d = Number(duration);
  // B 点拖到曲尾之外（换曲/ seeking 竞态下的脏值）按实际时长收口，别把错误抛给用户
  const b = Number.isFinite(d) && d > 0 ? Math.min(bRaw, d) : bRaw;
  if (!(b - a >= MIN_CLIP_SEC)) return { ok: false, msg: `片段太短（不足 ${MIN_CLIP_SEC} 秒），导不出` };
  return {
    ok: true,
    inputPath: p,
    start: Math.round(a * 100) / 100,
    end: Math.round(b * 100) / 100,
    outputFormat: clipFormatFor(p),
  };
}

/** 主进程返回 → toast（成功文案带回区间，用户能核对截的是哪一段） */
function clipResultToast(res, plan) {
  if (res && res.canceled) return { kind: 'info', text: '已取消导出' };
  if (res && res.success) {
    return { kind: 'success', text: `✂ 片段已导出（${mmss(plan.start)}–${mmss(plan.end)}）` };
  }
  return { kind: 'error', text: '导出失败：' + ((res && res.error) || '未知错误') };
}

// ── 运行时 ────────────────────────────────────────────
let _running = false;

async function exportAbClip() {
  if (_running) { showToast('片段导出进行中，稍等…', 'warn', 2000); return; }
  const song = typeof getState === 'function' ? getState('currentPlaying') : null;
  const au = typeof document === 'undefined' ? null : document.getElementById('audioPlayer');
  const plan = planClipExport({
    region: getAbRegion(),
    filePath: song && (song.filePath || song.path),
    duration: au && au.duration,
  });
  if (!plan.ok) { showToast(plan.msg, 'warn', 3500); return; }
  const api = globalThis.api;
  if (!api || typeof api.convertAudio !== 'function') { showToast('转码桥接未就绪', 'error', 3000); return; }

  _running = true;
  showToast(`✂ 正在导出 ${mmss(plan.start)}–${mmss(plan.end)} 片段…`, 'info', 2500);
  try {
    const res = await api.convertAudio({
      inputPath: plan.inputPath,
      outputFormat: plan.outputFormat,
      start: plan.start,
      end: plan.end,
      revealFolder: true,
    });
    const msg = clipResultToast(res, plan);
    showToast(msg.text, msg.kind, 3500);
  } catch (e) {
    if (typeof logger !== 'undefined') logger.warn('[exportAbClip] error:', e);
    showToast('导出失败：' + errBrief(e), 'error', 3000);
  } finally {
    _running = false;
  }
}

if (typeof document !== 'undefined') {
  window.exportAbClip = exportAbClip;
}

export { MIN_CLIP_SEC, CLIP_FORMATS, clipFormatFor, planClipExport, clipResultToast, exportAbClip };
