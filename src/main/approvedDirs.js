/**
 * 目录授权注册表（C1 下载目录沙箱的统一底座）
 *
 * 背景：渲染层能把任意路径字符串送进多条 IPC 通道（add-to-queue 的 saveDir、
 * check-local-exists、scan-local-library…）。文件名有 sanitize，目录没有 ——
 * 渲染层一旦被恶意歌单/歌词数据 XSS，即可把文件写到任意目录。
 *
 * 规则：只有**经过主进程原生目录选择器（select-dir）确认**的路径（含其子目录）
 * 算「用户批准过」。应用启动时把 prefs 里已存的各目录键 seed 进集合
 * （它们是历史会话里选器确认的结果），此后 set-pref 写入目录键必须先过
 * isApprovedDir，攻击者无法在运行时凭空注入新目录。
 */
const path = require('path');

/** 目录型偏好键：值必须通过 isApprovedDir 校验后才允许写入 */
const DIR_PREF_KEYS = new Set(['saveDir', 'localDirPath', 'aiMusicSaveDir', 'convertOutputDir']);

const _approved = new Set();

function normalize(p) {
  if (!p || typeof p !== 'string') return null;
  try { return path.resolve(p); } catch (_e) { return null; }
}

/** base 是否包含 target（相等算包含）；path.relative 判定，防前缀碰撞 */
function isInside(base, target) {
  try {
    const rel = path.relative(base, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch (_e) { return false; }
}

function approve(p) {
  const r = normalize(p);
  if (r) _approved.add(r);
  return r;
}

/** p 等于某批准目录或其子目录 */
function isApprovedDir(p) {
  const r = normalize(p);
  if (!r) return false;
  for (const a of _approved) {
    if (isInside(a, r)) return true;
  }
  return false;
}

module.exports = { approve, isApprovedDir, isInside, normalize, DIR_PREF_KEYS };
