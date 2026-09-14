/**
 * QQ 音乐平台实现
 *
 * 依赖：
 *   - qqMusic: qq-music-api 第三方 SDK
 *   - qqGetSign: qq-music-api/util/sign.js 签名工具
 *   - request: 通用 HTTP 请求函数
 *   - cookie 工具: extractQQUin / extractQQMusickey / detectQQCookieType
 */

const qqMusic = require('qq-music-api');
const qqGetSign = require('qq-music-api/util/sign');
const request = require('../request');
const { AppError } = require('../../shared/errors');
const {
  extractQQUin,
  extractQQMusickey,
  detectQQCookieType,
} = require('../../utils/cookie');
const logger = require('../../utils/logger');

// 调试专辑搜索字段（临时）
// require('qq-music-api').api('search', { key: '周杰伦', pageNo: 1, pageSize: 2, t: 8 })
//   .then(r => { logger.log('ALBUM_RAW_FIELDS:' + JSON.stringify(Object.keys(r?.list?.[0] || {}))); })
//   .catch(e => console.error(e.message));

// 调试歌手搜索字段（临时）
// require('qq-music-api').api('search', { key: '周杰伦', pageNo: 1, pageSize: 2, t: 9 })
//   .then(r => {
//     logger.log('SINGER_RAW keys:', Object.keys(r || {}));
//     logger.log('SINGER_RAW data keys:', Object.keys(r?.data || {}));
//     logger.log('SINGER_RAW list:', JSON.stringify(r?.data?.list?.[0] || r?.list?.[0]));
//   })
//   .catch(e => console.error(e.message));

// 所有临时调试代码已移除

/**
 * 获取歌手热门歌曲（通过 singer/songs 路由）
 */
async function qqGetSingerSongs(singerMid, limit = 20) {
  try {
    const result = await qqMusic.api('singer/songs', { singermid: singerMid, num: limit });
    // 返回结构: { list: [...], singer, desc, total, num, singermid }
    // list 项字段: mid, id, name, album={mid,name}, singer=[{mid,name}], interval
    const list = result?.list || [];
    return list.map(s => ({
      id: String(s.mid || s.id || ''),
      numId: String(s.id || ''),
      mid: s.mid || '',
      title: s.name || '',
      artist: (s.singer || []).map(a => a.name).join(' / '),
      album: s.album?.name || '',
      albumMid: s.album?.mid || '',
      cover: s.album?.mid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
        : '',
      duration: s.interval ? s.interval * 1000 : 0,
      source: 'qq',
    }));
  } catch (e) {
    logger.warn('[qq] getSingerSongs 失败:', e.message);
    return [];
  }
}

/**
 * 获取歌手专辑列表（通过 singer/album 路由）
 */
async function qqGetSingerAlbums(singerMid, pageNo = 1, pageSize = 20) {
  try {
    const result = await qqMusic.api('singer/album', { singermid: singerMid, pageNo, pageSize });
    // 返回结构: { list, id, singermid, name, total, pageNo, pageSize }
    const list = result?.list || [];
    return {
      albums: list.map(a => ({
        id: String(a.album_id || ''),
        mid: a.album_mid || '',
        title: a.album_name || '',
        artist: result?.data?.name || '',
        cover: a.album_mid
          ? `https://y.qq.com/music/photo_new/T002R300x300M000${a.album_mid}.jpg`
          : '',
        publishTime: a.publish_date || '',
        source: 'qq',
      })),
      total: result?.data?.total || list.length,
      singerName: result?.data?.name || '',
    };
  } catch (e) {
    logger.warn('[qq] getSingerAlbums 失败:', e.message);
    return { albums: [], total: 0, singerName: '' };
  }
}

/**
 * 搜索歌手
 */
