/**
 * IPC 注册器：主进程所有 handle/on 必须走这里（契约校验 + 漂移防护）
 *
 * - 未声明在 src/shared/ipcContract 的通道 → 启动即抛错（回归第一时间暴露）
 * - 方向不匹配（invoke 通道用了 on / 反之）→ 启动即抛错
 * - 进入 handler 前按契约 args 规格做参数形状校验/钳制，非法参数统一拒绝，
 *   handler 从此只见到「规范化后的位置参数」，不再各自手写 shim 与防御
 */

const { ipcMain } = require('electron');
const { CHANNELS, normalizeArgs } = require('../../shared/ipcContract');
const logger = require('../../utils/logger');

const _registered = new Set();

function _entry(channel, dir) {
  const e = CHANNELS[channel];
  if (!e || !(e[dir] || []).length) {
    throw new Error(`IPC 通道未声明在契约 (${dir}): ${channel} —— 请先在 src/shared/ipcContract.js 登记`);
  }
  return e;
}

function handle(channel, fn) {
  _entry(channel, 'invoke');
  ipcMain.handle(channel, (event, ...raw) => {
    const r = normalizeArgs(channel, raw);
    if (!r.ok) {
      logger.warn(`[ipc] ${r.error}`);
      return { error: r.error, fatal: true };
    }
    return fn(event, ...r.args);
  });
  _registered.add(channel);
}

function on(channel, fn) {
  _entry(channel, 'send');
  ipcMain.on(channel, (event, ...raw) => {
    const r = normalizeArgs(channel, raw);
    if (!r.ok) {
      logger.warn(`[ipc] ${r.error}（已丢弃）`);
      return;
    }
    fn(event, ...r.args);
  });
  _registered.add(channel);
}

/**
 * 全部模块注册完成后调用：契约里声明了 invoke/send 却没有实际注册器的通道 → 告警。
 * （静默失踪是原三套白名单架构最常见的腐化方式）
 */
function assertContractCoverage() {
  const missing = [];
  for (const [channel, e] of Object.entries(CHANNELS)) {
    const needsHandler = (e.invoke || []).includes('main');
    const needsOn = ((e.send || []).length) > 0;
    if ((needsHandler || needsOn) && !_registered.has(channel)) missing.push(channel);
  }
  if (missing.length) {
    logger.warn(`[ipc] 契约通道无人注册（${missing.length}）:`, missing.join(', '));
  }
  return missing;
}

module.exports = { handle, on, assertContractCoverage, _registered };
