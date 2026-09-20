/**
 * 列表骨架屏生成 —— 全站唯一实现（设计验收 qa-3 回写）
 *
 * 为什么收在一处：骨架的价值全在「形状与真实行一致」——高度对不上就等于白占位，
 * 数据落地的瞬间页面照样跳。各视图自己抄一份行标记，迟早和真实行的改版脱钩，
 * 所以这里只留一份标记，形状差异用修饰类表达（尺寸见 content.css 的 --skel-thumb）。
 *
 * 形状清单（括号内是真实行的封面尺寸，CSS 钉测会逐条比对）：
 *   list   首页榜单行（36，基准形状，无修饰类）
 *   song   搜索结果 / 歌单 / 专辑的曲目行（44）
 *   album  专辑行（56）
 *   singer 歌手行（48，圆头像）
 *   local  本地曲库行（40）
 *   grid   首页歌单九宫格（方块卡片）
 *
 * 本模块只吐字符串：不引依赖、不读全局，所以 node 侧可直接单测。
 * caption 只允许传开发者写死的文案（如「搜索中...」），不接受任何外部输入。
 */

/** 整页列表类容器默认占位行数：约等于首屏可见行数，多了是浪费、少了仍会跳 */
export const SKEL_ROWS = 10;

/** 需要自带形状修饰类的 kind；其余（list）走基准形状，保持首页观感不变 */
const SHAPED = { song: 1, album: 1, singer: 1, local: 1 };

/**
 * @param {'list'|'song'|'album'|'singer'|'local'|'grid'} kind 形状
 * @param {number} [count] 行数 / 卡片数
 * @param {string} [caption] 状态文字（写死文案，不接外部输入）
 * @returns {string}
 */
export function skeletonHtml(kind, count = SKEL_ROWS, caption = '') {
  const cap = caption ? `<div class="skel-cap">${caption}</div>` : '';
  if (count <= 0) return '';
  if (kind === 'grid') return cap + '<div class="skel-card"></div>'.repeat(count);
  // 未知形状退化成基准行：拼错一个字符串的代价应该是"样式略偏"，不是白屏
  const cls = SHAPED[kind] ? `skel-row skel-row--${kind}` : 'skel-row';
  const row = `<div class="${cls}"><div class="skel-avatar"></div>`
    + '<div class="skel-lines"><div class="skel-line w60"></div>'
    + '<div class="skel-line w40"></div></div></div>';
  return cap + row.repeat(count);
}
