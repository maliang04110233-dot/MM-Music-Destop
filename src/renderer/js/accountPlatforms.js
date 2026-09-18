/**
* 平台账号页的清单派生
*
* 账号页之前手写了一份 3 个平台的 PLATFORMS，加咪咕/汽水/5sing 之后它没跟着长，
* 界面上就还是「只有原来的 3 个」。平台清单的权威来源是主进程插件能力：
* 插件实现 verifyCookie ⇒ capabilities.cookie 为 true，见 api/pluginRegistry.js。
*
* 纯函数不碰 DOM / api，便于在 node 里单测。
*/

import { getPlatforms, fallbackPlatformIds, platformName, platformIcon } from './utils.js';

/** 插件能力表里「支持 Cookie 登录」的键名 */
export const COOKIE_CAPABILITY = 'cookie';

/**
* 主进程支持一键登录窗口的平台（loginWindow.js LOGIN_CONFIGS）。
* 主进程是能力事实来源，这里只留 id 供 UI 展示判断，不拷贝 URL / 探测字段。
*/
export const MAIN_PROCESS_LOGIN_PLATFORMS = new Set(['netease', 'qq', 'bilibili']);

/**
* 兜底清单：IPC 未就绪（首屏极早期）时用。
* 只在 getPlatforms() 返回空数组时短暂使用，随后被主进程清单覆盖。
*/
export const FALLBACK_ACCOUNT_PLATFORMS = [
  { id: 'netease', name: '网易云音乐', shortName: '网易云' },
  { id: 'qq', name: 'QQ 音乐', shortName: 'QQ音乐' },
  { id: 'bilibili', name: '哔哩哔哩', shortName: 'B站' },
];

/** 平台是否支持 Cookie 登录（capabilities 缺失 / 非对象时视为不支持） */
export function hasCookieCapability(p) {
  return !!(p && p.capabilities && p.capabilities[COOKIE_CAPABILITY] === true);
}

/** 平台是否可一键打开登录窗口（Cookie 能力 + 主进程有登录窗口配置） */
export function hasLoginWindow(platformId) {
  return MAIN_PROCESS_LOGIN_PLATFORMS.has(platformId);
}

/**
* Cookie 文本框占位符
* @param {Array<{key:string}>} fields 该平台要检查的字段配置
* @returns {string} 无配置时返回通用占位符
*/
export function cookiePlaceholder(fields) {
  const keys = (Array.isArray(fields) ? fields : []).map(f => f && f.key).filter(Boolean);
  if (!keys.length) return '粘贴该平台的完整 Cookie 字符串';
  return keys.map(k => k + '=xxxx').join('; ') + '; ...';
}

/** 分平台手动 Cookie 提示；未定制的平台返回通用提示 */
export function cookieHint(platformId, hints) {
  const map = (hints && typeof hints === 'object') ? hints : {};
  return map[platformId] || '在浏览器登录后 → F12 → Network → 复制请求头 <code>Cookie:</code> 字段';
}

/**
* 按 Cookie 能力拆分平台清单
*
* 传空 / 非法清单时返回兜底表，保证首屏不是空白页。
* 传合法清单时**如实反映**——即使全部不支持 Cookie（返回空 cookie 列表），
* 也不拿兜底表冒充，否则用户会看到三个实际登录不了的卡片。
*
* @param {Array} platforms 主进程下发的平台清单
* @returns {{cookie: Array, anonymous: Array}}
*/
export function splitPlatformsByCookie(platforms) {
  const list = Array.isArray(platforms) ? platforms.filter(p => p && p.id) : [];
  if (!list.length) {
    return { cookie: FALLBACK_ACCOUNT_PLATFORMS.slice(), anonymous: [] };
  }
  return {
    cookie: list.filter(hasCookieCapability),
    anonymous: list.filter(p => !hasCookieCapability(p)),
  };
}

/**
* 账号页要渲染的清单
* 主进程清单未就绪时回落兜底表；两者都不可用时回落到内置 id 表。
*
* @returns {{cookie: Array, anonymous: Array}}
*/
export function accountPlatforms() {
  const platforms = getPlatforms();
  if (Array.isArray(platforms) && platforms.length) {
    return splitPlatformsByCookie(platforms);
  }

  // 主进程清单未就绪（init 未完成 / getPlatforms IPC 失败）：
  // 回落到内置 id 表，仍然按登录能力分好组，而不是给用户一个空页面。
  const ids = fallbackPlatformIds();
  if (!ids.length) return splitPlatformsByCookie([]);

  // 内置表只有名字和 id，Cookie 能力按主进程登录窗口清单标记
  return ids.reduce((acc, id) => {
    const base = { id, name: platformName(id), shortName: platformName(id), icon: platformIcon(id) };
    acc[hasLoginWindow(id) ? 'cookie' : 'anonymous'].push(base);
    return acc;
  }, { cookie: [], anonymous: [] });
}

export default {
  COOKIE_CAPABILITY,
  MAIN_PROCESS_LOGIN_PLATFORMS,
  FALLBACK_ACCOUNT_PLATFORMS,
  hasCookieCapability,
  hasLoginWindow,
  cookiePlaceholder,
  cookieHint,
  splitPlatformsByCookie,
  accountPlatforms,
};
