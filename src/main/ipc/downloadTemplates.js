/**
 * 下载路径模板 IPC
 *
 * 注册: get-download-templates / save-download-template /
 *       delete-download-template / set-active-template
 *
 * 模板格式: { artist } / { album } / { title } / { source } / { year }
 */

const { ipcMain } = require('electron');
const path = require('path');
const prefs = require('../../utils/prefs');

const TEMPLATE_KEY = 'downloadTemplates';
const ACTIVE_KEY = 'activeDownloadTemplate';

function register() {
  ipcMain.handle('get-download-templates', () => {
    const templates = prefs.get(TEMPLATE_KEY) || [];
    const active = prefs.get(ACTIVE_KEY) || null;
    return { templates, active };
  });

  ipcMain.handle('save-download-template', (_, template) => {
    if (!template || !template.name || !template.path) {
      return { success: false, error: '名称和路径不能为空' };
    }
    // M10: 校验路径在安全目录内
    const safePath = sanitizeDownloadPath(template.path.trim());
    if (!safePath) {
      return { success: false, error: '路径不在允许的下载目录内' };
    }
    template = { ...template, path: safePath };
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
      createdAt: now,
      updatedAt: now,
    };
    templates.unshift(newTpl);
    prefs.set(TEMPLATE_KEY, templates);
    return { success: true, template: newTpl };
  });

  ipcMain.handle('delete-download-template', (_, templateId) => {
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

  ipcMain.handle('set-active-template', (_, templateId) => {
    prefs.set(ACTIVE_KEY, templateId || null);
    return { success: true, active: templateId };
  });

  // 文件名模板预览：renderFileName 依赖 src/utils/naming，renderer 无法直接 require，
  // 预览必须在主进程算。顺带返回未知变量列表，设置页据此提示拼写错误。
  ipcMain.handle('preview-naming-template', (_, template) => {
    const naming = require('../../utils/naming');
    const src = typeof template === 'string' && template.trim() ? template : naming.DEFAULT_TEMPLATE;
    return {
      preview: naming.previewTemplate(src),
      unknown: naming.unknownPlaceholders(src),
    };
  });

  // 应用模板路径（替换变量）
  ipcMain.handle('apply-path-template', (_, { templateId, song }) => {
    const templates = prefs.get(TEMPLATE_KEY) || [];
    const tpl = templateId ? templates.find(t => t.id === templateId) : null;
    if (!tpl) return { path: null };

    const path = tpl.path
      .replace(/\{artist\}/gi, sanitizeFileName(song.artist || '未知艺术家'))
      .replace(/\{album\}/gi, sanitizeFileName(song.album || '未知专辑'))
      .replace(/\{title\}/gi, sanitizeFileName(song.title || '未知标题'))
      .replace(/\{source\}/gi, sanitizeFileName(song.source || ''))
      .replace(/\{year\}/gi, (song.year || '').toString().slice(0, 4))
      .replace(/\{track\}/gi, String(song.trackNumber || song.track || '').padStart(2, '0'));

    return { path, template: tpl };
  });
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80);
}

/**
 * M10: 校验路径在用户配置的下载目录内，防止路径穿越
 * 返回安全解析后的绝对路径；不在允许范围内则返回 null（拒绝）。
 */
function sanitizeDownloadPath(templatePath) {
  if (!templatePath || typeof templatePath !== 'string') return null;
  const raw = templatePath.trim();
  // 拒绝含协议处理器 / 明显 traversal 的输入（兜底，path.resolve 后还会再校验）
  if (/^(file|https?|data|javascript|ftp|smb|ms-|mailto):/i.test(raw)) return null;
  try {
    const saveDir = prefs.get('saveDir') || path.join(require('electron').app.getPath('home'), 'Music');
    const resolved = path.resolve(raw);
    const base = path.resolve(saveDir);
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
