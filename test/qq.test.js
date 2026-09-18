/**
 * 单元测试：QQ 平台（纯函数 + 接线守卫）
 *
 * 网络链路（搜索 / 首页 8 分区 / 取流 / 歌词）由 .preview/probe-qq-home-counts.cjs
 * 实测覆盖；这里只钉住「回归代价高、且曾经真的错过」的部分：
 *
 *   - **电台接口是两级结构**：radio/category 返回的是「分组数组」，
 *     电台在 group.list 里。曾经按 result.radio_list 取值 → 恒 undefined
 *     → 「热门电台」分区永远空，且不报错（静默失效）。
 *   - **不得回退到上游 radio/category 路由**：那条路由打的是 http:// 明文地址，
 *     且包装层返回形状与文档不符。自己打 https 是刻意选择，不能被改回去。
 *   - **payload 的 module/method 是硬契约**：写错不会被服务端报错，
 *     只会返回 code!=0 的空结构，同样表现为静默 0 项。
 *   - 适配器是否真的注册进了插件中心（曾出现「实现写了但从未 require」）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const qq = require('../src/api/platforms/qq');
const api = require('../src/api/index.js');

const { mapRadioStations, _radioPayload, _qqEscapeCount, _handleQQEscape } = qq._internal;

/** 实测响应形态的缩影（两层：组 → 电台） */
function realShape() {
  return {
    code: 0,
    radiolist: {
      code: 0,
      data: {
        title: '电台',
        freshtime: 1789642987,
        radio_list: [
          {
            id: 48, title: '热门', group_type: 10023,
            list: [
              { id: 99, title: '猜你喜欢', listenNum: 46665, pic_url: 'https://y.gtimg.cn/music/common/upload/t_music_radio/4492404.png' },
              { id: 101, title: '随心听', listenNum: 48791, pic_url: 'https://y.gtimg.cn/music/common/upload/t_music_radio/x.png' },
            ],
          },
          {
            id: 49, title: '情感', group_type: 10024,
            list: [
              { id: 200, title: '深夜治愈', listenNum: 1234, pic_url: '' },
            ],
          },
        ],
      },
    },
  };
}

// ── mapRadioStations：拍平 ────────────────────────────────

test('mapRadioStations: 拍平两级结构，顺序为「组内优先、按组顺序」', () => {
  const out = mapRadioStations(realShape());
  assert.strictEqual(out.length, 3);
  assert.deepStrictEqual(out.map((r) => r.id), ['99', '101', '200']);
  assert.deepStrictEqual(out.map((r) => r.name), ['猜你喜欢', '随心听', '深夜治愈']);
});

test('mapRadioStations: 字段映射（id 转字符串、cover 取 pic_url、playCount 取 listenNum）', () => {
  const [first] = mapRadioStations(realShape());
  assert.strictEqual(first.id, '99');
  assert.strictEqual(first.name, '猜你喜欢');
  assert.strictEqual(first.cover, 'https://y.gtimg.cn/music/common/upload/t_music_radio/4492404.png');
  assert.strictEqual(first.playCount, 46665);
  assert.strictEqual(first.group, '热门');
  assert.strictEqual(first.source, 'qq');
});

test('mapRadioStations: cover 回落 pic_url → subscript_picurl → picUrl', () => {
  const mk = (item) => ({ radiolist: { data: { radio_list: [{ title: 'g', list: [item] }] } } });
  assert.strictEqual(mapRadioStations(mk({ id: 1, subscript_picurl: 'sub.png' }))[0].cover, 'sub.png');
  assert.strictEqual(mapRadioStations(mk({ id: 1, picUrl: 'old.png' }))[0].cover, 'old.png');
  assert.strictEqual(mapRadioStations(mk({ id: 1 }))[0].cover, '');
});

test('mapRadioStations: playCount 回落 listen_num；name 回落 name 字段', () => {
  const raw = { radiolist: { data: { radio_list: [{ title: 'g', list: [{ id: 7, name: '旧字段', listen_num: 88 }] }] } } };
  const [r] = mapRadioStations(raw);
  assert.strictEqual(r.name, '旧字段');
  assert.strictEqual(r.playCount, 88);
});

test('mapRadioStations: limit 跨组截断（不会只截第一组）', () => {
  assert.strictEqual(mapRadioStations(realShape(), 2).length, 2);
  assert.strictEqual(mapRadioStations(realShape(), 1)[0].id, '99');
  assert.strictEqual(mapRadioStations(realShape(), 0).length, 0);
});

test('mapRadioStations: 缺 id 的条目被跳过（避免渲染出无法点击的空卡片）', () => {
  const raw = { radiolist: { data: { radio_list: [{ title: 'g', list: [{ title: '无 id' }, { id: 0, title: 'id=0 有效' }] }] } } };
  const out = mapRadioStations(raw);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].id, '0');
});

test('mapRadioStations: 组 list 非数组 / 缺失时跳过该组，不影响其它组', () => {
  const raw = {
    radiolist: {
      data: {
        radio_list: [
          { title: '坏组' },
          { title: '坏组2', list: null },
          { title: '好组', list: [{ id: 5, title: 'ok' }] },
        ],
      },
    },
  };
  const out = mapRadioStations(raw);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].group, '好组');
});

