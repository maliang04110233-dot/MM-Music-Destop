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
}

module.exports = { register };