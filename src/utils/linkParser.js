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

// ── 各平台 URL 正则（顺序即优先级，第一个命中即返回）──
// 正则里已含完整域名（music.163.com / y.qq.com / bilibili.com / kugou.com），
// 无需单独的域名映射表
const PATTERNS = [
  // 网易云歌曲：/song?id=123 或 /song/#/123（旧版 hash 路由）
  {
    platform: 'netease', type: 'song',
    re: /music\.163\.com\/song(?:\/#\/|#\/)?(?:\?id=|\/)?(\d{4,15})/,
    extract: m => m[1],
  },
  // 网易云专辑：/album?id=123 或 /album/123
  {
    platform: 'netease', type: 'album',
    re: /music\.163\.com\/album(?:\?id=|\/)(\d{4,15})/,
    extract: m => m[1],
  },
  // 网易云歌单：/playlist?id=123（当作专辑处理——上层逐首入队）
  {
    platform: 'netease', type: 'playlist',
    re: /music\.163\.com\/playlist(?:\?id=|\/)(\d{4,15})/,
    extract: m => m[1],
  },
  // QQ 单曲新版路由：/n/ryqq/songDetail/MID（mid 是 14 位字母数字）
  {
    platform: 'qq', type: 'song',
    re: /y\.qq\.com\/n\/ryqq\/(?:songDetail|player)\/([A-Za-z0-9]{10,18})(?:[?/]|$)/,
    extract: m => m[1],
  },
  // QQ 单曲播放页：playsong.html?songmid=XXX
  {
    platform: 'qq', type: 'song',
    re: /y\.qq\.com\/[^?]*playsong\.html[^"'\s]*?[?&]songmid=([A-Za-z0-9]{10,18})/,
    extract: m => m[1],
  },
  // QQ 专辑：/n/ryqq/albumDetail/MID
  {
    platform: 'qq', type: 'album',
    re: /y\.qq\.com\/n\/ryqq\/albumDetail\/([A-Za-z0-9]{10,18})(?:[?/]|$)/,
    extract: m => m[1],
  },
  // B站视频：/video/BVxxxx
  {
    platform: 'bilibili', type: 'song',
    re: /bilibili\.com\/video\/(BV[A-Za-z0-9]{8,12})(?:[?/\s]|$)/,
    extract: m => m[1],
  },
  // B站音频：/audio/auxxxx
  {
    platform: 'bilibili', type: 'song',
    re: /bilibili\.com\/audio\/(au\d{5,12})(?:[?/\s]|$)/,
    extract: m => m[1],
  },
  // 酷狗单曲：mixsong/12345.html 或 /song/xxx.html?hash=YYYY
  {
    platform: 'kugou', type: 'song',
    re: /kugou\.com\/mixsong\/(\d{4,15})\.html/,
    extract: m => m[1],
  },
  {
    platform: 'kugou', type: 'song',
    re: /kugou\.com\/song\/[a-z0-9]+\.html\?hash=([A-Fa-f0-9]{20,40})/,
    extract: m => m[1],
  },
  // 酷狗专辑：/album/xxx.html（slug 型 id，保持原样）
  {
    platform: 'kugou', type: 'album',
    re: /kugou\.com\/album\/([a-z0-9_-]{6,40})\.html/,
    extract: m => m[1],
  },
];

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

  for (const p of PATTERNS) {
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
