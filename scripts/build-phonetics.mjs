#!/usr/bin/env node
/**
 * scripts/build-phonetics.mjs — 构建 data/phonetics.json.gz（美音 + 英音双音标）
 *
 * 数据源：open-dict-data/ipa-dict（MIT 许可）
 *   https://github.com/open-dict-data/ipa-dict
 *   美音 data/en_US.txt · 英音 data/en_UK.txt
 *
 * 用法：
 *   node scripts/build-phonetics.mjs
 *
 * 行为：
 *   1. 源文件优先取本地缓存 <repo>/.cache/ipa/，其次 /tmp/ipa-*.txt（若有效），
 *      都没有才用 curl -k 下载到 .cache/ipa/（.cache 已被 .gitignore 忽略）；
 *   2. 解析两文件并按 ASCII 小写词形合并为 { "word": ["<us>", "<gb>"] }；
 *   3. gzip（level 9）写入 data/phonetics.json.gz（原子写：先 .tmp 再 rename）；
 *   4. 幂等：键按字母序排序、gzip 不写时间戳 ⇒ 重复执行产物字节一致。
 *
 * 可调环境变量（便于离线/测试）：
 *   IPA_CACHE_DIR   源文件缓存目录（默认 <repo>/.cache/ipa）
 *   IPA_SKIP_TMP    设为 1 时不回退读取 /tmp 下的预下载文件
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = process.env.IPA_CACHE_DIR
  ? path.resolve(process.env.IPA_CACHE_DIR)
  : path.join(ROOT, '.cache', 'ipa');
const OUT_DIR = path.join(ROOT, 'data');
const OUT_FILE = path.join(OUT_DIR, 'phonetics.json.gz');
const SKIP_TMP = process.env.IPA_SKIP_TMP === '1';

/** 两套口音的源定义。 */
const SOURCES = [
  {
    dialect: 'us',
    fileName: 'en_US.txt',
    url: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt',
  },
  {
    dialect: 'gb',
    fileName: 'en_UK.txt',
    url: 'https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt',
  },
];

/** 源文件最低可信体积：真实文件 1.3–3.2MB，404 页面只有十几字节。 */
const MIN_SOURCE_BYTES = 500_000;

/* -------------------------------------------------------------------------- */
/* 工具                                                                        */
/* -------------------------------------------------------------------------- */

const fmtMb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const fmtKb = (n) => `${(n / 1024).toFixed(1)} KB`;

function log(msg) {
  console.log(`[build-phonetics] ${msg}`);
}

/** ASCII 小写折叠（合并键 & 查询键一致）。 */
function foldAscii(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : str[i];
  }
  return out;
}

/** 判定文本是否像 ipa-dict 数据（防止把 404 页当数据用）。 */
function looksLikeIpaData(text) {
  if (typeof text !== 'string' || text.length < MIN_SOURCE_BYTES) return false;
  const lines = text.split('\n');
  let good = 0;
  const probe = Math.min(lines.length, 2000);
  for (let i = 0; i < probe; i++) {
    const line = lines[i];
    const tab = line.indexOf('\t');
    if (tab > 0 && line.length < 400 && line.slice(tab + 1).includes('/')) {
      good++;
      if (good >= 100) return true;
    }
  }
  return false;
}

/** 读文本并按有效性校验；无效返回 null（不抛错，交给上层继续找来源）。 */
async function readValidSource(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return looksLikeIpaData(text) ? text : null;
  } catch {
    return null;
  }
}

/** curl -k 下载（本机 Windows 自带 curl.exe）。 */
function downloadWithCurl(url, dest) {
  const args = [
    '-k',
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--max-time',
    '180',
    '--output',
    dest,
    url,
  ];
  execFileSync('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Node 原生 fetch 兜底（curl 不可用时）。 */
async function downloadWithFetch(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(dest, buf);
}

/**
 * 确保某个口音的源文件可用，返回其文本。
 * 顺序：缓存目录 → /tmp 预下载 → 下载（curl，失败则 fetch）。
 */
async function ensureSource(src) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const cached = path.join(CACHE_DIR, src.fileName);

  const fromCache = await readValidSource(cached);
  if (fromCache) {
    log(`${src.dialect}: 使用缓存 ${path.relative(ROOT, cached)}（${fmtKb(Buffer.byteLength(fromCache))}）`);
    return fromCache;
  }

  if (!SKIP_TMP) {
    const tmpCandidate = path.join(path.sep === '\\' ? (process.env.TEMP || '/tmp') : '/tmp', `ipa-${src.fileName}`);
    const fromTmp = await readValidSource(tmpCandidate);
    if (fromTmp) {
      await fsp.writeFile(cached, fromTmp, 'utf8');
      log(`${src.dialect}: 复用预下载 ${tmpCandidate} → ${path.relative(ROOT, cached)}`);
      return fromTmp;
    }
  }

  log(`${src.dialect}: 缓存缺失或无效，开始下载 ${src.url}`);
  try {
    downloadWithCurl(src.url, cached);
  } catch (err) {
    const hint = err && err.code === 'ENOENT' ? '（未找到 curl）' : '';
    log(`${src.dialect}: curl 下载失败${hint}，改用 fetch 兜底：${err && err.message ? String(err.message).split('\n')[0] : err}`);
    try {
      await downloadWithFetch(src.url, cached);
    } catch (err2) {
      throw new Error(
        `[build-phonetics] 无法获取 ${src.fileName}：${src.url}\n` +
          `  curl: ${err && err.message ? String(err.message).split('\n')[0] : err}\n` +
          `  fetch: ${err2 && err2.message ? err2.message : err2}`,
      );
    }
  }

  const downloaded = await readValidSource(cached);
  if (!downloaded) {
    const size = (() => {
      try {
        return fs.statSync(cached).size;
      } catch {
        return 0;
      }
    })();
    throw new Error(
      `[build-phonetics] 下载内容无效（${fmtKb(size)}，疑似 404/错误页）：${cached}\n` +
        '  请检查网络或手动放置正确的 en_US.txt / en_UK.txt 到该目录后重试',
    );
  }
  log(`${src.dialect}: 下载完成 ${fmtKb(Buffer.byteLength(downloaded))}`);
  return downloaded;
}

/* -------------------------------------------------------------------------- */
/* 解析与合并                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 把 `/ˈæpl/` 或 `/ˈeɪ/, /ə/` 规整成 `ˈæpl` / `ˈeɪ, ə`。
 * 多读音以 ", " 连接（与本模块存储约定一致）；无斜杠时退化为去首尾斜杠。
 */
function normalizeIpa(raw) {
  const groups = [];
  const re = /\/([^/]+)\//g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const value = m[1].trim();
    if (value && !groups.includes(value)) groups.push(value);
  }
  if (groups.length) return groups.join(', ');
  return raw.trim().replace(/^\/+|\/+$/g, '').trim();
}

