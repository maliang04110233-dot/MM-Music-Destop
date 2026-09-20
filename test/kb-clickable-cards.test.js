/**
 * 键盘可达收口（qa-5 回写：点击卡片必须键盘可触发）
 *
 * 结论来自设计验收：首页/曲库大量「可点击的 div 卡片」只有 onclick，
 * 键盘用户 Tab 到不了、到了也按不动 —— 静态源码钉 + 全局键桥形状钉。
 * 约定沿用 renderer-audit.test.js：read() 把 CRLF 归一化为 \n，钉不受 core.autocrlf 影响。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const R = (...p) => path.join(__dirname, '..', 'src', 'renderer', ...p);
const read = (...p) => fs.readFileSync(R(...p), 'utf8').replace(/\r\n/g, '\n');

const KB_ATTR = 'tabindex="0" role="button"';

// ── 桥本身 ────────────────────────────────────────────

test('shortcuts.js: 全局 Enter/Space→click 桥必须存在且形状完整（一处兜底，视图零补丁）', () => {
  const src = read('js', 'shortcuts.js');
  assert.match(src, /function isKbClickable\(/,
    '必须有 isKbClickable 判定函数 —— 桥与 Space 播放分支共用同一个"什么叫可点击卡片"的定义');
  assert.match(src, /matches\('\[tabindex="0"\]\[onclick\]'\)/,
    '判定必须按属性选择器 [tabindex="0"][onclick] 识别 —— 模板只加属性不写 JS 的前提就是这条契约');
  assert.match(src, /function setupKbClickableBridge\(/, '必须有桥的注册函数');
  assert.match(src, /if \(e\.key !== 'Enter' && e\.key !== ' ' && e\.key !== 'Spacebar'\) return;/,
    '桥必须同时认 Enter / Space / Spacebar（老 WebKit Space 键名），其余键直接放行');
  assert.match(src, /if \(e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey\) return;/,
    '带修饰键的组合必须放行 —— 否则 Ctrl+Space / Cmd+Enter 之类的既有快捷键会被桥吃掉');
  assert.match(src, /if \(e\.defaultPrevented\) return;/,
    '已被更早的消费者处理过的事件必须放行 —— 桥挂在同一个 document 上，晚于搜索列表导航注册');
  assert.match(src, /e\.preventDefault\(\); \/\/ Space 不滚页\s*\n\s*el\.click\(\);/,
    '命中卡片必须 preventDefault（Space 默认滚页）后调 el.click()');
});

test('shortcuts.js: Space 播放/暂停分支必须给聚焦中的卡片让路（否则空格既是播放又是点开）', () => {
  const src = read('js', 'shortcuts.js');
  const guard = src.match(/if \(inInput \|\| _anyModalOpen\(\) \|\| isKbClickable\(document\.activeElement\)\) return;/);
  assert.ok(guard,
    'Space 分支的让路条件必须包含 isKbClickable(document.activeElement) —— '
    + '焦点在卡片上时空格应"点开这张卡"，不应同时触发全局播放暂停');
  // 让路必须发生在 togglePlay 之前（顺序钉：正则位置比较）
  const guardPos = src.indexOf('isKbClickable(document.activeElement)');
  const playPos = src.indexOf('if (typeof togglePlay === \'function\') togglePlay();');
  assert.ok(guardPos >= 0 && playPos >= 0 && guardPos < playPos,
    '让路判断必须在 togglePlay 调用之前 —— 写在后面就等于没写');
});

// ── 模板侧：只加属性，零 JS ───────────────────────────

function assertCardPinned(name, src, prefixes, count) {
  const hits = src.split(KB_ATTR).length - 1;
  assert.strictEqual(hits, count,
    `${name} 必须恰好 ${count} 处 ${KB_ATTR}，实际 ${hits} 处 —— 少了是漏挂，多了说明把桥的契约属性挂到了不该键盘触发的元素上`);
  for (const p of prefixes) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.ok(new RegExp(escaped + '[^>]*' + KB_ATTR).test(src),
      `${name} 中 ${p} 模板必须带 ${KB_ATTR}`);
  }
}

test('index.html: 4 张 stat-card 全部键盘可达（数字卡是找到本地曲库/下载队列的最短路径）', () => {
  const src = read('index.html');
  assertCardPinned('index.html', src, ['<div class="stat-card"'], 4);
});

test('home.js: 4 类可点击模板（歌单卡/最近播放/榜单行/分区重试）全部挂桥属性', () => {
  const src = read('js', 'views', 'home.js');
  assertCardPinned('home.js', src, [
    '<div class="playlist-card"', '<div class="recent-item"',
    '<div class="top-song-row"', '<div class="home-sec-msg is-error"',
  ], 4);
});

test('playlist.js: 歌单卡与"加入歌单"弹层条目挂桥属性（弹层内也可键盘选定）', () => {
  const src = read('js', 'views', 'playlist.js');
  assertCardPinned('playlist.js', src, [
    '<div class="playlist-card"', '<div class="playlist-select-item"',
  ], 2);
});

test('local.js: 列表行与网格单元挂桥属性（本地曲库两种视图都要键盘可播）', () => {
  const src = read('js', 'views', 'local.js');
  assertCardPinned('local.js', src, [
    '<div class="${rowClass}"', '<div class="grid-cell"',
  ], 2);
});

// ── 反向钉：不收的口子，防止无声扩大或走偏 ─────────────

test('桥属性不得被挂到既有 input/checkbox 上（tabindex 归桥只认 div 卡片；复选框另有 aria-checked 课题）', () => {
  const files = ['index.html', 'js/views/home.js', 'js/views/playlist.js', 'js/views/local.js'];
  for (const f of files) {
    const parts = f.split('/');
    const src = read(...parts);
    for (const m of src.matchAll(/<(\w+)[^>]*tabindex="0" role="button"[^>]*>/g)) {
      assert.strictEqual(m[1], 'div',
        `${f}: <${m[1]}> 上挂了桥属性 —— 桥的识别器是通用 [tabindex="0"][onclick]，原生可聚焦元素（input 等）不该借这条路触发 click()`);
    }
  }
});

test('本切片刻意未收的元素保持原样（并发会话热文件 download.js / app.js pq-item，避免踩线）', () => {
  const dl = read('js', 'views', 'download.js');
  assert.ok(!dl.includes(KB_ATTR),
    'download.js 尚未纳入键盘收口切片（该文件正被并发会话改动）—— 若此钉变红，说明有人先行挂了桥属性，需对齐归属而非直接删');
});
