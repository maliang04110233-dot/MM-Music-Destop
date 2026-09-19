/**
 * AI 音乐生成模块（基于 MiniMax API）
 *
 * 功能：
 *   - 根据歌词+风格生成音乐
 *   - AI 生成歌词
 *   - 生成历史记录
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const { readFile, writeFile } = require('fs/promises');
const path = require('path');
const logger = require('../utils/logger');

// MiniMax API 配置
const MINIMAX_API_BASE = 'https://api.minimaxi.com';


// 生成历史存储路径
let _historyPath = null;

function setHistoryPath(userDataPath) {
  _historyPath = path.join(userDataPath, 'ai-music-history.json');
}

/**
 * 通用 HTTP 请求
 */
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const lib = parsedUrl.protocol === 'https:' ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      timeout: options.timeout || 300000,
    };

    // H3: 自动重试（最多 3 次，仅对超时/网络错误）
    const maxRetries = options.retries ?? 3;
    const baseDelay = options.retryDelay ?? 1000;

    function doRequest(retryCount = 0) {
      const req = lib.request(reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, data });
          }
        });
      });

      req.on('error', (e) => {
        if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          setTimeout(() => doRequest(retryCount + 1), delay);
        } else {
          reject(e);
        }
      });
      req.on('timeout', () => {
        req.destroy();
        if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          setTimeout(() => doRequest(retryCount + 1), delay);
        } else {
          reject(new Error('请求超时'));
        }
      });

      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    }

    doRequest(0);
  });
}

/**
 * AI 生成歌词 + 音乐 Prompt（精简输入版）
 *
 * 用户只需要给出关键词/主题和风格，AI 自动生成：
 *   1. 详细的音乐描述 prompt（用于 MiniMax Music API 的 prompt 字段）
 *   2. 完整的歌词 + 标题
 *
 * @param {Object} params
 * @param {string} params.topic - 主题/关键词（简短，如"夏日海滩"）
 * @param {string} params.style - 风格键名（pop/rock/ballad/electronic 等）
 * @param {string} params.apiKey - MiniMax API Key
 * @param {string} [params.mode] - 模式：'song'（默认，生成音乐描述+歌词）或 'playlist'（生成歌单列表）
 * @returns {Promise<{lyrics: string, title: string, musicPrompt: string}>}
 */
