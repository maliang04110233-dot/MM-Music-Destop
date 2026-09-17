/**
 * 搜索 / 歌词 / 推荐 IPC
 *
 * 注册：search-music / get-lyrics / get-home-recommendations / get-playlist-songs
 */

const { ipcMain } = require('electron');
const api = require('../../api');
const logger = require('../../utils/logger');

function register() {
  // 渲染层（含上游原版）按位置参数调用：api.searchMusic(keyword, source, page)，
  // preload 原样展开传给 invoke —— handle 需同时兼容位置参数与对象两种形态
  const args = (pos, obj) => (Array.isArray(pos) && pos.length) ? pos : obj;

  ipcMain.handle('search-music', async (_, ...a) => {
    try {
      const [keyword, source, page] = args(a, a[0] || {});
      return await api.searchMusic(keyword, source, page || 1);
    } catch (e) {
      return { error: e.message, songs: [] };
    }
  });

  ipcMain.handle('get-lyrics', async (_, ...a) => {
    try {
      const [id, source, title, artist] = args(a, a[0] || {});
      return await api.getLyrics(id, source, title, artist);
    } catch (e) {
      logger.warn('获取歌词失败:', e.message || e);
      return { lrc: '', error: e.message || e };
    }
  });

  ipcMain.handle('get-home-recommendations', async () => {
    try {
      return await api.getHomeRecommendations();
    } catch (e) {
      logger.warn('获取推荐内容失败:', e.message);
      return { netease: { tops: [], playlists: [] }, qq: { playlists: [] }, error: e.message };
    }
  });

  ipcMain.handle('get-home-section', async (_, section) => {
    try {
      return await api.getHomeSection(section);
    } catch (e) {
      return { ok: false, section, data: [], error: e.message || String(e) };
    }
  });

  ipcMain.handle('get-playlist-songs', async (_, ...a) => {
    try {
      const [platform, id, limit] = args(a, a[0] || {});
      return await api.getPlaylistSongs(platform, id, limit);
    } catch (e) {
      logger.warn('获取歌单歌曲失败:', e.message);
      return [];
    }
  });

  ipcMain.handle('search-singer', async (_, ...a) => {
    try {
      const [keyword, source, page] = args(a, a[0] || {});
      return await api.searchSinger(keyword, source, page || 1);
    } catch (e) {
      logger.warn('搜索歌手失败:', e.message);
      return { singers: [], total: 0 };
    }
  });

  ipcMain.handle('get-singer-songs', async (_, ...a) => {
    try {
      const [singerMid, limit] = args(a, a[0] || {});
      return await api.getSingerSongs(singerMid, limit || 30);
    } catch (e) {
      logger.warn('获取歌手歌曲失败:', e.message);
      return [];
    }
  });

  ipcMain.handle('get-singer-albums', async (_, ...a) => {
    try {
      const [singerMid, source, pageNo, pageSize] = args(a, a[0] || {});
      return await api.getSingerAlbums(singerMid, source || 'qq', pageNo || 1, pageSize || 20);
    } catch (e) {
      logger.warn('获取歌手专辑失败:', e.message);
      return { albums: [], total: 0 };
    }
  });

  ipcMain.handle('get-album-songs', async (_, ...a) => {
    try {
      const [platform, albumMid, limit] = args(a, a[0] || {});
      return await api.getAlbumSongs(platform, albumMid, limit || 999);
    } catch (e) {
      logger.warn('获取专辑歌曲失败:', e.message);
      return [];
    }
  });

  ipcMain.handle('search-album', async (_, ...a) => {
    try {
      const [keyword, source, page] = args(a, a[0] || {});
      return await api.searchAlbum(keyword, source || 'qq', page || 1);
    } catch (e) {
      return { albums: [], total: 0, error: e.message };
    }
  });

  // 粘贴链接智能识别：文本 → { matched, song? | link?, shortLink?, error? }
  ipcMain.handle('get-song-by-link', async (_, ...a) => {
    const [text] = args(a, a[0] || {});
    try {
      return await api.getSongByLink(String(text || ''));
    } catch (e) {
      logger.warn('链接识别失败:', e.message || e);
      return { matched: false, error: e.message || e };
    }
  });

  // ── 源可用性探针（P2）─────────────────────────────
  // 被动健康度快照：getDownloadUrlSmart 各环节记的滑动窗口统计
  ipcMain.handle('get-source-health', () => {
    return api.getSourceHealthMap(['netease', 'qq', 'kugou', 'kuwo', 'bilibili']);
  });

  // 主动探测：各源搜一首公共曲并尝试取流。搜索通=源可达；取流通=源健康。
  // 探测结果记入 sourceHealth 滑动窗口（与真实下载共用同一分数）。
  ipcMain.handle('probe-sources', async () => {
    const PROBE_SOURCES = ['netease', 'qq', 'kugou', 'kuwo', 'bilibili'];
    const KEYWORD = '周杰伦 晴天';
    const withTimeout = (p) => Promise.race([
      p,
      new Promise(r => setTimeout(() => r({ error: 'timeout' }), 8000)),
    ]);
    const probes = [];
    for (const src of PROBE_SOURCES) {
      let ok = false;
      let stage = 'search';
      let error = null;
      try {
        const r = await withTimeout(api.searchMusic(KEYWORD, src, 1));
        const songs = (r && r.songs) || [];
        if (songs.length > 0) {
          stage = 'getUrl';
          const u = await withTimeout(api.getDownloadUrl(songs[0].id, src, 'standard'));
          ok = !!(u && u.url);
          if (!ok) error = (u && (u.error || u.code)) || 'no-url';
        } else {
          error = (r && r.error) || 'empty-result';
        }
      } catch (e) {
        error = e.message || 'probe-error';
      }
      // 搜索通但取流失败：可达但不健康（VIP/登录墙），记 fail 供换源排序参考
      api.recordProbeResult(src, ok);
      probes.push({ source: src, ok, stage, error, latency: null });
    }
    return { probes, health: api.getSourceHealthMap(PROBE_SOURCES) };
  });
}

module.exports = { register };