async function qqSearchSinger(keyword, page = 1) {
  // smartbox API 是唯一还能返回歌手列表的 QQ 接口（2026 年起 client_search_cp t=9 空数据）
  if (page > 1) return { singers: [], total: 0, page };
  try {
    const result = await request(
      `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(keyword)}&g_tk=5381&_t=${Date.now()}&format=json`,
      { headers: { 'Referer': 'https://y.qq.com' } }
    );
    const itemlist = result?.data?.singer?.itemlist || [];
    return {
      singers: itemlist.map(s => ({
        id: String(s.id || ''),
        mid: s.mid || '',
        name: s.name || '',
        nameHilight: s.name || '',
        avatar: s.pic || '',
        songCount: 0,
        albumCount: 0,
        mvCount: 0,
        source: 'qq',
      })),
      total: itemlist.length,
      page,
    };
  } catch (e) {
    logger.warn('[qqSearchSinger] smartbox 失败:', e.message);
    return { singers: [], total: 0, page };
  }
}

/**
 * 搜索歌曲（通过 search 路由）
 */
async function qqSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  try {
    const result = await qqMusic.api('search', {
      key: keyword,
      pageNo: page,
      pageSize: 30,
      t: 0, // 0=单曲
    });
    const songs = result?.list || [];
    return songs.map(s => ({
      id: String(s.songmid || ''),
      numId: String(s.songid || ''),
      title: s.songname || '',
      artist: (s.singer || []).map(a => a.name).join(' / '),
      album: s.albumname || '',
      albumMid: s.albummid || '',
      cover: s.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
      duration: s.interval ? s.interval * 1000 : 0,
      source: 'qq',
      pay: s.pay,
    }));
  } catch (e) {
    logger.warn('[qqSearch] 失败:', e.message);
    return [];
  }
}

/**
 * 搜索专辑
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{albums: Array, total: number, page: number}>}
 */
async function qqSearchAlbum(keyword, page = 1) {
  /**
   * 策略：
   * 1. smartbox → 直接专辑匹配 + 获取歌手 mid（仅 page=1）
   * 2. 若匹配到歌手，用 singer/album 路由获取该歌手的完整专辑列表（支持分页）
   * 3. 合并去重
   *
   * 因为 client_search_cp t=8 2026 年起不再返回专辑结果。
   */
  const pageSize = 99;
  try {
    // ── Step 1: smartbox（直接专辑 + 歌手 mid） ──
    let smartAlbums = [];
    const singerMids = [];
    const smartData = await request(
      `https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=${encodeURIComponent(keyword)}&g_tk=5381&_t=${Date.now()}&format=json`,
      { headers: { 'Referer': 'https://y.qq.com' } }
    );
    // 仅 page=1 包含直接专辑命中（smartbox 不支持分页）
    if (page === 1) {
      smartAlbums = (smartData?.data?.album?.itemlist || []).map(a => ({
        id: String(a.id || ''),
        mid: a.mid || '',
        title: a.name || '',
        artist: a.singer || '',
        cover: a.pic ? a.pic.replace(/\/T002R\d+x\d+/, '/T002R300x300') : '',
        publishTime: '',
        songCount: 0,
        source: 'qq',
      }));
    }
    (smartData?.data?.singer?.itemlist || []).forEach(s => {
      if (s.mid) singerMids.push(s.mid);
    });

    // ── Step 2: 通过歌手 mid 拿到专辑列表（支持分页） ──
    const singerAlbums = [];
    for (const sMid of singerMids) {
      try {
        const sa = await qqMusic.api('singer/album', {
          singermid: sMid, pageNo: page, pageSize,
        });
        const list = sa?.list || [];
        list.forEach(a => {
          const mid = a.album_mid || '';
          // 只包含录音室专辑，过滤 EP/单曲、现场专辑、参与专辑等非专辑类型
          if (a.albumtype && a.albumtype !== '录音室专辑') return;
          singerAlbums.push({
            id: String(a.albumid || ''),
            mid,
            title: a.album_name || '',
            artist: a.singer_name || '',
            cover: mid
              ? `https://y.qq.com/music/photo_new/T002R300x300M000${mid}.jpg`
              : '',
            publishTime: a.pub_time || '',
            songCount: a.latest_song?.song_count || 0,
            source: 'qq',
          });
        });
      } catch (e) {
        logger.warn('[qqSearchAlbum] singer/album 失败:', sMid, e.message);
      }
    }

    // ── Step 3: 合并去重 → 补充时间 → 按发布时间倒序 ──
    const seen = new Map(); // mid → index in allAlbums
    const allAlbums = [];
    // page=1：smartbox 优先（直接命中）
    if (page === 1) {
      smartAlbums.forEach(a => {
        if (!a.mid) return;
        const idx = allAlbums.length;
        seen.set(a.mid, idx);
        allAlbums.push(a);
      });
    }
    // singer/album 补充时间后去重
    singerAlbums.forEach(a => {
      if (!a.mid) return;
      if (seen.has(a.mid)) {
        // smartbox 已有这条，补充它缺失的发布时间
        const idx = seen.get(a.mid);
        if (a.publishTime && !allAlbums[idx].publishTime) {
          allAlbums[idx].publishTime = a.publishTime;
        }
        return;
      }
      seen.set(a.mid, allAlbums.length);
      allAlbums.push(a);
    });

    // 按发布时间倒序（最新在前），无时间的排最后
    allAlbums.sort((a, b) => {
      if (!a.publishTime && !b.publishTime) return 0;
      if (!a.publishTime) return 1;
      if (!b.publishTime) return -1;
      return b.publishTime.localeCompare(a.publishTime);
    });

    return {
      albums: allAlbums,
      total: allAlbums.length,
      page,
    };
  } catch (e) {
    logger.warn('[qqSearchAlbum] 搜索失败:', e.message);
    return { albums: [], total: 0, page };
  }
}

