/**
 * 搜索页「非单曲视图被陈旧单曲列表覆盖」回归钉（增量130）
 *
 * 缺陷：`_dlLastList` 只在 renderSongList 里被赋值、**从不置空**；而四处重绘入口
 *   search.js:171（隐藏已下载）、:179（排序）、:888（队列变化，300ms 防抖）、
 *   :893（屏蔽变化）
 * 一律只判 `if (_dlLastList)`，**不判当前视图类型**。
 * 偏偏 renderSingerList / renderAlbumList / openSingerDetail / openAlbumDetail
 * 都写同一个容器 #songList（index.html:219）。于是「歌手/专辑视图」下任何一次队列
 * 变化（app.js:308-311 每次 queue-updated 都触发）都会把专辑列表盖成上次的单曲
 * 搜索结果，并按单曲排序模式重排。
 *
 * 修法：保持 renderSongList 为 `_dlLastList` 的唯一「= list」写入者；所有非单曲
 * 写 #songList 的路径一律清空（= null）。四处重绘入口即天然安全，无需再加类型判断。
 * （不选「重绘入口加 _searchType === 'song' 守卫」：loadSingerDetail 的 albums 分支
 *   search.js:855 不改 _searchType，守卫会放行、仍被覆盖。）
 *
 * 渲染层模块顶层碰 document，node:test 无法真跑 —— 沿用本仓库的静态源码断言约定。
 * 扫描前一律 stripComments（本仓库有「注释里写代码示例」的惯例）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAW = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'views', 'search.js'), 'utf8');

/** 剥注释：块注释换成等长空格（保留换行，行号不漂），行注释整段去掉 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const CODE = stripComments(RAW);

/** 用花括号配平抽函数体（含首尾大括号） */
function fnBody(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}

// ── 自检 ────────────────────────────────────────────────

test('自检: stripComments 生效（注释里提到的 _dlLastList 不得被当成代码）', () => {
  assert.ok(!stripComments("// _dlLastList = null; 说明文字").includes('_dlLastList'), '行注释未剥离');
  assert.ok(!stripComments('/* _dlLastList = null; */ let a = 1;').includes('_dlLastList'), '块注释未剥离');
  assert.ok(stripComments('_dlLastList = null;').includes('_dlLastList'), '代码被误剥离');
});

test('自检: fnBody 能正确抽到四个目标函数的函数体（哨兵守卫，防配平被字符串干扰）', () => {
  const sentinels = {
    renderSingerList: 'singer-row',
    renderAlbumList: 'album-row',
    openSingerDetail: 'singer-detail-header',
    backToSearch: 'currentKeyword',
  };
  for (const [fn, token] of Object.entries(sentinels)) {
    const body = fnBody(CODE, fn);
    assert.ok(body.length > 0, `fnBody 未抽到 ${fn}`);
    assert.ok(body.includes(token),
      `fnBody 抽到的 ${fn} 函数体不含哨兵「${token}」——花括号配平被字符串/模板字面量干扰，本文件的钉已失效`);
  }
});

// ── 回归钉 ──────────────────────────────────────────────

test('回归钉：写 #songList 的非单曲渲染函数必须清空 _dlLastList', () => {
  const sentinels = {
    renderSingerList: 'singer-row',
    renderAlbumList: 'album-row',
    openSingerDetail: 'singer-detail-header',
    backToSearch: 'currentKeyword',
  };
  for (const fn of Object.keys(sentinels)) {
    const body = fnBody(CODE, fn);
    assert.ok(body.includes("getElementById('songList')"),
      `${fn}() 应当仍在写 #songList（前提已变？若已改渲染目标，请更新本钉）`);
    assert.ok(body.includes('_dlLastList = null'),
      `${fn}() 写 #songList 却没清空 _dlLastList —— 队列/屏蔽变化（:171/:179/:888/:893 只判 if(_dlLastList)）会把它盖成上次的单曲搜索结果`);
  }
});

test('接线钉：_dlLastList 的赋值形态受限（= list 仅 renderSongList 一处，= null 为非单曲清空点）', () => {
  const code = CODE.replace(/^\s*let\s+_dlLastList\s*=\s*null;\s*$/m, ''); // 排除声明行
  const assigns = [...code.matchAll(/_dlLastList\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(assigns.length >= 5, `_dlLastList 赋值点过少（${assigns.length}），本钉可能已失效`);

  const unexpected = assigns.filter((v) => v !== 'list' && v !== 'null');
  assert.deepStrictEqual(unexpected, [],
    `_dlLastList 出现非约定赋值：${unexpected.join(' | ')}（只允许 list / null）`);

  const asList = assigns.filter((v) => v === 'list');
  assert.strictEqual(asList.length, 1,
    `「= list」只允许 renderSongList 一处，实际 ${asList.length} 处 —— 多一处就多一个会被队列变化重绘的陈旧锚点`);

  const asNull = assigns.filter((v) => v === 'null');
  assert.ok(asNull.length >= 4,
    `非单曲视图清空点应 ≥4（歌手列表/专辑列表/歌手详情/返回），实际 ${asNull.length}`);
});

test('回归钉：renderSongList 必须是 _dlLastList 的唯一「= list」写入者', () => {
  const body = fnBody(CODE, 'renderSongList');
  assert.ok(body.includes('_dlLastList = list'),
    'renderSongList 需把本次列表记为徽标重绘锚点');
  const others = ['renderSingerList', 'renderAlbumList', 'openSingerDetail', 'backToSearch']
    .filter((fn) => fnBody(CODE, fn).includes('_dlLastList = list'));
  assert.deepStrictEqual(others, [], `这些函数不应把自身列表设为徽标锚点：${others.join(', ')}`);
});
