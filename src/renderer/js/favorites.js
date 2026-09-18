/**
 * 收藏（红心）
 *
 * 收藏歌单 = 主进程 userPlaylists 里 id 为 favorites 的系统歌单；红心状态从
 * state.favoriteKeys 派生。本模块负责：生成行内红心按钮 HTML、点击切换、
 * 就地刷新所有同键红心，并把渲染过的歌曲对象留在登记表里供切换时取用。
 *
 * 切换后只刷新按钮本身，不重渲染整张列表 —— 搜索结果与首页榜单都是
 * 整块 innerHTML 重写，重渲染会丢滚动位置和已勾选状态。
 *
 * 按钮不带内联字符串参数（改用 data-fav-key + this 回传），
 * 避免把用户可控的歌曲字段拼进 onclick。
*/

import { logger } from './logger.js';
import { FAVORITES_PLAYLIST_ID, favKey } from './state.js';

export const HEART_ON = '♥';
export const HEART_OFF = '♡';

/** 渲染时登记歌曲，收藏/取消时才能带回完整元数据 */
const _songRegistry = new Map();

export function registerFavSong(song) {
  if (song && song.id != null) _songRegistry.set(favKey(song.source, song.id), song);
  return song;
}

export function isFavorite(song) {
  if (!song || song.id == null) return false;
  return (getState('favoriteKeys') || new Set()).has(favKey(song.source, song.id));
}

/**
 * 红心按钮 HTML，返回完整 button 标签
 * @param {Object} song 需含 source / id
 * @param {string} [baseClass] 行内按钮基类（搜索页 action-btn，首页 top-song-action）
 */
export function heartBtnHtml(song, baseClass) {
  registerFavSong(song);
  const key = favKey(song.source, song.id);
  const on = isFavorite(song);
  const cls = (baseClass || 'action-btn') + ' heart-btn' + (on ? ' fav-on' : '');
  const title = on ? '取消收藏' : '收藏';
  return '<button class="' + escAttr(cls) + '" data-fav-key="' + escAttr(key) + '"' +
    ' title="' + escAttr(title) + '"' +
    ' onclick="event.stopPropagation();favHeartClick(this)">' +
    (on ? HEART_ON : HEART_OFF) + '</button>';
}

/** 红心按钮的 onclick 入口（this 回传，避免内联字符串参数） */
export function favHeartClick(btn) {
  const key = btn && btn.getAttribute('data-fav-key');
  if (key) toggleFavoriteByKey(key);
}

/** 按收藏键切换状态并就地刷新全部红心按钮 */
export async function toggleFavoriteByKey(key) {
  const song = _songRegistry.get(key);
  if (!song) { showToast('收藏失败：歌曲信息缺失', 'warn'); return; }
  try {
    const r = await api.toggleFavorite(String(song.source || ''), String(song.id), song);
    if (!r || !r.success) {
      showToast((r && r.error) || '收藏失败', 'error');
      return;
    }
    // 写回主进程返回的收藏歌单，favoriteKeys 计算属性随之失效重建
    const pls = (getState('userPlaylists') || []).slice();
    const idx = pls.findIndex(pl => pl && pl.id === FAVORITES_PLAYLIST_ID);
    if (idx >= 0) pls[idx] = r.playlist; else pls.unshift(r.playlist);
    setState('userPlaylists', pls);
    refreshFavoriteHearts();
    const name = song.title || song.artist || '';
    showToast((r.favorited ? '已收藏' : '已取消收藏') + (name ? '：' + name : ''),
      r.favorited ? 'success' : 'info', 1800);
  } catch (e) {
    logger.warn('收藏失败:', e);
    showToast('收藏失败: ' + (e.message || e), 'error');
  }
}

/** 就地刷新所有红心按钮外观（不重渲染列表） */
export function refreshFavoriteHearts() {
  const keys = getState('favoriteKeys') || new Set();
  document.querySelectorAll('[data-fav-key]').forEach(btn => {
    const on = keys.has(btn.getAttribute('data-fav-key'));
    btn.classList.toggle('fav-on', on);
    btn.textContent = on ? HEART_ON : HEART_OFF;
    btn.title = on ? '取消收藏' : '收藏';
  });
}

window.toggleFavoriteByKey = toggleFavoriteByKey;
window.favHeartClick = favHeartClick;
window.refreshFavoriteHearts = refreshFavoriteHearts;
