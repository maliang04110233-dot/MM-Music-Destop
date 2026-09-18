/**
 * 单元测试：utils/logger.js —— 日志接口完整性
 *
 * 为什么值得单独测：
 *   曾出现 downloader.js 断点续传分支调用 `logger.info(...)`，但 logger
 *   只导出 { log, warn, error } —— 走到该分支就抛
 *   "logger.info is not a function"，**把断点续传整个打断**。
 *   因为只在「传输出错 + 已有部分落盘」时才触发，长期无人发现。
 *
 *   这类 bug 的特点：调用点语法合法、静态检查（未开 no-undef 的用法）也不报，
 *   只有真跑那条分支才炸。所以用「扫源码 + 断言方法存在」的方式把它钉死。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const logger = require('../src/utils/logger');

const ROOT = path.join(__dirname, '..');

test('logger 导出 log / info / warn / error 四个方法', () => {
  for (const m of ['log', 'info', 'warn', 'error']) {
    assert.strictEqual(typeof logger[m], 'function', `logger.${m} 应为函数`);
  }
});

test('守卫：源码中出现的 logger.<method> 都真实存在（防"方法不存在"运行时崩溃）', () => {
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.preview' || entry.name === 'release') continue;
      const rel = `${dir}/${entry.name}`.replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(rel);
      } else if (entry.name.endsWith('.js')) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        for (const m of src.matchAll(/\blogger\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
          used.add(m[1]);
        }
      }
    }
  };
  walk('src');

  const missing = [...used].filter((m) => typeof logger[m] !== 'function');
  assert.deepStrictEqual(
    missing, [],
    `以下 logger 方法被调用但未导出（会在运行时抛 "is not a function"）：${missing.join(', ')}\n`
    + '请在 utils/logger.js 中补齐实现。',
  );
});

test('logger.info 与 logger.log 行为一致（非生产输出、生产静默）', () => {
  // 本测试进程 NODE_ENV 通常非 production；这里只断言「可调用且不抛」
  assert.doesNotThrow(() => logger.info('test info'));
  assert.doesNotThrow(() => logger.log('test log'));
  assert.doesNotThrow(() => logger.warn('test warn'));
  assert.doesNotThrow(() => logger.error('test error'));
});
