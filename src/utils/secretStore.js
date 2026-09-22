/**
 * 敏感值本地加密封装（M4 / 2026-09 审计 P1 加固）
 *
 * cookie / API key 等同账号级凭证原先明文落 userData 下的 JSON 文件。
 * 本模块用 Electron safeStorage（Windows 上走 DPAPI，密钥绑定当前系统
 * 用户）把它们包装成 'enc:v1:<base64>' 形态。
 *
 * ── 三种运行态（审计修正：旧实现把后两种混为一谈，导致「加密坏了」也照样明文落盘）──
 *
 *   ready        在 Electron 主进程里，safeStorage 可用 → 正常加密。
 *   unavailable  **不在 Electron 里**（纯 Node 单测 / 打包脚本 / CLI）。
 *                require('electron') 返回的是二进制路径字符串，没有 API 面。
 *                此时明文透传，不报错 —— 单测与「备份回导入」都依赖这条语义。
 *   insecure     在 Electron 主进程里，但系统加密不可用（DPAPI 被策略禁用、
 *                密钥环缺失等）。**这是真实用户的危险态**：以前它走的是和
 *                unavailable 一样的明文透传，用户既看不到告警、文件里也是明文。
 *                现在一律拒绝写入并抛出 SecretStorageError，由调用方转成
 *                用户可见的失败提示 —— 宁可存不进去，也不静默明文落盘。
 *
 * decrypt() 语义不变：无前缀值（历史明文）原样返回，调用方下次写入即完成迁移；
 * 有前缀但无法解密（换机/换用户）返回空串，按「未登录/未配置」处理。
 * 密文跨机器不可解是有意为之：备份文件被拿走时凭证随之失效，好过明文可携。
 */

const PREFIX = 'enc:v1:';

/** 本机安全存储不可用（真实用户态）时抛出的错误码，供调用方识别并给出可操作提示 */
const ERR_SECRET_STORAGE_UNAVAILABLE = 'SECRET_STORAGE_UNAVAILABLE';

class SecretStorageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretStorageError';
    this.code = ERR_SECRET_STORAGE_UNAVAILABLE;
  }
}

let _probe; // undefined=未探测；否则 {mode, safe}

/**
 * 探测当前运行态。
 *
 * insecure 态**不缓存**：safeStorage.isEncryptionAvailable() 在 app ready 前
 * 可能返回 false，一旦把「还没准备好」记成永久不可用，用户就再也存不进凭证。
 * 其余两态稳定，缓存即可（避免每次取 cookie 都 require 一次 electron）。
 */
function _probeState() {
  if (_probe !== undefined && _probe.mode !== 'insecure') return _probe;
  try {
    const electron = require('electron');
    // 纯 Node 下 require('electron') 是字符串（二进制路径），没有 app/safeStorage 面。
    const isElectronMain = !!electron && typeof electron === 'object' && !!electron.app;
    if (!isElectronMain) {
      _probe = { mode: 'unavailable', safe: null };
    } else if (electron.safeStorage && electron.safeStorage.isEncryptionAvailable()) {
      _probe = { mode: 'ready', safe: electron.safeStorage };
    } else {
      _probe = { mode: 'insecure', safe: null };
    }
  } catch (_e) {
    _probe = { mode: 'unavailable', safe: null };
  }
  return _probe;
}

/** 当前运行态（'ready' | 'insecure' | 'unavailable'），供诊断与测试使用 */
function storageMode() {
  return _probeState().mode;
}

/** 能否安全落盘凭证：仅 ready 态为 true（insecure 态必须拒绝写入） */
function canEncrypt() {
  return _probeState().mode === 'ready';
}

/**
 * 加密明文。
 *
 * @throws {SecretStorageError} 在 Electron 里但本机安全存储不可用 / 加密本身失败。
 *   调用方必须处理（拒绝保存 + 提示用户），**不得**回退成明文写入。
 * 非 Electron 运行时（单测 / 脚本）保持明文透传的历史语义。
 */
function encrypt(plain) {
  if (typeof plain !== 'string' || !plain) return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const st = _probeState();
  if (st.mode === 'unavailable') return plain;
  if (st.mode === 'insecure') {
    throw new SecretStorageError('本机安全存储不可用（系统加密未启用），拒绝明文保存凭证');
  }
  try {
    return PREFIX + st.safe.encryptString(plain).toString('base64');
  } catch (e) {
    // 旧实现此处静默返回明文 —— 审计 P1 的根因之一
    throw new SecretStorageError(`凭证加密失败，拒绝明文保存: ${e.message}`);
  }
}

/** 尝试加密；不可用时返回 null 而不是抛错（给「尽力而为」的调用方用） */
function tryEncrypt(plain) {
  try {
    return encrypt(plain);
  } catch (_e) {
    return null;
  }
}

/** 解密存储值；非密文（历史明文）原样返回；密文解不开返回空串 */
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  const st = _probeState();
  if (st.mode !== 'ready') return '';
  try {
    return st.safe.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch (_e) {
    return '';
  }
}

module.exports = {
  canEncrypt,
  storageMode,
  encrypt,
  tryEncrypt,
  decrypt,
  PREFIX,
  ERR_SECRET_STORAGE_UNAVAILABLE,
  SecretStorageError,
};
