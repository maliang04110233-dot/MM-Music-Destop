/**
 * 平台契约测试（v3 · 阶段 4 —— 这一步才让 v3 成立）
 *
 * 为什么需要它：v3 把「平台」从 20 处手写副本收敛成 1 处 manifest + N 处**派生**。
 * 派生关系本身没有类型系统保护，只有测试能防它悄悄回退。
 * 本文件断言的是**契约**，不是实现细节：
 *
 *   1. manifest 完整性      —— 必填字段齐全
 *   2. 策略必须显式声明      —— "没想清楚"不能和"故意排除"长得一样
 *   3. 派生一致性            —— 与冻结值逐条相等（CORS 是唯一的安全边界，最重要）
 *   4. 无硬编码守卫          —— 防止将来有人又手写第二份平台清单
 *   5. 未被抽象覆盖的耦合点  —— recommendations.js / settings.js 的手写分派
 *   6. i18n 完整性           —— 平台名退出 i18n 后，其余键不得因此残破
 *
 * 冻结值来源：2026-09-17 阶段 0 基线快照（.preview/platform-baseline.json），
 * 经人工确认后**内联在此** —— 契约必须能在没有 .preview/（gitignore）的环境下运行。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { defaultRegistry, loadPlatformPlugins } = require('../src/api/pluginRegistry');
loadPlatformPlugins();
const reg = defaultRegistry;

// ── 冻结契约 ──────────────────────────────────────────────
const ALL_IDS = ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];
/** 平台顺序 = 展示顺序 = 聚合权重顺序，改动会静默影响搜索结果条数 */
const FROZEN_ORDER = ['netease', 'qq', 'bilibili', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];
/** 'all' 聚合时各源取几条（原来按下标 i===0?10:i===1?10:5 硬编码） */
const FROZEN_AGG_LIMIT = { netease: 10, qq: 10 };
const DEFAULT_AGG_LIMIT = 5;
/** 换源候选：故意排除 bilibili（其 artist 是 UP 主名，参与换源只会制造错配） */
const FROZEN_FALLBACK = ['netease', 'qq', 'kugou', 'kuwo', 'migu', 'fivesing', 'soda'];
/** 链接识别支持直取详情的平台 */
const FROZEN_LINK_PLATFORMS = ['netease', 'qq', 'bilibili', 'kugou'];
/** 🔴 安全边界：CORS 白名单必须与历史枚举**逐条相等**（不是"包含"） */
const FROZEN_LOCAL_ORIGINS = ['http://localhost', 'http://127.0.0.1'];
const FROZEN_PLATFORM_ORIGINS = [
  'https://music.163.com',
  'https://y.qq.com',
  'https://www.bilibili.com',
  'https://www.kugou.com',
  'http://www.kuwo.cn',
  'http://antiserver.kuwo.cn',
  'http://m.kuwo.cn',
  'https://img4.kuwo.cn',
  'https://pd.musicapp.migu.cn',
  'https://c.musicapp.migu.cn',
  'https://d.musicapp.migu.cn',
  'https://freetyst.nf.migu.cn',
  'https://music.migu.cn',
  'http://search.5sing.kugou.com',
  'http://mobileapi.5sing.kugou.com',
  'https://5sing.kugou.com',
  'https://api.qishui.com',
  'https://music.douyin.com',
];
const FROZEN_ORIGIN_SUFFIXES = ['.douyinvod.com', '.douyinpic.com', '.kugou.com'];

// ── 工具 ──────────────────────────────────────────────────
const sorted = (a) => [...a].sort();

/** 该行出现的**带引号的**平台 id 个数 */
function countPlatformIds(line) {
  const re = new RegExp(`['"\`](${ALL_IDS.join('|')})['"\`]`, 'g');
  return (line.match(re) || []).length;
}

/** 收集「一行里出现 ≥min 个平台 id」的行（= 手写清单的特征） */
function platformListLines(src, min = 3) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    const n = countPlatformIds(line);
    if (n >= min) out.push({ line: i + 1, n, text: line.trim().slice(0, 100) });
  });
  return out;
}

/** 定位 `const X = { ... };` 的花括号闭合位置，返回 [起始行, 结束行]（1-based） */
function objectSpanLines(src, declMarker) {
  const start = src.indexOf(declMarker);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        return [
          src.slice(0, start).split('\n').length,
          src.slice(0, i).split('\n').length,
        ];
      }
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════
// 1. manifest 完整性
// ══════════════════════════════════════════════════════════

