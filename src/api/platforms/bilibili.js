/**
 * B 站（哔哩哔哩）平台实现
 *
 * 依赖：
 *   - request: 通用 HTTP 请求函数
 */

const request = require('../request');
const logger = require('../../utils/logger');
const { AppError } = require('../../shared/errors');

// ── 访客 Cookie（无登录态时自动获取）──────────────────
// B 站 2024 起匿名请求带假 buvid3 会被风控：playurl 不返回 DASH 音频流
// （走 LOGIN_REQUIRED 误判）。spi 接口可拿正式访客指纹 buvid3/buvid4，
// 实测带它就能匿名取到 DASH。进程内缓存，spi 挂了回退假 buvid3（老行为）。
let _visitorCookie = null;
let _visitorCookieAt = 0;
const VISITOR_COOKIE_TTL = 3600 * 1000;

async function getVisitorCookie() {
  const now = Date.now();
  if (_visitorCookie && now - _visitorCookieAt < VISITOR_COOKIE_TTL) return _visitorCookie;
  try {
    const r = await request('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: { 'Referer': 'https://www.bilibili.com/' },
      timeout: 6000,
    });
    const b3 = r?.data?.b_3;
    const b4 = r?.data?.b_4;
    if (b3) {
      _visitorCookie = 'buvid3=' + b3 + (b4 ? '; buvid4=' + b4 : '');
      _visitorCookieAt = now;
      return _visitorCookie;
    }
  } catch (e) {
    logger.warn('[bilibili] 访客指纹获取失败:', e.message);
  }
  return 'buvid3=anon;'; // 兜底：老行为（可能拿不到 DASH）
}

// 统一 Cookie 决策：用户登录态优先，否则访客指纹
async function resolveCookie(cookie) {
  if (cookie) return cookie;
  return getVisitorCookie();
}

/**
 * 解析时长字符串 "mm:ss" 或 "hh:mm:ss" → 秒
 */
function parseDuration(str) {
  if (!str) return 0;
  const parts = String(str).split(':').map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parseInt(str) || 0;
}

/**
 * 搜索视频
 * @param {string} keyword
 * @param {number} page
 * @param {string} cookie
 */
