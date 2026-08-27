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

export async function applyTranslations() {
  const code = await api.getPref('language') || 'zh';
  loadLanguage(code);
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      el.placeholder = val;
    } else {
      el.textContent = val;
    }
  });
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
window.t = t;
window.translateMessage = translateMessage;