async function generateLyrics(params) {
  const {
    topic,
    style = 'pop',
    apiKey,
    mode = 'song',
  } = params;

  if (!apiKey) throw new Error('请先配置 MiniMax API Key');

  // L6: 清理 prompt 注入风险 — 移除用户输入中的控制序列和特殊字符
  const cleanTopic = String(topic || '').replace(/[`$\\{}]/g, '').slice(0, 200);
  const cleanStyle = String(style || 'pop').slice(0, 50);

  // ── 根据 mode 选择提示词 ──
  let prompt;
  let systemMsg;

  if (mode === 'playlist') {
    // 歌单策划模式：生成歌曲推荐列表
    systemMsg = `你是一位专业的音乐推荐师，擅长根据用户描述推荐合适的歌曲。请输出推荐的歌曲列表，每行一首。`;
    prompt = `请根据以下用户描述，推荐歌曲：

用户需求：${cleanTopic || '生成一些好听的歌曲'}

要求：
1. 每行一首歌曲，格式：序号. 歌曲名 - 歌手
2. 推荐 8-15 首歌曲
3. 歌曲风格多样，质量高
4. 直接输出列表，不要多余解释

输出格式：
1. 歌曲名 - 歌手
2. 歌曲名 - 歌手
...`;
  } else {
    // 默认 song 模式：同时生成音乐描述 + 歌词
    systemMsg = `你是一位顶级的音乐制作人和词曲创作人。擅长根据简单的关键词和风格，创作出适合 AI 音乐生成模型的详细音乐描述，并写出与之匹配的完整歌词。你的特点：
1. 音乐描述精准且富有画面感，详细描述配器、节奏和氛围
2. 歌词语言优美、押韵自然
3. 结构清晰，使用[主歌][副歌][桥段][结尾]等标准标签
4. 音乐描述和歌词风格高度统一

如果你一次输出多个版本，会更有创作价值。`;

    prompt = `你是一位顶级的音乐制作人和词曲创作人。

用户只提供了一个主题关键词和音乐风格。请基于以下信息，**同时创作出 2 个不同版本**的歌词：

## 用户输入
- 主题/关键词：${cleanTopic || '自由创作'}
- 音乐风格：${cleanStyle}

## 你的任务

### 第一部分：音乐描述（Music Prompt）
写一段 30-60 字的音乐描述，用于输入 AI 音乐生成模型。要求：
- 描述配器（乐器）、节奏速度、氛围情绪、制作风格
- 风格特征鲜明、画面感强
- 直接可作生成模型的 prompt，不要解释

### 第二部分：歌词
创作**2个不同版本**的歌词（版本A、版本B）：
- **版本A**：按标准方向创作
- **版本B**：从完全不同的主题角度/歌词结构/叙事视角创作，与版本A有明显差异
- 每个版本都包含完整的两段主歌+副歌结构
- 使用结构标签：[主歌1] [副歌] [主歌2] [副歌] [桥段] [副歌] [结尾]
- 每段 4-6 行，副歌重复时有记忆点
- 标题：版本A和版本B共用同一个标题，4-8个字，富有意境

## 输出格式（严格按此格式，不要多余内容）

音乐描述：<音乐描述文本>

标题：<歌曲标题>

=== 版本A ===
[主歌1]
<歌词>

[副歌]
<歌词>

[主歌2]
<歌词>

[副歌]
<歌词>

[桥段]
<歌词，可选>

[副歌]
<歌词>

[结尾]
<歌词>

=== 版本B ===
[主歌1]
<歌词>

[副歌]
<歌词>

[主歌2]
<歌词>

[副歌]
<歌词>

[桥段]
<歌词，可选>

[副歌]
<歌词>

[结尾]
<歌词>`;
  }

  try {
    const result = await request(`${MINIMAX_API_BASE}/v1/text/chatcompletion_v2`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: {
        model: 'MiniMax-Text-01',
        messages: [
          {
            role: 'system',
            content: systemMsg,
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.8,
        max_tokens: mode === 'playlist' ? 2048 : 4096,
      },
    });

    if (result.status !== 200 || !result.data?.choices) {
      throw new Error(result.data?.error?.message || '歌词生成失败');
    }

    const rawContent = result.data.choices[0]?.message?.content || '';

    // 解析音乐描述、标题和歌词
    let title = '';
    let musicPrompt = '';
    let parsedLyrics;

    // ── 稳健解析策略 ──
    // AI 可能输出：
    // （开场白）
    // 音乐描述：<第一行>
    // <更多描述行>
    // 
    // 标题：<歌名>
    //
    // [主歌1]
    // <歌词>
    // ...
    // 我们需要可靠地剥离非歌词内容，只保留[标签]歌词

    const musicDescIdx = rawContent.indexOf('音乐描述');
    if (musicDescIdx !== -1) {
      // 找到下一个章节标记的位置（标题 / === / [ 或字符串末尾）
      const afterMpTitle = rawContent.indexOf('\n标题', musicDescIdx);
      const afterMpBracket = rawContent.indexOf('\n[', musicDescIdx);
      const afterMpVersion = rawContent.indexOf('\n===', musicDescIdx);
      let blockEnd = rawContent.length;
      const candidates = [afterMpTitle, afterMpBracket, afterMpVersion].filter(i => i !== -1);
      if (candidates.length > 0) blockEnd = Math.min.apply(null, candidates);

      // 提取音乐描述（仅第一行，作为 MiniMax Music API 的 prompt）
      const firstLineMatch = rawContent.slice(musicDescIdx, blockEnd)
        .match(/音乐描述[：:]\s*(.+?)(?:\n|$)/);
      musicPrompt = firstLineMatch ? firstLineMatch[1].trim() : '';

      // 删除从字符串开头到 blockEnd 的所有内容
      // 这同时也删除了 AI 可能在音乐描述前加的任意开场白
      parsedLyrics = rawContent.slice(blockEnd).trim();
    } else {
      parsedLyrics = rawContent.trim();
    }

    // 提取标题
    const titleMatch = parsedLyrics.match(/标题[：:]\s*(.+?)(?:\n|$)/);
    if (titleMatch) {
      title = titleMatch[1].trim();
      parsedLyrics = parsedLyrics.replace(/标题[：:].+?\n?/, '').trim();
    } else {
      // fallback：从第一行非标签文字提取
      const lines = parsedLyrics.split('\n').filter(l => l.trim() && !l.trim().startsWith('['));
      title = lines[0]?.trim() || topic || 'AI创作';
      if (title && title !== topic && lines[0]) {
        parsedLyrics = parsedLyrics.replace(lines[0].trim(), '').trim();
      }
    }

    // ★ 解析 2 个版本
    const versions = [];
    const versionSplit = parsedLyrics.split(/===+\s*版本[ABab]\s*===+/);
    if (versionSplit.length >= 3) {
      // 格式: 标题 + 版本A片段 + 版本B片段
      // versionSplit[1] = 版本A, versionSplit[2] = 版本B
      for (let i = 1; i < Math.min(versionSplit.length, 3); i++) {
        let v = versionSplit[i].trim();
        v = normalizeLyrics(v);
        v = v.replace(/^(?:标题|音乐描述|主题)[：:].*$/gm, '').trim();
        const firstB = v.indexOf('[');
        if (firstB > 0) v = v.substring(firstB).trim();
        v = v.replace(/[\uFFFD]+/g, '').trim();
        versions.push({
          label: i === 1 ? '版本A' : '版本B',
          lyrics: v,
        });
      }
    } else {
      // 降级：AI 没按格式输出，整个当单版本
      let v = normalizeLyrics(parsedLyrics);
      v = v.replace(/^(?:标题|音乐描述|主题)[：:].*$/gm, '').trim();
      const firstB = v.indexOf('[');
      if (firstB > 0) v = v.substring(firstB).trim();
      v = v.replace(/[\uFFFD]+/g, '').trim();
      versions.push({ label: '版本', lyrics: v });
    }

    return { versions, musicPrompt, title };
  } catch (e) {
    logger.warn('[AI Music] 歌词生成失败:', e.message);
    throw e;
  }
}

/**
 * 规范化歌词结构
 * 确保歌词使用标准的结构标签
 */
function normalizeLyrics(lyrics) {
  if (!lyrics) return lyrics;

  // 常见的非标准标签映射
  const tagMap = {
    'verse': '主歌',
    'chorus': '副歌',
    'bridge': '桥段',
    'intro': '前奏',
    'outro': '结尾',
    'interlude': '间奏',
    'pre-chorus': '导歌',
    'hook': '副歌',
    'verse 1': '主歌',
    'verse 2': '主歌',
    'chorus 1': '副歌',
    'chorus 2': '副歌',
  };

  let result = lyrics;

  // 替换非标准标签
  for (const [eng, chn] of Object.entries(tagMap)) {
    const regex = new RegExp(`\\[${eng}\\]`, 'gi');
    result = result.replace(regex, `[${chn}]`);
  }

  return result;
}

/**
 * AI 生成音乐（使用 MiniMax Music API）
 *
 * 注意：MiniMax Music API 没有 duration 参数，音乐时长由歌词长度决定。
 * 更长的歌词 → 更长的音乐。
 *
 * @param {Object} params
 * @param {string} params.lyrics - 歌词（越长生成的音乐越长）
 * @param {string} params.title - 歌曲标题
 * @param {string} params.style - 音乐风格（备用，仅当 musicPrompt 为空时使用）
 * @param {string} params.musicPrompt - AI 生成的详细音乐描述（优先于 style）
 * @param {string} params.apiKey - MiniMax API Key
 * @param {function} [params.onProgress] - 进度回调
 * @returns {Promise<{audioHex: string, status: number}>}
 */
async function generateMusic(params) {
  const { lyrics, style, musicPrompt, apiKey, timbre, onProgress } = params;

  if (!apiKey) throw new Error('请先配置 MiniMax API Key');
  if (!lyrics) throw new Error('歌词不能为空');

  // 使用 AI 生成的详细音乐描述（musicPrompt），如果没有则用 style
  const prompt = musicPrompt || style || '流行音乐';

  if (onProgress) onProgress({ status: 'submitting', percent: 10 });

  try {
    // M10: 计费接口禁止自动重试——网络抖动/超时后重试可能重复扣费
    const result = await request(`${MINIMAX_API_BASE}/v1/music_generation`, {
      method: 'POST',
      retries: 0,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: {
        model: 'music-2.6',
        prompt: prompt,
        lyrics: lyrics,
        timbre: timbre || 'female',
        output_format: 'hex',
        audio_setting: {
          sample_rate: 44100,
          bitrate: 256000,
          format: 'mp3',
        },
      },
      timeout: 300000, // 5 分钟超时
    });

    if (result.status !== 200) {
      throw new Error(result.data?.base_resp?.status_msg || '音乐生成失败');
    }

    const baseResp = result.data?.base_resp;
    if (baseResp && baseResp.status_code !== 0) {
      throw new Error(baseResp.status_msg || '音乐生成失败');
    }

    const data = result.data?.data;

    // 检查是否仍在生成中（status=1）
    if (data && data.status === 1) {
      // API 返回生成中状态，需要轮询
      if (onProgress) onProgress({ status: 'generating', percent: 50 });
      throw new Error('API 返回生成中状态，请稍后重试');
    }

    if (onProgress) onProgress({ status: 'completed', percent: 100 });

    return {
      audioHex: data?.audio || '',
      status: data?.status || 0,
      duration: result.data?.extra_info?.music_duration || 0,
    };
  } catch (e) {
    logger.warn('[AI Music] 音乐生成失败:', e.message);
    throw e;
  }
}

/**
 * 将 hex 编码的音频数据保存为文件
 *
 * @param {string} audioHex - hex 编码的音频数据
 * @param {string} savePath - 保存路径
 * @returns {Promise<string>} 保存的文件路径
 */
function saveAudioFromHex(audioHex, savePath) {
  return new Promise((resolve, reject) => {
    try {
      const MAX_AUDIO_SIZE = 100 * 1024 * 1024; // 100MB
      if (audioHex.length / 2 > MAX_AUDIO_SIZE) {
        return reject(new Error('音频数据过大'));
      }
      const buffer = Buffer.from(audioHex, 'hex');
      fs.writeFile(savePath, buffer, (err) => {
        if (err) reject(err);
        else resolve(savePath);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ── 生成历史 ──────────────────────────────────────────

async function loadHistory() {
  if (!_historyPath) return [];
  try {
    if (!fs.existsSync(_historyPath)) return [];
    const data = JSON.parse(await readFile(_historyPath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

async function saveHistory(history) {
  if (!_historyPath) return;
  try {
    await writeFile(_historyPath, JSON.stringify(history, null, 2), 'utf-8');
  } catch (e) {
    logger.warn('[AI Music] 保存历史失败:', e.message);
  }
}

async function addToHistory(item) {
  const history = await loadHistory();
  history.unshift({
    id: Date.now().toString(36),
    title: item.title || 'AI创作',
    lyrics: item.lyrics || '',
    style: item.style || '',
    audioPath: item.audioPath || '',
    createdAt: new Date().toISOString(),
  });
  if (history.length > 50) history.length = 50;
  await saveHistory(history);
  return history;
}

async function clearHistory() {
  await saveHistory([]);
}

/**
 * AI 翻译歌词
 *
 * @param {Object} params
 * @param {string} params.lyrics - 原始歌词
 * @param {string} params.sourceLang - 源语言（auto/en/zh/ja/ko）
 * @param {string} params.targetLang - 目标语言（zh/en/ja/ko）
 * @param {string} params.apiKey - MiniMax API Key
 * @returns {Promise<{translated: string}>}
 */
async function translateLyrics(params) {
  const { lyrics, targetLang = 'zh', apiKey } = params;

  if (!apiKey) throw new Error('请先配置 MiniMax API Key');
  if (!lyrics) throw new Error('歌词不能为空');

  const langMap = { zh: '中文', en: '英文', ja: '日文', ko: '韩文', auto: '自动检测' };
  const targetLabel = langMap[targetLang] || '中文';

  const prompt = `请将以下歌词翻译成${targetLabel}，保持歌词的结构和标签格式不变：

${lyrics}

要求：
1. 保持原有的结构标签（如 [主歌] [副歌] 等）
2. 翻译要自然流畅，符合歌曲的韵律
3. 直接输出翻译后的歌词，不要其他解释`;

  try {
    const result = await request(`${MINIMAX_API_BASE}/v1/text/chatcompletion_v2`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: {
        model: 'MiniMax-Text-01',
        messages: [
          { role: 'system', content: '你是一位专业的歌词翻译家，擅长将各种语言的歌词翻译成目标语言，保持歌词的韵律和结构。' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      },
    });

    if (result.status !== 200 || !result.data?.choices) {
      throw new Error(result.data?.error?.message || '翻译失败');
    }

    return { translated: result.data.choices[0]?.message?.content || '' };
  } catch (e) {
    logger.warn('[AI Music] 歌词翻译失败:', e.message);
    throw e;
  }
}

/**
 * 稳健解析 LLM 输出的搜索关键词数组。
 * LLM 常带 markdown 围栏或前后废话，先按纯 JSON 解析，失败再提取第一个
 * [...] 片段。清洗规则：只留字符串、trim、丢空白与超长（>60 字符）、去重、最多 3 个。
 * 无任何可解析数组 → null（由调用方兜底）。
 * @param {string} text
 * @returns {string[]|null}
 */
function parseSearchQueries(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let arr = null;
  try {
    arr = JSON.parse(text.trim());
  } catch (_) {
    const m = text.match(/\[[\s\S]*?\]/);
    if (m) {
      try { arr = JSON.parse(m[0]); } catch (_) { arr = null; }
    }
  }
  if (!Array.isArray(arr)) return null;
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (typeof item !== 'string') continue;
    const q = item.trim();
    if (!q || q.length > 60 || seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * 自然语言 → 平台可搜的关键词数组（P0-A 改写层）
 * @param {Object} params
 * @param {string} params.phrase - 用户的自然语言需求
 * @param {string} params.apiKey - MiniMax API Key
 * @returns {Promise<string[]>} 0~3 个关键词；解析失败返回空数组（调用方兜底）
 */
async function rewriteSearchQueries(params) {
  const { phrase, apiKey } = params;
  if (!apiKey) throw new Error('请先配置 MiniMax API Key');
  if (!phrase) throw new Error('搜索需求不能为空');

  const prompt = `用户想在音乐软件里搜索歌曲，但给的是自然语言描述。请把它改写成 1~3 个能直接用于音乐平台搜索的关键词（风格/语言/场景/歌手等词的稀疏组合，不要整句）。

用户描述：${phrase}

严格只输出一个 JSON 字符串数组，例如 ["轻快 中文 晨跑"]。不要输出其它任何文字。`;

  const result = await request(`${MINIMAX_API_BASE}/v1/text/chatcompletion_v2`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: {
      model: 'MiniMax-Text-01',
      messages: [
        { role: 'system', content: '你是音乐搜索关键词改写器。只输出 JSON 字符串数组，不输出任何解释。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
      max_tokens: 200,
    },
  });

  if (result.status !== 200 || !result.data?.choices) {
    throw new Error(result.data?.error?.message || '关键词改写失败');
  }
  return parseSearchQueries(result.data.choices[0]?.message?.content) || [];
}

module.exports = {
  setHistoryPath,
  generateLyrics,
  generateMusic,
  translateLyrics,
  parseSearchQueries,
  rewriteSearchQueries,
  saveAudioFromHex,
  loadHistory,
  addToHistory,
  clearHistory,
};
