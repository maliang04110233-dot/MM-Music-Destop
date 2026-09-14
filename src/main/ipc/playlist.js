/**
 * 用户歌单 IPC
 *
 * 注册：get-user-playlists / save-user-playlist / delete-user-playlist /
 *       add-to-user-playlist / remove-from-user-playlist
 *
 * 持久化到 userData/prefs.json
 */

const { ipcMain } = require('electron');
const prefs = require('../../utils/prefs');

function register() {
  // 获取所有用户歌单
  ipcMain.handle('get-user-playlists', () => {
    return prefs.get('userPlaylists') || [];
  });

  // 保存歌单（新建或更新）
  ipcMain.handle('save-user-playlist', (_, playlist) => {
    if (!playlist || !playlist.name) return { success: false, error: '歌单名称不能为空' };
    const playlists = prefs.get('userPlaylists') || [];
    const now = Date.now();

    if (playlist.id) {
      // 更新已有歌单
      const idx = playlists.findIndex(p => p.id === playlist.id);
      if (idx >= 0) {
        playlists[idx] = { ...playlists[idx], ...playlist, updatedAt: now };
        prefs.set('userPlaylists', playlists);
        return { success: true, playlist: playlists[idx] };
      }
    }

    // 新建歌单
    const newPlaylist = {
      id: 'pl_' + now + '_' + Math.random().toString(36).slice(2, 8),
      name: playlist.name,
      desc: playlist.desc || '',
      songs: playlist.songs || [],
      createdAt: now,
      updatedAt: now,
    };
    playlists.unshift(newPlaylist);
    prefs.set('userPlaylists', playlists);
    return { success: true, playlist: newPlaylist };
  });

  // 删除歌单
  ipcMain.handle('delete-user-playlist', (_, playlistId) => {
    if (!playlistId) return { success: false, error: '缺少歌单ID' };
    const playlists = prefs.get('userPlaylists') || [];
    const filtered = playlists.filter(p => p.id !== playlistId);
    if (filtered.length === playlists.length) {
      return { success: false, error: '歌单不存在' };
    }
    prefs.set('userPlaylists', filtered);
    return { success: true };
  });

  // 添加歌曲到歌单
  // 参数为位置参数（renderer 侧 api.addToUserPlaylist(playlistId, song)）
  ipcMain.handle('add-to-user-playlist', (_, playlistId, song) => {
    if (!playlistId || !song) return { success: false, error: '参数不完整' };
    const playlists = prefs.get('userPlaylists') || [];
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx < 0) return { success: false, error: '歌单不存在' };

    const pl = playlists[idx];
    // 避免重复添加（按 source+id 判断）
    const exists = pl.songs.some(s => s.source === song.source && s.id === song.id);
    if (exists) return { success: true, skipped: true };

    pl.songs.push({ ...song, addedAt: Date.now() });
    pl.updatedAt = Date.now();
    playlists[idx] = pl;
    prefs.set('userPlaylists', playlists);
    return { success: true, playlist: pl };
  });

  // 从歌单移除歌曲（位置参数，同上）
  ipcMain.handle('remove-from-user-playlist', (_, playlistId, songId) => {
    if (!playlistId || !songId) return { success: false, error: '参数不完整' };
    const playlists = prefs.get('userPlaylists') || [];
    const idx = playlists.findIndex(p => p.id === playlistId);
    if (idx < 0) return { success: false, error: '歌单不存在' };

    const pl = playlists[idx];
    pl.songs = pl.songs.filter(s => String(s.id) !== String(songId));
    pl.updatedAt = Date.now();
    playlists[idx] = pl;
    prefs.set('userPlaylists', playlists);
    return { success: true, playlist: pl };
  });
}

module.exports = { register };