test('mapRadioStations: 组标题缺失时 group 为空串（不写入 undefined）', () => {
  const raw = { radiolist: { data: { radio_list: [{ list: [{ id: 5, title: 'x' }] }] } } };
  assert.strictEqual(mapRadioStations(raw)[0].group, '');
});

test('mapRadioStations: 非法/空输入一律返回空数组，不抛异常', () => {
  for (const bad of [null, undefined, 0, '', 'x', [], {}, { radiolist: {} }, { radiolist: { data: {} } }, { radiolist: { data: { radio_list: 'nope' } } }]) {
    assert.deepStrictEqual(mapRadioStations(bad), [], `输入 ${JSON.stringify(bad)} 应得空数组`);
  }
});

test('mapRadioStations: 不修改入参（纯函数）', () => {
  const raw = realShape();
  const snapshot = JSON.stringify(raw);
  mapRadioStations(raw, 1);
  assert.strictEqual(JSON.stringify(raw), snapshot);
});

// ── payload 契约 ──────────────────────────────────────────

test('_radioPayload: module/method 是硬契约（写错只会静默返回 0 项）', () => {
  const p = _radioPayload();
  assert.strictEqual(p.radiolist.module, 'pf.radiosvr');
  assert.strictEqual(p.radiolist.method, 'GetRadiolist');
  assert.strictEqual(String(p.radiolist.param.ct), '24');
  assert.strictEqual(p.songlist.module, 'mb_track_radio_svr');
  assert.strictEqual(p.comm.ct, 24);
});

test('_radioPayload: 每次调用返回新对象（避免共享可变引用被下游改写）', () => {
  assert.notStrictEqual(_radioPayload(), _radioPayload());
});

// ── 防回退守卫 ────────────────────────────────────────────

test('守卫：不得回退到上游 radio/category 路由（那条是 http:// 明文，且返回形状不符）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'platforms', 'qq.js'), 'utf8');
  assert.ok(!/api\(\s*['"]radio\/category['"]/.test(src), 'qq.js 不应再调用 qqMusic.api(\'radio/category\')');
  assert.ok(/https:\/\/u\.y\.qq\.com\/cgi-bin\/musicu\.fcg/.test(src), '电台应走 https 的 musicu.fcg');
});

test('接线：qq 适配器已注册进插件中心，且对外暴露电台能力', () => {
  const p = api.registry.get('qq');
  assert.ok(p, 'qq 未注册进 pluginRegistry');
  assert.strictEqual(typeof qq.qqGetRadioStations, 'function');
  assert.strictEqual(p.id, 'qq');
});

// ── 上游游离异常隔离（曾导致整个进程崩溃）────────────────

test('守卫：模块级安装 unhandledRejection 兜底，隔离 qq-music-api 游离异常', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'platforms', 'qq.js'), 'utf8');
  assert.ok(
    /process\.on\('unhandledRejection'/.test(src),
    'qq.js 应在模块加载时安装常驻 unhandledRejection 兜底：'
    + 'qq-music-api 的 async route 抛错会变成游离 rejected promise，'
    + '无人兜底时整个 Node 进程崩溃（实例：routes/top.js 读 result.detail 于 HTTP 400 时）。',
  );
  // 不允许再按「调用窗口」临时挂监听：游离异常可能在 api() 返回很久后才冒出来，
  // 窗口一关就漏（踩过）。
  assert.ok(
    !/removeListener\(\s*'unhandledRejection'/.test(src),
    '不应在调用结束后摘掉 unhandledRejection 监听 —— 游离异常无法归属到具体调用，'
    + '必须常驻兜底。',
  );
});

test('守卫：所有 qqMusic.api 调用都经 safeQQApi 包装（统一入口，禁止散落裸调）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'platforms', 'qq.js'), 'utf8');
  // 裸调只允许出现在 safeQQApi 内部（1 处，return qqMusic.api(path, query)）。
  const bare = [...src.matchAll(/qqMusic\.api\(/g)];
  assert.strictEqual(
    bare.length, 1,
    'qq.js 中只允许 safeQQApi 内部保留 1 处裸调 qqMusic.api；'
    + `其余调用点一律经 safeQQApi（当前发现 ${bare.length} 处）。\n`
    + '原因：所有 QQ 路由调用须走统一入口，异常隔离与日志才有单一归属。',
  );
});

test('游离异常隔离：模块级兜底拦截 SDK 特征异常并计数', () => {
  assert.strictEqual(typeof _qqEscapeCount(), 'number', '应暴露 _qqEscapeCount 供诊断');

  const before = _qqEscapeCount();
  // SDK 特征异常（top 路由读 result.detail 于 HTTP 400）：应被隔离并计数
  const handled = _handleQQEscape(
    new TypeError("Cannot read properties of undefined (reading 'detail')"));
  assert.strictEqual(handled, true, 'SDK 特征异常应被识别并隔离');
  assert.strictEqual(_qqEscapeCount(), before + 1, '计数应 +1');

  // 非 SDK 异常：不归本模块管，须交还上层（否则会吞掉别人的错误）
  assert.strictEqual(
    _handleQQEscape(new Error('unrelated failure')), false,
    '非 SDK 特征异常不应被本模块吞掉',
  );
  assert.strictEqual(_qqEscapeCount(), before + 1, '未识别异常不应计数');
});
