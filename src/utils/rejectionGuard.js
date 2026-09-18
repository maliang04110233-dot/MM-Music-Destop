/**
 * 主进程未捕获拒绝归口（unhandledRejection）
 *
 * 为什么需要它
 * ------------
 * 依赖 qq-music-api 的内部是「伪 Express 路由」：路由 handler 声明成 async，
 * 但它的返回值被直接丢弃（qq-music-api/node/index.js 第 70 行附近），
 * 所以 handler 内部抛出的异常不会链回调用方的 await，成为**无主的 rejection**：
 *   - 我们自己的 try/catch 拦不到它 —— 同一次失败已经在 res.send 处 reject 过一次，
 *     我们只拿到了那一半；
 *   - 默认处置策略随运行时而变（Electron 当前是 warn，而 Node 15+ 默认是 throw）。
 *     一旦某次升级切到 throw，它就会升级成 uncaughtException 直接退出进程。
 *
 * 分流而不是一刀切
 * ----------------
 * 只有「第三方包自己泄漏」的事我们改不了（除非换依赖或重写那批接口），
 * 所以按**栈帧归属**分开记：
 *   - 栈里有 node_modules  → warn（上游缺陷，附首个栈帧做溯源）
 *   - 否则                 → error（本仓漏网，必须能被发现）
 * 若不分流，要么上游噪音淹没真问题，要么本仓问题被当成噪音忽略。
 *
 * ⚠ 两个 TAG 字面量是 e2e 闸门（.preview/e2e-electron-v3.cjs）的判据，
 *   闸门直接从本模块 import，不要再在别处硬编码。
 */

const defaultLogger = require('./logger');

/** 本仓代码抛出的未捕获拒绝 */
const TAG_OURS = '[未捕获拒绝·本仓]';
/** 第三方依赖抛出的未捕获拒绝 */
const TAG_THIRD_PARTY = '[未捕获拒绝·第三方]';

/**
 * 归类一个 rejection（纯函数）
 * @param {*} reason Promise 拒绝原因（通常是 Error，也可能是任意值）
 * @returns {{thirdParty: boolean, message: string, firstFrame: string, stack: string}}
 */
function classifyRejection(reason) {
  const stack = String((reason && reason.stack) || reason || '');
  const message = String((reason && reason.message) || reason || 'unknown');
  const firstFrame = (stack.split('\n').find((l) => /^\s+at /.test(l)) || '').trim();
  return { thirdParty: stack.includes('node_modules'), message, firstFrame, stack };
}

/**
 * 注册 unhandledRejection 归口
 * @param {{proc?: object, logger?: object}} [opts] proc 默认 process（便于测试注入假对象）
 * @returns {boolean} 是否注册成功
 */
function installRejectionGuard({ proc = process, logger = defaultLogger } = {}) {
  if (!proc || typeof proc.on !== 'function') return false;
  proc.on('unhandledRejection', (reason) => {
    // 整个处理器包起来：记录通道自己抛错会升级成 uncaughtException，等于没兜住
    try {
      const r = classifyRejection(reason);
      if (r.thirdParty) {
        logger.warn(`${TAG_THIRD_PARTY} ${r.message}${r.firstFrame ? '  ⇢ ' + r.firstFrame : ''}`);
      } else {
        logger.error(`${TAG_OURS} ${r.message}\n${r.stack}`);
      }
      return true;
    } catch (_e) {
      // 记录失败就放弃这次记录（返回 false；也避免出现空 catch 块）
      return false;
    }
  });
  return true;
}

module.exports = { classifyRejection, installRejectionGuard, TAG_OURS, TAG_THIRD_PARTY };
