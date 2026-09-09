/**
 * 下载文件命名模板
 *
 * 支持变量：
 *   {title}   - 歌曲标题
 *   {artist}  - 艺术家
 *   {album}   - 专辑名
 *   {source}  - 平台来源 (netease/qq/bilibili/kugou)
 *   {id}      - 歌曲 ID
 *
 * 示例：
 *   "{artist} - {title}"           → "周杰伦 - 晴天.mp3"
 *   "{album}/{artist} - {title}"   → "叶惠美/周杰伦 - 晴天.mp3"
 *   "{source}/{artist}/{title}"    → "netease/周杰伦/晴天.mp3"
 *
 * 默认模板："{artist} - {title}"
 */

const DEFAULT_TEMPLATE = '{artist} - {title}';

/**
 * 根据模板生成文件名
 * @param {string} template - 模板字符串
 * @param {object} song - 歌曲信息 { title, artist, album, source, id }
 * @param {string} ext - 文件扩展名（不含点）
 * @returns {string} 完整文件路径（不含目录）
 */
function renderFileName(template, song, ext) {
  const safe = (v) => (v || '未知').replace(/[<>:"/\\|?*]/g, '_').trim();
  const result = (template || DEFAULT_TEMPLATE)
    .replace(/\{title\}/g, safe(song.title))
    .replace(/\{artist\}/g, safe(song.artist))
    .replace(/\{album\}/g, safe(song.album))
    .replace(/\{source\}/g, safe(song.source))
    .replace(/\{id\}/g, safe(song.id));

  // 清理路径分隔符导致的子目录（防止用户用模板逃逸到其他目录）
  const cleaned = result.replace(/\.\./g, '_').replace(/^[/\\]+/, '');

  // 确保有扩展名
  return cleaned + '.' + (ext || 'mp3').replace(/[^a-zA-Z0-9]/g, '').substring(0, 10);
}

/**
 * 预览模板效果
 * @param {string} template
 * @returns {string} 示例文件名
 */
function previewTemplate(template) {
  return renderFileName(template, {
    title: '晴天',
    artist: '周杰伦',
    album: '叶惠美',
    source: 'netease',
    id: '12345',
  }, 'mp3');
}

module.exports = { renderFileName, previewTemplate, DEFAULT_TEMPLATE };
