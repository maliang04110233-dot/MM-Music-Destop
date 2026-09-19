// m3u 歌单文本解析（m3uImport.js，纯 ESM 无 window 依赖）
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fresh = () => import(`../src/renderer/js/m3uImport.js?ck=${Math.random()}`);

test('标准 EXTINF：取逗号后描述，跳过路径行与指令行', async () => {
  const { parseM3u } = await fresh();
  const text = [
    '#EXTM3U',
    '#EXTINF:240,周杰伦 - 晴天',
    'D:\\Music\\cd1\\01 周杰伦 - 晴天.flac',
    '#EXTVLCOPT:radio-text=xxx',
    '#EXTINF:-1,陈奕迅 - 十年',
    '/music/eason/ten.mp3',
  ].join('\n');
  assert.deepEqual(parseM3u(text), ['周杰伦 - 晴天', '陈奕迅 - 十年']);
});

test('描述为 - 或空时回退路径行文件名（去目录去扩展名）', async () => {
  const { parseM3u } = await fresh();
  const text = [
    '#EXTM3U',
    '#EXTINF:200,-',
    'https://cdn/x/02. 林俊杰 - 江南.mp3',
    '#EXTINF:180,',
    'D:\\a\\b\\solo.flac',
  ].join('\n');
  assert.deepEqual(parseM3u(text), ['02. 林俊杰 - 江南', 'solo']);
});

test('无 EXTINF 的纯文本行列表原样成行（含 CRLF 与 BOM）', async () => {
  const { parseM3u } = await fresh();
  const text = '\uFEFF#EXTM3U\r\n五月天 - 倔强\r\n\r\n  李荣浩 - 年少有为  \r\n';
  assert.deepEqual(parseM3u(text), ['五月天 - 倔强', '李荣浩 - 年少有为']);
});

test('连续 EXTINF 坏文件不吞前条；尾部 EXTINF 无路径行也落袋', async () => {
  const { parseM3u } = await fresh();
  assert.deepEqual(parseM3u('#EXTINF:1,A - 甲\n#EXTINF:2,B - 乙\n'), ['A - 甲', 'B - 乙']);
  assert.deepEqual(parseM3u('#EXTM3U\n#EXTINF:3,C - 丙'), ['C - 丙']);
  assert.deepEqual(parseM3u('#EXTM3U\n#EXTINF:4,-'), []); // 只有 - 无路径：无输出
});

test('maxLines 封顶与脏输入安全', async () => {
  const { parseM3u } = await fresh();
  const many = Array.from({ length: 50 }, (_, i) => `s - t${i}`).join('\n');
  assert.equal(parseM3u(many, 10).length, 10);
  assert.deepEqual(parseM3u(null), []);
  assert.deepEqual(parseM3u(''), []);
  assert.deepEqual(parseM3u('   \n\t\n'), []);
});

test('扩展名剥离仅限常见音频格式，其它点号不动', async () => {
  const { parseM3u } = await fresh();
  const text = '#EXTINF:1,-\n/dir/歌手 - 歌名 (live).m4a\n/dir/readme.txt';
  assert.deepEqual(parseM3u(text), ['歌手 - 歌名 (live)', 'readme.txt']);
});
