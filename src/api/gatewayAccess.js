/**
 * Gateway 懒访问器 —— 给"深处在 api 层内部"的消费方用
 *
 * 背景：gateway 需要 cookie（由 api/index.js 的 cookieStore 提供），
 * 而 api/index.js 又会间接 require 到 utils/onlineCover.js，形成环。
 *
 * 直接 `require('../api')` 在模块顶层会踩到「拿到的 exports 还没装配完」
 * 的问题（api/index.js 的 module.exports 在其顶层执行到尾才成型）。
 * 因此这里**延迟到调用时**再解析，并优先使用 api/index.js 已装配好的
 * gateway 实例（它带着正确的 cookie reader）。
 *
 * 这不是新的抽象层 —— 只是把「延迟 require」这一处耦合收敛到单一文件，
 * 避免每个消费方各写一遍且某天有人写成顶层 require 造成静默失效。
 */

/**
 * 取 platform gateway 实例。
 * @returns {Object|null}
 */
function getGateway() {
  try {
    const api = require('../api');
    if (api && api.gateway) return api.gateway;
  } catch (_e) { /* 环依赖未就绪：回落到自建实例 */ }

  // 兜底：自建一个（无 cookie 注入）。仅在 api/index.js 尚未装配时发生。
  try {
    const { defaultRegistry } = require('../api/pluginRegistry');
    const { createPlatformGateway } = require('../api/gateway');
    return createPlatformGateway({ registry: defaultRegistry });
  } catch (_e) {
    return null;
  }
}

/**
 * 经 gateway 搜索某平台的单曲。
 * 失败 / gateway 不可用 ⇒ []（与平台搜索失败的历史行为一致）
 *
 * @param {string} platformId
 * @param {string} keyword
 * @param {number} [page=1]
 * @returns {Promise<Array>}
 */
async function searchViaGateway(platformId, keyword, page = 1) {
  const gw = getGateway();
  if (!gw) return [];
  return gw.search(platformId, keyword, page);
}

module.exports = { getGateway, searchViaGateway };