async function bilibiliSearch(keyword, page = 1, cookie = '') {
  if (!keyword || typeof keyword !== 'string') return [];
  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=20&order=totalrank`;

  const result = await request(url, {
    headers: {
      'Referer': 'https://www.bilibili.com/',
      'Cookie': await resolveCookie(cookie),
    },
    timeout: 8000,
  });

  const videos = result?.data?.result || [];
  return videos.slice(0, 20).map(v => ({
    id: v.bvid || String(v.aid),
    aid: v.aid,
    title: (v.title || '').replace(/<[^>]+>/g, ''),
    artist: v.author || v.uploader || '',
    album: '哔哩哔哩',
    cover: v.pic ? ('https:' + v.pic) : '',
    duration: parseDuration(v.duration) * 1000,
    source: 'bilibili',
  }));
}

/**
 * 获取 B 站视频的音频流 URL（DASH 格式）
 * @param {string} bvid
 * @param {string} quality - standard | 其他（hq）
 * @param {string} cookie
 */
async function bilibiliGetUrl(bvid, quality, cookie = '') {
  try {
    const c = await resolveCookie(cookie);
    // 1) 先拿 cid 和 aid
    const infoResult = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { 'Referer': 'https://www.bilibili.com/', 'Cookie': c },
      timeout: 10000,
    });
    const cid = infoResult?.data?.cid;
    const aid = infoResult?.data?.aid;
    if (!cid) throw new Error('获取 cid 失败');

    // 2) 拿 DASH 播放地址（fnval=16 必带）
    const streamResult = await request(
      `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&fnval=16&fnver=0&fourk=1&bvid=${bvid}&qn=112`,
      { headers: { 'Referer': 'https://www.bilibili.com/', 'Cookie': c }, timeout: 12000 }
    );

    const dash = streamResult?.data?.dash;
    if (dash && dash.audio && dash.audio.length > 0) {
      const audios = [...dash.audio].sort((a, b) => b.bandwidth - a.bandwidth);
      const audio = quality === 'standard' ? audios[audios.length - 1] : audios[0];
      return {
        url: audio.baseUrl || audio.base_url,
        ext: 'm4a',
        referer: 'https://www.bilibili.com/',
      };
    }
    // 有 DASH 无 audio 多为番剧/大会员：区分登录墙与地区限制文案
    if (dash && (!dash.audio || dash.audio.length === 0)) {
      return cookie
        ? { error: '该视频无独立音频流（可能是会员番剧或特殊稿件）', code: 'NO_AUDIO_STREAM', fatal: true }
        : AppError.loginRequired('B站');
    }
    return AppError.loginRequired('B站');
  } catch (e) {
    logger.warn('[bilibili] getPlayUrl 失败:', e.message);
    return { error: 'B站获取URL异常: ' + (e.message || e), code: 'BILI_URL_ERROR', fatal: true };
  }
}

/**
 * 按 bvid 拉视频详情（粘贴链接智能识别用）
 * @param {string} bvid
 * @param {string} cookie
 * @returns {Promise<object|null>} 标准歌曲对象，拉不到返回 null
 */
async function bilibiliGetSongDetail(bvid, cookie = '') {
  try {
    const result = await request(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      headers: { 'Referer': 'https://www.bilibili.com/', 'Cookie': await resolveCookie(cookie) },
      timeout: 10000,
    });
    const d = result?.data;
    if (!d || !d.bvid) return null;
    return {
      id: d.bvid,
      aid: d.aid,
      title: d.title || '',
      artist: d.owner?.name || '',
      album: '哔哩哔哩',
      cover: d.pic || '',
      duration: (d.duration || 0) * 1000,
      source: 'bilibili',
    };
  } catch (e) {
    logger.warn(`[bilibili] song detail 失败 (bvid=${bvid}):`, e.message || e);
    return null;
  }
}

/**
 * 验证 B 站 Cookie
 */
async function bilibiliVerifyCookie(cookie) {
  try {
    const result = await request('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'Referer': 'https://www.bilibili.com/', 'Cookie': cookie },
      timeout: 8000,
    });
    if (result?.data?.isLogin) {
      return { valid: true, nickname: result.data.uname, vip: result.data.vipType > 0 };
    }
  } catch (e) {
    logger.warn('B站 Cookie 验证失败:', e.message || e);
  }
  return { valid: false };
}

/**
 * B 站音乐区排行
 * @param {number} limit
 * @param {string} [cookie] - 由 aggregator 注入
 */
async function bilibiliGetRanking(limit = 10, cookie = '') {
  try {
    const result = await request('https://api.bilibili.com/x/web-interface/ranking/region?rid=3&day=3', {
      headers: {
        'Referer': 'https://www.bilibili.com/',
        'User-Agent': 'Mozilla/5.0',
        'Cookie': await resolveCookie(cookie),
      },
    });
    return (result?.data || []).slice(0, limit).map(v => ({
      id: v.bvid,
      title: (v.title || '').replace(/<[^>]+>/g, ''),
      artist: v.author || '',
      cover: v.pic ? (v.pic.startsWith('http') ? v.pic : 'https:' + v.pic) : '',
      duration: parseDuration(v.duration) * 1000,
      playCount: v.play,
      source: 'bilibili',
    }));
  } catch (e) {
    logger.warn('[bilibili] getTopList 失败:', e.message);
    return [];
  }
}

module.exports = {
  // ── PlatformManifest（v3 单一事实来源）──────────────────────
  id: 'bilibili',
  name: 'B站',
  nameEn: 'Bilibili',
  icon: '📺',
  badge: { bg: 'rgba(0,180,230,.12)', fg: 'var(--accent-ui)', border: 'rgba(0,180,230,.2)' },
  hosts: { origins: ['https://www.bilibili.com'] },
  linkPatterns: [
    // 视频：/video/BVxxxx
    { type: 'song', re: /bilibili\.com\/video\/(BV[A-Za-z0-9]{8,12})(?:[?/\s]|$)/, extract: m => m[1] },
    // 音频：/audio/auxxxx
    { type: 'song', re: /bilibili\.com\/audio\/(au\d{5,12})(?:[?/\s]|$)/, extract: m => m[1] },
  ],
  // ⚠️ fallbackSource: false —— 唯一不参与跨源换源的平台。
  // B 站搜索结果的 artist 是 UP 主名，与音乐源的真实歌手永远对不上，
  // 参与换源只会制造错配（把翻唱合集 / DJ 版误当原曲）。
  policies: { order: 30, fallbackSource: false, probeable: true, aggregateLimit: 5 },

  // ── 实现（方法存在 = 能力存在）──────────────────────────────
  search: bilibiliSearch,
  getUrl: bilibiliGetUrl,
  getSongDetail: bilibiliGetSongDetail,
  verifyCookie: bilibiliVerifyCookie,
  // 排行（v3 阶段 1 收尾：正式纳入 manifest。signature 含 cookie 末位参数，
  // 由 gateway 的 withCookie 选项负责注入）
  getRanking: bilibiliGetRanking,

  // ── 老式具名导出（阶段 3 清理前保留）────────────────────────
  bilibiliSearch,
  bilibiliGetUrl,
  bilibiliGetSongDetail,
  bilibiliVerifyCookie,
  bilibiliGetRanking,
  parseDuration,
};
