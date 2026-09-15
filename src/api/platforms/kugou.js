/**
 * 酷狗音乐平台实现
 *
 * 基于酷狗公开 Web API：
 *   - songsearch.kugou.com 搜索
 *   - kugou.com/yy/index.php 获取播放/下载 URL
 *   - lyrics.kugou.com 获取歌词
 */

const request = require('../request');
const logger = require('../../utils/logger');

// 编码/解码三种音质的 hash 到 id
const HASH_SEP = '::';

function encodeKugouId(fileHash, sqHash, hqHash) {
  return `${fileHash}${HASH_SEP}${sqHash || ''}${HASH_SEP}${hqHash || ''}`;
}

function decodeKugouId(encodedId) {
  const parts = encodedId.split(HASH_SEP);
  return {
    fileHash: parts[0] || '',
    sqHash: parts[1] || '',
    hqHash: parts[2] || '',
  };
}

// 随机设备 ID（酷狗需要，用一次生成缓存）
let _mid = '';

function getMid() {
  if (!_mid) {
    _mid = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  return _mid;
}

/**
 * 搜索歌曲
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<Array>}
 */
async function kugouSearch(keyword, page = 1) {
  if (!keyword || typeof keyword !== 'string') return [];
  const url = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=30&platform=WebFilter`;
  const result = await request(url, { timeout: 10000 });
  const songs = result?.data?.lists || [];
  return songs.map(s => ({
    title: s.SongName || '',
    artist: s.SingerName || '',
    album: s.AlbumName || '',
    cover: s.FileHash
      ? `https://imgessl.kugou.com/stdmusic/${s.FileHash.slice(0, 2)}/${s.FileHash}.jpg`
      : '',
    duration: (s.Duration || 0) * 1000,
    source: 'kugou',
    // 将三种音质的 hash 编码到 id 中，方便 getUrl 按需取用
    id: encodeKugouId(s.FileHash || '', s.SQFileHash || '', s.HQFileHash || ''),
  }));
}

/**
 * 获取下载 URL（使用酷狗移动端 API v3）
 */
async function kugouGetUrl(id, quality = 'standard') {
  const { fileHash, sqHash, hqHash } = decodeKugouId(id);

  let hash = fileHash;
  if (quality === 'lossless' && sqHash) hash = sqHash;
  else if (quality === 'hq' && hqHash) hash = hqHash;

  if (!hash) return { error: '缺少歌曲 hash', fatal: true };

  const extMap = { lossless: 'flac', hq: 'mp3', standard: 'mp3' };
  const ext = extMap[quality] || 'mp3';

  try {
    // 主链路：m.kugou.com 移动端 playInfo（免费曲直接返回 sharefs URL，
    // 付费曲返回 error=需要付费）。原 mobilecdn.kugou.com 在部分网络下
    // DNS 污染（解析到腾讯 CDN，证书不匹配直接 TLS 报错），已弃用。
    let playUrl = '';
    let payError = '';
    const info = await request(`https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`, { timeout: 10000 });
    if (info && typeof info === 'object') {
      playUrl = info.url || info.play_url || '';
      payError = info.error || '';
    }

    // 备选：trackercdn v2（key=md5(hash+kgcloudv2)）——部分网络下仍可用
    if (!playUrl) {
      try {
        const crypto = require('crypto');
        const key = crypto.createHash('md5').update(hash + 'kgcloudv2').digest('hex').toLowerCase();
        const cdnUrl = `https://trackercdn.kugou.com/i/v2/?appid=1005&pid=2&cmd=25&behavior=play&hash=${hash}&key=${key}&br=${quality === 'lossless' ? 2000 : quality === 'hq' ? 320 : 128}&mid=${encodeURIComponent(getMid())}`;
        const cdnResult = await request(cdnUrl, { timeout: 8000 });
        const cdnData = cdnResult?.data || cdnResult || {};
        if (cdnData.play_url) playUrl = cdnData.play_url;
      } catch (_e) { /* 备选失败走降级链 */ }
    }

    // 降级链：无损拿不到试 HQ，HQ 拿不到试标准
    if (!playUrl && quality === 'lossless') return kugouGetUrl(id, 'hq');
    if (!playUrl && quality === 'hq') return kugouGetUrl(id, 'standard');
    if (!playUrl) {
      // playInfo 明确说付费：版权错误码（getDownloadUrlSmart 会换其他源）
      if (payError && /付费|VIP|版权/.test(payError)) {
        return {
          error: `酷狗：${payError}（该曲需付费/会员，已自动尝试其他源）`,
          code: 'COPYRIGHT_RESTRICTED',
          fatal: false,
        };
      }
      return {
        error: '酷狗音源获取受限（反爬保护），请改用网易云/QQ音乐/B站搜索相同歌曲下载',
        code: 'PLATFORM_CHANGED',
        fatal: true,
      };
    }

    return { url: playUrl, ext };
  } catch (e) {
    logger.warn('[kugou] getPlayUrl 失败:', e.message);
    return { error: e.message || '请求失败' };
  }
}

