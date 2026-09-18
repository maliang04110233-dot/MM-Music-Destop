/**
 * fixture 契约测试的期望值表（与 test/fixtures/platforms/*.search.json 逐字段手工核对）
 *
 * 每个 expect 条目是「字段子集」：只钉映射结果里最有契约含义的值
 * （id 编码、实体解码、HTML 剥离、时长换算、cover 拼装），全量形状由
 * platform-fixture.test.js 的 assertSongShape 负责。
 */
'use strict';

module.exports = {
  netease: {
    marker: 'ncm:search',
    expect: [
      {
        id: '186016',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        albumMid: '186017',
        cover: 'https://p1.music.126.net/2E0mZQ.jpg?param=300y300',
        duration: 269733,
      },
      { id: '186018', artist: '周杰伦 / 杨瑞代', duration: 223866, fee: 1 },
    ],
  },

  qq: {
    marker: 'qqapi:search',
    expect: [
      {
        id: '003OUlho2HcRHF',
        numId: '401174374',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        albumMid: '002MThns1dBR5U',
        cover: 'https://y.qq.com/music/photo_new/T002R300x300M000002MThns1dBR5U.jpg',
        duration: 269000,
      },
      { id: '001z9s452kKpZG', duration: 223000 },
    ],
  },

  kugou: {
    // 三种 hash 编进 id（:: 分隔），getUrl 再解码 —— 编码形状是硬契约
    marker: 'song_search_v2',
    expect: [
      {
        id: 'aabbccddeeff0011::sq000111222333::hq000111222333',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        cover: 'https://imgessl.kugou.com/stdmusic/aa/aabbccddeeff0011.jpg',
        duration: 264000,
      },
      {
        id: 'ddeeff001122::::hq4455667788',
        duration: 223000,
        cover: 'https://imgessl.kugou.com/stdmusic/dd/ddeeff001122.jpg',
      },
    ],
  },

  kuwo: {
    // MUSIC_ 前缀剔除、<em> 剥离、&amp; → ', '、相对封面补 https host
    marker: 'searchMusicBykeyWord',
    expect: [
      {
        id: '91234567',
        title: '晴天',
        artist: '周杰伦, 杨瑞代',
        album: '叶惠美',
        cover: 'https://img4.kuwo.cn/star/albumcover/17/89/3a1b.jpg',
        duration: 269000,
      },
    ],
  },

  bilibili: {
    // bvid 缺失回退 aid；"mm:ss" 与纯秒两种时长；pic 补 https: 前缀
    marker: 'web-interface/search/type',
    expect: [
      {
        id: 'BV1qt411p7hx',
        aid: 812345,
        title: '晴天 MV 周杰伦【4K修复】',
        artist: '周杰伦官方账号',
        album: '哔哩哔哩',
        cover: 'https://i0.hdslb.com/bfs/archive/abc123.jpg',
        duration: 269000,
      },
      { id: '999000', title: '稻香  live版', artist: 'UP主B', cover: '', duration: 223000 },
    ],
  },

  migu: {
    // 搜索接口不返回时长：duration 恒 0 是已知事实，不是缺陷
    marker: 'search_all.do',
    expect: [
      {
        id: '600577OHmn',
        title: '晴天',
        artist: '周杰伦、杨瑞代',
        album: '叶惠美',
        cover: 'http://m.sgxw.cn/pic/1/600/577/600577OHmn_a0.jpg',
        duration: 0,
      },
    ],
  },

  fivesing: {
    // id = `${songId}_${typeEname}`；stripHtml 解码实体；'null' 字面量歌手归空
    marker: 'home/json',
    expect: [
      { id: '26571775_fczx', title: '晴天', artist: '周杰伦', album: '', cover: '', duration: 0 },
      { id: '26571776_gfyx', title: '稻香', artist: '', duration: 0 },
    ],
  },

  soda: {
    // entity.track 与 legacy track 两种嵌套都要吃；url_cover 对象拼 cover；duration 毫秒
    marker: 'luna/search/track',
    expect: [
      {
        id: '70477183',
        title: '晴天',
        artist: '周杰伦',
        album: '叶惠美',
        cover: 'https://p.soda.com/album/690x690.jpg~c5_375x375.jpg',
        duration: 269733,
      },
      { id: '70477184', title: '稻香', artist: '', album: '', cover: '', duration: 223866 },
    ],
  },
};
