/**
 * send 型 IPC 的统一错误边界（2026-09 审计 P1）
 *
 * 问题：register.js 的 handle() 有 try/catch（信封），on() 却是裸调用
 * `fn(event, ...args)`。send 通道没有回执，handler 一抛错就无处可去：
 *   同步抛 → 主进程 uncaughtException；返回 rejected Promise → unhandledRejection。
 * 主进程即 UI 线程，代价是窗口失联。本文件钉住「两条路都被接住」。
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const sendHandlers = new Map();
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      ipcMain: {
        handle: () => {},
        on: (ch, fn) => sendHandlers.set(ch, fn),
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const { on } = require('../src/main/ipc/register');

/** 模拟渲染层 send：ipcMain.on 的监听器 */
const fire = (channel, ...args) => sendHandlers.get(channel)({}, ...args);

test('send handler 同步抛错被就地接住，不向 ipcMain 外抛', () => {
  on('window-minimize', () => { throw new Error('sync boom'); });
  assert.doesNotThrow(() => fire('window-minimize'));
});

test('send handler 返回 rejected Promise 被接住，不产生 unhandledRejection', async () => {
  let leaked = null;
  const onLeak = (r) => { leaked = r; };
  process.once('unhandledRejection', onLeak);
  on('window-maximize', async () => { throw new Error('async boom'); });
  fire('window-maximize');
  // 让 microtask 队列跑空，给 unhandledRejection 一个暴露机会
  await new Promise((r) => setTimeout(r, 20));
  process.removeListener('unhandledRejection', onLeak);
  assert.strictEqual(leaked, null, '异步 handler 的拒绝必须被 then(undefined, …) 吃掉');
});

test('正常路径仍拿到规范化后的位置参数（错误边界不改语义）', () => {
  const seen = [];
  on('desktop-lyric-lock', (_e, locked) => { seen.push(locked); });
  fire('desktop-lyric-lock', true);
  fire('desktop-lyric-lock', 'not-a-boolean');
  assert.deepStrictEqual(seen, [true, false], 'bool 规格的历史语义是 v === true，不是拒绝');
});

test('未声明在契约里的通道仍在注册期就抛错（错误边界不放松契约校验）', () => {
  assert.throws(() => on('not-a-real-channel', () => {}), /未声明在契约/);
});
