/**
 * phonetics.js — 美音 / 英音双音标（离线查表）
 *
 * 数据源：open-dict-data/ipa-dict（MIT 许可）
 *   https://github.com/open-dict-data/ipa-dict
 *   data/en_US.txt（美音）、data/en_UK.txt（英音）
 *
 * 构建产物：data/phonetics.json.gz（由 scripts/build-phonetics.mjs 生成）
 *   JSON 结构：{ "word": ["<美音>", "<英音>"] }
 *   - 音标已去掉外层 `/` 分隔符，与引擎 `phonetic` 字段风格一致（如 "ˈæpl"）；
 *   - 同一词有多种读音时以 ", " 连接（如 "ˈskɛdʒuɫ, ˈskɛdʒʊɫ"）；
 *   - 某一边缺数据时给空字符串 ""。
 *
 * 内存策略：只保留「两条并行字符串数组 + 一个 Map 索引」，不保留原始 JSON 对象，
 * 也不复制字符串（数组与 Map 共享同一批字符串实例）。
 *
 * 模块顶层不做任何 IO，全部在 loadPhonetics 内完成。
 */

import fsp from 'node:fs/promises';
import zlib from 'node:zlib';

/** 期望的 JSON 顶层结构说明（错误信息用）。 */
const FORMAT_HINT = '{ "word": ["<us>", "<gb>"] }';
/** gzip 魔数，用于把「传了明文 JSON / HTML 错误页」区分出明确报错。 */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/** 只折叠 ASCII 大小写（与 StarDict idx / 单词本的大小写策略一致）。 */
function foldAscii(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : str[i];
  }
  return out;
}

/** 把 [us, gb] 之类二元组规整为两个字符串。 */
function pickPair(pair) {
  let us = '';
  let gb = '';
  if (Array.isArray(pair)) {
    us = typeof pair[0] === 'string' ? pair[0] : '';
    gb = typeof pair[1] === 'string' ? pair[1] : '';
  } else if (pair && typeof pair === 'object') {
    // 容忍 {us, gb} 形态（供测试/未来格式使用）
    us = typeof pair.us === 'string' ? pair.us : '';
    gb = typeof pair.gb === 'string' ? pair.gb : '';
  }
  return [us, gb];
}

/**
 * 音标索引：并行数组 + Map，体积最小化，不常驻原始 JSON。
 */
export class PhoneticIndex {
  /** @type {string[]} */
  #us;
  /** @type {string[]} */
  #gb;
  /** @type {Map<string, number>} folded word → 数组下标 */
  #index;

  constructor(us, gb, index) {
    this.#us = us;
    this.#gb = gb;
    this.#index = index;
  }

  /** 条目数（唯一单词数）。 */
  get size() {
    return this.#index.size;
  }

