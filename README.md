# 音乐下载器

多平台音乐下载桌面应用，支持**网易云音乐**、**QQ音乐**、**哔哩哔哩**、**酷狗音乐**、**酷我音乐**。

## 功能

- 🔍 **多平台搜索** — 网易云 / QQ音乐 / B站 / 酷狗 / 酷我 聚合搜索
- ⬇ **高品质下载** — 支持标准 / 高品质 / 无损（视平台授权）
- 🏷 **ID3 元数据** — 自动嵌入标题、艺术家、专辑、封面图、歌词
- 📝 **歌词下载** — 自动获取 LRC 歌词并生成独立文件
- 🎵 **内置播放器** — 搜索结果可直接试听，歌词同步滚动
- 📋 **下载队列** — 多任务并发下载，进度实时显示
- 🔀 **随机 / 循环** — 随机播放、列表循环、单曲循环

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式运行（含 DevTools）
npm run dev

# 正式运行
npm start

# 打包（Windows 安装包）
npm run build
```

## 目录结构

```
music-downloader/
├── src/
│   ├── main/
│   │   ├── index.js       # Electron 主进程
│   │   └── preload.js     # 上下文桥接
│   ├── api/
│   │   └── music.js       # 多平台 API 聚合
│   ├── renderer/
│   │   └── index.html     # 渲染进程 UI
│   └── utils/
│       └── downloader.js  # 下载 & ID3 工具
├── package.json
└── README.md
```

## 依赖

| 包 | 用途 |
|---|---|
| electron | 桌面应用框架 |
| music-metadata | 音频元数据读取（MP3/FLAC/M4A 全格式） |
| NeteaseCloudMusicApi | 网易云音乐 API |
| qq-music-api | QQ 音乐 API |
| node-id3 | MP3 ID3 标签写入 |
| crypto-js | 网易云 API 加密 |
| iconv-lite | GBK 编码歌词解码（Windows 兼容） |

## 声明

本项目仅供学习研究使用，请遵守各平台服务条款。
