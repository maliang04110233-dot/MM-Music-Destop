/**
 * libraryWatcher 单元测试：防抖合并、目录切换、停止、降级与错误自愈
 */
const test = require('node:test');
const assert = require('node:assert');
const { createLibraryWatcher } = require('../src/main/libraryWatcher');

class FakeWatcher {
  constructor(onChange) {
    this.onChange = onChange;
    this.closed = false;
    this._handlers = {};
  }
  on(ev, fn) { (this._handlers[ev] = this._handlers[ev] || []).push(fn); }
  close() { this.closed = true; }
  trigger() { if (!this.closed) this.onChange('change', 'x.mp3'); }
  triggerError(err) { (this._handlers.error || []).forEach(fn => fn(err)); }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

test('触发后防抖合并 emit，携带监听目录', async () => {
  const emits = [];
  let lastWatcher = null;
  const w = createLibraryWatcher({
    emit: (dir) => emits.push(dir),
    debounceMs: 20,
    watch: (dir, opts, cb) => {
      lastWatcher = new FakeWatcher(typeof opts === 'function' ? opts : cb);
      return lastWatcher;
    },
  });
  w.setDir('/music');
  lastWatcher.trigger();
  lastWatcher.trigger();
  lastWatcher.trigger();
  await wait(60);
  assert.deepStrictEqual(emits, ['/music']); // 3 次事件合并为 1 次推送
});

test('setDir 换目录：关闭旧 watcher，emit 带新目录', async () => {
  const emits = [];
  const watchers = [];
  const w = createLibraryWatcher({
    emit: (dir) => emits.push(dir),
    debounceMs: 10,
    watch: (dir, opts, cb) => {
      const fw = new FakeWatcher(typeof opts === 'function' ? opts : cb);
      fw.dir = dir;
      watchers.push(fw);
      return fw;
    },
  });
  w.setDir('/music');
  w.setDir('/music'); // 同目录重复 setDir 不应重建
  assert.strictEqual(watchers.length, 1);
  w.setDir('/downloads');
  assert.strictEqual(watchers.length, 2);
  assert.ok(watchers[0].closed, '旧 watcher 应被关闭');
  assert.strictEqual(w.getDir(), '/downloads');
  watchers[1].trigger();
  await wait(40);
  assert.deepStrictEqual(emits, ['/downloads']);
});

test('setDir(null) 与 stop() 后不再 emit', async () => {
  const emits = [];
  let lastWatcher = null;
  const w = createLibraryWatcher({
    emit: (dir) => emits.push(dir),
    debounceMs: 10,
    watch: (dir, opts, cb) => {
      lastWatcher = new FakeWatcher(typeof opts === 'function' ? opts : cb);
      return lastWatcher;
    },
  });
  w.setDir('/music');
  w.setDir(null);
  assert.strictEqual(w.getDir(), null);
  assert.ok(lastWatcher.closed);
  w.setDir('/music2');
  w.stop();
  assert.ok(lastWatcher.closed);
  lastWatcher.trigger(); // stop 后触发（定时器已清）不应 emit
  await wait(40);
  assert.deepStrictEqual(emits, []);
});

test('watch 抛异常不崩溃，getDir 归 null', () => {
  const warns = [];
  const w = createLibraryWatcher({
    emit: () => { throw new Error('不该被调用'); },
    debounceMs: 10,
    watch: () => { throw new Error('EPERM'); },
    logger: { warn: (...args) => warns.push(args.join(' ')) },
  });
  w.setDir('/locked'); // recursive 与非 recursive 都抛 → 被吞
  assert.strictEqual(w.getDir(), null);
  assert.ok(warns.length >= 1, '应记录告警');
});

test('watcher error 事件（如目录被删）自动停止', async () => {
  const emits = [];
  const warns = [];
  let lastWatcher = null;
  const w = createLibraryWatcher({
    emit: (dir) => emits.push(dir),
    debounceMs: 10,
    watch: (dir, opts, cb) => {
      lastWatcher = new FakeWatcher(typeof opts === 'function' ? opts : cb);
      return lastWatcher;
    },
    logger: { warn: (...args) => warns.push(args.join(' ')) },
  });
  w.setDir('/music');
  lastWatcher.triggerError(new Error('ENOENT: directory gone'));
  assert.strictEqual(w.getDir(), null);
  assert.ok(lastWatcher.closed);
  assert.ok(warns.length >= 1);
  lastWatcher.trigger();
  await wait(40);
  assert.deepStrictEqual(emits, [], 'error 后不应再 emit');
});

test('recursive 不支持时降级为非 recursive', () => {
  const calls = [];
  let lastWatcher = null;
  const w = createLibraryWatcher({
    emit: () => {},
    debounceMs: 10,
    watch: (dir, opts, cb) => {
      calls.push(typeof opts === 'function' ? 'plain' : 'recursive');
      if (typeof opts !== 'function') throw new Error('recursive not supported');
      lastWatcher = new FakeWatcher(cb);
      return lastWatcher;
    },
  });
  w.setDir('/music');
  assert.deepStrictEqual(calls, ['recursive', 'plain']);
  assert.strictEqual(w.getDir(), '/music', '降级后仍应保持监听');
  assert.ok(lastWatcher && !lastWatcher.closed);
});
