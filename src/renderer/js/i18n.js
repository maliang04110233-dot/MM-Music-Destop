/**
 * MusicDL i18n 国际化 — ES Module
 */
import zh from './lang/zh.json';
import en from './lang/en.json';

const LANGUAGES = { zh, en };
let _lang = 'zh';

export function loadLanguage(code) {
  if (!LANGUAGES[code]) code = 'zh';
  _lang = code;
}

export function getLang() {
  return _lang;
}

export function t(key, params = {}) {
  const msg = LANGUAGES[_lang]?.[key] || key;
  let result = msg;
  for (const [k, v] of Object.entries(params)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return result;
}

/**
 * 应用翻译。
 *
 * @param {string} [code] 指定语言；省略时从 pref 读取（首次启动路径）。
 *
 * ⚠️ 2026-09-17 修复：原实现**无条件**从 pref 回读并 loadLanguage。
 *    于是 setLanguage('en') → setPref('en') → applyTranslations() 时若 pref 读回
 *    null/旧值，就把刚设好的语言**又覆盖回去**（实测在无头台下切 en 无效、仍是 zh）。
 *    "显式设定"与"从存储恢复"必须是两条路径，不能共用一次回读。
 */
export async function applyTranslations(code) {
  if (code) {
    loadLanguage(code);
  } else {
    try {
      loadLanguage((await api.getPref('language')) || 'zh');
    } catch (_e) {
      loadLanguage('zh'); // pref 不可用时退回中文，而不是抛错中断整个启动
    }
  }
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = val;
    } else if (el.children.length === 0) {
      // ⚠️ 只对**无子元素**的节点写 textContent。
      // textContent 会摧毁子元素：设置页 3 个 Cookie 提示框内嵌 <code>，
      // 直接赋值会把它们抹平成纯文本（实测 3 处）。跳过是零副作用的保守解。
      el.textContent = val;
    }
  });
}

/**
 * 切换语言并**持久化**。
 * 原先设置页 onchange 只 loadLanguage + applyTranslations，从不写 pref，
 * 重启即回退 —— 语言选择等于没记住。
 * @param {string} code
 */
export async function setLanguage(code) {
  loadLanguage(code);
  try {
    if (api && api.setPref) await api.setPref('language', code);
  } catch (_e) { /* 持久化失败不影响本次切换 */ }
  await applyTranslations(code);
}

/**
 * 翻译中文文本 → 当前语言
 * 优先精确匹配，再尝试模糊匹配
 * 用于 showToast 等动态消息的自动翻译
 */
export function translateMessage(msg) {
  if (_lang === 'zh') return msg;
  // 精确匹配
  if (LANGUAGES[_lang]?.[msg]) return LANGUAGES[_lang][msg];
  // 查找包含该消息的 key
  for (const [k, v] of Object.entries(LANGUAGES.zh || {})) {
    if (v === msg || msg.startsWith(v)) {
      const trans = LANGUAGES[_lang]?.[k];
      if (trans) return trans;
    }
  }
  return msg;
}

// 全局导出
//
// ⚠️ 2026-09-17 修复：`window.i18n` 此前**从未被赋值**。
//    而 app.js 的启动语言恢复与 index.html 设置页的语言下拉都写作
//    `window.i18n && window.i18n.xxx()` —— 恒为假 ⇒ i18n 运行时整条断链，
//    界面永远显示中文，切语言无任何效果。此处补齐挂载点。
window.i18n = { loadLanguage, getLang, t, applyTranslations, setLanguage, translateMessage };
window.t = t;
window.translateMessage = translateMessage;
