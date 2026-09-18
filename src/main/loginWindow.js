/**
 * 登录子窗口管理
 * 在 Electron 里内嵌官方登录页（QQ音乐/网易云/B站），用户在子窗口走官方扫码/账号密码流程
 * 登录成功后通过 session.cookies 自动抓取 Cookie 返回给渲染进程
 *
 * 关键点：
 * - QQ音乐子窗口加载 y.qq.com，QQ号登录和微信扫码都走官方页面（无需集成 OAuth）
 * - 微信扫码必须用户在手机上确认（绕不开），但整个流程都在我们子窗口内完成
 * - 轮询检测关键 Cookie 字段（uin / MUSIC_U / SESSDATA）判断登录成功
 */

const { BrowserWindow } = require('electron');
const logger = require('../utils/logger');

// 各平台登录配置
const LOGIN_CONFIGS = {
  qq: {
    loginUrl: 'https://y.qq.com',
    title: '登录 QQ 音乐',
    // 检测登录成功的关键 Cookie 字段（uin 是登录后立即有的）
    detectFields: ['uin', 'wxuin'],
    // 抓取 Cookie 的域名（覆盖主域 + 子域）
    cookieDomains: ['.qq.com', '.y.qq.com', '.open.weixin.qq.com'],
    // 登录后需要额外等待让 musickey 刷新的时间（ms）
    musickeyDelay: 3000,
  },
  netease: {
    loginUrl: 'https://music.163.com',
    title: '登录 网易云音乐',
    detectFields: ['MUSIC_U'],
    cookieDomains: ['.music.163.com', '.163.com'],
  },
  bilibili: {
    loginUrl: 'https://passport.bilibili.com/login',
    title: '登录 哔哩哔哩',
    detectFields: ['SESSDATA'],
    cookieDomains: ['.bilibili.com'],
  },
};

/**
 * 打开登录子窗口
 * @param {string} platform  平台标识 (qq / netease / bilibili)
 * @param {BrowserWindow} parentWindow  父窗口（主窗口）
 * @returns {Promise<{success: boolean, cookie?: string, cookies?: object[], cancelled?: boolean, error?: string}>}
 */
async function openLoginWindow(platform, parentWindow) {
  const config = LOGIN_CONFIGS[platform];
  if (!config) {
    return { success: false, error: '不支持的平台: ' + platform };
  }

  const loginWin = new BrowserWindow({
    width: 1000,
    height: 760,
    parent: parentWindow || undefined,
    modal: false,
    title: config.title,
    backgroundColor: '#1a1a2e',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // M3: 独立内存会话 —— 原实现共用 defaultSession，clearStorageData
      // 会无差别清掉所有站点/其他平台登录态；不带 persist: 前缀意味着
      // 登录 Cookie 只活在本次登录窗口，抓到即弃，不落第二份。
      partition: `login-${platform}`,
    },
  });

  // M3: 页面内跳转同样限域（原先只有弹窗守卫，will-navigate 不设防，
  // 被诱导导航到 file:///内网 即可在本窗口上下文里读其他域）
  const hostAllowed = (u) => {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname;
    return config.cookieDomains.some(d =>
      host === d.replace(/^\./, '') || host.endsWith(d));
  };
  loginWin.webContents.on('will-navigate', (event, url) => {
    let ok = false;
    try { ok = hostAllowed(new URL(url)); } catch (_e) { ok = false; }
    if (!ok) {
      logger.warn('[loginWindow] 拒绝越域导航:', url);
      event.preventDefault();
    }
  });

  // 拦截窗口弹出（OAuth跳转时可能被强制新窗口打开）。
  // 只允许 http(s) 协议且域名限于该平台配置的 cookie 域，防止被导向
  // file://、内网地址或钓鱼页（登录窗口能读取这些域的 Cookie）。
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (hostAllowed(new URL(url))) {
        loginWin.webContents.loadURL(url);
      } else {
        logger.warn('[loginWindow] 拒绝弹出导航:', url);
      }
    } catch (_) {
      logger.warn('[loginWindow] 无效的弹出 URL:', url);
    }
    return { action: 'deny' };
  });

  // 内存分区会话天然无历史 Cookie；仍显式清一次以防同窗口期残留
  const ses = loginWin.webContents.session;
  try {
    await ses.clearStorageData({ cookies: true });
  } catch (e) {
    logger.warn('[loginWindow] clearStorageData failed:', e.message);
  }

  // 加载登录页
  await loginWin.loadURL(config.loginUrl);

  return new Promise((resolve) => {
    let resolved = false;
    let checkCount = 0;
    let timeoutId = null;
    const checkInterval = setInterval(async () => {
      if (loginWin.isDestroyed()) {
        clearInterval(checkInterval);
        return;
      }
      checkCount++;
      try {
        const allCookies = [];
        for (const domain of config.cookieDomains) {
          const cookies = await ses.cookies.get({ domain });
          allCookies.push(...cookies);
        }

        // 检测是否有关键登录字段
        const hasLoginField = config.detectFields.some(field =>
          allCookies.some(c => c.name === field && c.value && c.value.length > 3)
        );

        if (hasLoginField && !resolved) {
          resolved = true;
          clearInterval(checkInterval);
          if (timeoutId) clearTimeout(timeoutId);

          // QQ 音乐：登录后额外等一会儿，让 musickey 有时间刷新
          if (platform === 'qq' && config.musickeyDelay) {
            await new Promise(r => setTimeout(r, config.musickeyDelay));
            // 重新拉一次 cookie（这次 musickey 应该已经在了）
            const freshCookies = [];
            for (const domain of config.cookieDomains) {
              const cookies = await ses.cookies.get({ domain });
              freshCookies.push(...cookies);
            }
            allCookies.length = 0;
            allCookies.push(...freshCookies);
          }

          const cookieStr = allCookies
            .filter(c => c.value)
            .map(c => `${c.name}=${c.value}`)
            .join('; ');

          logger.log('[loginWindow] 登录成功，捕获', allCookies.length, '个 Cookie（共检查', checkCount, '次）');
          loginWin.close();
          resolve({
            success: true,
            cookie: cookieStr,
            cookies: allCookies.map(c => ({ name: c.name, domain: c.domain, value: c.value })),
          });
        }
      } catch (e) {
        logger.warn('[loginWindow] check cookies error:', e.message);
      }
    }, 1500);

    // 用户手动关闭窗口 → 取消登录
    loginWin.on('closed', () => {
      if (!resolved) {
        clearInterval(checkInterval);
        logger.log('[loginWindow] 用户取消登录');
        resolve({ success: false, cancelled: true });
      }
    });

    // 超时 5 分钟
    timeoutId = setTimeout(() => {
      if (!resolved && !loginWin.isDestroyed()) {
        resolved = true;
        clearInterval(checkInterval);
        loginWin.close();
        logger.log('[loginWindow] 登录超时');
        resolve({ success: false, error: '登录超时（5分钟）' });
      }
    }, 5 * 60 * 1000);
  });
}

module.exports = { openLoginWindow, LOGIN_CONFIGS };