test('契约：registry 自动发现 8 个平台，id 集合与冻结值一致', () => {
  assert.strictEqual(reg.size, 8, '平台数应为 8');
  assert.deepStrictEqual(sorted(reg.getIds()), sorted(ALL_IDS));
});

test('契约：每个平台必填字段齐全（id/name/search/getUrl/hosts.origins/policies.order）', () => {
  for (const p of reg.getAll()) {
    assert.ok(typeof p.id === 'string' && p.id.trim(), `${p.id}: id 非法`);
    assert.ok(typeof p.name === 'string' && p.name.trim(), `${p.id}: 缺 name`);
    assert.ok(typeof p.search === 'function', `${p.id}: 缺 search()`);
    assert.ok(typeof p.getUrl === 'function', `${p.id}: 缺 getUrl()`);
    assert.ok(
      p.hosts && Array.isArray(p.hosts.origins) && p.hosts.origins.length > 0,
      `${p.id}: 缺 hosts.origins（CORS 白名单由此派生）`,
    );
    assert.ok(typeof p.policies.order === 'number', `${p.id}: 缺 policies.order`);
  }
});

test('契约：badge 三色齐全 —— 消灭「忘补 CSS 只静默掉色」', () => {
  for (const p of reg.getAll()) {
    assert.ok(p.badge, `${p.id}: 缺 badge（徽标会掉回默认灰且不报错）`);
    for (const k of ['bg', 'fg', 'border']) {
      assert.ok(
        typeof p.badge[k] === 'string' && p.badge[k].trim(),
        `${p.id}: badge.${k} 缺失`,
      );
    }
  }
  assert.strictEqual(reg.toClientPayload().filter(p => p.badge).length, reg.size);
});

test('契约：平台名有中文名与英文名，且互不相同（下拉框不会出现两个同名项）', () => {
  const names = new Set();
  for (const p of reg.getAll()) {
    assert.ok(typeof p.nameEn === 'string' && p.nameEn.trim(), `${p.id}: 缺 nameEn`);
    assert.ok(!names.has(p.name), `${p.id}: name "${p.name}" 与其它平台重复`);
    names.add(p.name);
  }
});

test('契约：策略字段必须**显式声明**，不依赖 POLICY_DEFAULTS 兜底', () => {
  // 全用默认值时，"这个平台不参与换源"和"作者忘了写"长得一模一样。
  for (const p of reg.getAll()) {
    for (const k of ['order', 'fallbackSource', 'probeable', 'aggregateLimit']) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(p.policies, k),
        `${p.id}: 未显式声明 policies.${k}`,
      );
    }
    assert.strictEqual(typeof p.policies.fallbackSource, 'boolean', `${p.id}: fallbackSource 必须是布尔`);
    assert.strictEqual(typeof p.policies.probeable, 'boolean', `${p.id}: probeable 必须是布尔`);
  }
});

// ══════════════════════════════════════════════════════════
// 2. 派生一致性（与冻结值逐条相等）
// ══════════════════════════════════════════════════════════

test('派生：平台顺序 == 冻结顺序（顺序决定聚合权重与 UI 排序）', () => {
  assert.deepStrictEqual(reg.getIds(), FROZEN_ORDER);
});

test('派生：探针源 == 全部 8 个平台', () => {
  assert.deepStrictEqual(sorted(reg.getProbeSources()), sorted(ALL_IDS));
});

test('派生：换源候选 == 冻结 7 个（排除 bilibili）', () => {
  assert.deepStrictEqual(sorted(reg.getFallbackSources()), sorted(FROZEN_FALLBACK));
  assert.ok(!reg.getFallbackSources().includes('bilibili'), 'bilibili 不应参与换源');
});

test('派生：被排除换源的平台必须**显式**说明（不计入默认值兜底）', () => {
  for (const p of reg.getAll()) {
    if (!p._policies.fallbackSource) {
      assert.strictEqual(
        p.policies.fallbackSource, false,
        `${p.id} 不参与换源，但 policies.fallbackSource 不是显式的 false —— `
        + '这是决策还是个疏漏？请写明。',
      );
    }
  }
});

test('派生：聚合条数 netease/qq=10、其余=5（原为按数组下标 10/10/5）', () => {
  for (const p of reg.getAll()) {
    const want = FROZEN_AGG_LIMIT[p.id] ?? DEFAULT_AGG_LIMIT;
    assert.strictEqual(
      p._policies.aggregateLimit, want,
      `${p.id}: aggregateLimit 应为 ${want}`,
    );
  }
});

