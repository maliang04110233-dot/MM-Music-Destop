'use strict';

// 下载速度估算（纯函数，不依赖 electron，便于单测）。
// 用法：每个 taskId 维护一份 state，随进度回调喂入 (nowMs, receivedBytes, totalBytes)。
// 采样窗口内的调用复用上一次速度，避免抖动；窗口滚动时重算。

const DEFAULT_WINDOW_MS = 1500;

/**
 * @param {{baseT:number, baseB:number, speed:number}|null} state 上次采样状态
 * @param {number} nowMs 当前时间戳
 * @param {number} receivedBytes 已下载字节（累计，含续传偏移）
 * @param {number} totalBytes 总字节，未知传 0
 * @param {number} [windowMs] 速度重算最小间隔
 * @returns {{state:{baseT:number,baseB:number,speed:number}, speedBps:number, etaSec:number|null}}
 */
function nextSpeed(state, nowMs, receivedBytes, totalBytes, windowMs = DEFAULT_WINDOW_MS) {
  const bytes = Number.isFinite(receivedBytes) && receivedBytes >= 0 ? receivedBytes : 0;
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;

  let next = state;
  if (!next || now - next.baseT >= windowMs) {
    const elapsed = next ? (now - next.baseT) / 1000 : 0;
    let speed = 0;
    if (next && elapsed > 0) {
      speed = Math.max(0, (bytes - next.baseB) / elapsed);
    }
    next = { baseT: now, baseB: bytes, speed };
  }

  let etaSec = null;
  if (total > 0) {
    if (bytes >= total) etaSec = 0;
    else if (next.speed > 0) etaSec = Math.ceil((total - bytes) / next.speed);
  }
  return { state: next, speedBps: Math.round(next.speed), etaSec };
}

module.exports = { nextSpeed, DEFAULT_WINDOW_MS };
