/**
 * MCP 本地服务 IPC（P1）
 *
 * 注册: mcp-status / mcp-set-config
 *
 * 把 MusicDL 变成可被外部 Agent 驱动的 MCP Server：
 *   - 工具面 = ipcContract 的显式白名单子集（src/main/mcp/tools.js），
 *     调用直接落到 register.js 里同一批 handler —— 同一实现同一契约校验；
 *   - 默认关闭；token 经 safeStorage 加密存 prefs（与 webdav 密码同路数）；
 *   - 只监听 127.0.0.1（传输层钉死），token 为空时绝不启动。
 */

const crypto = require('crypto');
const { handle, getInvokeHandler } = require('./register');
const prefs = require('../../utils/prefs');
const logger = require('../../utils/logger');
const secretStore = require('../../utils/secretStore');
const { createMcpServer } = require('../mcp/mcpServer');
const { createMcpHandler } = require('../mcp/mcpCore');
const { toolsFromContract } = require('../mcp/tools');

const DEFAULT_PORT = 39217;

let _server = null;

function _getPort() {
  const p = Number(prefs.get('mcpPort'));
  return Number.isFinite(p) && p >= 1 && p <= 65535 ? p : DEFAULT_PORT;
}

function _ensureToken(rotate) {
  if (rotate) prefs.set('mcpToken', '');
  const current = secretStore.decrypt(prefs.get('mcpToken') || '');
  if (current) return current;
  const fresh = crypto.randomBytes(24).toString('hex');
  prefs.set('mcpToken', secretStore.encrypt(fresh));
  return fresh;
}

async function _start() {
  if (_server) return { port: _server.port };
  const token = _ensureToken(false);
  if (!token) return { error: '无法生成访问令牌（系统加密不可用？）' };

  const handleMessage = createMcpHandler({
    tools: toolsFromContract(),
    serverVersion: (() => {
      try { return require('electron').app.getVersion(); } catch (_e) { return '0.0.0'; }
    })(),
    callTool: async (channel, args) => {
      const fn = getInvokeHandler(channel);
      if (!fn) throw new Error(`通道未注册: ${channel}`);
      // event 传 null：工具白名单里的 handler 均不依赖 sender（有依赖的通道不入白名单）
      return fn(null, ...args);
    },
  });

  _server = createMcpServer({ token, handleMessage });
  try {
    const { port } = await _server.start(_getPort());
    logger.log(`[mcp] 本地 MCP 服务已启动: http://127.0.0.1:${port}/mcp`);
    return { port };
  } catch (e) {
    _server = null;
    const msg = e && e.code === 'EADDRINUSE'
      ? `端口 ${_getPort()} 已被占用，请在设置中更换端口`
      : e.message;
    logger.warn('[mcp] 启动失败:', e);
    return { error: msg };
  }
}

async function _stop() {
  if (!_server) return;
  const s = _server;
  _server = null;
  await s.stop();
  logger.log('[mcp] 本地 MCP 服务已停止');
}

function _status() {
  return {
    enabled: prefs.get('mcpEnabled') === true,
    running: !!(_server && _server.listening),
    port: _getPort(),
    token: secretStore.decrypt(prefs.get('mcpToken') || '') || '',
    url: `http://127.0.0.1:${_getPort()}/mcp`,
  };
}

function register() {
  handle('mcp-status', () => _status());

  handle('mcp-set-config', async (_, cfg) => {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    if (typeof c.enabled === 'boolean') prefs.set('mcpEnabled', c.enabled);
    if (Number.isFinite(Number(c.port)) && Number(c.port) >= 1 && Number(c.port) <= 65535) {
      prefs.set('mcpPort', Number(c.port));
    }

    if (c.enabled === false) {
      await _stop();
      return { success: true, status: _status() };
    }

    // 运行中改端口 / 重置令牌都需要先停再起
    const needsRestart = !!_server && (c.rotateToken || _server.port !== _getPort());
    if (needsRestart) await _stop();
    if (c.rotateToken) _ensureToken(true);
    if (c.enabled === true || needsRestart) {
      if (!_server) {
        const r = await _start();
        if (r.error) return { success: false, error: r.error, status: _status() };
      }
    }
    return { success: true, status: _status() };
  });
}

/** 应用启动时按偏好自启（在全部 ipc register 之后调用，保证 handler 已在注册表） */
async function startIfEnabled() {
  if (prefs.get('mcpEnabled') === true) await _start();
}

module.exports = { register, startIfEnabled, stop: _stop, DEFAULT_PORT, _statusForTest: _status };
