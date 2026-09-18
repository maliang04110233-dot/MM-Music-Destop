/**
 * 敏感值本地加密封装（M4）
 *
 * cookie / API key 等同账号级凭证原先明文落 userData 下的 JSON 文件。
 * 本模块用 Electron safeStorage（Windows 上走 DPAPI，密钥绑定当前系统
 * 用户）把它们包装成 'enc:v1:<base64>' 形态：
 *   - Electron 不可用（纯 Node 单测）或系统加密不可用 → 原样透传，不报错；
 *   - decrypt() 对无前缀值（历史明文）原样返回，调用方下次写入即完成迁移；
 *   - 有前缀但无法解密（换机/换用户）→ 返回空串，按"未登录/未配置"处理。
 * 密文跨机器不可解是有意为之：备份文件被拿走时凭证随之失效，好过明文可携。
 */

const PREFIX = 'enc:v1:';

let _safe; // undefined=未探测；null=不可用
function _getSafe() {
  if (_safe !== undefined) return _safe;
  try {
    const { app, safeStorage } = require('electron');
    _safe = (app && safeStorage && safeStorage.isEncryptionAvailable()) ? safeStorage : null;
  } catch (_e) {
    _safe = null;
  }
  return _safe;
}

function canEncrypt() {
  return _getSafe() !== null;
}

/** 加密明文；不可加密时原样返回；已包装值不二次加密（备份回导入场景） */
function encrypt(plain) {
  if (typeof plain !== 'string' || !plain) return plain;
  if (plain.startsWith(PREFIX)) return plain;
  const s = _getSafe();
  if (!s) return plain;
  try {
    return PREFIX + s.encryptString(plain).toString('base64');
  } catch (_e) {
    return plain;
  }
}

/** 解密存储值；非密文（历史明文）原样返回；密文解不开返回空串 */
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return stored;
  const s = _getSafe();
  if (!s) return '';
  try {
    return s.decryptString(Buffer.from(stored.slice(PREFIX.length), 'base64'));
  } catch (_e) {
    return '';
  }
}

module.exports = { canEncrypt, encrypt, decrypt, PREFIX };
