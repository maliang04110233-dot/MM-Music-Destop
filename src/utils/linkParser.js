/**
 * 粘贴链接智能识别（cobalt 式「贴链接即得歌」交互）
 *
 * 输入：用户在搜索框粘贴的任意文本（通常含平台分享链接）
 * 输出：{ platform, type, id, kindHint } 或 null
 *
 * 支持的形式：
 *   网易云  https://music.163.com/song?id=2652820720
 *           https://music.163.com/album?id=12345（专辑→取全部歌）
 *           分享文案：https://music.163.com/song?id=xxx&userid=1（"来自QQ音乐"的短语中取 URL）
 *           短链 https://163cn.tv/xxx （需平台跳转才能拿 id，暂不支持，返回
 *           kindHint='unsupported' 让上层提示用户打开链接后复制完整地址）
 *   QQ音乐  https://y.qq.com/n/ryqq/songDetail/004Z8Ihr0JIu5s
 *           https://i.y.qq.com/v8/playsong.html?songmid=004Z8Ihr0JIu5s...
 *           https://y.qq.com/n/ryqq/albumDetail/002Neh8b0FxUIF
 *   B站     https://www.bilibili.com/video/BV1BZbSzZEGT
 *           https://b23.tv/xxx（短链，同 163cn 逻辑）
 *   酷狗    https://www.kugou.com/song/xxx.html?hash=XXXX（hash 即 id；页面版
 *           https://www.kugou.com/mixsong/XXXX.html 取数字为 id）
 *
 * 设计：纯函数、零依赖、可单测；URL 里带文本（分享文案）也能命中第一个 URL。
 */

'use strict';

const { defaultRegistry, loadPlatformPlugins } = require('../api/pluginRegistry');

// ── 各平台 URL 正则（顺序即优先级，第一个命中即返回）──
// v3：整组正则由 registry 从各平台 manifest 的 linkPatterns 派生，不再在此维护副本
// （原先加平台必须回来手写正则，且漏写不报错）。顺序即 registry 的平台顺序
// （netease → qq → bilibili → kugou），与原硬编码 PATTERNS 的顺序一致。
//
// ⚠️ 惰性求值：单测会直接 require 本模块，此时平台可能尚未注册。
let _patterns = null;
function getPatterns() {
  if (!_patterns) {
    loadPlatformPlugins();
    _patterns = defaultRegistry.getLinkPatterns();
  }
  return _patterns;
}

// ── 短链域名（无法本地解析，需要提示）──
const SHORT_LINK_HOSTS = ['163cn.tv', 'b23.tv', 'url.cn', 't.cn'];

/**
 * 从任意文本中解析音乐平台链接
 * @param {string} text 用户输入（可能是纯 URL、分享文案、或普通关键词）
 * @returns {{platform, type, id}|null} type: song|album|playlist；null=不是链接
 */
function parseMusicLink(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  // 性能护栏：超过 500 字符的输入按普通关键词处理（分享文案不会这么长，
  // 且长文本里嵌 URL 基本是误粘贴整篇文章）
  if (trimmed.length > 500) return null;

  for (const p of getPatterns()) {
    const m = trimmed.match(p.re);
    if (m) {
      const id = p.extract(m);
      if (id) return { platform: p.platform, type: p.type, id };
    }
  }
  return null;
}

/**
 * 检测短链（解析失败但看起来是平台短链时，给用户明确提示）
 * @param {string} text
 * @returns {string|null} 命中的短链域名，null=不是短链
 */
function detectShortLink(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/https?:\/\/([a-z0-9.-]+)/i);
  if (!m) return null;
  const host = m[1].toLowerCase();
  return SHORT_LINK_HOSTS.includes(host) ? host : null;
}

module.exports = { parseMusicLink, detectShortLink };
