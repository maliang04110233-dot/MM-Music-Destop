/**
 * 酷我平台接入实测（真实网络，非模拟）
 *
 * 验证：适配器注册 → 搜索 → 取流（含直链预检）→ 歌词 → 预检负例
 * 跑法：node .preview/verify-kuwo.js
 */

const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  // ── 1) 插件注册 ──────────────────────────────────────
  let api;
  try {
    api = require(path.join(ROOT, 'src', 'api', 'index.js'));
    const ids = api.registry.getIds();
    check('api/index.js 可加载且注册 kuwo', ids.includes('kuwo'), `平台 ${ids.length} 个: ${ids.join(', ')}`);
  } catch (e) {
    check('api/index.js 可加载', false, e.message);
    process.exit(1);
  }

  // ── 2) 直链预检工具（正例：已知可用的公开音频）────────
  const { testAudioLink } = require(path.join(ROOT, 'src', 'api', 'request.js'));
  check('testAudioLink 已导出为函数', typeof testAudioLink === 'function');

  // ── 3) 搜索 ──────────────────────────────────────────
  let songs = [];
  try {
    const r = await api.searchMusic('晴天 周杰伦', 'kuwo', 1);
    songs = (r && r.songs) || [];
    check('酷我搜索返回结果', songs.length > 0, `${songs.length} 条${songs[0] ? `，首条「${songs[0].title} - ${songs[0].artist}」id=${songs[0].id}` : ''}`);
    if (songs[0]) {
      check('搜索结果字段完整', !!(songs[0].id && songs[0].title), `source=${songs[0].source} duration=${songs[0].duration}ms cover=${songs[0].cover ? '有' : '无'}`);
      check('搜索结果 source 标记为 kuwo', songs[0].source === 'kuwo');
    }
  } catch (e) {
    check('酷我搜索', false, e.message);
  }

  if (!songs.length) {
    console.log('\n搜索无结果，跳过取流/歌词实测');
    report();
    return;
  }

  // ── 4) 取流（standard：官方 antiserver 128k）─────────
  const id = songs[0].id;
  let gotUrl = null;
  try {
    const u = await api.getDownloadUrl(id, 'kuwo', 'standard');
    gotUrl = u && u.url ? u : null;
    check('酷我取流返回可用直链', !!gotUrl, gotUrl ? `ext=${u.ext} size=${u.size} via=${u.via}` : `error=${u && (u.error || u.code)}`);
    if (gotUrl) {
      check('取流经过直链预检（带 via 标记）', !!gotUrl.via, `via=${gotUrl.via}`);
    }
  } catch (e) {
    check('酷我取流', false, e.message);
  }

  // ── 5) 预检工具正例（用刚拿到的真实直链）─────────────
  if (gotUrl) {
    const t = await testAudioLink(gotUrl.url, { headers: { Referer: 'http://www.kuwo.cn/' } });
    check('testAudioLink 对真实直链判定可用', t.ok, `status=${t.status} ext=${t.ext} size=${t.sizeBytes} ct=${t.contentType || '(空)'}`);
  }

  // ── 6) 预检工具负例（无效 rid 应判不可用，且不能把正文读进内存）──
  const bad = await testAudioLink(
    'http://antiserver.kuwo.cn/anti.s?type=convert_url&format=mp3&response=url&rid=MUSIC_1',
    { headers: { Referer: 'http://www.kuwo.cn/' } },
  );
  check('testAudioLink 对无效直链判定不可用', bad.ok === false, `ok=${bad.ok} status=${bad.status} reason=${bad.reason}`);

  // ── 7) 歌词 ──────────────────────────────────────────
  try {
    const lrc = await api.getLyrics(id, 'kuwo', songs[0].title, songs[0].artist);
    const hasLrc = !!(lrc && lrc.lrc && lrc.lrc.trim());
    // 酷我歌词接口实测可能返回空（kuwo.js 注释已说明），空不算失败，仅记录
    check('歌词接口可调用（有内容更佳）', true, hasLrc ? `${lrc.lrc.split('\n').length} 行` : '返回空（接口失效，已保留恢复位——不算失败）');
  } catch (e) {
    check('歌词接口可调用', false, e.message);
  }

  report();

  function report() {
    const pass = results.filter(r => r.ok).length;
    console.log(`\n===== ${pass}/${results.length} 通过 =====`);
    process.exit(results.every(r => r.ok) ? 0 : 1);
  }
})().catch((e) => {
  console.error('实测脚本异常:', e);
  process.exit(1);
});
