/**
 * MusicDL 设置 / Cookie 管理视图
 */

/* @module */
import { logger } from '../logger.js';
// ── 平台配置 ──────────────────────────────────────────
const PLATFORMS = [
  { id: 'netease', name: '网易云音乐', shortName: '网易云', loginUrl: 'https://music.163.com' },
  { id: 'qq', name: 'QQ 音乐', shortName: 'QQ音乐', loginUrl: 'https://y.qq.com' },
  { id: 'bilibili', name: '哔哩哔哩', shortName: 'B站', loginUrl: 'https://www.bilibili.com' },
];

// ── Cookie 字段分析配置 ──────────────────────────────
const COOKIE_FIELDS = {
  netease: [
    { key: 'MUSIC_U', label: '登录凭证', required: true, tip: '请用 Network（网络）方式获取完整 Cookie' },
    { key: '__csrf', label: '防跨站', required: false },
  ],
  qq: [
    { key: 'uin', label: 'QQ号', required: true, tip: '缺少 uin 字段' },
    { key: 'qm_keyst', label: '登录密钥', required: false },
  ],
  bilibili: [
    { key: 'SESSDATA', label: '登录凭证', required: true, tip: '这是 HttpOnly Cookie' },
    { key: 'bili_jct', label: 'CSRF令牌', required: false },
    { key: 'buvid3', label: '设备ID', required: false },
  ],
};

// ── DOM 缓存 ──────────────────────────────────────────
const _settingsDom = {
  overlay: null,
  cacheSize: null,
  // 平台 DOM 缓存：{ platformId: { statusEl, dotEl, loginBtn, textarea, card, verifyEl } }
  platforms: {},
};

function _cacheSettingsDom() {
  _settingsDom.overlay = document.getElementById('settingsOverlay');
  _settingsDom.cacheSize = document.getElementById('cacheSize');
  // 缓存每个平台的 DOM 元素
  PLATFORMS.forEach(p => {
    _settingsDom.platforms[p.id] = {
      statusEl: document.getElementById(p.id + 'StatusText'),
      dotEl: document.getElementById(p.id + 'Dot'),
      loginBtn: document.getElementById(p.id + 'LoginBtn'),
      textarea: document.getElementById(p.id + 'Cookie'),
      card: document.querySelector(`.account-card[data-platform="${p.id}"]`),
      verifyEl: document.getElementById(p.id + 'VerifyResult'),
      analyzeEl: document.getElementById(p.id + 'Analyze'),
    };
  });
}

// ── 设置面板切换 ──────────────────────────────────────
function switchSettingsTab(tab, btn) {
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.settings-page').forEach(el => el.classList.add('hidden'));
  const page = document.getElementById('settingsPage' + tab.charAt(0).toUpperCase() + tab.slice(1));
  if (page) page.classList.remove('hidden');
}

function openSettings() {
  if (_settingsDom.overlay) _settingsDom.overlay.classList.remove('hidden');
  const firstNav = document.querySelector('.settings-nav-item');
  if (firstNav) switchSettingsTab('accounts', firstNav);
  // 并行加载所有设置
  Promise.all([
    ...PLATFORMS.map(p => loadAccountCardStatus(p.id)),
    loadGeneralSettings(),
    loadQualityBySource(),
    updateCacheSize(),
    loadDownloadTemplates(),
    loadSourceHealth(),
  ]);
}

function closeSettings() {
  if (_settingsDom.overlay) _settingsDom.overlay.classList.add('hidden');
}

function closeSettingsOnBg(e) {
  if (e.target === _settingsDom.overlay) closeSettings();
}

// ── 账号状态 ──────────────────────────────────────────
async function loadAccountCardStatus(platform) {
  const dom = _settingsDom.platforms[platform];
  if (!dom || !dom.card) return;

  let cookie = '';
  try {
    const all = await api.getCookies();
    cookie = all[platform] || '';
  } catch (e) {
    logger.warn('[loadAccountCardStatus] 读 cookies 失败:', e.message);
  }
  if (dom.textarea) dom.textarea.value = cookie || '';

  const isLoggedIn = cookie && cookie.length > 0;
  if (dom.statusEl) {
    dom.statusEl.textContent = isLoggedIn ? '已登录' : '未登录';
    dom.statusEl.className = 'account-status' + (isLoggedIn ? ' ok' : '');
  }
  if (dom.dotEl) {
    dom.dotEl.className = 'account-dot' + (isLoggedIn ? ' ok' : '');
  }
  dom.card.classList.toggle('is-login', isLoggedIn);
  dom.card.classList.remove('is-error');
  if (dom.loginBtn) {
    dom.loginBtn.textContent = isLoggedIn ? '🔄 重新登录' : '🔑 一键登录';
  }
}

