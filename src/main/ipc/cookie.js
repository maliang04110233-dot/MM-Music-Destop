/**
 * Cookie 管理 IPC
 *
 * 注册：get-cookies / save-cookie / clear-cookie / verify-cookie / open-login-window
 */

const { handle } = require('./register');
const api = require('../../api');
const cookieStore = require('../../utils/cookieStore');
const { refreshQQMusickey } = require('../../utils/cookie');
const { ERR_SECRET_STORAGE_UNAVAILABLE: SECRET_STORAGE_UNAVAILABLE } = require('../../utils/secretStore');
const { openLoginWindow } = require('../loginWindow');
const { getMainWindow } = require('../context');

function register() {
  // 注意：不要在 register 时解构 mainWindow（那时是 undefined）——
  // 每次用时从 getCtx() 拿。

  // 脱敏显示所有 Cookie
  handle('get-cookies', () => {
    const all = cookieStore.getAll();
    const masked = {};
    for (const [k, v] of Object.entries(all)) {
      masked[k] = v ? v.substring(0, 30) + (v.length > 30 ? '...' : '') : '';
    }
    return masked;
  });

  // 保存 Cookie（渲染层位置参数：api.saveCookie(platform, cookie)）
  handle('save-cookie', async (_, platform, cookie) => {
    // 审计 P1：安全存储不可用时 cookieStore.set 返回 false（拒绝明文落盘）。
    // 必须如实回错，不能回 saved:true —— 那会让用户以为登录态已保存。
    if (cookie.trim() && !cookieStore.set(platform, cookie.trim())) {
      return { saved: false, error: SECRET_STORAGE_UNAVAILABLE };
    }
    api.updateCookie(platform, cookie.trim());
    if (cookie.trim()) {
      const result = await api.verifyCookie(platform, cookie.trim());
      if (platform === 'qq' && result?.valid && result?.freshMusickey) {
        const refreshed = refreshQQMusickey(cookie.trim(), result.freshMusickey);
        if (refreshed && refreshed !== cookie.trim()) {
          cookieStore.set('qq', refreshed);
          api.updateCookie('qq', refreshed);
          return { saved: true, verify: result, cookieRefreshed: true };
        }
      }
      return { saved: true, verify: result };
    }
    return { saved: true, verify: null };
  });

  // 删除 Cookie
  handle('clear-cookie', (_, platform) => {
    cookieStore.clear(platform);
    api.updateCookie(platform, '');
    return { cleared: true };
  });

  // 验证 Cookie（不保存，仅测试）
  handle('verify-cookie', async (_, platform, cookie) => {
    try {
      return await api.verifyCookie(platform, cookie);
    } catch (e) {
      return { valid: false, error: e.message };
    }
  });

  // 打开登录子窗口
  handle('open-login-window', async (_, platform) => {
    try {
      const result = await openLoginWindow(platform, getMainWindow());
      if (result.success && result.cookie) {
        if (!cookieStore.set(platform, result.cookie)) {
          return { ...result, saved: false, error: SECRET_STORAGE_UNAVAILABLE };
        }
        api.updateCookie(platform, result.cookie);
        const verify = await api.verifyCookie(platform, result.cookie);
        // 登录后若有新 musickey，写回 store
        if (platform === 'qq' && verify?.valid && verify?.freshMusickey) {
          const refreshed = refreshQQMusickey(result.cookie, verify.freshMusickey);
          if (refreshed && refreshed !== result.cookie) {
            cookieStore.set('qq', refreshed);
            api.updateCookie('qq', refreshed);
            verify.cookieRefreshed = true;
          }
        }
        return { ...result, saved: true, verify };
      }
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
}

module.exports = { register };