/**
 * 解析单个口音文件 → Map<folded word, ipa string>。
 * 同一词形多次出现（理论上没有）时合并读音，不丢信息。
 */
function parseIpaFile(text) {
  const map = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const word = line.slice(0, tab).trim();
    if (!word) continue;
    const ipa = normalizeIpa(line.slice(tab + 1));
    if (!ipa) continue;
    const key = foldAscii(word);
    if (!key) continue;
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, ipa);
    } else if (prev !== ipa) {
      const merged = [...new Set([...prev.split(', '), ...ipa.split(', ')])].join(', ');
      map.set(key, merged);
    }
  }
  return map;
}

/** 合并两套口音 → 普通对象 {word: [us, gb]}（键按字母序，保证幂等）。 */
function mergeDialects(perDialect) {
  /** @type {Map<string, [string, string]>} */
  const merged = new Map();
  for (const { dialect, map } of perDialect) {
    const slot = dialect === 'us' ? 0 : 1;
    for (const [word, ipa] of map) {
      let pair = merged.get(word);
      if (!pair) {
        pair = ['', ''];
        merged.set(word, pair);
      }
      if (!pair[slot]) pair[slot] = ipa;
    }
  }
  const sortedWords = [...merged.keys()].sort();
  const out = {};
  for (const word of sortedWords) out[word] = merged.get(word);
  return out;
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const t0 = performance.now();

  // 1) 源文件
  const perDialect = [];
  const sourceStats = [];
  for (const src of SOURCES) {
    const text = await ensureSource(src);
    const map = parseIpaFile(text);
    perDialect.push({ dialect: src.dialect, map });
    sourceStats.push({ dialect: src.dialect, lines: text.split('\n').length - 1, words: map.size });
  }

  // 2) 合并
  const tMerge = performance.now();
  const records = mergeDialects(perDialect);
  const words = Object.keys(records);
  const withUs = words.filter((w) => records[w][0]).length;
  const withGb = words.filter((w) => records[w][1]).length;
  const withBoth = words.filter((w) => records[w][0] && records[w][1]).length;
  const mergeMs = performance.now() - tMerge;

  // 3) 序列化 + gzip
  const json = JSON.stringify(records);
  const jsonBytes = Buffer.byteLength(json);
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });

  await fsp.mkdir(OUT_DIR, { recursive: true });
  const tmp = `${OUT_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, gz);
  await fsp.rename(tmp, OUT_FILE);

  const elapsed = performance.now() - t0;
  const sha = crypto.createHash('sha256').update(gz).digest('hex');

  // 4) 汇报
  console.log('');
  log(`源文件：`);
  for (const s of sourceStats) {
    log(`  ${s.dialect}: ${s.lines.toLocaleString('en-US')} 行 → ${s.words.toLocaleString('en-US')} 词` +
      `（${path.join(path.relative(ROOT, CACHE_DIR), SOURCES.find((x) => x.dialect === s.dialect).fileName)}）`);
  }
  log(`条目数（唯一词形，大小写不敏感）：${words.length.toLocaleString('en-US')}`);
  log(`  仅美音：${(withUs - withBoth).toLocaleString('en-US')} · 仅英音：${(withGb - withBoth).toLocaleString('en-US')} · 双音标：${withBoth.toLocaleString('en-US')}`);
  log(`JSON 原始：${fmtMb(jsonBytes)} → gzip(level 9)：${fmtMb(gz.length)}（压缩率 ${(jsonBytes / gz.length).toFixed(2)}×）`);
  log(`输出：${path.relative(ROOT, OUT_FILE)}`);
  log(`SHA-256：${sha}`);
  log(`耗时：${elapsed.toFixed(0)}ms（解析+合并 ${mergeMs.toFixed(0)}ms，gzip ${(elapsed - mergeMs).toFixed(0)}ms）`);

  // 5) 自检：产物可被运行时模块读出
  const { loadPhonetics } = await import('../src/host/phonetics.js');
  const tLoad = performance.now();
  const index = await loadPhonetics(OUT_FILE);
  log(`自检：loadPhonetics 成功，size=${index.size.toLocaleString('en-US')}，耗时 ${(performance.now() - tLoad).toFixed(0)}ms`);
  if (index.size !== words.length) {
    throw new Error(`[build-phonetics] 自检失败：产物条目 ${index.size} 与构建条目 ${words.length} 不一致`);
  }
}

main().catch((err) => {
  console.error(`\n[build-phonetics] 失败：${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
