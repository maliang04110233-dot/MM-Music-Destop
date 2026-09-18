/**
 * withRetry —— 带退避的可测重试
 *
 * 为什么存在：electron-updater 的 HttpExecutor.retryOnServerError 只在 5xx /
 * EPIPE 上重试，网络超时（net::ERR_TIMED_OUT、socket 超时）不在其列——一次失败
 * 就直接抛给调用方。GitHub 控制面在部分网络下会间歇性丢 TCP 连接（同一时刻
 * 80% 连接超时），所以调用方必须自己包一层重试。
 *
 * 抽成无 Electron 依赖的纯模块以便 node 单测，同 downloadQueue.js / sourceHealth.js。
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 顺序执行 fn，失败后按 delays 退避重试，全部失败时抛**最后一次**错误。
 *
 * delays 的长度就是重试次数：delays: [] = 只执行一次不重试，
 * delays: [a, b] = 首次失败后等 a 再试，再失败等 b 再试，共 3 次尝试。
 *
 * @param {() => Promise<any>} fn 要执行的动作，每次尝试都重新调用
 * @param {object} [options]
 * @param {number[]} [options.delays] 每次失败后的等待毫秒
 * @param {(err: Error, attempt: number, total: number) => void} [options.onAttempt]
 *        每次失败后的回调（最后一次失败也会触发，attempt 是刚失败的这次）
 * @returns {Promise<any>} fn 的返回值
 */
async function withRetry(fn, options) {
  const opts = options || {};
  const delays = Array.isArray(opts.delays) ? opts.delays.slice() : [];
  const total = delays.length + 1;
  let lastError = null;

  for (let attempt = 1; attempt <= total; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (typeof opts.onAttempt === 'function') {
        opts.onAttempt(err, attempt, total);
      }
      if (attempt < total) {
        await sleep(delays[attempt - 1]);
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error('withRetry: 未记录到任何错误');
}

module.exports = { withRetry, sleep };
