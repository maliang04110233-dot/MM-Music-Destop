/**
 * 首页榜单过滤（纯函数，node 可测）
 *
 * list 分区必须返回 [{s, i}] 而不是过滤后的歌曲数组：
 * 榜单行的播放/下载/右键全部按「原始数组下标」回查 _getSection(sec)[idx]，
 * 过滤若改变下标语义，点第 1 行会播成别的歌。
 */
function filterHomeSection(kind, data, kw) {
  const key = String(kw || '').trim().toLowerCase();
  const items = Array.isArray(data) ? data : [];
  if (!key) {
    return kind === 'grid'
      ? { items }
      : { pairs: items.map((s, i) => ({ s, i })) };
  }
  if (kind === 'grid') {
    return { items: items.filter(p => String(p.name || '').toLowerCase().includes(key)) };
  }
  const pairs = [];
  items.forEach((s, i) => {
    const hay = `${s.title || ''} ${s.artist || ''}`.toLowerCase();
    if (hay.includes(key)) pairs.push({ s, i });
  });
  return { pairs };
}

export { filterHomeSection };