test('派生：链接识别平台 == 冻结 4 个，且每条 pattern 都带 extract', () => {
  const patterns = reg.getLinkPatterns();
  assert.deepStrictEqual(
    sorted([...new Set(patterns.map(x => x.platform))]),
    sorted(FROZEN_LINK_PLATFORMS),
  );
  // extract 缺失会让 parseMusicLink 静默拿不到 id（初版设计稿就漏了这个字段）
  for (const x of patterns) {
    assert.ok(x.re instanceof RegExp, `${x.platform}/${x.type}: re 不是正则`);
    assert.strictEqual(typeof x.extract, 'function', `${x.platform}/${x.type}: 缺 extract`);
  }
});

test('🔴 安全边界：CORS 平台域名 == 冻结 18 条，逐条相等（不是"包含"）', () => {
  const { origins } = reg.getAllowedOrigins();
  assert.deepStrictEqual(sorted(origins), sorted(FROZEN_PLATFORM_ORIGINS));
});

test('🔴 安全边界：CORS 后缀 == 冻结 3 条，且都带前导点', () => {
  const { suffixes } = reg.getAllowedOrigins();
  assert.deepStrictEqual(sorted(suffixes), sorted(FROZEN_ORIGIN_SUFFIXES));
  // 前导点是防 evil-douyinvod.com 这类绕过的关键，不能省
  for (const s of suffixes) {
    assert.ok(s.startsWith('.'), `后缀 "${s}" 缺少前导点，会放行 evil-xxx.com`);
  }
});

test('🔴 安全边界：本地源独立于平台清单，全量白名单恰为 20 条', () => {
  const src = read('src/main/index.js');
  assert.ok(/LOCAL_ORIGINS\s*=\s*\[/.test(src), 'main/index.js 应保留 LOCAL_ORIGINS 常量');
  const local = [...src.matchAll(/LOCAL_ORIGINS\s*=\s*\[([^\]]*)\]/g)]
    .flatMap(m => [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]));
  assert.deepStrictEqual(sorted(local), sorted(FROZEN_LOCAL_ORIGINS));
  const { origins } = reg.getAllowedOrigins();
  assert.strictEqual(
    new Set([...local, ...origins]).size,
    FROZEN_LOCAL_ORIGINS.length + FROZEN_PLATFORM_ORIGINS.length,
  );
});

// ══════════════════════════════════════════════════════════
// 3. 渲染层契约（清单下发一致性）
// ══════════════════════════════════════════════════════════

test('UI：toClientPayload() 剔除函数、保留展示与能力字段', () => {
  const payload = reg.toClientPayload();
  assert.strictEqual(payload.length, 8);
  assert.deepStrictEqual(sorted(payload.map(p => p.id)), sorted(ALL_IDS));
  for (const item of payload) {
    assert.ok(!('search' in item) && !('getUrl' in item), `${item.id}: payload 不应带函数`);
    assert.strictEqual(typeof item.name, 'string');
    assert.strictEqual(typeof item.nameEn, 'string');
    assert.strictEqual(typeof item.badge, 'object');
    assert.strictEqual(typeof item.capabilities, 'object');
    // 策略是规范化后的结果（含默认值补齐），渲染层可直接消费
    for (const k of ['order', 'fallbackSource', 'probeable', 'aggregateLimit']) {
      assert.ok(k in item.policies, `${item.id}: payload.policies 缺 ${k}`);
    }
    assert.strictEqual(typeof item.policies.order, 'number');
  }
  // 与探针源集合一致 —— 两者都来自同一 registry，不应出现"下拉里有但探针没有"
  assert.deepStrictEqual(sorted(payload.map(p => p.id)), sorted(reg.getProbeSources()));
});

test('UI：能力由方法存在性推导，不额外声明（抽查 netease/kuwo）', () => {
  const ne = reg.getCapabilities('netease');
  assert.strictEqual(ne.album, typeof reg.get('netease').searchAlbum === 'function');
  assert.strictEqual(ne.lyrics, true);
  assert.strictEqual(ne.linkDetail, true);

  const ku = reg.getCapabilities('kuwo');
  assert.strictEqual(ku.lyrics, true);
  // kuwo 只有三能力：不能虚报专辑/歌手
  assert.strictEqual(ku.album, false);
  assert.strictEqual(ku.singer, false);
  assert.strictEqual(ku.cookie, false);
});

