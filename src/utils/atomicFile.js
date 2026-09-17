/**
 * 原子文件写入 + 安全读取
 *
 * 问题背景：
 *   直接 fs.writeFileSync 写 JSON 时若进程被强杀（断电/任务管理器/崩溃），
 *   文件可能停在半写状态 → JSON.parse 永久失败 → 队列/历史/偏好静默清空。
 *
 * 方案（业界标准 write-temp + rename）：
 *   atomicWriteJson(file, data)
 *     1. 序列化完整内容到同目录临时文件 file.tmp（同目录保证 rename 不跨卷）
 *     2. fs.renameSync 原子替换正式文件（POSIX 与 NTFS 均为原子操作）
 *   中途被杀时正式文件永远是旧完整版本，最坏丢最近一次防抖，不损坏。
 *
 *   safeReadJson(file, { backupOnCorrupt })
 *     JSON.parse 失败时先把损坏文件备份为 file.bak（抢救数据），
 *     再返回 null 由调用方走默认值，避免「损坏即清空」。
 *
 * 同步与异步两套并存的原因：
 *   主进程 UI 线程上的文件 IO 必须是异步的（见 utils/fsAsync.js），
 *   但 utils/prefs.js 的 flush() 需要在进程退出路径上做同步落盘
 *   ——那时事件循环可能已经不再推进，await 永远不会回来。
 *   因此同步版仅保留给这类必须「立即写完」的场景，其余一律用异步版。
 */

const fs = require('fs');

/**
 * 原子写 JSON：tmp + rename
 * @param {string} file - 目标文件绝对路径
 * @param {*} data - 可 JSON.stringify 的数据
 * @param {number} [space=2] - 缩进
 */
function atomicWriteJson(file, data, space = 2) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, space), 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 安全读 JSON：损坏时备份 .bak 后返回 null（不清空原文件，等下次写入覆盖）
 * @param {string} file - 目标文件绝对路径
 * @param {Object} [opts]
 * @param {boolean} [opts.backupOnCorrupt=true] - parse 失败时备份 file.bak
 * @returns {{ ok: boolean, data?: *, empty: boolean }} ok=false 表示损坏
 */
function safeReadJson(file, opts = {}) {
  const { backupOnCorrupt = true } = opts;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, empty: true };
    throw e;
  }
  if (!raw.trim()) return { ok: true, empty: true };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    if (backupOnCorrupt) {
      try {
        fs.copyFileSync(file, file + '.bak');
      } catch (bakE) {
        // 备份失败不阻断读取流程
      }
    }
    return { ok: false, empty: false };
  }
}

module.exports = { atomicWriteJson, safeReadJson, atomicWriteJsonAsync, safeReadJsonAsync };

/**
 * 原子写 JSON（异步版）：tmp + rename
 * 主进程 UI 线程的默认选择，语义与 atomicWriteJson 完全一致。
 * @param {string} file
 * @param {*} data
 * @param {number} [space=2]
 */
async function atomicWriteJsonAsync(file, data, space = 2) {
  const fsp = require('fs').promises;
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, space), 'utf8');
  await fsp.rename(tmp, file);
}

/**
 * 安全读 JSON（异步版）：损坏时备份 .bak 后返回 { ok:false }
 * @param {string} file
 * @param {Object} [opts]
 * @param {boolean} [opts.backupOnCorrupt=true]
 * @returns {Promise<{ ok: boolean, data?: *, empty: boolean }>}
 */
async function safeReadJsonAsync(file, opts = {}) {
  const fsp = require('fs').promises;
  const { backupOnCorrupt = true } = opts;
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, empty: true };
    throw e;
  }
  if (!raw.trim()) return { ok: true, empty: true };
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    if (backupOnCorrupt) {
      try {
        await fsp.copyFile(file, file + '.bak');
      } catch (bakE) {
        // 备份失败不阻断读取流程
      }
    }
    return { ok: false, empty: false };
  }
}