/**
 * 获取歌词
 * @param {string} id - song hash
 * @returns {Promise<string>}
 */
async function kugouGetLyrics(id) {
  if (!id) return '';
  try {
    // 第一步：搜索歌词 ID
    const searchUrl = `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(id)}`;
    const searchResult = await request(searchUrl, { timeout: 8000 });
    const candidates = searchResult?.candidates || [];
    if (!candidates.length) return '';

    const first = candidates[0];
    const lrcId = first.id;
    const accessToken = first.accessToken || '';

    if (!lrcId) return '';

    // 第二步：下载歌词
    const dlUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(lrcId)}&accessToken=${encodeURIComponent(accessToken)}&fmt=lrc`;
    const lrcResult = await request(dlUrl, { timeout: 8000 });
    const content = lrcResult?.content || '';

    if (content) {
      // 酷狗返回 base64 编码的歌词
      try {
        return Buffer.from(content, 'base64').toString('utf-8');
      } catch {
        return content;
      }
    }
    return '';
  } catch (e) {
    logger.warn('酷狗获取歌词失败:', e.message);
    return '';
  }
}

/**
 * 按照歌曲名+歌手搜索歌词的 fallback
 */
async function kugouGetLyricsByTitle(title, artist) {
  if (!title) return '';
  const keyword = `${title} ${artist || ''}`.trim();
  try {
    const searchUrl = `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(keyword)}&duration=0`;
    const result = await request(searchUrl, { timeout: 8000 });
    const candidates = result?.candidates || [];
    if (!candidates.length) return '';

    const first = candidates[0];
    const lrcId = first.id;
    const accessToken = first.accessToken || '';
    if (!lrcId) return '';

    const dlUrl = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(lrcId)}&accessToken=${encodeURIComponent(accessToken)}&fmt=lrc`;
    const lrcResult = await request(dlUrl, { timeout: 8000 });
    const content = lrcResult?.content || '';
    if (content) {
      try { return Buffer.from(content, 'base64').toString('utf-8'); }
      catch { return content; }
    }
    return '';
  } catch (e) {
    logger.warn('酷狗歌词 fallback 搜索失败:', e.message);
    return '';
  }
}

/**
 * 搜索专辑
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{albums: Array, total: number, page: number}>}
 */
async function kugouSearchAlbum(keyword, page = 1) {
  const url = `https://mobilecdn.kugou.com/api/v3/search/album?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=30&sort=1`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  const total = result?.data?.total || 0;
  return {
    albums: list.map(a => ({
      id: String(a.albumid || a.albumID || ''),
      mid: String(a.albumid || a.albumID || ''),
      title: a.albumname || a.albumName || '',
      artist: a.singername || a.singerName || '',
      cover: a.imgurl || (a.albumid ? `https://imgessl.kugou.com/album/${String(a.albumid).slice(0, 2)}/${a.albumid}.jpg` : ''),
      songCount: a.songcount || a.songCount || 0,
      publishTime: (a.publishtime || a.publishTime || '').replace(/\s.*$/, ''),
      source: 'kugou',
    })),
    total,
    page,
  };
}

/**
 * 搜索歌手
 * @param {string} keyword
 * @param {number} page
 * @returns {Promise<{singers: Array, total: number, page: number}>}
 */
async function kugouSearchSinger(keyword, page = 1) {
  const url = `https://mobilecdn.kugou.com/api/v3/search/singer?keyword=${encodeURIComponent(keyword)}&page=${page}&pagesize=10`;
  const result = await request(url, { timeout: 10000 });
  const list = Array.isArray(result?.data) ? result.data : (result?.data?.info || []);
  const total = result?.data?.total || list.length;
  return {
    singers: list.map(s => ({
      id: String(s.singerid || s.singerID || s.id || ''),
      mid: String(s.singerid || s.singerID || s.id || ''),
      name: s.singername || s.singerName || '',
      avatar: s.imgurl || s.pic || s.imgsmall || '',
      songCount: s.songcount || s.songCount || 0,
      albumCount: s.albumcount || s.albumCount || 0,
      source: 'kugou',
    })),
    total,
    page,
  };
}

/**
 * 获取专辑内歌曲
 * @param {string|number} albumId
 * @param {number} limit
 */