test('UI：index.html 不再写死平台 <option>（源下拉由 renderSourceSelect 生成）', () => {
  const html = read('src/renderer/index.html');
  const select = /<select[^>]*id="sourceSelect"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(select, 'index.html 应仍有 #sourceSelect');
  const options = [...select[1].matchAll(/<option[^>]*value="([^"]*)"/g)].map(m => m[1]);
  assert.deepStrictEqual(options, ['all'], `#sourceSelect 内联选项应只剩 all，实际: ${options}`);
});

test('UI：renderSourceSelect 存在并消费传入清单（不内联平台 id）', () => {
  const src = read('src/renderer/js/views/search.js');
  assert.ok(/function renderSourceSelect\s*\(/.test(src), 'search.js 应有 renderSourceSelect');
  assert.ok(/window\.renderSourceSelect\s*=/.test(src), 'renderSourceSelect 应桥接到 window');
  assert.strictEqual(
    platformListLines(src).length, 0,
    'renderSourceSelect 内不应出现平台 id 字面量清单',
  );
});

test('UI：app.js 在 applyTranslations() **之前**拉取平台清单（顺序陷阱）', () => {
  // ⚠️ 必须先剥注释。app.js 与本文件的注释里都**提到了** applyTranslations()，
  //    直接 indexOf 会命中注释自身 —— 这个坑在本次实现中已踩过一次（补丁脚本断言）。
  const src = read('src/renderer/js/app.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const iPlatforms = src.indexOf('renderSourceSelect(');
  const iI18n = src.indexOf('applyTranslations()');
  assert.ok(iPlatforms > 0, 'app.js 应调用 renderSourceSelect');
  assert.ok(iI18n > 0, 'app.js 应调用 applyTranslations');
  assert.ok(
    iPlatforms < iI18n,
    '顺序错误：renderSourceSelect 必须在 applyTranslations 之前，'
    + '否则新插入的 <option data-i18n> 拿不到翻译',
  );
});

test('UI：utils.js 的 platformName 具备降级兜底（清单缺失不炸界面）', () => {
  const src = read('src/renderer/js/utils.js');
  assert.ok(/FALLBACK_PLATFORM_NAMES/.test(src), '应有兜底名称表');
  assert.ok(/function platformName\s*\(/.test(src), '应有 platformName(id)');
  assert.ok(/function setPlatforms\s*\(/.test(src), '应有 setPlatforms(list)');
  assert.ok(/window\.platformName\s*=/.test(src), 'platformName 应桥接到 window');
});

// ══════════════════════════════════════════════════════════
// 4. 无硬编码守卫（防止将来又手写第二份清单）
// ══════════════════════════════════════════════════════════

test('守卫：主进程侧不存在平台 id 字面量清单', () => {
  const files = [
    'src/utils/matchMusic.js',
    'src/main/ipc/search.js',
    'src/main/index.js',
    'src/api/index.js',
    'src/utils/linkParser.js',
    'src/renderer/js/views/search.js',
    'src/renderer/js/views/settings.js',
    'src/renderer/js/player.js',
  ];
  const offenders = [];
  for (const rel of files) {
    for (const hit of platformListLines(read(rel), 3)) {
      offenders.push(`${rel}:${hit.line} — ${hit.text}`);
    }
  }
  assert.deepStrictEqual(offenders, [],
    '这些位置又出现了手写的平台清单，请改为从 registry 派生：\n' + offenders.join('\n'));
});

test('守卫：renderer/js/utils.js 的平台 id 只允许出现在兜底表内', () => {
  const src = read('src/renderer/js/utils.js');
  const span = objectSpanLines(src, 'const FALLBACK_PLATFORM_NAMES');
  assert.ok(span, 'utils.js 应保留 FALLBACK_PLATFORM_NAMES 兜底表');
  const [startLine, endLine] = span;
  const outside = platformListLines(src, 3).filter(h => h.line < startLine || h.line > endLine);
  assert.deepStrictEqual(outside, [],
    '兜底表之外不允许出现平台 id 清单（兜底表是唯一豁免，且只含名称）：\n'
    + outside.map(h => `  ${h.line}: ${h.text}`).join('\n'));
});

test('守卫：api/index.js 不再 require 平台模块（平台清单不得长回 API 层）', () => {
  const src = read('src/api/index.js');
  assert.ok(!/require\('\.\/platforms\//.test(src), 'api/index.js 不应再直接 require 平台模块');
  assert.ok(!/_ADAPTERS/.test(src), 'api/index.js 不应再有手写适配器表');
  assert.ok(/loadPlatformPlugins/.test(src), 'api/index.js 应通过 loadPlatformPlugins 自动发现');
});

// ══════════════════════════════════════════════════════════
// 5. 尚未被 registry 覆盖的耦合点（存在但已被"钉住"）
// ══════════════════════════════════════════════════════════

test('守卫：recommendations.js 经 gateway 调用平台，不再直连或手写分派', () => {
  // v3 阶段 2 已完成迁移：该文件原先直接 require 4 个平台模块 + 按 id 写 if/else，
  // 导致「新平台实现了 searchSinger 也不可达」（第 22 个耦合点）。
  // 现在全部经 gateway，本测试改为**钉住新状态**：一旦有人写回直连即红。
  const src = read('src/api/recommendations.js');
  assert.ok(
    !/require\('\.\/platforms\//.test(src),
    'recommendations.js 不应再直接 require 平台模块（应经 gateway）',
  );

  // 能力分派必须走 gateway，而不是手写平台 id 分支。
  // 唯一豁免：SOURCE_PREFERENCE 策略常量区 —— 那是**产品决策**
  // （「先试哪个源」无法从平台能力推导），且集中在一处、被本测试的
  // 存在性断言钉住。剥离该区块后再扫描，避免常量本身误报。
  const STRATEGY_BLOCK = /const SOURCE_PREFERENCE = Object\.freeze\(\{[\s\S]*?\n\}\);/;
  assert.ok(STRATEGY_BLOCK.test(src),
    'recommendations.js 应保留集中的 SOURCE_PREFERENCE 策略常量（勿散落回 if/else）');

  // ⚠️ 必须先剥注释再扫描：本仓库有「注释里写代码示例」的惯例
  //    （如说明历史行为 `source==='qq'`），不剥会误报。
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const withoutStrategy = stripComments(src).replace(STRATEGY_BLOCK, '');

  const hardcoded = [...withoutStrategy.matchAll(/(?:===|!==)\s*'(netease|qq|kugou|bilibili|kuwo|migu|fivesing|soda)'/g)]
    .map((m) => m[1]);
  assert.deepStrictEqual(
    hardcoded, [],
    `recommendations.js 策略区之外仍存在平台 id 字面量比较（应用能力推导/策略常量）：${hardcoded.join(', ')}`,
  );

  // 必须已接入 gateway
  assert.ok(/setGateway/.test(src), 'recommendations.js 应通过 setGateway 接入 platform gateway');
});

test('守卫：所有消费方均不直连平台模块（gateway 是唯一调用出口）', () => {
  // 允许直连的两类例外：
  //   1. src/api/platforms/* 自身
  //   2. 平台单测（test/{fivesing,kuwo,migu,qq,soda}.test.js 直接测平台实现）
  const ALLOW = /^(src\/api\/platforms\/|test\/[a-z0-9]+\.test\.js$)/;
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`.replace(/\\/g, '/').replace(/^\.\//, '');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.preview') continue;
        walk(rel);
      } else if (entry.name.endsWith('.js')) {
        if (ALLOW.test(rel)) continue;
        const src = read(rel);
        const hits = [...src.matchAll(/require\((?:'|")[^'"]*platforms\/[a-z0-9]+(?:'|")\)/g)];
        // 平台单测按文件名豁免；其余文件出现直连即记
        if (hits.length && !/^test\/[a-z0-9]+\.test\.js$/.test(rel)) {
          offenders.push(`${rel} (${hits.length} 处)`);
        }
      }
    }
  };
  walk('src');
  walk('test');

  assert.deepStrictEqual(
    offenders, [],
    '以下文件绕过 gateway 直连平台模块（应改走 gateway）：\n  ' + offenders.join('\n  '),
  );
});

test('守卫：settings.js 的 Cookie 账号卡 == registry 的 cookie 能力平台 == index.html 的卡片', () => {
  const declared = sorted(reg.getAll().filter(p => p._caps.cookie).map(p => p.id));
  assert.deepStrictEqual(declared, sorted(['netease', 'qq', 'bilibili']),
    '支持 Cookie 登录的平台发生变化，请同步更新设置页与 index.html');

  const jsIds = sorted([...read('src/renderer/js/views/settings.js')
    .matchAll(/\{\s*id:\s*'([a-z0-9]+)',\s*name:/g)].map(m => m[1]));
  assert.deepStrictEqual(jsIds, declared, 'settings.js 的 PLATFORMS 与 registry 不一致');

  const htmlIds = sorted([...read('src/renderer/index.html')
    .matchAll(/data-platform="([a-z0-9]+)"/g)].map(m => m[1]));
  assert.deepStrictEqual(htmlIds, declared, 'index.html 的账号卡与 registry 不一致');
});

test('IPC：get-platforms 三处登记齐全（漏一处静默失效）', () => {
  const search = read('src/main/ipc/search.js');
  const preload = read('src/main/preload.js');
  assert.ok(/ipcMain\.handle\(\s*'get-platforms'/.test(search), '主进程未注册 get-platforms');

  // ⚠️ 不能按前后顺序切文件取块：preload 里三张表的**声明顺序**是
  //    SEND → RECEIVE → INVOKE，按 RECEIVE 切会把 INVOKE 切到后半段（已踩）。
  //    改为锚定各表自身的声明区段。
  const invokeBlock = /const SAFE_CHANNELS_INVOKE = new Set\(\[([\s\S]*?)\]\)/.exec(preload);
  assert.ok(invokeBlock, 'preload 应存在 SAFE_CHANNELS_INVOKE 白名单');
  assert.ok(/'get-platforms'/.test(invokeBlock[1]), 'SAFE_CHANNELS_INVOKE 未登记 get-platforms');
  assert.ok(/getPlatforms:\s*'get-platforms'/.test(preload), 'METHOD_MAP 未登记 getPlatforms');
});

// ══════════════════════════════════════════════════════════
// 6. i18n 完整性（平台名退出 i18n 之后）
// ══════════════════════════════════════════════════════════

test('i18n：zh/en 键集合完全一致', () => {
  const zh = Object.keys(JSON.parse(read('src/renderer/js/lang/zh.json')));
  const en = Object.keys(JSON.parse(read('src/renderer/js/lang/en.json')));
  const onlyZh = zh.filter(k => !en.includes(k));
  const onlyEn = en.filter(k => !zh.includes(k));
  assert.deepStrictEqual({ onlyZh, onlyEn }, { onlyZh: [], onlyEn: [] });
});

test('i18n：平台名键已移除，且平台名不再回退到 i18n', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const removed = [
    'home.neteaseTab', 'home.qqTab', 'home.biliTab',
    'search.netease', 'search.qq', 'search.kugou', 'search.kuwo',
    'search.migu', 'search.fivesing', 'search.soda', 'search.bilibili',
  ];
  for (const k of removed) {
    assert.ok(!(k in zh), `zh.json 仍残留平台名键 ${k}`);
    assert.ok(!(k in en), `en.json 仍残留平台名键 ${k}`);
  }
  // 平台名唯一来源是 manifest：渲染层不应再引用这些键
  for (const rel of ['src/renderer/index.html', 'src/renderer/js/views/home.js']) {
    const src = read(rel);
    for (const k of removed) {
      assert.ok(!src.includes(`"${k}"`) && !src.includes(`'${k}'`), `${rel} 仍引用 ${k}`);
    }
  }
  // 但「全部」与分区标题必须留下
  for (const k of ['search.all', 'home.subtab.tops']) {
    assert.ok(k in zh && k in en, `误删了必须保留的键 ${k}`);
  }
});

test('i18n：所有 data-i18n 键都在 zh/en 中存在（启用 i18n 后漏键 = 界面露裸串）', () => {
  const zh = JSON.parse(read('src/renderer/js/lang/zh.json'));
  const en = JSON.parse(read('src/renderer/js/lang/en.json'));
  const missing = [];
  for (const rel of ['src/renderer/index.html', 'src/renderer/mini-player.html']) {
    for (const m of read(rel).matchAll(/data-i18n="([^"]+)"/g)) {
      if (!(m[1] in zh)) missing.push(`${rel}: ${m[1]} 缺 zh`);
      else if (!(m[1] in en)) missing.push(`${rel}: ${m[1]} 缺 en`);
    }
  }
  assert.deepStrictEqual(missing, [], '缺键会让界面直接显示裸 key：\n' + missing.join('\n'));
});

test('i18n：window.i18n 已被挂载（否则语言切换整条链是死代码）', () => {
  const src = read('src/renderer/js/i18n.js');
  assert.ok(/window\.i18n\s*=/.test(src),
    'window.i18n 未挂载 —— app.js 的启动恢复与设置页语言下拉都会静默失效');
  for (const fn of ['loadLanguage', 'getLang', 'applyTranslations', 'setLanguage']) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(src), `window.i18n 应暴露 ${fn}`);
  }
});
