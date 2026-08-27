/**
 * 搜索 / 歌词 / 推荐 IPC
 *
 * 注册：search-music / get-lyrics / get-home-recommendations / get-playlist-songs
 */

const { ipcMain } = require('electron');
const api = require('../../api');
const logger = require('../../utils/logger');

function register() {
  ipcMain.handle('search-music', async (_, { keyword, source, page }) => {
    try {
      return await api.searchMusic(keyword, source, page || 1);
    } catch (e) {
      return { error: e.message, songs: [] };
    }
  });

  ipcMain.handle('get-lyrics', async (_, { id, source, title, artist }) => {
    try {
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

  ipcMain.handle('get-playlist-songs', async (_, { platform, id, limit }) => {
    try {
      return await api.getPlaylistSongs(platform, id, limit);
    } catch (e) {
      logger.warn('获取歌单歌曲失败:', e.message);
      return [];
    }
  });

  ipcMain.handle('search-singer', async (_, { keyword, source, page }) => {
    try {
      return await api.searchSinger(keyword, source, page || 1);
    } catch (e) {
      logger.warn('搜索歌手失败:', e.message);
      return { singers: [], total: 0 };
    }
  });

  ipcMain.handle('get-singer-songs', async (_, { singerMid, limit }) => {
    try {
      return await api.getSingerSongs(singerMid, limit || 30);
    } catch (e) {
      logger.warn('获取歌手歌曲失败:', e.message);
      return [];
    }
  });

  ipcMain.handle('get-singer-albums', async (_, { singerMid, source, pageNo, pageSize }) => {
    try {
      return await api.getSingerAlbums(singerMid, source || 'qq', pageNo || 1, pageSize || 20);
    } catch (e) {
      logger.warn('获取歌手专辑失败:', e.message);
      return { albums: [], total: 0 };
    }
  });

  ipcMain.handle('get-album-songs', async (_, { platform, albumMid, limit }) => {
    try {
      return await api.getAlbumSongs(platform, albumMid, limit || 999);
    } catch (e) {
      logger.warn('获取专辑歌曲失败:', e.message);
      return [];
    }
  });

  ipcMain.handle('search-album', async (_, { keyword, source, page }) => {
    try {
      return await api.searchAlbum(keyword, source || 'qq', page || 1);
    } catch (e) {
      return { albums: [], total: 0, error: e.message };
    }
  });
}

module.exports = { register };