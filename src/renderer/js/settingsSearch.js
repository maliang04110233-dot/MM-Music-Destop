/**
 * 设置页搜索 —— 纯函数（node 可单测，无 DOM 依赖）
 *
 * 设置面板 6 个 tab、上百个条目，找一个开关全靠肉眼翻。
 * 这里只做「输入词 → 每个块显不显示」的计划：多词空格分词 AND 匹配，
 * 命中条目所在节整节保留；节标题命中则节内条目全显示（标题即整节语义）。
 * 接线层把 DOM 拍平成 pages/sections/blocks 传进来即可，不碰 DOM。
 */

/** 分词：trim + 小写 + 空白切分；空输入返回 null（= 退出过滤） */
function sTokens(term) {
  const t = String(term == null ? '' : term).trim().toLowerCase();
  return t ? t.split(/\s+/).filter(Boolean) : null;
}

/** 块文本是否含全部 token（AND） */
function sMatch(text, tokens) {
  const hay = String(text == null ? '' : text).toLowerCase();
  return tokens.every((tk) => hay.includes(tk));
}

/**
 * 生成过滤计划。
 * @param pages 每页 = sections 数组；section = {title: string|null,
 *   blocks: [{kind:'row'|'other', text:string}]}。'other' 是跟随节的容器/杂项，
 *   自身 text 可为空串（空 text 永不命中，只随节显隐）
 * @param term 搜索词
 * @returns {null | {pages: Array<{sections: Array<{keep:boolean, visible:boolean[]}>, hits:number}>, total:number}}
 *   term 为空返回 null；hits 只数可见的 row 块（纯 other 命中的节记 1，徽标不为 0 假象）
 */
function planSettingsSearch(pages, term) {
  const tokens = sTokens(term);
  if (!tokens) return null;
  let total = 0;
  const outPages = (Array.isArray(pages) ? pages : []).map((sections) => {
    const secPlans = (Array.isArray(sections) ? sections : []).map((sec) => {
      const blocks = (sec && Array.isArray(sec.blocks)) ? sec.blocks : [];
      const titleHit = sMatch(sec && sec.title, tokens);
      const selfHits = blocks.map((b) => sMatch(b && b.text, tokens));
      const keep = titleHit || selfHits.some(Boolean);
      const visible = blocks.map((b, i) => keep && (titleHit || selfHits[i] || !b || b.kind !== 'row'));
      return { keep, visible };
    });
    let hits = 0;
    secPlans.forEach((sp, si) => {
      if (!sp.keep) return;
      const blocks = sections[si].blocks || [];
      sp.visible.forEach((v, bi) => { if (v && blocks[bi] && blocks[bi].kind === 'row') hits++; });
    });
    if (!hits && secPlans.some((sp) => sp.keep)) hits = 1;
    total += hits;
    return { sections: secPlans, hits };
  });
  return { pages: outPages, total };
}

export { sTokens, sMatch, planSettingsSearch };
