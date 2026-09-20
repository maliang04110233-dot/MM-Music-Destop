/**
 * 首页榜单「播放全部」—— 取哪几首、怎么截断的纯逻辑（node 可测，无 DOM）。
 *
 * 过滤一律走 homeFilter.filterHomeSection：榜单行的播放/下载按**原始下标**回查，
 * 这里若自己写一遍 includes 就会和渲染层漂移（弹层与分区看到的不一样）。
 */

import { filterHomeSection } from './homeFilter.js';

/** 整单连播入队上限：榜单最长 200+ 行，全塞进队列既没必要也容易误触 */
const PLAY_ALL_LIMIT = 100;

/**
 * @param {Array} data - 分区原始歌曲数组（homeState 里那份，未过滤）
 * @param {string} kw - 当前过滤词
 * @param {number} [limit]
 * @returns {{songs: Array, total: number, truncated: boolean}}
 */
function planSectionPlay(data, kw, limit = PLAY_ALL_LIMIT) {
  const { pairs } = filterHomeSection('list', data, kw);
  const songs = (pairs || []).map(p => p && p.s).filter(Boolean);
  const n = Number(limit) > 0 ? Number(limit) : songs.length;
  const picked = songs.slice(0, n);
  return { songs: picked, total: songs.length, truncated: songs.length > picked.length };
}

/** 播报文案：截断时明说「前 N 首」，否则用户以为整榜都在队列里 */
function playAllToastText(label, pickedCount, totalCount, truncated) {
  const head = `▶ 正在播放${label}`;
  if (truncated) return `${head}（共 ${totalCount} 首，已入前 ${pickedCount} 首）`;
  return `${head}（共 ${pickedCount} 首）`;
}

export { PLAY_ALL_LIMIT, planSectionPlay, playAllToastText };
