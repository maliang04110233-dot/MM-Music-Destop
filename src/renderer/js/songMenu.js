/**
 * 歌曲行右键菜单（搜索结果 / 歌单详情等共享）
 *
 * 菜单框架在 contextMenu.js，本模块负责「歌曲行业务项」的统一组装：
 * 立即播放 / 下一首播放 / 下载（含按音质覆盖）/ 加入播放队列 / 收藏 / 添加到歌单。
 * 各视图差异（自己的 playSong / addDownload / 索引语义）通过 opts 回调注入，
 * 视图特有项走 opts.extra。
 */

import { showContextMenu } from './contextMenu.js';
import { isFavorite, toggleFavoriteByKey, registerFavSong } from './favorites.js';
import { favKey } from './state.js';
import { qualityOverrideOptions, resolveQuality } from './quality.js';

/**
 * 「以此音质下载」菜单项（纯组装，便于单测）：
 * 每个候选档一项，点击回调 onPick(qualityValue)。
 */
export function qualityDownloadItems(source, current, onPick) {
  return qualityOverrideOptions(source, current).map(o => ({
    icon: '⬇', label: `以此音质下载：${o.label}`, onClick: () => onPick(o.value),
  }));
}

/** 「下一首播放」：插到当前曲之后；已在队列则移动而非重复插入 */
export function playNextHere(song, playNowFallback) {
  const q = (getState('playQueue') || []).slice();
  let curIdx = getState('playIdx');
  if (curIdx == null || curIdx < 0 || !q[curIdx]) { playNowFallback(); return; } // 未在播放 → 直接播
  const isSame = x => x && String(x.id) === String(song.id) && x.source === song.source;
  const at = q.findIndex(isSame);
  if (at !== -1) {
    if (at === curIdx + 1) { showToast('它已经在下一首了', 'info', 1500); return; }
    q.splice(at, 1);
    if (at < curIdx) curIdx--;
  }
  q.splice(curIdx + 1, 0, song);
  setState('playQueue', q);
  setState('playIdx', curIdx);
  showToast(`⤳ 下一首播放：${song.title}`, 'success', 2000);
}

/**
 * 弹出歌曲行右键菜单
 * @param {MouseEvent} e contextmenu 事件
 * @param {Object} song 行对应的歌曲对象
 * @param {{play: Function, download?: Function, addToQueue?: Function, extra?: Array}} opts
 *   play/download/addToQueue 为视图注入的动作回调；extra 为视图特有菜单项
 */
export function openSongRowMenu(e, song, opts = {}) {
  if (!song || !opts.play) return;
  e.preventDefault();
  registerFavSong(song); // 收藏切换要从登记表带回完整元数据
  const on = isFavorite(song);
  const items = [
    { icon: '▶', label: '立即播放', onClick: () => opts.play() },
    { icon: '⤳', label: '下一首播放', onClick: () => playNextHere(song, () => opts.play()) },
    { sep: true },
  ];
  if (opts.download) items.push({ icon: '⬇', label: '下载', onClick: () => opts.download() });
  if (opts.downloadQuality) {
    const extra = qualityDownloadItems(song.source, resolveQuality(song.source), opts.downloadQuality);
    if (extra.length) items.push(...extra);
  }
  if (opts.addToQueue) items.push({ icon: '➕', label: '加入播放队列', onClick: () => opts.addToQueue() });
  items.push(
    { icon: on ? '💔' : '♥', label: on ? '取消收藏' : '收藏',
      onClick: () => toggleFavoriteByKey(favKey(song.source, song.id)) },
    { icon: '📋', label: '添加到歌单', onClick: () => {
      if (typeof window.quickAddToPlaylist === 'function') window.quickAddToPlaylist(song);
    } },
  );
  if (opts.extra && opts.extra.length) items.push({ sep: true }, ...opts.extra);
  showContextMenu(e.clientX, e.clientY, items);
}
