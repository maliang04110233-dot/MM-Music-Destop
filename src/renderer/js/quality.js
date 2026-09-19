/**
* 分平台音质模板
*
* 全局「音质」下拉（搜索栏）是兜底默认；用户可在设置里为单个平台指定档位，
* 下载/播放该平台的歌曲时按平台覆盖，其余平台继续沿用下拉的选择。
*
* 纯逻辑 pickQuality 不碰 DOM / api，便于在 node 里单测；
* resolveQuality 才是各调用点用的入口。
*/

import { logger } from './logger.js';

const QUALITY_PREF_KEY = 'qualityBySource';
export const QUALITY_DEFAULT = 'standard';

export const QUALITY_OPTIONS = [
  { value: 'standard', label: '标准 128k' },
  { value: 'hq', label: '高品质 320k' },
  { value: 'lossless', label: '无损 FLAC' },
];

const VALID = new Set(QUALITY_OPTIONS.map(o => o.value));

/** 播放中音质徽标的短标签（迷你窗/主播放器共用同一映射） */
const PLAYED_BADGE_LABELS = { standard: '128k', hq: '320k', lossless: '无损' };
export function playedQualityLabel(q) {
  return PLAYED_BADGE_LABELS[q] || '';
}

/**
* 服务端不区分音质的平台：quality 参数不产生实际差异（免登录只有一档）。
* 依据各平台插件注释 —— migu.js:25 / soda.js:35-36。
* 列表里只是设置页禁用选择框 + 提示，resolveQuality 照常返回档位。
*/
export const QUALITY_FIXED = new Set(['migu', 'soda']);

/**
* 纯解析：平台覆盖优先，缺失或非法值回退到默认档位
* @param {Object|string} [map] 平台→档位 映射
* @param {string} [source] 平台 id
* @param {string} [fallback] 默认档位
*/
export function pickQuality(map, source, fallback) {
  const base = VALID.has(fallback) ? fallback : QUALITY_DEFAULT;
  if (!map || typeof map !== 'object' || !source) return base;
  const raw = map[String(source)];
  return VALID.has(raw) ? raw : base;
}

/** 已知平台 id：主进程下发清单 ∪ 内置兜底表（两者都缺时返回空集） */
export function knownPlatformIds() {
  const ids = new Set();
  if (typeof fallbackPlatformIds === 'function') {
    for (const id of fallbackPlatformIds()) ids.add(String(id));
  }
  if (typeof getPlatforms === 'function') {
    for (const pl of getPlatforms()) if (pl && pl.id) ids.add(String(pl.id));
  }
  return ids;
}

/**
 * 清洗覆盖表：只保留「已知平台 + 合法档位」的条目。
 * prefs 会被云同步导入，导入内容不可信，故必须在这里过滤 ——
 * 否则外部 JSON 能往覆盖表里塞任意键。
 * @param {Object|string} map 原始覆盖表
 * @param {Set} [platformIds] 已知平台集合（测试注入用，默认取 knownPlatformIds()）
 */
export function cleanQualityMap(map, platformIds) {
  const ids = platformIds || knownPlatformIds();
  const clean = {};
  if (map && typeof map === 'object' && !Array.isArray(map)) {
    for (const [k, v] of Object.entries(map)) {
      if (ids.has(String(k)) && VALID.has(v)) clean[String(k)] = v;
    }
  }
  return clean;
}

/**
 * 「以此音质下载」候选档：固定音质平台返回空表；当前解析档位被剔除。
 * 纯函数，供 songMenu 组装菜单项。
 */
export function qualityOverrideOptions(source, current) {
  if (QUALITY_FIXED.has(String(source))) return [];
  const cur = VALID.has(current) ? current : null;
  return QUALITY_OPTIONS.filter(o => o.value !== cur).map(o => ({ value: o.value, label: o.label }));
}

/** 搜索栏音质下拉的当前值（唯一的全局默认来源） */
export function selectQuality() {
  const el = typeof document !== 'undefined' && document.getElementById('qualitySelect');
  return (el && el.value) || getState('quality') || QUALITY_DEFAULT;
}

/** 按平台解析音质：平台覆盖 > 下拉默认 */
export function resolveQuality(source) {
  return pickQuality(getQualityBySource(), source, selectQuality());
}

/** 读取分平台覆盖表（对象，仅含有自定义的平台） **/
export function getQualityBySource() {
  const v = getState('qualityBySource');
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** 写入并持久化分平台覆盖表；非法平台/档位被丢弃 **/
export async function saveQualityBySource(map) {
  const clean = cleanQualityMap(map);
  setState('qualityBySource', clean);
  try {
    const ok = await api.setPref(QUALITY_PREF_KEY, clean);
    if (!ok) logger.warn('保存分平台音质失败：键不在白名单');
  } catch (e) {
    logger.warn('保存分平台音质失败:', e);
  }
  return clean;
}

if (typeof window !== 'undefined') {
  window.resolveQuality = resolveQuality;
  window.getQualityBySource = getQualityBySource;
  window.saveQualityBySource = saveQualityBySource;
  window.cleanQualityMap = cleanQualityMap;
  window.knownPlatformIds = knownPlatformIds;
  window.QualityOptions = QUALITY_OPTIONS;
  window.QualityFixed = QUALITY_FIXED;
}
