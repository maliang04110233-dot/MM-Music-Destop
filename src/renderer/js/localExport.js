/**
 * 本地曲库导出 m3u —— 范围挑选与字段映射的纯函数（node 可测，无 DOM）。
 * duration 单位跟主进程 export-playlist 语义对齐 = **毫秒**
 * （主进程写 EXTINF 前统一 ÷1000，这里不要再除）。
 */

/**
 * @param {Array} localSongs - 本地库视图行（{filePath,title,artist,durationMs}）
 * @param {Set|null} selected - 勾选的 filePath 集合；非空时只导出勾选，空/null 导出全部
 */
export function buildExportSongs(localSongs, selected) {
  const list = Array.isArray(localSongs) ? localSongs : [];
  const useSel = selected && typeof selected.size === 'number' && selected.size > 0;
  return list
    .filter(s => s && s.filePath && (!useSel || selected.has(s.filePath)))
    .map(s => ({
      title: s.title || '',
      artist: s.artist || '',
      filePath: s.filePath,
      duration: s.durationMs || 0,
    }));
}