async function kugouGetAlbumSongs(albumId, limit = 999) {
  const url = `https://mobilecdn.kugou.com/api/v3/album/song?albumid=${albumId}&page=1&pagesize=${limit}`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  return list.map(s => {
    const parts = (s.filename || s.songname || '').split(' - ');
    const title = parts.length > 1 ? parts.slice(1).join(' - ') : (s.filename || '');
    const artist = parts.length > 1 ? parts[0] : '';
    return {
      id: (s.hash || '') + '::' + (s.sqhash || '') + '::' + (s.hqhash || ''),
      title,
      artist,
      album: s.album_name || '',
      cover: s.imgurl || (s.hash ? `https://imgessl.kugou.com/stdmusic/${s.hash.slice(0, 2)}/${s.hash}.jpg` : ''),
      duration: (s.duration || 0) * 1000,
      source: 'kugou',
    };
  });
}

/**
 * 获取歌手热门歌曲
 */
async function kugouGetSingerSongs(singerId, limit = 50) {
  const url = `https://mobilecdn.kugou.com/api/v3/singer/song?singerid=${singerId}&page=1&pagesize=${Math.min(limit, 100)}`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  return list.slice(0, limit).map(s => {
    const parts = (s.filename || '').split(' - ');
    const title = parts.length > 1 ? parts.slice(1).join(' - ') : (s.filename || '');
    const artist = parts.length > 1 ? parts[0] : '';
    return {
      id: (s.hash || '') + '::' + (s.sqhash || '') + '::' + (s.hqhash || ''),
      title,
      artist,
      album: s.album_name || '',
      cover: s.imgurl || (s.hash ? `https://imgessl.kugou.com/stdmusic/${s.hash.slice(0, 2)}/${s.hash}.jpg` : ''),
      duration: (s.duration || 0) * 1000,
      source: 'kugou',
    };
  });
}

/**
 * 获取歌手专辑列表
 */
async function kugouGetSingerAlbums(singerId, pageNo = 1, pageSize = 20) {
  const url = `https://mobilecdn.kugou.com/api/v3/singer/album?singerid=${singerId}&page=${pageNo}&pagesize=${pageSize}`;
  const result = await request(url, { timeout: 10000 });
  const list = result?.data?.info || [];
  const total = result?.data?.total || 0;
  return {
    albums: list.map(a => ({
      id: String(a.albumid || a.albumID || ''),
      mid: String(a.albumid || a.albumID || ''),
      title: a.albumname || a.albumName || '',
      artist: a.singername || a.singerName || '',
      cover: a.imgurl || (a.albumid ? `https://imgessl.kugou.com/album/${String(a.albumid).slice(0, 2)}/${a.albumid}.jpg` : ''),
      songCount: a.songcount || a.songCount || 0,
      publishTime: (a.publishtime || a.publishTime || '').replace(/\s.*$/, ''),
      source: 'kugou',
    })),
    total,
    page: pageNo,
  };
}

/**
 * 按 hash 拉单曲详情（粘贴链接智能识别用）
 *
 * 链接里只有单 hash（无 SQ/HQ hash），id 用 encodeKugouId(hash,'','') 编码——
 * kugouGetUrl 对缺失的高品质 hash 已有降级处理。
 * @param {string} hash 歌曲 FileHash
 * @returns {Promise<object|null>} 标准歌曲对象，拉不到返回 null
 */
async function kugouGetSongDetail(hash) {
  if (!hash) return null;
  try {
    const url = `https://mobilecdn.kugou.com/api/v3/song/detail?hash=${encodeURIComponent(hash)}&mid=${encodeURIComponent(getMid())}`;
    const detail = await request(url, { timeout: 10000 });
    const info = detail?.data?.info?.[0] || detail?.data || {};
    if (!info || (!info.hash && !info.FileName && !info.songname)) return null;
    // 接口同时回传 SQ/HQ hash 时编码进 id，下载侧可上更高音质
    const fileHash = info.hash || hash;
    const sqHash = info.sq_hash || info.SQFileHash || '';
    const hqHash = info.hq_hash || info.HQFileHash || '';
    const title = info.songname || info.FileName || (info.filename ? String(info.filename).split(' - ').pop() : '');
    if (!title) return null;
    return {
      id: encodeKugouId(fileHash, sqHash, hqHash),
      title,
      artist: info.singername || info.SingerName || '',
      album: info.albumname || info.AlbumName || '',
      cover: fileHash
        ? `https://imgessl.kugou.com/stdmusic/${String(fileHash).slice(0, 2)}/${fileHash}.jpg`
        : '',
      duration: (info.duration || info.Duration || 0) * 1000,
      source: 'kugou',
    };
  } catch (e) {
    logger.warn(`[kugou] song detail 失败 (hash=${String(hash).slice(0, 12)}...):`, e.message || e);
    return null;
  }
}

module.exports = {
  kugouSearch,
  kugouGetUrl,
  kugouGetSongDetail,
  kugouGetLyrics,
  kugouGetLyricsByTitle,
  kugouSearchAlbum,
  kugouSearchSinger,
  kugouGetAlbumSongs,
  kugouGetSingerSongs,
  kugouGetSingerAlbums,
};
