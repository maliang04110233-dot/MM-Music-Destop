/**
 * 单元测试：main/ipc/checkLocal.js 的 norm + matchSong
 *
 * 跑：npm test
 *
 * 覆盖：括号清洗、空格归一、artist 单边缺失、artist 互含
 */

const test = require('node:test');
const assert = require('node:assert');

// checkLocal.js 顶层 require('electron') 仅为注册 IPC（测试环境无 electron
// 二进制会直接抛错）。用 Module._load 拦截注入 mock，生产代码不受影响。
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function interceptedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return { ipcMain: { handle() { /* no-op in tests */ } } };
  }
  return originalLoad(request, parent, isMain);
};
const { norm, matchSong } = require('../src/main/ipc/checkLocal');
Module._load = originalLoad;

test('norm: 去括号 + 去空格 + 小写', () => {
  assert.strictEqual(norm('陈奕迅 (Live)'), '陈奕迅');
  assert.strictEqual(norm('  Hello   World  '), 'helloworld');
  assert.strictEqual(norm('周杰伦'), '周杰伦');
  assert.strictEqual(norm(''), '');
  assert.strictEqual(norm(null), '');
  assert.strictEqual(norm(undefined), '');
});

test('matchSong: 完全匹配', () => {
  assert.strictEqual(
    matchSong({ title: '晴天', artist: '周杰伦' }, { title: '晴天', artist: '周杰伦' }),
    true
  );
});

test('matchSong: 标题包含匹配', () => {
  assert.strictEqual(
    matchSong({ title: '晴天', artist: '周杰伦' }, { title: '晴天 (Album Version)', artist: '周杰伦' }),
    true
  );
  // 反向也匹配
  assert.strictEqual(
    matchSong({ title: '晴天 (Live)', artist: '周杰伦' }, { title: '晴天', artist: '周杰伦' }),
    true
  );
});

test('matchSong: 标题不匹配', () => {
  assert.strictEqual(
    matchSong({ title: '晴天', artist: '周杰伦' }, { title: '夜曲', artist: '周杰伦' }),
    false
  );
});

test('matchSong: 括号内容清洗后能匹配', () => {
  assert.strictEqual(
    matchSong({ title: '浮夸 (Live)', artist: '陈奕迅' }, { title: '浮夸', artist: '陈奕迅' }),
    true
  );
});

test('matchSong: artist 互含匹配', () => {
  // 用户搜"林俊杰" - 本地标签 "林俊杰 / JJ Lin"
  assert.strictEqual(
    matchSong({ title: '江南', artist: '林俊杰' }, { title: '江南', artist: '林俊杰 / JJ Lin' }),
    true
  );
});

test('matchSong: artist 完全不同则不匹配', () => {
  assert.strictEqual(
    matchSong({ title: '江南', artist: '林俊杰' }, { title: '江南', artist: '周杰伦' }),
    false
  );
});

test('matchSong: 缺 artist 时只比 title', () => {
  assert.strictEqual(
    matchSong({ title: '晴天' }, { title: '晴天 (Remix)', artist: '某艺术家' }),
    true
  );
});
