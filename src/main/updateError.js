/**
 * 更新失败的「说什么」与「什么时候说」
 *
 * 抽成独立模块的原因（与 updateMirror.js 同源）：updater.js 顶层 require
 * electron-updater 与 electron，测试环境里加载不动，而这两条判据恰恰是
 * 出过事的逻辑，必须能被单测钉住。
 *
 * 背景（2026-09-21 用户截图「更新失败：net::ERR_CONNECTION_RESET」）：
 *   1. electron-updater 每次 checkForUpdates() 失败都 emit('error') 再 reject
 *      （node_modules/electron-updater/out/AppUpdater.js:269-272）。我们一次
 *      用户主动检查要跑「直连×3 + 镜像×2」，事件若无条件转发，第 1 次失败就
 *      会弹「更新失败」，而兜底还在跑 —— 弹窗冒充了最终结果。
 *   2. 旧码表按 Node socket 码写（ECONNRESET / ETIMEDOUT），但 electron 抛的是
 *      Chromium 的 net:: 名字：`net::ERR_CONNECTION_RESET` 不含子串 `ECONNRESET`，
 *      一条都不匹配 ⇒ 内部 token 直接印到普通用户脸上。
 *
 * 两条判据都刻意保持「不确定就不说」：非网络错误原样返回（翻成"网络问题"会
 * 掩盖真因），事件级错误缺字段一律不打扰用户。
 */
'use strict';

/**
 * 传输层失败：连接建立不了、中途断了、域名解析不出来。
 * 两套命名都要覆盖 —— Chromium 的 net::ERR_* 与 Node 的 socket 码。
 * 证书/TLS 不在这里（它重试无用，走下面单独一条）。
 */
const TRANSPORT_ERROR = /net::ERR_(?:TIMED_OUT|CONNECTION_(?:RESET|CLOSED|REFUSED|ABORTED|FAILED)|INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|SOCKET_NOT_CONNECTED)|\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|HOSTUNREACH|NETUNREACH|PIPE|AI_AGAIN|NOTFOUND)\b|socket hang up|network timeout/i;

/**
 * 证书 / TLS 握手失败：镜像是第三方转发链路，这一族比直连更容易撞上。
 * 单独一支是因为「稍后再试」对它不成立 —— 拦你的东西不会自己消失。
 */
const TLS_ERROR = /net::ERR_(?:CERT_[A-Z_]+|SSL_PROTOCOL_ERROR|SSL_FALLBACK_EXCEEDED)|unable to verify the first certificate|self[- ]signed certificate|certificate (?:chain|has expired|revoked)/i;

function messageOf(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return err.message ? String(err.message) : '';
}

/**
 * 把裸的网络错误翻译成用户能行动的一句话。
 *
 * @param {Error|string|null} err
 * @param {{mirrorTried?:boolean}} [opts] 镜像兜底是否已经跑过 —— 措辞必须跟着事实走，
 *        否则「已自动重试多次」会在用户面前变成假话（实际还试了镜像）。
 * @returns {string} 非网络错误原样返回（无 message 时返回空串）
 */
function describeUpdateError(err, opts = {}) {
  const msg = messageOf(err);
  if (TLS_ERROR.test(msg)) {
    return '更新连接被证书校验挡住（常见于代理、VPN 或安全软件拦截），' +
      '请检查这类网络中间件后再试，或到 GitHub Releases 页面手动下载最新版本';
  }
  if (TRANSPORT_ERROR.test(msg)) {
    const scope = opts.mirrorTried
      ? 'GitHub 直连与镜像源均已试过'
      : '已自动重试多次';
    return `网络连不上更新服务器（${scope}），请稍后再试，` +
      '或到 GitHub Releases 页面手动下载最新版本';
  }
  return msg;
}

/**
 * 事件级（autoUpdater.on('error')）错误是否该打扰用户。
 *
 * 只有「用户主动触发」且「我们自己的重试/镜像流程已经收尾」两者同时成立才报：
 * 流程在飞时每次尝试失败都会 emit 一次事件，而收尾时 IPC 返回值会把最终结论
 * 报给 UI（渲染层措辞是「检查失败：」/「下载失败：」），事件再报一次就是抢跑。
 *
 * @param {{userInitiated?:boolean, flowInFlight?:boolean}} state
 * @returns {boolean}
 */
function shouldReportEventError(state) {
  if (!state) return false;
  return state.userInitiated === true && state.flowInFlight !== true;
}

module.exports = {
  TRANSPORT_ERROR,
  TLS_ERROR,
  describeUpdateError,
  shouldReportEventError,
};
