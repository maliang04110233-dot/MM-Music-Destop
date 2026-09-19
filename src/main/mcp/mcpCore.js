/**
 * MCP JSON-RPC 2.0 核心（P1）—— 纯函数 + 依赖注入，单测不触网不碰 electron
 *
 * 只实现 MCP Streamable HTTP 的最小子集（对桌面端本地 Agent 足够）：
 *   initialize / notifications/* / ping / tools/list / tools/call
 * SSE 流式与 sampling 等高级能力刻意不做：工具结果都是一次性 JSON。
 *
 * callTool(channel, positionalArgs) 由 HTTP 层注入（最终落到 register.js
 * 的 handler 注册表）。工具执行失败按 MCP 约定回 isError:true 的内容而不是
 * 协议错误 —— 让 Agent 能把错误文本喂回模型继续对话。
 */

const { CHANNELS, normalizeArgs } = require('../../shared/ipcContract');

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'musicdl';

/** 具名参数 → 契约位置参数（复用主进程同一套 normalizeArgs 钳制/拒绝逻辑） */
function namedToPositional(channel, namedArgs, channels = CHANNELS) {
  const specs = channels[channel] && channels[channel].args;
  const obj = (namedArgs && typeof namedArgs === 'object' && !Array.isArray(namedArgs)) ? namedArgs : {};
  if (!specs) return { ok: true, args: [] };
  const positional = specs.map(([name]) => obj[name]);
  return normalizeArgs(channel, positional);
}

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolText(id, isError, text) {
  return rpcResult(id, { content: [{ type: 'text', text: String(text) }], isError });
}

/**
 * @param {Object} deps
 * @param {Array} deps.tools   toolsFromContract() 的产物（含 channel 内部字段）
 * @param {string} deps.serverVersion
 * @param {(channel:string, args:any[])=>Promise<any>} deps.callTool
 * @returns {(msg:Object) => Promise<Object|null>} JSON-RPC 分发；通知返回 null
 */
function createMcpHandler({ tools, serverVersion, callTool }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  // tools/list 面剔除内部字段（channel 不外泄给 Agent）
  const publicTools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
    }
    const { id = null, method, params } = msg;

    // 通知：有义务收到，无义务应答
    if (method.startsWith('notifications/')) return null;

    switch (method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: String(serverVersion || '0.0.0') },
        });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: publicTools });

      case 'tools/call': {
        const name = params && params.name;
        const tool = byName.get(name);
        if (!tool) return rpcError(id, -32602, `未知工具: ${String(name).slice(0, 64)}`);
        const r = namedToPositional(tool.channel, params && params.arguments);
        if (!r.ok) return toolText(id, true, r.error);
        let result;
        try {
          result = await callTool(tool.channel, r.args);
        } catch (e) {
          return toolText(id, true, `工具执行失败: ${e.message || e}`);
        }
        const businessError = !!(result && typeof result === 'object' && result.error);
        return toolText(id, businessError, JSON.stringify(result === undefined ? null : result));
      }

      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  };
}

module.exports = { createMcpHandler, namedToPositional, PROTOCOL_VERSION, SERVER_NAME };