async function loadCookieStatus() {
  try {
    const cookies = await api.getCookies();
    PLATFORMS.forEach(p => {
      const hasVal = cookies[p.id] && cookies[p.id].length > 0;
      const statusEl = document.getElementById(p.id + 'Status');
      if (statusEl) {
        statusEl.textContent = hasVal ? '已设置' : '未设置';
        statusEl.className = 'cookie-status' + (hasVal ? ' ok' : ' none');
      }
      const dom = _settingsDom.platforms[p.id];
      if (dom?.textarea && hasVal) {
        dom.textarea.placeholder = '已保存（粘贴新值覆盖）';
      }
    });
    updateSidebarPlatformStatus(cookies);
  } catch (e) {
    logger.error('加载 Cookie 状态失败:', e);
  }
}

function updateSidebarPlatformStatus(cookies) {
  const sidebarMap = {
    netease: { dot: 'dotNetease', label: 'labelNetease' },
    qq:      { dot: 'dotQQ',      label: 'labelQQ' },
    bilibili:{ dot: 'dotBili',    label: 'labelBili' },
  };
  Object.entries(sidebarMap).forEach(([platform, ids]) => {
    const dotEl = document.getElementById(ids.dot);
    const labelEl = document.getElementById(ids.label);
    if (!dotEl || !labelEl) return;
    const hasCookie = cookies && cookies[platform] && cookies[platform].length > 0;
    dotEl.className = 'platform-dot' + (hasCookie ? ' cookie' : '');
    labelEl.textContent = hasCookie ? '已登录' : '未登录';
    labelEl.style.color = hasCookie ? 'var(--gold)' : 'var(--text-muted)';
  });
}

// ── 源可用性探针（P2）─────────────────────────────────
// 平台名统一走 utils.js 的 platformName()（单一来源）。原先此处第二份 SOURCE_NAMES 拷贝。

function renderSourceHealth(health, probes) {
  const list = document.getElementById('sourceHealthList');
  if (!list) return;
  const sources = Object.keys(health || {});
  if (!sources.length) { list.innerHTML = ''; return; }
  const probeMap = {};
  for (const p of probes || []) probeMap[p.source] = p;

  // 改为「名称 + 进度条 + 数值」三列：原先只有一行文字，中间空 300px，
  // 41% 和 98% 扫视起来毫无差别。三档语义用 class 承载（token 上色，跨主题协调），
  // 不再硬编码 #ff7676 这类色值。
  list.innerHTML = sources.map(s => {
    const h = health[s];
    const probe = probeMap[s];
    const name = platformName(s);

    // 一次性探测结果优先于历史成功率
    if (probe) {
      const ok = !!probe.ok;
      const text = ok ? '可用' : (probe.stage === 'getUrl' ? '取流失败' : '搜索不可达');
      const tone = ok ? 'is-ok' : 'is-bad';
      return `<div class="source-health-row">
        <span class="source-health-name">${name}</span>
        <span class="source-health-bar"><i class="${tone}" style="width:100%"></i></span>
        <span class="source-health-val ${tone}">${text}</span>
      </div>`;
    }

    if (h && h.score != null && h.samples > 0) {
      const pct = Math.round(h.score * 100);
      // ≥60 健康 / ≥30 警告 / 否则不可用
      const tone = pct >= 60 ? 'is-ok' : (pct >= 30 ? 'is-warn' : 'is-bad');
      return `<div class="source-health-row">
        <span class="source-health-name">${name}</span>
        <span class="source-health-bar"><i class="${tone}" style="width:${pct}%"></i></span>
        <span class="source-health-val ${tone}">${pct}%<em>${h.samples} 次</em></span>
      </div>`;
    }

    return `<div class="source-health-row is-empty">
      <span class="source-health-name">${name}</span>
      <span class="source-health-bar"><i></i></span>
      <span class="source-health-val">暂无数据</span>
    </div>`;
  }).join('');
}

