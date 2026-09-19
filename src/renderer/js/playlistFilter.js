/**
 * 歌单详情歌曲过滤 — 纯函数（node 直测，无 DOM 依赖）
 *
 * 与首页榜单过滤（homeFilter）同配方：返回 [song, 原始下标] pairs，
 * 行内播放/下载/移除/拖拽的 onclick 索引全部沿用原始下标，
 * 过滤只做"藏行"绝不重排，索引语义与完整列表恒一致。
 */

/** 关键词按空白分词，行文本=标题+歌手+专辑，全词命中（AND）才保留 */
export function filterPlaylistSongs(songs, kw) {
  const terms = String(kw || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return (songs || []).map((s, i) => ({ song: s, i }));
  const out = [];
  (songs || []).forEach((s, i) => {
    const hay = [s && s.title, s && s.artist, s && s.album]
      .filter(Boolean).join(' ').toLowerCase();
    if (terms.every(t => hay.includes(t))) out.push({ song: s, i });
  });
  return out;
}
