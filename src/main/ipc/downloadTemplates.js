/**
 * 下载路径模板 IPC
 *
 * 注册: get-download-templates / save-download-template /
 *       delete-download-template / set-active-template
 *
 * 模板存两份路径：path 是校验过的绝对路径（展示用），subpath 是「相对下载目录」
 * 的片段（真正参与落盘，可由 {artist} {album} {title} {source} {year} {track}
 * 等变量组成）。目录怎么算的见 utils/downloadPath，队列在哪用它见 main/downloadQueue。
 */

const { handle } = require('./register');
const path = require('path');
const prefs = require('../../utils/prefs');
const { defaultDownloadDir } = require('../../shared/downloadDefaults');
const { subpathFromAbsolute } = require('../../utils/downloadPath');

const TEMPLATE_KEY = 'downloadTemplates';
const ACTIVE_KEY = 'activeDownloadTemplate';

/**
 * 当前下载根目录 —— 校验模板路径与推导 subpath 必须用同一个根，
 * 否则「校验说你在目录内、推导说你在目录外」，模板会被静默当成不可用。
 */
function currentSaveDir() {
  // 兜底必须与真实落盘/展示默认目录同源，否则未设 saveDir 时
  // 默认目录下的模板路径会被误判越界（曾经的 home/Music 是第三套默认）
  return prefs.get('saveDir')
    || defaultDownloadDir(require('electron').app.getPath('music'));
}

function register() {
  handle('get-download-templates', () => {
    const templates = prefs.get(TEMPLATE_KEY) || [];
    const active = prefs.get(ACTIVE_KEY) || null;
    return { templates, active };
  });

  handle('save-download-template', (_, template) => {
    if (!template || !template.name || !template.path) {
      return { success: false, error: '名称和路径不能为空' };
    }
    // M10: 校验路径在安全目录内
    const root = currentSaveDir();
    const safePath = sanitizeDownloadPath(template.path.trim(), root);
    if (!safePath) {
      return { success: false, error: '路径不在允许的下载目录内' };
    }
    // 存下「相对下载目录」的片段：下载时按它建子目录（增量169 之前模板只存不用，
    // 设置页的「使用中」是句空话）。相对而不是绝对，用户换下载目录时模板才跟得上。
    const subpath = subpathFromAbsolute(safePath, root);
    template = { ...template, path: safePath, subpath: subpath === null ? '' : subpath };
    const templates = prefs.get(TEMPLATE_KEY) || [];
    const now = Date.now();

    if (template.id) {
      const idx = templates.findIndex(t => t.id === template.id);
      if (idx >= 0) {
        templates[idx] = { ...templates[idx], ...template, updatedAt: now };
        prefs.set(TEMPLATE_KEY, templates);
        return { success: true, template: templates[idx] };
      }
    }

    const newTpl = {
      id: 'tpl_' + now + '_' + Math.random().toString(36).slice(2, 6),
      name: template.name.trim(),
      path: safePath,
      subpath: template.subpath,
      createdAt: now,
      updatedAt: now,
    };
    templates.unshift(newTpl);
    prefs.set(TEMPLATE_KEY, templates);
    return { success: true, template: newTpl };
  });

  handle('delete-download-template', (_, templateId) => {
    if (!templateId) return { success: false, error: '缺少ID' };
    const templates = prefs.get(TEMPLATE_KEY) || [];
    const filtered = templates.filter(t => t.id !== templateId);
    if (filtered.length === templates.length) return { success: false, error: '模板不存在' };
    prefs.set(TEMPLATE_KEY, filtered);

    // 如果删除的是当前激活的，清除激活状态
    if (prefs.get(ACTIVE_KEY) === templateId) {
      prefs.set(ACTIVE_KEY, null);
    }
    return { success: true };
  });

  handle('set-active-template', (_, templateId) => {
    prefs.set(ACTIVE_KEY, templateId || null);
    return { success: true, active: templateId };
  });

  // 文件名模板预览：renderFileName 依赖 src/utils/naming，renderer 无法直接 require，
  // 预览必须在主进程算。顺带返回未知变量列表，设置页据此提示拼写错误。
  handle('preview-naming-template', (_, template) => {
    const naming = require('../../utils/naming');
    const src = typeof template === 'string' && template.trim() ? template : naming.DEFAULT_TEMPLATE;
    return {
      preview: naming.previewTemplate(src),
      unknown: naming.unknownPlaceholders(src),
    };
  });

  // （原 'apply-path-template' handler 已删除：不在 preload 白名单，渲染层
  //   零引用，属死代码 —— 队列下载的路径生成走 downloadQueue + naming）
}

/**
 * M10: 校验路径在用户配置的下载目录内，防止路径穿越
 * 返回安全解析后的绝对路径；不在允许范围内则返回 null（拒绝）。
 * @param {string} templatePath 用户写的模板路径（可含 {artist} 之类占位符）
 * @param {string} root 当前下载根目录（由 currentSaveDir() 取，与 subpath 推导同源）
 */
function sanitizeDownloadPath(templatePath, root) {
  if (!templatePath || typeof templatePath !== 'string') return null;
  const raw = templatePath.trim();
  // 拒绝含协议处理器 / 明显 traversal 的输入（兜底，path.resolve 后还会再校验）
  if (/^(file|https?|data|javascript|ftp|smb|ms-|mailto):/i.test(raw)) return null;
  try {
    const base = path.resolve(root);
    // 相对写法一律按「相对下载目录」解释（设置页的提示就是这个口径）。
    // 早先走 path.resolve(raw) 是相对进程 CWD —— 打包后那是程序安装目录，
    // 用户照提示写 {artist}/{album} 会被判「不在允许的下载目录内」。
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
    // 允许 saveDir 本身或其子目录
    if (resolved === base || resolved.startsWith(base + path.sep)) {
      return resolved;
    }
  } catch (_) {
    // 路径校验失败，拒绝
  }
  // 不在允许的下载目录内 → 拒绝（不再回退放行原始输入）
  return null;
}

module.exports = { register };
