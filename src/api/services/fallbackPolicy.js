/**
 * 换源平台排除策略（增量126-B）—— 纯函数，无 IO。
 *
 * 用户可在设置页勾选「不参与换源的平台」：某些平台长期无版权/风控严，
 * 换源时在它们身上逐个撞墙既慢又浪费请求。该清单只影响**跨源路径**
 * （候选过滤 + _altSource 记忆），本源取流永远不受限 —— 用户禁了 kuwo
 * 也不该导致 kuwo 自己的歌播不了。
 *
 * prefs 键 `fallbackDisabledPlatforms` 的容错解析集中在这里：
 * 渲染层写数组，旧备份/手改可能出现对象映射或垃圾值，一律安全降级。
 */

/**
 * 把 prefs 原始值归一化为平台 id 集合。
 * 接受：字符串数组 / `{id:true}` 对象映射；其余（null/对象数组/垃圾）→ 空集。
 * @param {unknown} raw
 * @returns {Set<string>}
 */
function normalizeDisabledPlatforms(raw) {
  const out = new Set();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string' && item.trim()) out.add(item.trim());
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof k === 'string' && k.trim()) out.add(k.trim());
    }
  }
  return out;
}

/**
 * 过滤掉被禁用平台的换源候选。缺 source/id 的畸形候选原样保留 ——
 * 主循环自会跳过它们，这里不做二次裁判（保持纯过滤职责）。
 * @param {Array<{source?:string}>} candidates
 * @param {Set<string>} disabled
 * @returns {Array}
 */
function filterDisabledCandidates(candidates, disabled) {
  if (!Array.isArray(candidates) || !disabled || disabled.size === 0) return candidates;
  return candidates.filter((c) => !c || !c.source || !disabled.has(c.source));
}

module.exports = { normalizeDisabledPlatforms, filterDisabledCandidates };