/**
 * 音质 → 文件名前缀/后缀映射
 * 规则来自 qq-music-api/routes/song.js（48-69 行）：
 *   F000 + mid + mid + .flac = 无损 FLAC
 *   M800 + mid + mid + .mp3  = 320k 高品 MP3
 *   M500 + mid + mid + .mp3  = 128k 标准 MP3
 */
const QUALITY_MAP = {
  lossless: { s: 'F000', e: '.flac', ext: 'flac' },
  hq:       { s: 'M800', e: '.mp3',  ext: 'mp3' },
  standard: { s: 'M500', e: '.mp3',  ext: 'mp3' },
};
// sd 是 standard 的别名（兼容旧代码传入 'sd'）
QUALITY_MAP.sd = QUALITY_MAP.standard;

/**
 * 获取下载 URL
 * @param {string} id - songmid
 * @param {string} quality - lossless | hq | sd
 * @param {string} cookie
 * @returns {Promise<{url,ext}|{error,code,fatal}>}
 */
async function qqGetUrl(id, quality, cookie = '') {
  const uin = extractQQUin(cookie) || '0';
  const q = QUALITY_MAP[quality] || QUALITY_MAP.sd;
  const qqmusicKey = extractQQMusickey(cookie);
  const mediaId = id;
  const file = `${q.s}${id}${mediaId}${q.e}`;
  const guid = Math.floor(Math.random() * 10000000).toString();

  // vkey 请求体
  const dataObj = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        filename: [file],
        guid,
        songmid: [id],
        songtype: [0],
        uin,
        loginflag: uin !== '0' ? 1 : 0,
        platform: '20',
      },
    },
    comm: {
      uin,
      format: 'json',
      ct: 19,    // 官方 song/url 用 19（PC 客户端标识）
      cv: 0,
      authst: qqmusicKey,    // 新版 QQ 鉴权签名（VIP/FLAC 必备）
    },
  };
  const data = encodeURIComponent(JSON.stringify(dataObj));
  const url = `https://u.y.qq.com/cgi-bin/musicu.fcg?-=getplaysongvkey${Date.now()}&g_tk=5381&loginUin=${encodeURIComponent(uin)}&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&data=${data}`;

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://y.qq.com/',
    };
    if (cookie) headers['Cookie'] = cookie;

    const result = await request(url, { headers, timeout: 15000 });
    const midurlinfo = result?.req_0?.data?.midurlinfo || [];
    const sip = result?.req_0?.data?.sip || [];
    const info = midurlinfo.find(m => m.songmid === id) || midurlinfo[0];

    if (info && info.purl) {
      // 优先选非 http://ws 开头的 CDN 域名
      const baseUrl = sip.find(s => !s.startsWith('http://ws')) || sip[0] || '';
      // 修复 B13：sip 为空时不要拼接出相对路径
      if (!baseUrl) {
        return AppError.cdnEmpty('QQ音乐');
      }
      return { url: baseUrl + info.purl, ext: q.ext };
    }
    // 细化失败原因（result=104003 通常是 VIP/auth 失败）
    const errCode = info?.result;
    if (errCode === 104003) {
      return { ...AppError.authExpired('QQ音乐'), error: 'QQ音乐鉴权失败（cookie 中的 qqmusic_key 过期或失效，请重新登录）' };
    }
    return AppError.vipRequired('QQ音乐');
  } catch (e) {
    logger.warn('[qqGetUrl] 失败:', e.message);
    return AppError.internal('QQ音乐', { error: 'QQ音乐获取URL异常: ' + (e.message || e) });
  }
}

