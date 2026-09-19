/**
 * 跨歌单重复检测纯函数（增量117）—— node 可直测，全模块零 DOM
 *
 * 增量84「🧹 清重复」只管单歌单内部；同名歌散在收藏夹+自建单+导入单
 * 里没人报警。这里扫全部我的歌单，把同一身份出现在 ≥2 个歌单的歌折成
 * 报告。身份键与收藏线同约定（88/92）：本地行认 filePath，在线行认
 * source:id；drop 临时行/缺键行不参与（进了报告也没法定位）。
 * 同键只算一次跨单，单内重复归 84 管。
 */

/** 歌行 → 查重身份键；不可判别（无题/drop/缺路径/缺id）返回 null */
export function songDedupeKey(s) {
  if (!s || !s.title) return null;
  const src = String(s.source || '');
  if (src === 'drop') return null;
  if (src === 'local') return s.filePath ? `L:${s.filePath}` : null;
  return s.id != null ? `O:${src}:${s.id}` : null;
}

/**
 *  playlists → [{title,artist,where:[歌单名…]}]（出现在 ≥2 个歌单）。
 * 排序：散落多的在前，同数按歌名 zh 序；脏输入当空。
 */
export function findCrossPlaylistDupes(playlists) {
  const map = new Map();
  const list = Array.isArray(playlists) ? playlists : [];
  for (const pl of list) {
    if (!pl || !Array.isArray(pl.songs)) continue;
    const name = String(pl.name || '').trim() || '未命名歌单';
    for (const s of pl.songs) {
      const k = songDedupeKey(s);
      if (!k) continue;
      let g = map.get(k);
      if (!g) {
        g = { title: String(s.title || ''), artist: String(s.artist || ''), plNames: new Set() };
        map.set(k, g);
      }
      g.plNames.add(name);
    }
  }
  const out = [];
  for (const g of map.values()) {
    if (g.plNames.size >= 2) out.push({ title: g.title, artist: g.artist, where: Array.from(g.plNames) });
  }
  out.sort((a, b) => b.where.length - a.where.length || a.title.localeCompare(b.title, 'zh'));
  return out;
}

/** 组 → 复制报告正文（每组一行「歌 - 歌手 ×N: 单A、单B」） */
export function dedupeScanText(groups) {
  const list = Array.isArray(groups) ? groups : [];
  return list.map((g) => {
    const name = g.artist ? `${g.title} - ${g.artist}` : String(g.title || '');
    const where = Array.isArray(g.where) ? g.where : [];
    return `「${name}」×${where.length}: ${where.join('、')}`;
  }).join('\n');
}
