/**
 * 下载路径模板：把「相对下载目录的片段」规划成真实落盘目录
 *
 * 变量渲染不住在这里（那是 naming.renderPathSegments，和文件名模板同一张表），
 * 本模块只管目录语义三件事：
 *   1. 相对片段从哪来 —— 新模板存 subpath；老模板（含云同步/导入来的）只存了
 *      绝对路径，就按当前根目录现推，推不出来（用户换了下载目录）就当它不可用；
 *   2. 层级上限 —— 超过 MAX_SEGMENTS 整条模板作废，而不是静默截断到别处；
 *   3. 永远不出根目录 —— 单点规则（缺值段丢弃、点号段丢弃、未知变量段丢弃）之外，
 *      拼完再过一次包含检查。模板是用户输入 + 外部同步数据，两道锁都要有。
 *
 * 落不了地时一律回落根目录并带上 reason，调用方（downloadQueue）只负责把
 * reason 写进日志：下载绝不能因为「目录规划失败」而失败。
 */

const path = require('path');
const { renderPathSegments } = require('./naming');

/** 子目录层级上限：8 层已经超出「按歌手/专辑整理」的量级，再多是写错了 */
const MAX_SEGMENTS = 8;

// Windows 与 macOS 默认大小写不敏感：比较包含关系时先归一大小写，
// 否则 D:\Music 与 d:\music 会被当成两个目录，把合法模板误判成越界。
const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function normDir(p) {
  const s = path.resolve(String(p));
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
}

/** target 是否落在 base 内（含 base 自身） */
function isInsideDir(base, target) {
  if (!base || !target) return false;
  const b = normDir(base);
  return normDir(target) === b || normDir(target).startsWith(b + path.sep);
}

/**
 * 绝对模板路径 → 相对下载根目录的片段
 * @returns {string} 在内（含正好是根目录 → ''）
 * @returns {null} 参数不全或不在根目录内
 */
function subpathFromAbsolute(absPath, saveDir) {
  if (typeof absPath !== 'string' || !absPath.trim()) return null;
  if (typeof saveDir !== 'string' || !saveDir.trim()) return null;
  if (!isInsideDir(saveDir, absPath)) return null;
  return path.relative(path.resolve(saveDir), path.resolve(absPath));
}

/** 只按 id 取活动模板；id 缺失或查不到都算「没有模板」，不猜第一个 */
function activePathTemplate(templates, activeId) {
  if (!activeId || !Array.isArray(templates)) return null;
  return templates.find((t) => t && t.id === activeId) || null;
}

/**
 * 规划这首歌唱到哪个目录
 * @param {object|null} template 活动模板 { subpath } 或老数据 { path }
 * @param {string} saveDir 生效的下载根目录（绝对；逐曲覆盖目录也算根目录）
 * @param {object} song 歌曲信息
 * @param {object} [opts] { now: Date } 透传给变量渲染
 * @returns {{dir:string, applied:boolean, reason:string}}
 *   reason: '' | 'no-root' | 'no-template' | 'no-subpath' | 'empty-after-render'
 *           | 'too-deep' | 'outside-save-dir'
 */
function planDownloadDir(template, saveDir, song, opts) {
  const root = (typeof saveDir === 'string' && saveDir.trim()) ? path.resolve(saveDir.trim()) : '';
  if (!root) return { dir: '', applied: false, reason: 'no-root' };

  const tpl = (template && typeof template === 'object') ? template : null;
  let pattern = '';
  if (tpl && typeof tpl.subpath === 'string') {
    pattern = tpl.subpath.trim();
  } else if (tpl && typeof tpl.path === 'string' && tpl.path.trim()) {
    const sub = subpathFromAbsolute(tpl.path.trim(), root);
    if (sub === null) return { dir: root, applied: false, reason: 'outside-save-dir' };
    pattern = sub.trim();
  } else {
    return { dir: root, applied: false, reason: 'no-template' };
  }

  if (!pattern) return { dir: root, applied: false, reason: 'no-subpath' };
  const segments = renderPathSegments(pattern, song, opts);
  if (!segments.length) return { dir: root, applied: false, reason: 'empty-after-render' };
  if (segments.length > MAX_SEGMENTS) return { dir: root, applied: false, reason: 'too-deep' };

  const dir = path.join(root, ...segments);
  if (!isInsideDir(root, dir)) return { dir: root, applied: false, reason: 'outside-save-dir' };
  return { dir, applied: true, reason: '' };
}

module.exports = {
  MAX_SEGMENTS,
  planDownloadDir,
  subpathFromAbsolute,
  activePathTemplate,
  isInsideDir,
};