async function loadSourceHealth() {
  try {
    if (typeof api.getSourceHealth !== 'function') return;
    const health = await api.getSourceHealth();
    renderSourceHealth(health, null);
  } catch (e) {
    logger.error('加载源健康度失败:', e);
  }
}

async function probeSourcesUI(btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ 探测中…'; }
  try {
    if (typeof api.probeSources !== 'function') { showToast('当前版本不支持探测', 'error'); return; }
    const r = await api.probeSources();
    renderSourceHealth(r.health, r.probes);
    const okCount = (r.probes || []).filter(p => p.ok).length;
    showToast(`探测完成：${okCount}/${r.probes.length} 个源可用`, okCount > 0 ? 'success' : 'warn');
  } catch (e) {
    showToast('探测失败: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

// ── Cookie 操作 ───────────────────────────────────────
async function saveCookie(platform) {
  const dom = _settingsDom.platforms[platform];
  if (!dom?.textarea) return;
  const val = dom.textarea.value.trim();
  if (!val) { showToast('请先填入 Cookie', 'error'); return; }
  try {
    const result = await api.saveCookie(platform, val);
    if (result.saved) {
      showToast('Cookie 已保存', 'success');
      await loadCookieStatus();
      if (result.verify) showVerifyResult(platform, result.verify);
      dom.textarea.value = '';
    }
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

async function clearCookie(platform) {
  try {
    await api.clearCookie(platform);
  } catch (e) {
    showToast('清除失败：' + e.message, 'error');
    return;
  }
  const dom = _settingsDom.platforms[platform];
  if (dom?.textarea) dom.textarea.value = '';
  const statusEl = document.getElementById(platform + 'Status');
  if (statusEl) {
    statusEl.textContent = '未设置';
    statusEl.className = 'cookie-status none';
  }
  clearVerifyResult(platform);
  showToast('Cookie 已清除', 'info');
}

async function verifyCookieUI(platform) {
  const dom = _settingsDom.platforms[platform];
  if (!dom?.textarea) return;
  const val = dom.textarea.value.trim();
  if (!val) { showToast('请先在输入框中填入 Cookie', 'error'); return; }
  if (!dom.verifyEl) return;
  dom.verifyEl.textContent = '验证中...';
  dom.verifyEl.className = 'cookie-verify-result ok';
  try {
    const result = await api.verifyCookie(platform, val);
    showVerifyResult(platform, result);
  } catch (e) {
    dom.verifyEl.textContent = '验证出错: ' + e.message;
    dom.verifyEl.className = 'cookie-verify-result err';
  }
}

function showVerifyResult(platform, result) {
  const dom = _settingsDom.platforms[platform];
  if (!dom?.verifyEl) return;
  const el = dom.verifyEl;
  el.className = 'cookie-verify-result';
  el.style.whiteSpace = 'pre-wrap';
  el.style.textAlign = 'left';
  el.style.lineHeight = '1.6';

  if (result.valid) {
    let line = `✅ 验证成功！用户：${result.nickname || '未知'}`;
    if (result.type === 'wechat-with-qq') line += '\n⚠️ 检测到微信登录，VIP 歌曲可能仍无法下载（VIP 绑定在微信侧）';
    if (result.message) line += '\n' + result.message;
    el.textContent = line;
    el.className = 'cookie-verify-result ok';
    const statusEl = document.getElementById(platform + 'Status');
    if (statusEl) {
      statusEl.textContent = '已登录 ✓';
      statusEl.className = 'cookie-status ok';
    }
  } else {
    let line = `❌ 验证失败：${result.reason || 'Cookie 无效或已过期'}`;
    if (result.missing && result.missing.length) line += '\n\n🔍 缺失字段：' + result.missing.join(', ');
    if (result.suggestions && result.suggestions.length) line += '\n\n💡 建议：\n' + result.suggestions.map(s => '  ' + s).join('\n');
    el.textContent = line;
    el.className = 'cookie-verify-result err';
  }
}

function clearVerifyResult(platform) {
  const dom = _settingsDom.platforms[platform];
  if (!dom?.verifyEl) return;
  dom.verifyEl.textContent = '';
  dom.verifyEl.className = 'cookie-verify-result';
}

// ── Cookie 分析（配置驱动）────────────────────────────
function analyzeCookieUI(platform) {
  const dom = _settingsDom.platforms[platform];
  if (!dom?.textarea || !dom?.analyzeEl) return;
  const cookie = dom.textarea.value.trim();
  const el = dom.analyzeEl;

  if (!cookie) {
    el.innerHTML = '<span class="analyze-miss">❌ Cookie 为空</span>';
    el.className = 'cookie-analyze show';
    return;
  }

  const fields = parseCookieFields(cookie);
  const config = COOKIE_FIELDS[platform] || [];
  let html = '';

  // 检查每个配置的字段
  config.forEach(c => {
    const found = fields.some(f => f.key === c.key);
    const cls = found ? 'analyze-ok' : 'analyze-miss';
    const icon = found ? '✓' : '✗';
    const status = found ? '已找到' : (c.required ? '缺失（必须）' : '缺失');
    html += `<div class="analyze-row"><span class="${cls}">${icon} ${c.key}</span><span>${c.label} ${status}</span></div>`;
  });

  // 显示缺失必填字段的提示
  const missingRequired = config.filter(c => c.required && !fields.some(f => f.key === c.key));
  if (missingRequired.length) {
    missingRequired.forEach(c => {
      if (c.tip) html += `<div class="analyze-tip">⚠️ ${c.tip}</div>`;
    });
  }

  html += `<div class="analyze-tip" style="margin-top:6px">共解析 ${fields.length} 个字段：${fields.map(f => f.key).join(', ')}</div>`;
  el.innerHTML = html;
  el.className = 'cookie-analyze show';
}

// ── 辅助工具 ──────────────────────────────────────────
function openLoginPage(platformId) {
  const platform = PLATFORMS.find(p => p.id === platformId);
  if (!platform) return;
  api.openExternal(platform.loginUrl);
  showToast('已在浏览器中打开 ' + platform.loginUrl + '，请登录后获取 Cookie', 'info');
}

async function openLoginWindowUI(platformId, btn) {
  if (!btn) btn = event.target;
  const platform = PLATFORMS.find(p => p.id === platformId);
  const name = platform?.shortName || platformId;
  const originalText = btn ? btn.textContent : '🔑 一键登录';

  if (btn) { btn.disabled = true; btn.textContent = '🔄 打开登录窗口...'; }
  showToast(`正在打开 ${name} 登录窗口...`, 'info');

  try {
    const result = await api.openLoginWindow(platformId);
    if (result.success) {
      showToast(`✅ ${name} 登录成功！Cookie 已自动保存`, 'success');
      const dom = _settingsDom.platforms[platformId];
      if (dom?.textarea) dom.textarea.value = result.cookie;
      if (result.verify) showVerifyResult(platformId, result.verify);
      await loadCookieStatus();
    } else if (result.cancelled) {
      showToast('已取消登录', 'info');
    } else {
      showToast('登录失败: ' + (result.error || '未知错误'), 'error');
    }
  } catch (e) {
    showToast('登录失败: ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalText; }
  }
}

// ── 通用设置加载 / 保存 ─────────────────────────────
const GENERAL_PREFS = {
  quality:       { key: 'quality',       default: 'standard',   el: 'settingQuality' },
  concurrency:   { key: 'concurrency',   default: 3,             el: 'settingConcurrency' },
  speedLimit:    { key: 'speedLimit',    default: 0,             el: 'settingSpeedLimit' },
  filenameTmpl:  { key: 'namingTemplate',  default: '{artist} - {title}', el: 'settingFilenameTmpl' },
  autoLyric:     { key: 'autoLyric',     default: true,          el: 'settingAutoLyric' },
  autoCover:     { key: 'autoCover',     default: true,          el: 'settingAutoCover' },
  notifications: { key: 'notifications',  default: true,          el: 'settingNotifications' },
  playProgressMemory: { key: 'playProgressMemory', default: true, el: 'settingPlayProgressMemory' },
  globalShortcuts: { key: 'globalShortcuts', default: true, el: 'settingGlobalShortcuts' },
  theme:         { key: 'theme',         default: 'default',     el: 'settingTheme' },
  lyricFontSize: { key: 'lyricFontSize', default: 18,            el: 'settingLyricFontSize' },
  lyricOffset:   { key: 'lyricOffset',   default: 0,             el: 'settingLyricOffset' },
};

// 命名模板实时预览：renderFileName 跑在主进程（renderer 拿不到 src/utils），
// 预览值必须走 IPC 取。250ms 防抖，避免每次击键都跨进程请求。
let filenameTmplPreviewTimer = null;
function updateFilenameTmplPreview() {
  const input = document.getElementById('settingFilenameTmpl');
  const out = document.getElementById('filenameTmplPreview');
  const warn = document.getElementById('filenameTmplWarn');
  if (!input || !out) return;
  clearTimeout(filenameTmplPreviewTimer);
  filenameTmplPreviewTimer = setTimeout(async () => {
    try {
      const r = await api.previewNamingTemplate(input.value);
      if (!r) return;
      out.textContent = r.preview || '—';
      if (warn) {
        warn.textContent = (r.unknown && r.unknown.length)
          ? ('未知变量: ' + r.unknown.map(v => '{' + v + '}').join(' '))
          : '';
      }
    } catch (_e) {
      // 预览失败不该打断设置页：静默清空告警即可
      if (warn) warn.textContent = '';
    }
  }, 250);
}

// ── 分平台音质 ─────────────────────────────────────────
// 默认音质（settingQuality）是兜底；这里为单个平台指定档位。
// 覆盖表只存有自定义的平台，其余平台走默认值 —— 新增平台自动继承默认，无需迁移。
let _qualityBySourceTimer = null;

/** 平台 id 清单：主进程下发优先，未就绪时回落到内置兜底表 */
function qualityPlatformIds() {
  const ids = getPlatforms().map(x => x && x.id).filter(Boolean);
  return ids.length ? ids : fallbackPlatformIds();
}

function _qualitySelectOptions(selected) {
  let opts = '<option value="">' + esc('跟随默认') + '</option>';
  for (const o of QualityOptions) {
    opts += '<option value="' + escAttr(o.value) + '"' +
      (selected === o.value ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }
  return opts;
}

async function loadQualityBySource() {
  let map = null;
  try { map = await api.getPref('qualityBySource'); }
  catch (e) { logger.warn('读取分平台音质失败:', e.message); }
  setState('qualityBySource', (map && typeof map === 'object' && !Array.isArray(map)) ? map : {});
  renderQualityBySource();
}

function renderQualityBySource() {
  const el = document.getElementById('qualityBySourceList');
  if (!el) return;
  const map = getQualityBySource();
  el.innerHTML = qualityPlatformIds().map(id => {
    const fixed = QualityFixed.has(id);
    const cur = map[id] || '';
    const icon = platformIcon(id);
    return '<div class="quality-map-row' + (fixed ? ' quality-map-row--fixed' : '') + '">' +
      '<div class="quality-map-name" title="' + escAttr(platformName(id)) + '">' +
        (icon ? esc(icon) + ' ' : '') + esc(platformName(id)) + '</div>' +
      '<select class="setting-select quality-map-select"' +
        (fixed ? ' disabled' : '') +
        ' data-qs-id="' + escAttr(id) + '"' +
        (fixed ? '' : ' onchange="onQualityBySourceChange(this)"') + '>' +
        _qualitySelectOptions(cur) +
      '</select>' +
    '</div>';
  }).join('');
}

function onQualityBySourceChange(sel) {
  const map = getQualityBySource();
  const id = sel.dataset.qsId;
  if (!id) return;
  if (sel.value) map[id] = sel.value; else delete map[id];
  setState('qualityBySource', map);
  // 防抖落盘：逐项切换时避免每次击键都跨进程写 prefs
  clearTimeout(_qualityBySourceTimer);
  _qualityBySourceTimer = setTimeout(() => saveQualityBySource(map), 250);
}

async function resetQualityBySource() {
  clearTimeout(_qualityBySourceTimer);
  setState('qualityBySource', {});
  await saveQualityBySource({});
  renderQualityBySource();
  showToast('已恢复为全部跟随默认音质', 'info');
}

async function loadGeneralSettings() {
  try {
    const prefs = Object.values(GENERAL_PREFS);
    const values = await Promise.all(prefs.map(cfg => api.getPref(cfg.key)));
    prefs.forEach((cfg, i) => {
      const el = document.getElementById(cfg.el);
      if (!el) return;
      const v = values[i] !== undefined && values[i] !== null ? values[i] : cfg.default;
      if (el.type === 'checkbox') {
        el.checked = !!v;
      } else {
        el.value = String(v);
      }
    });
    // 色卡高亮不会随 select 的程序化赋值自动更新（不触发 change），加载完主动刷一次
    syncThemeCards();
    // 预览同理：输入框被程序化赋值不触发 input，主动刷一次
    updateFilenameTmplPreview();
  } catch (e) {
    logger.error(`[loadGeneralSettings] error:`, e);
  }
}

// ── 主题切换 ──────────────────────────────────────────
let _themeMediaQuery = null;

function applyTheme(theme) {
  const t = theme || 'default';
  // 清除之前的系统主题监听
  if (_themeMediaQuery) { _themeMediaQuery.onchange = null; _themeMediaQuery = null; }

  if (t === 'auto') {
    // 跟随系统主题
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    _themeMediaQuery = mq;
    const applySystem = (isDark) => {
      document.documentElement.setAttribute('data-theme', isDark ? 'default' : 'light');
    };
    applySystem(mq.matches);
    mq.onchange = (e) => applySystem(e.matches);
  } else if (t === 'default') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}

// ── 主题色卡（外观页）──────────────────────────────────
// 色卡只负责「显示 + 点击」，真正的值仍由隐藏的 <select id="settingTheme"> 承载。
// 这样 GENERAL_PREFS / loadGeneralSettings / setupGeneralSettingListeners
// 这条既有读写链路一行都不用改 —— 点击时写入 select 并派发 change 即可复用。
const THEME_CARDS = ['auto', 'default', 'light', 'cyber', 'aurora', 'sunset', 'forest'];

function syncThemeCards(value) {
  const sel = document.getElementById('settingTheme');
  const cur = value != null ? String(value) : (sel ? sel.value : 'default');
  document.querySelectorAll('.theme-card').forEach(card => {
    const on = card.dataset.themeValue === cur;
    card.classList.toggle('active', on);
    card.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function selectTheme(value) {
  if (!THEME_CARDS.includes(value)) return;
  const sel = document.getElementById('settingTheme');
  if (sel) {
    sel.value = value;
    // 触发 change：写 prefs + applyTheme 都由既有监听器完成
    sel.dispatchEvent(new Event('change'));
  }
  syncThemeCards(value);
}

function setupGeneralSettingListeners() {
  for (const cfg of Object.values(GENERAL_PREFS)) {
    const el = document.getElementById(cfg.el);
    if (!el) continue;
    el.addEventListener('change', () => {
      const val = el.type === 'checkbox' ? el.checked : el.value;
      api.setPref(cfg.key, val);
      if (cfg.key === 'quality') {
        const qs = document.getElementById('qualitySelect');
        if (qs) qs.value = val;
      }
      if (cfg.key === 'theme') {
        applyTheme(val);
      }
      // 全局媒体键：prefs 写入外还要实时通知主进程注册/注销
      if (cfg.key === 'globalShortcuts') {
        try { if (typeof api.setGlobalShortcuts === 'function') api.setGlobalShortcuts(!!val); } catch (_e) { /* 下次启动仍会按 prefs 生效 */ }
      }
    });
    // 命名模板走 input 事件实时预览：change 只在失焦时触发，敲字时看不出效果
    if (cfg.key === 'namingTemplate') {
      el.addEventListener('input', updateFilenameTmplPreview);
    }
  }
}

// （云同步导出/导入的 UI 入口是 exportConfig/importConfig，见 window 桥接区；
// 早期的 exportAllData/importAllData 重复实现已删除）

// ── 云同步 ───────────────────────────────────────────

// ── 下载路径模板 ──────────────────────────────────────
let _dlTemplates = [];
let _dlActiveTemplate = null;

async function loadDownloadTemplates() {
  try {
    const result = await api.getDownloadTemplates();
    _dlTemplates = result.templates || [];
    _dlActiveTemplate = result.active || null;
    renderDownloadTemplates();
  } catch (e) {
    logger.error('加载下载模板失败:', e);
  }
}

function renderDownloadTemplates() {
  const container = document.getElementById('dlTemplateList');
  if (!container) return;

  if (_dlTemplates.length === 0) {
    container.innerHTML = '<div class="empty-tip" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">暂无模板，点击「新建」添加</div>';
    return;
  }

  container.innerHTML = _dlTemplates.map(tpl => {
    const isActive = tpl.id === _dlActiveTemplate;
    return `
      <div class="dl-template-item ${isActive ? 'active' : ''}" data-id="${tpl.id}">
        <div class="dl-template-info" onclick="setActiveTemplate('${tpl.id}')">
          <div class="dl-template-name">
            ${isActive ? '✅ ' : ''}${escHtml(tpl.name)}
            ${isActive ? '<span class="dl-template-badge">使用中</span>' : ''}
          </div>
          <div class="dl-template-path">${escHtml(tpl.path)}</div>
        </div>
        <div class="dl-template-actions">
          <button class="btn-icon" onclick="openDlTemplateEditor('${tpl.id}')" title="编辑">✏️</button>
          <button class="btn-icon" onclick="deleteDlTemplate('${tpl.id}')" title="删除">🗑️</button>
        </div>
      </div>`;
  }).join('');
}

async function setActiveTemplate(templateId) {
  try {
    await api.setActiveDownloadTemplate(templateId);
    _dlActiveTemplate = templateId;
    renderDownloadTemplates();
    const tpl = _dlTemplates.find(t => t.id === templateId);
    showToast(`已切换到: ${tpl?.name || '默认路径'}`, 'info');
  } catch (e) {
    logger.error(`[setActiveTemplate] error:`, e);
  }
}

function openDlTemplateEditor(templateId) {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');
  const titleEl = document.getElementById('dlTemplateEditorTitle');

  if (templateId) {
    const tpl = _dlTemplates.find(t => t.id === templateId);
    if (tpl) {
      titleEl.textContent = '✏️ 编辑路径模板';
      nameInput.value = tpl.name;
      pathInput.value = tpl.path;
      modal.dataset.editId = templateId;
    }
  } else {
    titleEl.textContent = '➕ 新建路径模板';
    nameInput.value = '';
    pathInput.value = '';
    delete modal.dataset.editId;
  }

  updateTemplateVarHints();
  modal.classList.remove('hidden');
  nameInput.focus();
}

function closeDlTemplateEditor() {
  document.getElementById('dlTemplateEditorModal').classList.add('hidden');
}

function updateTemplateVarHints() {
  const el = document.getElementById('dlTemplateVarHints');
  if (el) {
    el.innerHTML = '可用变量: {artist} {album} {title} {source} {year} {track}，如: <code>D:/音乐/{artist}/{album}/{title}</code>';
  }
}

async function saveDlTemplate() {
  const modal = document.getElementById('dlTemplateEditorModal');
  const nameInput = document.getElementById('dlTemplateName');
  const pathInput = document.getElementById('dlTemplatePath');

  const name = nameInput.value.trim();
  const path = pathInput.value.trim();
  if (!name || !path) {
    showToast('名称和路径不能为空', 'warn');
    return;
  }

  const editId = modal.dataset.editId;
  try {
    const result = await api.saveDownloadTemplate({
      ...(editId ? { id: editId } : {}),
      name, path,
    });
    if (result.success) {
      await loadDownloadTemplates();
      closeDlTemplateEditor();
      showToast(editId ? '✅ 模板已更新' : '✅ 模板已创建', 'success');
    }
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

async function deleteDlTemplate(templateId) {
  if (!confirm('确认删除该路径模板？')) return;
  try {
    const result = await api.deleteDownloadTemplate(templateId);
    if (result.success) {
      await loadDownloadTemplates();
      showToast('✅ 模板已删除', 'success');
    }
  } catch (e) {
    showToast('删除失败: ' + e.message, 'error');
  }
}

// ── 在 DOM 就绪后绑定事件 ─────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupGeneralSettingListeners);
} else {
  setupGeneralSettingListeners();
}

// ── 缓存管理 ──────────────────────────────────────────
async function updateCacheSize() {
  try {
    const size = await api.getCacheSize();
    const el = document.getElementById('cacheSizeLabel');
    if (el) el.textContent = size ? `当前缓存 ${size}` : '暂无缓存';
  } catch (e) {
    // 静默
  }
}

async function clearPlayCache() {
  try {
    await api.clearPlayCache();
    showToast('✅ 播放缓存已清理', 'success');
    updateCacheSize();
  } catch (e) {
    showToast('清理缓存失败: ' + e.message, 'error');
  }
}

// ── 恢复默认设置 ──────────────────────────────────────
async function resetAllSettings() {
  if (!confirm('确认恢复所有设置为默认值？\n\n此操作不会删除：\n• 已下载的音乐文件\n• 平台登录 Cookie\n• 搜索历史')) return;

  const defaults = {
    quality: 'standard',
    concurrency: 3,
    namingTemplate: '{artist} - {title}',
    autoLyric: true,
    autoCover: true,
    theme: 'default',
  };

  try {
    for (const [key, value] of Object.entries(defaults)) {
      await api.setPref(key, value);
    }
    // 刷新 UI
    await loadGeneralSettings();
    applyTheme('default');
    showToast('✅ 设置已恢复默认值', 'success');
  } catch (e) {
    showToast('恢复失败: ' + e.message, 'error');
  }
}

function parseCookieFields(cookieStr) {
  const fields = [];
  cookieStr.split(';').forEach(part => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) fields.push({ key: trimmed, value: '' });
    else fields.push({ key: trimmed.substring(0, eq).trim(), value: trimmed.substring(eq + 1).trim() });
  });
  return fields;
}

// ── 备份与恢复 ───────────────────────────────────────
async function exportConfig() {
  try {
    const result = await window.ipcRenderer.invoke('export-all-data');
    if (result.canceled) return;
    if (result.success) {
      showToast('✅ 配置已导出: ' + result.path, 'success');
    } else {
      showToast('❌ 导出失败: ' + result.error, 'error');
    }
  } catch (e) {
    showToast('导出失败: ' + e.message, 'error');
  }
}

async function importConfig() {
  try {
    const result = await api.invoke('import-all-data');
    if (result.canceled) return;
    if (result.success) {
      showToast('✅ ' + result.message, 'success', 5000);
    } else {
      showToast('❌ ' + result.error, 'error');
    }
  } catch (e) {
    showToast('导入失败: ' + e.message, 'error');
  }
}

// ── ES Module 导出 ──────────────────────────────────────
export {
  openSettings,
  closeSettings,
  closeSettingsOnBg,
  switchSettingsTab,
  loadCookieStatus,
  saveCookie,
  clearCookie,
  verifyCookieUI,
  openLoginPage,
  openLoginWindowUI,
  analyzeCookieUI,
  clearPlayCache,
  resetAllSettings,
  exportConfig,
  importConfig,
  loadGeneralSettings,
  loadQualityBySource,
  loadSourceHealth,
  probeSourcesUI,
  applyTheme,
  PLATFORMS,
}

// ── 全局桥接（HTML onclick 兼容） ──────────────────────
window.openSettings = openSettings;
window.closeSettings = closeSettings;
window.closeSettingsOnBg = closeSettingsOnBg;
window.switchSettingsTab = switchSettingsTab;
window.loadQualityBySource = loadQualityBySource;
window.onQualityBySourceChange = onQualityBySourceChange;
window.resetQualityBySource = resetQualityBySource;
window.selectTheme = selectTheme;
window.loadCookieStatus = loadCookieStatus;
window.saveCookie = saveCookie;
window.clearCookie = clearCookie;
window.verifyCookieUI = verifyCookieUI;
window.openLoginPage = openLoginPage;
window.openLoginWindowUI = openLoginWindowUI;
window.analyzeCookieUI = analyzeCookieUI;
window.clearPlayCache = clearPlayCache;
window.resetAllSettings = resetAllSettings;
window.exportConfig = exportConfig;
window.importConfig = importConfig;
window.loadGeneralSettings = loadGeneralSettings;
window.loadSourceHealth = loadSourceHealth;
window.probeSourcesUI = probeSourcesUI;
window.loadDownloadTemplates = loadDownloadTemplates;
window.openDlTemplateEditor = openDlTemplateEditor;
window.closeDlTemplateEditor = closeDlTemplateEditor;
window.saveDlTemplate = saveDlTemplate;
// 模板列表项（loadDownloadTemplates 渲染的 onclick）走全局名
window.setActiveTemplate = setActiveTemplate;
window.deleteDlTemplate = deleteDlTemplate;
window.applyTheme = applyTheme;
window.PLATFORMS = PLATFORMS;

// ── DOM 缓存初始化 ──────────────────────────────────
_cacheSettingsDom();
