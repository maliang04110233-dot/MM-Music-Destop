/**
 * 歌单封面 — 纯函数（node 直测，无 DOM 依赖）
 *
 * 封面只存 URL（prefs.json 全量 JSON 持久化，data: 内嵌图会撑爆 prefs，
 * 故仅放行 http(s)）；歌单卡片 pl.cover 渲染链路本就存在，缺的是编辑入口。
 */

/** 合法化封面链接：空→''；非 http(s)→null（调用方据此报错） */
export function normalizeCoverUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/** 取歌单内第一首有封面的歌曲 URL，全无则 '' */
export function pickFirstSongCover(songs) {
  if (!Array.isArray(songs)) return '';
  for (const s of songs) {
    const c = normalizeCoverUrl(s && s.cover);
    if (c) return c;
  }
  return '';
}