/**
 * 尝试刷新 QQ 音乐 musickey（不依赖已有的 musickey）
 * 用 QQConnectLogin 接口尝试获取一个新的登录 key
 * @returns {Promise<string>} 新的 musickey，或空字符串
 */
async function _tryRefreshMusickey(cookie, uin) {
  const data = {
    req1: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: {
        expired_in: 7776000,
        musicid: uin || '0',
        musickey: '',   // 传空，让服务器分配一个新的
      },
    },
  };
  const sign = qqGetSign(data);
  const url =
    `https://u6.y.qq.com/cgi-bin/musics.fcg` +
    `?sign=${sign}` +
    `&format=json&inCharset=utf8&outCharset=utf-8` +
    `&data=${encodeURIComponent(JSON.stringify(data))}`;

  const result = await request(url, {
    headers: {
      'Referer': 'https://y.qq.com/',
      'Cookie': cookie,
    },
  });

  const payload = result?.req1?.data || {};
  return payload.musickey || payload.loginKey || '';
}

/**
 * 按 mid 拉单曲详情（粘贴链接智能识别用）
 * @param {string} mid 歌曲 mid（songmid）
 * @returns {Promise<object|null>} 标准歌曲对象（与 qqSearch 返回项同构），拉不到返回 null
 */
async function qqGetSongDetail(mid) {
  try {
    const result = await qqMusic.api('song', { songmid: String(mid) });
    const track = result?.data?.track_info || result?.trackInfo || result?.track_info;
    if (!track || !track.mid) return null;
    return {
      id: String(track.mid),
      numId: track.id ? String(track.id) : '',
      title: track.name || '',
      artist: (track.singer || []).map(a => a.name).join(' / '),
      album: track.album?.name || '',
      albumMid: track.album?.mid || '',
      cover: track.album?.mid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${track.album.mid}.jpg`
        : '',
      duration: track.interval ? track.interval * 1000 : 0,
      source: 'qq',
      pay: track.pay,
    };
  } catch (e) {
    logger.warn(`[qq] song detail 失败 (mid=${mid}):`, e.message || e);
    return null;
  }
}


async function qqVerifyCookie(cookie) {
  const detect = detectQQCookieType(cookie);

  // 微信登录：明确告知用户
  if (detect.isWechatLogin && !detect.isQQLogin) {
    return {
      valid: false,
      type: 'wechat',
      reason: '检测到「微信登录」Cookie，QQ音乐VIP解锁率较低',
      fields: detect.fields,
      missing: detect.missing,
      suggestions: [
        '1. 退出当前登录，在 y.qq.com 改用「QQ号+密码」重新登录',
        '2. 微信登录的VIP绑定在微信侧，QQ音乐API无法识别',
      ],
    };
  }

  // 必要字段缺失：没有 uin 就直接拒绝（这是未登录的明确标志）
  if (!detect.uin) {
    return {
      valid: false,
      type: 'unknown',
      reason: 'Cookie 缺少 uin 字段，请确认已成功登录 QQ 音乐',
      fields: detect.fields,
      missing: detect.missing,
    };
  }

  // 有 uin 但没有 musickey：说明是刚登录的 Cookie（musickey 要播歌后才会有）
  // 这种情况允许保存，但不标记为完整 VIP 登录
  const hasMusickey = detect.fields.qqmusic_key || detect.fields.qm_keyst;
  if (!hasMusickey) {
    // 尝试从 u6 接口拿一个临时 musickey（即使失败也不阻止保存）
    let freshMusickey = '';
    try {
      freshMusickey = await _tryRefreshMusickey(cookie, detect.uin);
    } catch (e) {
      // 忽略刷新失败
    }

    if (freshMusickey) {
      // 返回新 musickey，由 IPC 调用方写回 cookie store
      return {
        valid: true,
        type: 'qq',
        uin: detect.uin,
        freshMusickey,
        fields: detect.fields,
        message: 'QQ 登录 Cookie 有效（已刷新 musickey）',
        cookieRefreshed: true,
      };
    }

    // 没有 musickey 也刷新不到：仍然算登录成功，但提示需要先播歌
    return {
      valid: true,
      type: 'qq',
      uin: detect.uin,
      freshMusickey: '',
      fields: detect.fields,
      message: 'QQ 登录 Cookie 有效，但 musickey 需播放歌曲后自动刷新（非 VIP 账号可直接使用）',
    };
  }

  // 有 musickey，走完整验证流程
  const musickey = extractQQMusickey(cookie);
  const data = {
    req1: {
      module: 'QQConnectLogin.LoginServer',
      method: 'QQLogin',
      param: {
        expired_in: 7776000,
        musicid: detect.uin,
        musickey,
      },
    },
  };
  const sign = qqGetSign(data);
  const url =
    `https://u6.y.qq.com/cgi-bin/musics.fcg` +
    `?sign=${sign}` +
    `&format=json&inCharset=utf8&outCharset=utf-8` +
    `&data=${encodeURIComponent(JSON.stringify(data))}`;

  try {
    const result = await request(url, {
      headers: {
        'Referer': 'https://y.qq.com/',
        'Cookie': cookie,
      },
    });

    const payload = result?.req1?.data || {};
    const freshKey = payload.musickey || payload.loginKey || '';
    if (result?.req1 && (payload.musickey || payload.loginKey)) {
      return {
        valid: true,
        type: 'qq',
        uin: detect.uin,
        freshMusickey: freshKey,
        fields: detect.fields,
        message: 'QQ 登录 Cookie 有效（已通过 QQConnectLogin 接口验证）',
      };
    }

    const errMsg =
      payload.errMsg ||
      result?.req1?.errMsg ||
      result?.message ||
      '未能通过 QQ 音乐验证，请刷新 Cookie';
    return {
      valid: false,
      type: 'unknown',
      reason: errMsg,
      code: result?.req1?.code,
      fields: detect.fields,
      missing: detect.missing,
    };
  } catch (e) {
    return {
      valid: false,
      type: 'unknown',
      reason: '请求 QQ 验证接口失败: ' + (e.message || e),
      fields: detect.fields,
    };
  }
}

/**
 * QQ 首页 · 热门推荐歌单（个性化推荐）
 */
async function qqGetRecommendPlaylists(limit = 6) {
  try {
    const result = await qqMusic.api('recommend/playlist/u');
    return (result?.list || []).slice(0, limit).map(p => {
      const cover = p.cover || p.pic || p.image || p.picUrl || p.coverUrl || '';
      return {
        id: String(p.content_id || p.id || ''),
        name: p.title || p.name || '',
        cover: cover,
        playCount: p.listen_num || p.playCount || 0,
        source: 'qq',
      };
    });
  } catch (e) {
    logger.warn('[qq] getPlaylist 失败:', e.message);
    return [];
  }
}

/**
 * QQ 首页 · 分类歌单（官方/经典/情歌/网络/KTV 等）
 * @param {number} categoryId - 分类 ID（3317=官方, 59=经典, 71=情歌, 3056=网络, 64=KTV）
 * @param {number} pageNo
 * @param {number} pageSize - 单页条数（QQ 接口一般 20-30）
 */
async function qqGetCategoryPlaylists(categoryId = 3317, pageNo = 1, pageSize = 30) {
  try {
    // 使用 songlist/list 接口获取分类歌单
    const result = await qqMusic.api('songlist/list', { category: categoryId, pageNo, pageSize });
    // result 可能是 undefined（QQ API 返回 400 时），安全兜底
    const list = (result?.data?.list || result?.list || []).map(p => {
      const cover = p.imgurl || p.cover || p.img || p.pic || p.image || '';
      return {
        id: String(p.dissid || p.id || ''),
        name: p.dissname || p.title || p.name || '',
        cover: cover,
        playCount: p.listennum || p.access_num || 0,
        source: 'qq',
      };
    });
    return list.slice(0, pageSize);
  } catch (e) {
    // categoryId 无效时 QQ API 返回 400，静默跳过
    logger.warn(`[qq] categoryPlaylist categoryId=${categoryId} failed: ${e.message}`);
    return [];
  }
}

/**
 * QQ 首页 · 排行榜（热歌榜/新歌榜/飙升榜等）
 * @param {number} topId - 排行榜 ID（QQ 接口 top 路由）
 * @param {number} limit
 */
async function qqGetTopList(topId = 4, limit = 50) {
  try {
    const result = await qqMusic.api('top', { id: topId, pageSize: limit });
    // qq-music-api 的 top 路由直接 resolve data，歌曲在 result.list
    const songs = result?.list || [];
    return songs.slice(0, limit).map(s => {
      const info = s.data || s;
      const albumMid = info.albummid || info.album?.mid || '';
      return {
        id: String(info.songmid || info.mid || ''),
        numId: String(info.songid || info.id || ''),
        title: info.songname || info.name || '',
        artist: (info.singer || []).map(a => a.name).join(' / '),
        album: info.albumname || info.album?.name || '',
        albumMid: albumMid,
        cover: albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
        duration: info.interval ? info.interval * 1000 : 0,
        source: 'qq',
      };
    });
  } catch (e) {
    logger.warn('[qq] getTopList 失败:', e.message);
    return [];
  }
}

/**
 * QQ 首页 · 新歌首发
 * @param {number} type - new/songs 的 type：0=最新, 1=内地, 2=港台, 3=欧美, 4=韩国, 5=日本
 * @param {number} limit
 */
async function qqGetNewSongs(type = 1, limit = 30) {
  try {
    // new/songs 路由参数 type 含义：0=最新, 1=内地, 2=港台, 3=欧美, 4=韩国, 5=日本
    const result = await qqMusic.api('new/songs', { type, num: limit });
    // resolve 出 data: { lan, list, type }
    const songs = result?.list || [];
    return songs.slice(0, limit).map(s => {
      const info = s.songInfo || s.data || s;
      const albumMid = info.albummid || info.album?.mid || '';
      const singer = info.singer || s.singer || [];
      return {
        id: String(info.songmid || info.mid || ''),
        numId: String(info.songid || info.id || ''),
        title: info.songname || info.name || '',
        artist: singer.map(a => a.name).join(' / '),
        album: info.albumname || info.album?.name || '',
        albumMid: albumMid,
        cover: albumMid ? `https://y.qq.com/music/photo_new/T002R300x300M000${albumMid}.jpg` : '',
        duration: info.interval ? info.interval * 1000 : 0,
        source: 'qq',
      };
    });
  } catch (e) {
    logger.warn('[qq] getNewSongs 失败:', e.message);
    return [];
  }
}

/**
 * QQ 首页 · 热门电台
 */
async function qqGetRadioStations(limit = 20) {
  try {
    // radio/category 返回 data: {radio_list: [{id, name, picUrlMid, ...}]}
    const result = await qqMusic.api('radio/category');
    const list = result?.radio_list || [];
    return list.slice(0, limit).map(r => {
      // 电台封面用 picUrlMid 拼
      const picMid = r.picUrlMid || r.picurlmid || r.mid || '';
      const cover = picMid
        ? `https://y.gtimg.cn/music/photo/radio/300_${picMid}.jpg`
        : (r.picUrl || r.cover || '');
      return {
        id: String(r.id || r.rid || ''),
        name: r.name || r.title || '',
        cover,
        playCount: r.listenNum || r.playCount || 0,
        source: 'qq',
      };
    });
  } catch (e) {
    logger.warn('[qq] getRadioStations 失败:', e.message);
    return [];
  }
}

/**
 * QQ 首页 · 热门歌手
 */
async function qqGetHotSingers(limit = 20) {
  try {
    // singer/list 路由参数 area/sex/genre/index 任意，-100 = 不限
    const result = await qqMusic.api('singer/list', { area: -100, sex: -100, genre: -100, index: -100, pageSize: limit });
    // data.list: { totalNum, totalPage, pageSize, ...}
    const list = result?.list || [];
    return list.slice(0, limit).map(s => {
      const mid = s.singer_mid || s.mid || '';
      const pic = s.singer_pic_mid || s.pic_mid || mid;
      return {
        id: String(mid),
        name: s.singer_name || s.name || '',
        avatar: pic
          ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${pic}.jpg`
          : '',
        source: 'qq',
      };
    });
  } catch (e) {
    logger.warn('[qq] getHotSingers 失败:', e.message);
    return [];
  }
}

/**
 * QQ 专辑歌曲
 */
async function qqGetAlbumSongs(albumMid, limit = 999) {
  try {
    const result = await qqMusic.api('album/songs', { albummid: albumMid, begin: 0, num: limit });
    // 返回结构: { list: [...songInfo], total, albummid }
    const list = result?.list || [];
    return list.map(s => ({
      id: String(s.mid || s.id || ''),
      numId: String(s.id || ''),
      mid: s.mid || '',
      title: s.name || '',
      artist: (s.singer || []).map(a => a.name).join(' / '),
      album: s.album?.name || '',
      cover: s.album?.mid
        ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.album.mid}.jpg`
        : '',
      duration: s.interval ? s.interval * 1000 : 0,
      source: 'qq',
    }));
  } catch (e) {
    logger.warn('[qqGetAlbumSongs] failed:', e.message);
    return [];
  }
}

/**
 * QQ 歌词
 * @param {string} songmid - QQ 歌曲 mid
 * @returns {Promise<string>}
 */
async function qqGetLyrics(songmid) {
  if (!songmid) return '';
  try {
    const result = await qqMusic.api('lyric', { songmid });
    const lrc = result?.lyric || result?.data?.lyric || '';
    return lrc;
  } catch (e) {
    logger.warn('QQ获取歌词失败:', e.message);
    return '';
  }
}

/**
 * QQ 歌单歌曲
 */
async function qqGetPlaylistSongs(id, limit = 200) {
  try {
    const result = await qqMusic.api('songlist', { id });
    return (result?.songlist || []).slice(0, limit).map(s => {
      // 兼容多种字段：songmid / mid / id
      const songmid = s.songmid || s.mid || s.id || '';
      return {
        id: String(songmid),
        numId: String(s.songid || s.id || ''),
        title: s.songname || s.name || '',
        artist: (s.singer || []).map(a => a.name).join(' / '),
        album: s.albumname || '',
        albumMid: s.albummid || s.album?.mid || '',
        cover: s.albummid ? `https://y.qq.com/music/photo_new/T002R300x300M000${s.albummid}.jpg` : '',
        duration: s.interval ? s.interval * 1000 : 0,
        source: 'qq',
      };
    });
  } catch (e) {
    logger.warn('[qqGetPlaylistSongs] 失败:', e.message);
    return [];
  }
}

module.exports = {
  qqSearch,
  qqSearchAlbum,
  qqSearchSinger,
  qqGetSingerSongs,
  qqGetSingerAlbums,
  qqGetUrl,
  qqGetSongDetail,
  qqVerifyCookie,
  qqGetRecommendPlaylists,
  qqGetCategoryPlaylists,
  qqGetTopList,
  qqGetNewSongs,
  qqGetRadioStations,
  qqGetHotSingers,
  qqGetPlaylistSongs,
  qqGetAlbumSongs,
  qqGetLyrics,
  QUALITY_MAP,
};
