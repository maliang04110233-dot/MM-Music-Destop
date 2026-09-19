/**
 * 搜索关键词高亮 —— 把命中片段包进 <mark>，其余照常 HTML 转义
 *
 * 做法：在原文上按位置扫描匹配（大小写不敏感、按空白分词多词），
 * 逐段 escHtml 后只在命中段外套 <mark> —— 转义与高亮互不干扰，
 * 关键词里的正则元字符逐字符转义，用户输入不可能改变匹配语义。
 * 纯逻辑 export 供 node:test，顶层不触碰 document。
 */

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

/** 正则元字符逐字符转义（ASCII 字母与汉字视作安全字符直留） */
function escRe(s) {
  return s.split('').map(c => (/^[a-zA-Z0-9\u4e00-\u9fff]$/).test(c) ? c : '\\' + c).join('');
}

/**
 * text 中命中 term 任一空白分词的位置包 <mark>；term 为空时等价 escHtml(text)。
 * 返回值为可直接 innerHTML 的 HTML 片段。
 */
export function markTerm(text, term) {
  const t = String(text == null ? '' : text);
  const tokens = String(term == null ? '' : term).trim().split(/\s+/).filter(Boolean);
  if (!t || !tokens.length) return escHtml(t);
  let re;
  try {
    re = new RegExp(tokens.map(escRe).join('|'), 'gi');
  } catch (_e) {
    return escHtml(t);
  }
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(t)) !== null) {
    if (m[0]) {
      out += escHtml(t.slice(last, m.index)) + '<mark>' + escHtml(m[0]) + '</mark>';
      last = m.index + m[0].length;
    }
    if (re.lastIndex === m.index) re.lastIndex++; // 防空匹配死循环兜底
  }
  return out + escHtml(t.slice(last));
}
