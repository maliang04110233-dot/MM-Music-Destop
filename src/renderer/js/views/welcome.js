/**
 * 首次启动新手引导
 *
 * prefs.welcomeSeen 非 true 时展示一次性引导浮层：
 * 三条核心用法（剪贴板识别 / 登录解锁音质 / 目录与命名）+ 快捷键提示。
 * 「开始使用」永久关闭；「稍后再说」仅本次关闭，下次启动仍会提示。
 */

let _overlay = null;
let _escHandler = null;

function welcomeCard(icon, title, desc, btn) {
  return `
    <div class="welcome-card">
      <div class="welcome-card-icon">${icon}</div>
      <div class="welcome-card-body">
        <div class="welcome-card-title">${title}</div>
        <div class="welcome-card-desc">${desc}</div>
      </div>
      ${btn || ''}
    </div>`;
}

function showWelcome() {
  if (_overlay) return;
  _overlay = document.createElement('div');
  _overlay.className = 'welcome-overlay';
  _overlay.id = 'welcomeOverlay';
  _overlay.innerHTML = `
    <div class="welcome-panel">
      <div class="welcome-title">🎧 欢迎使用 MusicDL</div>
      <div class="welcome-sub">三步上手，下载无损音乐</div>
      ${welcomeCard('📋', '复制或拖入链接，自动识别',
        '把网易云 / QQ 音乐 / B 站的歌曲、歌单、专辑链接复制出来（或直接拖进窗口），应用会自动弹出识别条，一键加入队列。')}
      ${welcomeCard('🔐', '登录账号，解锁高音质',
        '扫码登录后即可下载 HQ / 无损音质，未登录只能下载标准音质。',
        `<button class="btn welcome-btn" onclick="welcomeGoto('accounts')">去登录</button>`)}
      ${welcomeCard('📂', '下载目录与命名规则',
        '默认保存到「音乐/MusicDownloader」，可修改目录、文件命名模板、并发数与限速。',
        `<button class="btn welcome-btn" onclick="welcomeGoto('download')">去设置</button>`)}
      <div class="welcome-hint">💡 小技巧：菜单里的「聚焦搜索」快捷键随时唤起搜索；下载队列支持 ⏫ 置顶和 ⬆⬇ 调整顺序。</div>
      <div class="welcome-actions">
        <button class="btn ghost" onclick="welcomeLater()">稍后再说</button>
        <button class="btn primary" onclick="closeWelcome()">开始使用</button>
      </div>
    </div>`;
  document.body.appendChild(_overlay);
  _escHandler = (e) => { if (e.key === 'Escape') closeWelcome(); };
  document.addEventListener('keydown', _escHandler, true);
}

/** 永久关闭并写入 welcomeSeen */
function closeWelcome() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  if (_escHandler) { document.removeEventListener('keydown', _escHandler, true); _escHandler = null; }
  try { api.setPref('welcomeSeen', true); } catch (_e) { /* 浏览器开发模式 */ }
}

/** 仅本次关闭：下次启动仍展示 */
function welcomeLater() {
  if (_overlay) { _overlay.remove(); _overlay = null; }
  if (_escHandler) { document.removeEventListener('keydown', _escHandler, true); _escHandler = null; }
}

/** 关闭引导并直达设置页签（'accounts' | 'download'） */
function welcomeGoto(tab) {
  closeWelcome();
  if (typeof openSettings !== 'function') return;
  openSettings();
  if (tab && tab !== 'accounts' && typeof switchSettingsTab === 'function') {
    const nav = document.querySelector(`.settings-nav-item[data-tab="${tab}"]`);
    if (nav) switchSettingsTab(tab, nav);
  }
}

/** 应用启动完成后调用：未看过引导才展示 */
async function maybeShowWelcome() {
  try {
    const seen = await api.getPref('welcomeSeen');
    if (seen === true) return;
  } catch (_e) { /* 读不到 prefs 时照常展示 */ }
  showWelcome();
}

window.showWelcome = showWelcome;
window.closeWelcome = closeWelcome;
window.welcomeLater = welcomeLater;
window.welcomeGoto = welcomeGoto;
window.maybeShowWelcome = maybeShowWelcome;
