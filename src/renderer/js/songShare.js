/**
 * 歌曲分享 —— 纯函数 + 剪贴板工具（node 可单测，无顶层 DOM 依赖）
 *
 * linkParser.js 会把平台页面链接解析成 {source,id}，这里做反向构造：
 * 由歌曲生成平台网页链接与「标题 - 歌手 + 链接」分享文案，
 * 配合右键菜单把听歌推荐发给朋友一步到位。未知平台退化为纯文本（不造假链接）。
 */

const URL_BUILDERS = {
  netease: id => `https://music.163.com/song?id=${encodeURIComponent(id)}`,
  qq: id => `https://y.qq.com/n/ryqq/songDetail/${encodeURIComponent(id)}`,
  kugou: id => `https://www.kugou.com/mixsong/${encodeURIComponent(id)}.html`,
  kuwo: id => `https://www.kuwo.cn/play_detail/${encodeURIComponent(id)}`,
  bilibili: id => `https://www.bilibili.com/video/${encodeURIComponent(id)}`,
};

/** 平台歌曲页链接；无 id / 未知平台返回 null */
function songPageUrl(song) {
  if (!song || typeof song !== 'object') return null;
  const build = URL_BUILDERS[song.source];
  const id = song.id == null ? '' : String(song.id).trim();
  if (!build || !id) return null;
  return build(id);
}

/** 「标题 - 歌手」+ 链接（有则附）；无标题返回空串 */
function songShareText(song) {
  if (!song || typeof song !== 'object') return '';
  const title = String(song.title || '').trim();
  if (!title) return '';
  const artist = String(song.artist || '').trim();
  const head = artist ? `${title} - ${artist}` : title;
  const url = songPageUrl(song);
  return url ? `${head}\n${url}` : head;
}

/**
 * 写剪贴板：优先异步 Clipboard API，被拒时退 execCommand。
 * @returns {Promise<boolean>} 是否成功
 */
async function copyText(text) {
  const t = String(text == null ? '' : text);
  if (!t) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (_e) { /* 权限被拒等，走回退 */ }
  try {
    if (typeof document === 'undefined') return false;
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_e) { return false; }
}

export { songPageUrl, songShareText, copyText };