  /**
   * 查双音标（ASCII 大小写不敏感）。
   * @param {string} word
   * @returns {{us: string, gb: string} | null} 无该词或两边都为空时返回 null
   */
  get(word) {
    if (typeof word !== 'string') return null;
    const key = foldAscii(word.trim());
    if (!key) return null;
    const at = this.#index.get(key);
    if (at === undefined) return null;
    return { us: this.#us[at], gb: this.#gb[at] };
  }

  /** 是否存在该词的双音标数据（即便某一边为空串）。 */
  has(word) {
    if (typeof word !== 'string') return false;
    const key = foldAscii(word.trim());
    return key ? this.#index.has(key) : false;
  }
}

/* -------------------------------------------------------------------------- */
/* 快速扫描器                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 直接扫描 `{"word":["us","gb"],...}` 文本构建索引，不产生中间 JSON 对象。
 *
 * 为什么不用 JSON.parse：147,488 个唯一键的对象在 V8 里会进入 dictionary mode，
 * JSON.parse 建对象 + 逐键 `obj[w]` 取值实测 320–500ms；直接扫描字符串约 130ms。
 *
 * 约束：仅接受本构建脚本产出的紧凑格式（无转义字符）。带反斜杠转义的输入由调用方
 * 回退到 JSON.parse，因此这里遇到非预期结构一律抛错，不猜测。
 *
 * @param {string} str 解压后的 JSON 文本
 * @returns {{us: string[], gb: string[], index: Map<string, number>}}
 */
function scanFlatRecords(str) {
  const Q = 34; // "
  const COLON = 58;
  const COMMA = 44;
  const LBRACK = 91; // [
  const RBRACK = 93; // ]
  const LBRACE = 123; // {
  const RBRACE = 125; // }

  const index = new Map();
  const us = [];
  const gb = [];
  const n = str.length;
  let p = 0;

  const skipSpace = () => {
    while (p < n) {
      const c = str.charCodeAt(p);
      if (c === 32 || c === 9 || c === 10 || c === 13) p++;
      else break;
    }
  };

  /** 读一个不带转义的 JSON 字符串，返回内容并前移 p。 */
  const readString = () => {
    if (str.charCodeAt(p) !== Q) throw new Error(`expect '"' at ${p}`);
    const end = str.indexOf('"', p + 1);
    if (end < 0) throw new Error(`unterminated string at ${p}`);
    const value = str.slice(p + 1, end);
    p = end + 1;
    return value;
  };

  const push = (key, u, g) => {
    if (!u && !g) return; // 两边都空 ⇒ 不收录
    const folded = /[A-Z]/.test(key) ? key.toLowerCase() : key;
    const at = index.get(folded);
    if (at !== undefined) {
      if (!us[at] && u) us[at] = u;
      if (!gb[at] && g) gb[at] = g;
      return;
    }
    index.set(folded, us.length);
    us.push(u);
    gb.push(g);
  };

  skipSpace();
  if (str.charCodeAt(p) !== LBRACE) throw new Error("expect '{'");
  p++;
  skipSpace();
  if (str.charCodeAt(p) === RBRACE) return { us, gb, index };

  for (;;) {
    skipSpace();
    const word = readString();
    skipSpace();
    if (str.charCodeAt(p) !== COLON) throw new Error(`expect ':' at ${p}`);
    p++;
    skipSpace();
    if (str.charCodeAt(p) !== LBRACK) throw new Error(`expect '[' at ${p}`);
    p++;
    skipSpace();
    const u = readString();
    skipSpace();
    if (str.charCodeAt(p) !== COMMA) throw new Error(`expect ',' at ${p}`);
    p++;
    skipSpace();
    const g = readString();
    skipSpace();
    if (str.charCodeAt(p) !== RBRACK) throw new Error(`expect ']' at ${p}`);
    p++;
    push(word, u, g);

    skipSpace();
    const c = str.charCodeAt(p);
    if (c === COMMA) {
      p++;
      continue;
    }
    if (c === RBRACE) {
      p++;
      skipSpace();
      if (p !== n) throw new Error('trailing data after object');
      return { us, gb, index };
    }
    throw new Error(`expect ',' or '}' at ${p}`);
  }
}

/** 依次遍历各类 records 形态：普通对象 / Map / [word, pair] 数组。 */
function iterateRecords(records) {
  if (records instanceof Map) return records.entries();
  if (Array.isArray(records)) return records[Symbol.iterator]();
  if (records && typeof records === 'object') {
    return (function* objectEntries() {
      for (const word of Object.keys(records)) yield [word, records[word]];
    })();
  }
  return null;
}

/**
 * 由内存中的记录构造索引（纯函数，不做 IO —— 供测试注入使用）。
 *
 * @param {Record<string, [string, string] | {us: string, gb: string}>
 *   | Map<string, [string, string]>
 *   | Array<[string, [string, string]]>} records
 * @returns {PhoneticIndex}
 */
export function makePhoneticIndex(records) {
  const iterator = iterateRecords(records);
  if (!iterator) {
    throw new TypeError(`makePhoneticIndex(records): 需要 ${FORMAT_HINT} 对象、Map 或 [word, pair] 数组`);
  }
  const us = [];
  const gb = [];
  const index = new Map();

  for (const entry of iterator) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [rawWord, pair] = entry;
    if (typeof rawWord !== 'string') continue;
    const key = foldAscii(rawWord.trim());
    if (!key) continue;
    const [u, g] = pickPair(pair);
    if (!u && !g) continue; // 两边都空 ⇒ 不收录
    const existing = index.get(key);
    if (existing !== undefined) {
      // 同一词重复出现（大小写变体等）：补空，但不用空值覆盖已有值
      if (!us[existing] && u) us[existing] = u;
      if (!gb[existing] && g) gb[existing] = g;
      continue;
    }
    index.set(key, us.length);
    us.push(u);
    gb.push(g);
  }

  return new PhoneticIndex(us, gb, index);
}

/**
 * 读取 data/phonetics.json.gz 并建立索引。
 * 失败时抛出带明确原因与修复提示的 Error（不做静默降级）。
 *
 * @param {string} filePath data/phonetics.json.gz 的路径
 * @returns {Promise<PhoneticIndex>}
 */
export async function loadPhonetics(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('loadPhonetics(filePath): filePath 必须是非空字符串');
  }

  let gz;
  try {
    gz = await fsp.readFile(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(
        `[phonetics] 音标数据文件不存在：${filePath}\n` +
          '  请先运行 `node scripts/build-phonetics.mjs` 生成 data/phonetics.json.gz',
      );
    }
    throw new Error(`[phonetics] 读取音标数据失败：${filePath}：${err && err.message ? err.message : err}`);
  }

  if (gz.length < 2 || gz[0] !== GZIP_MAGIC_0 || gz[1] !== GZIP_MAGIC_1) {
    throw new Error(
      `[phonetics] 不是 gzip 文件：${filePath}（期望 .json.gz 产物，请重新运行构建脚本）`,
    );
  }

  let raw;
  try {
    raw = zlib.gunzipSync(gz).toString('utf8');
  } catch (err) {
    throw new Error(`[phonetics] 解压失败（gzip 数据损坏）：${filePath}：${err && err.message ? err.message : err}`);
  }
  gz = null;

  let index = null;

  // 快路径：本构建脚本的产物不含转义字符，直接扫描字符串建索引
  //（实测 135–155ms；走 JSON.parse 建 147k 键对象再取值需 320–500ms）
  if (raw.indexOf('\\') < 0) {
    try {
      const scanned = scanFlatRecords(raw);
      if (scanned.index.size > 0) {
        index = new PhoneticIndex(scanned.us, scanned.gb, scanned.index);
      }
    } catch {
      index = null; // 结构与预期不符 ⇒ 回退到通用 JSON 解析
    }
  }

  if (!index) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `[phonetics] JSON 解析失败：${filePath}：${err && err.message ? err.message : err}`,
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(
        `[phonetics] 数据格式错误：顶层应为对象 ${FORMAT_HINT}，实际为 ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      );
    }
    index = makePhoneticIndex(parsed);
    // 及时断开对中间 JSON 对象的引用，让 GC 回收（只保留并行数组 + Map）
    parsed = null;
  }
  raw = null;

  if (index.size === 0) {
    throw new Error(`[phonetics] 数据为空：${filePath}（重新运行构建脚本）`);
  }
  return index;
}
