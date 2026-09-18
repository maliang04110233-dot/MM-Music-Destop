/**
 * 生产日志控制
 *
 * 开发环境：log / info / warn / error 全部输出
 * 生产环境（NODE_ENV === 'production'）：仅输出 error，其余静默
 *
 * ⚠️ info 与 log 行为一致（都是「非生产才输出」）。
 *    它存在是因为 downloader.js 的断点续传分支调用了 logger.info ——
 *    此前 logger 只导出 { log, warn, error }，导致那条分支抛
 *    "logger.info is not a function"，**把断点续传整个打断**
 *    （只有传输出错且已有部分落盘时才会走到，故长期未被发现）。
 *    保留 info 既有语义、又补齐接口，比把调用点改成 log 更稳
 *    （调用点语义上确实是「信息」而非「日志」）。
 */

const _isProduction = process.env.NODE_ENV === 'production';

function log(...args) {
  if (!_isProduction) {
    console.log(...args);
  }
}

/** 信息级日志：与 log 同级别（非生产才输出） */
function info(...args) {
  if (!_isProduction) {
    console.log(...args);
  }
}

function warn(...args) {
  if (!_isProduction) {
    console.warn(...args);
  }
}

function error(...args) {
  console.error(...args);
}

module.exports = { log, info, warn, error };
