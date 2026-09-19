/**
 * 单元测试：单曲右键「以此音质下载」
 *
 * quality.js 的 qualityOverrideOptions 决定候选档（固定音质平台不给选项、
 * 当前解析档剔除）；songMenu.js 的 qualityDownloadItems 组装菜单项。
 * 两者都是纯函数，直接测。渲染层模块顶层读 window.location（logger），
 * 导入前先补桩 —— 与 song-menu.test.js 同一模式。
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global.window || {
  location: { hostname: 'localhost', protocol: 'file:' },
  addEventListener: () => {},
};

async function freshMenu() {
  return import('../src/renderer/js/songMenu.js?tc=' + Math.random());
}
async function freshQuality() {
  return import('../src/renderer/js/quality.js?tc=' + Math.random());
}

test('qualityOverrideOptions: 剔除当前档，返回其余候选', async () => {
  const { qualityOverrideOptions } = await freshQuality();
  const opts = qualityOverrideOptions('qq', 'hq');
  assert.deepEqual(opts.map(o => o.value), ['standard', 'lossless']);
  assert.equal(opts[0].label, '标准 128k');
  assert.equal(opts[1].label, '无损 FLAC');
});

test('qualityOverrideOptions: 固定音质平台返回空表；当前档非法时全档可选', async () => {
  const { qualityOverrideOptions } = await freshQuality();
  assert.deepEqual(qualityOverrideOptions('migu', 'hq'), []);
  assert.deepEqual(qualityOverrideOptions('soda', 'standard'), []);
  assert.equal(qualityOverrideOptions('netease', null).length, 3);
  assert.equal(qualityOverrideOptions('netease', 'flac').length, 3);
});

test('qualityDownloadItems: 菜单项文案与点击回传档位值', async () => {
  const { qualityDownloadItems } = await freshMenu();
  const picked = [];
  const items = qualityDownloadItems('netease', 'standard', (q) => picked.push(q));
  assert.equal(items.length, 2);
  assert.ok(items[0].label.includes('以此音质下载：高品质 320k'));
  assert.ok(items[1].label.includes('以此音质下载：无损 FLAC'));
  items[0].onClick();
  items[1].onClick();
  assert.deepEqual(picked, ['hq', 'lossless']);
});

test('qualityDownloadItems: 固定音质平台不产出菜单项', async () => {
  const { qualityDownloadItems } = await freshMenu();
  assert.deepEqual(qualityDownloadItems('migu', 'hq', () => {}), []);
});
