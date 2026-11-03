/**
 * stardict.js — 零依赖 StarDict 2.4.2 读取器（Electron 主进程友好）
 *
 * 设计要点：
 *  - 只用 node: 内置模块。
 *  - 索引 = 单个 Uint32Array（每条 idx 记录的起始字节位），4.35M/3.4M 条常驻内存
 *    分别约 1.7MB / 13.6MB；不常驻 idx 原文（ECDICT idx 82MB）与 dict 原文（112MB），
 *    两者都通过文件描述符按需 readSync，避免 Electron 主进程堆膨胀。
 *  - 二分查找直接比较原始字节（只对 ASCII 做大小写折叠），不为每条记录创建字符串。
 *  - .dict.dz 即 GNU dictzip（gzip），用 node:zlib 整块解压为 Buffer（~14MB）常驻。
 *  - 索引缓存落 <repo>/.cache/，命中后跳过整块 idx 扫描。
 *
 * 说明：本文件仅暴露 StardictBook 与少数内部工具函数，供 dict.js 使用。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 索引缓存格式版本；格式变更时自增即可让旧缓存自动失效。 */
const CACHE_FORMAT = 1;

/** 仓库根（src/host/stardict.js → ../../），缓存目录固定为 <repo>/.cache。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(MODULE_DIR, '..', '..', '.cache');

/** 单条记录头部预读字节数：多数记录（词条 + \0 + 8 字节）远小于此值。 */
const RECORD_HEAD = 352;
/** 单个词条正文读取上限，防御性截断（正常词条远小于此值）。 */
const MAX_BODY_BYTES = 1 << 20;
/** 单个词条名长度上限（字节），异常数据防御。 */
const MAX_WORD_BYTES = 8192;

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

/** ASCII 大小写折叠；非 ASCII 字节原样返回（与 StarDict idx 的 g_ascii_strcasecmp 排序一致）。 */
function asciiLowerByte(b) {
  return b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
}

/** 只折叠 ASCII 的 lowercase，等价于 idx 排序的比较键。 */
export function asciiLower(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : str[i];
  }
  return out;
}

/** 把（可能已缓存的）查询词转成比较用 Buffer。 */
function lowerKeyBuffer(str) {
  const buf = Buffer.from(str, 'utf8');
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b >= 0x41 && b <= 0x5a) buf[i] = b + 0x20;
  }
  return buf;
}

/**
 * 比较原始词条字节（ASCII 折叠）与已折叠的 key 字节。
 * @returns {number} 负数=word<key，0=相等，正数=word>key
 */
function cmpWordKey(word, key) {
  const n = Math.min(word.length, key.length);
  for (let i = 0; i < n; i++) {
    const a = asciiLowerByte(word[i]);
    const b = key[i];
    if (a !== b) return a < b ? -1 : 1;
  }
  if (word.length === key.length) return 0;
  return word.length < key.length ? -1 : 1;
}

/** 读取恰好 len 字节，短读时循环补齐。 */
function readExact(fd, buffer, position) {
  let got = 0;
  while (got < buffer.length) {
    const n = fs.readSync(fd, buffer, got, buffer.length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got;
}

/* -------------------------------------------------------------------------- */
/* 索引缓存                                                                    */
/* -------------------------------------------------------------------------- */

/** 缓存文件名 = idx 路径 + 大小 + mtime + 缓存版本 的短哈希。 */
function cacheFilePath(idxPath, stat) {
  const h = crypto
    .createHash('sha1')
    .update(`${CACHE_FORMAT}\u0000${idxPath}\u0000${stat.size}\u0000${Math.round(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(CACHE_DIR, `idx-${h}.starts`);
}

/**
 * 尝试从缓存读取 starts 表。任何异常（缺失/损坏/不匹配）都返回 null，由调用方重建。
 * @returns {Uint32Array | null}
 */
function loadStartsCache(file, meta) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  try {
    if (raw.length < 12) return null;
    if (raw.readUInt32BE(0) !== 0x44534844 /* 'DSHD' */) return null;
    const jsonLen = raw.readUInt32BE(4);
    if (jsonLen <= 0 || 8 + jsonLen > raw.length) return null;
    const header = JSON.parse(raw.toString('utf8', 8, 8 + jsonLen));
    if (!header || header.v !== CACHE_FORMAT) return null;
    if (header.idxSize !== meta.idxSize) return null;
    if (header.mtimeMs !== meta.mtimeMs) return null;
    if (!Number.isInteger(header.count) || header.count <= 0) return null;
    const bodyStart = 8 + jsonLen;
    if (raw.length - bodyStart !== header.count * 4) return null;
    // 复制到独立的、按 4 字节对齐的 ArrayBuffer，避免 Buffer 池共享造成字节序/偏移问题
    const ab = new ArrayBuffer(header.count * 4);
    Buffer.from(ab).set(raw.subarray(bodyStart, bodyStart + header.count * 4));
    const starts = new Uint32Array(ab);
    if (starts[0] !== 0) return null;
    return starts;
  } catch {
    return null;
  }
}

/** 原子写缓存；失败静默（缓存只是加速，不影响正确性）。 */
function saveStartsCache(file, meta, starts) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const header = Buffer.from(
      JSON.stringify({
        v: CACHE_FORMAT,
        idxPath: meta.idxPath,
        idxSize: meta.idxSize,
        mtimeMs: meta.mtimeMs,
        count: starts.length,
      }),
      'utf8',
    );
    const head = Buffer.allocUnsafe(8);
    head.writeUInt32BE(0x44534844, 0);
    head.writeUInt32BE(header.length, 4);
    const body = Buffer.from(starts.buffer, starts.byteOffset, starts.byteLength);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, Buffer.concat([head, header, body]));
    fs.renameSync(tmp, file);
  } catch {
    /* 缓存写失败不影响功能 */
  }
}

/* -------------------------------------------------------------------------- */
/* idx 扫描：构建 starts 表                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 分块扫描 idx 文件，产出每条记录的起始字节位表。
 * 记录 = UTF-8 词条 + \0 + uint32BE offset + uint32BE size，最短 9 字节。
 * 分块边界处的半条记录通过 carry 带到下一块，保证任意大小文件都不会被整块载入。
 */
function buildStarts(fd, totalLength) {
  const CHUNK = 4 << 20;
  /** @type {Uint32Array[]} */
  const blocks = [];
  const BLOCK = 1 << 18; // 262144 条/块 = 1MB，避免一次性按上界估算造成大浪费
  let cur = new Uint32Array(BLOCK);
  let curLen = 0;
  let total = 0;

  const push = (v) => {
    if (curLen === cur.length) {
      blocks.push(cur);
      cur = new Uint32Array(BLOCK);
      curLen = 0;
    }
    cur[curLen++] = v;
    total++;
  };

  let carry = Buffer.alloc(0);
  let carryBase = 0;
  let pos = 0;

  while (pos < totalLength) {
    const want = Math.min(CHUNK, totalLength - pos);
    const chunk = Buffer.allocUnsafe(want);
    const got = readExact(fd, chunk, pos);
    if (got <= 0) break;
    const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, got)]) : chunk.subarray(0, got);
    const base = carryBase;

    let i = 0;
    for (;;) {
      const z = buf.indexOf(0, i);
      if (z < 0 || z + 9 > buf.length) break; // 剩余部分可能是半条记录
      push(base + i);
      i = z + 9;
    }

    if (i >= buf.length) {
      carry = Buffer.alloc(0);
      carryBase = base + buf.length;
    } else {
      carry = buf.subarray(i);
      carryBase = base + i;
    }
    pos += got;
  }

  if (carry.length > 0) {
    // 末尾半条记录：说明 idx 被截断。若其长度 >= 9（词条+\0+8）则仍可尝试收下。
    const z = carry.indexOf(0);
    if (z >= 0 && z + 9 <= carry.length) push(carryBase);
  }

  const out = new Uint32Array(total);
  let o = 0;
  for (const b of blocks) {
    if (o >= total) break;
    const take = Math.min(b.length, total - o);
    out.set(b.subarray(0, take), o);
    o += take;
  }
  if (o < total) {
    const take = Math.min(curLen, total - o);
    out.set(cur.subarray(0, take), o);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* StardictBook                                                                */
/* -------------------------------------------------------------------------- */

export class StardictBook {
  #dir;
  #ifo = {};
  #name = '';
  #error = null;
  #ok = false;
  /** @type {Uint32Array} */
  #starts = new Uint32Array(0);
  #count = 0;
  #idxFd = -1;
  #idxLength = 0;
  #dictFd = -1;
  #dictBuf = null; // .dict.dz 解压后的常驻 Buffer
  #dictSize = 0;
  #buildMs = 0;
  #cacheHit = false;

  constructor(dir) {
    this.#dir = dir;
  }

  /**
   * 打开一个 StarDict 词库目录。
   * 永不抛异常：即使失败也返回实例，用 info.ok / info.error 表达状态。
   * @param {string} dirPath
   * @returns {Promise<StardictBook>}
   */
  static async open(dirPath) {
    const book = new StardictBook(dirPath);
    await book.#open();
    return book;
  }

  get info() {
    const base = {
      name: this.#name || path.basename(this.#dir || ''),
      wordcount: this.#count,
      dir: this.#dir,
      ok: this.#ok,
    };
    if (this.#error) base.error = this.#error;
    return base;
  }

  /** 建索引耗时（毫秒），首次扫描或缓存载入。 */
  get buildMs() {
    return this.#buildMs;
  }

  /** 是否命中索引缓存。 */
  get cacheHit() {
    return this.#cacheHit;
  }

  get ready() {
    return this.#ok;
  }

  /* ------------------------------ 打开流程 ------------------------------ */

  async #open() {
    try {
      const files = fs.readdirSync(this.#dir);
      const ifoName = files.find((f) => f.toLowerCase().endsWith('.ifo'));
      if (!ifoName) {
        this.#error = 'no .ifo found in directory';
        return;
      }
      const stem = ifoName.slice(0, -4);
      const ifoPath = path.join(this.#dir, ifoName);
      const idxPath = files.includes(`${stem}.idx`) ? path.join(this.#dir, `${stem}.idx`) : null;
      if (!idxPath) {
        this.#error = `no ${stem}.idx found`;
        return;
      }
      const plainDict = [`${stem}.dict`, `${stem}.dict.dz`]
        .filter((n) => files.includes(n))
        .map((n) => path.join(this.#dir, n))[0];

      this.#ifo = parseIfo(fs.readFileSync(ifoPath, 'utf8'));
      this.#name = this.#ifo.bookname || stem;

      const idxStat = fs.statSync(idxPath);
      this.#idxLength = idxStat.size;
      this.#idxFd = fs.openSync(idxPath, 'r');

      // 索引表：缓存优先，否则整块扫描
      const t0 = Date.now();
      const cacheFile = cacheFilePath(idxPath, idxStat);
      const meta = { idxPath, idxSize: idxStat.size, mtimeMs: Math.round(idxStat.mtimeMs) };
      const cached = loadStartsCache(cacheFile, meta);
      if (cached) {
        this.#starts = cached;
        this.#cacheHit = true;
      } else {
        this.#starts = buildStarts(this.#idxFd, this.#idxLength);
        this.#cacheHit = false;
        saveStartsCache(cacheFile, meta, this.#starts);
      }
      this.#count = this.#starts.length;
      this.#buildMs = Date.now() - t0;

      if (this.#count === 0) {
        this.#error = 'idx index is empty';
        return;
      }

      // 正文
      if (!plainDict) {
        this.#error = `no ${stem}.dict or ${stem}.dict.dz found`;
        return;
      }
      if (plainDict.toLowerCase().endsWith('.dz')) {
        // GNU dictzip == gzip（含 FEXTRA 段），zlib 可直接整块解压
        this.#dictBuf = zlib.gunzipSync(fs.readFileSync(plainDict));
        this.#dictSize = this.#dictBuf.length;
      } else {
        this.#dictFd = fs.openSync(plainDict, 'r');
        this.#dictSize = fs.fstatSync(this.#dictFd).size;
      }

      // 与 ifo 声明的 wordcount 对账，不一致只作为提示，不视为失败
      const declared = Number.parseInt(this.#ifo.wordcount || '', 10);
      if (Number.isInteger(declared) && declared > 0 && declared !== this.#count) {
        this.#ifo.wordcountMismatch = `${declared} vs ${this.#count}`;
      }

      this.#ok = true;
    } catch (err) {
      this.#error = err && err.message ? err.message : String(err);
      this.#ok = false;
    }
  }

  /* ------------------------------ 记录访问 ------------------------------ */

  /** idx 记录 i 的字节区间 [start, end)。 */
  #recordRange(i) {
    const start = this.#starts[i];
    const end = i + 1 < this.#count ? this.#starts[i + 1] : this.#idxLength;
    return [start, end];
  }

  /**
   * 读取记录 i 的词条原始字节（不含 \0 与尾部 8 字节）。
   * 只读头部即可判定词条长度，避免为每条记录读整条。
   */
  #wordAt(i) {
    const [start, end] = this.#recordRange(i);
    const recordLen = end - start;
    if (recordLen <= 9) return Buffer.alloc(0);
    const head = Buffer.allocUnsafe(Math.min(recordLen, RECORD_HEAD));
    const got = readExact(this.#idxFd, head, start);
    if (got <= 0) return Buffer.alloc(0);
    const view = head.subarray(0, got);
    const z = view.indexOf(0);
    if (z >= 0) return view.subarray(0, z);
    // 词条名超过 RECORD_HEAD：完整读取该记录（上限保护）
    const fullLen = Math.min(recordLen, MAX_WORD_BYTES + 9);
    const full = Buffer.allocUnsafe(fullLen);
    const got2 = readExact(this.#idxFd, full, start);
    const v2 = full.subarray(0, got2);
    const z2 = v2.indexOf(0);
    return z2 >= 0 ? v2.subarray(0, z2) : v2;
  }

  /** 记录 i 的正文引用 { offset, size }（尾部 8 字节，大端）。 */
  #refAt(i) {
    const [, end] = this.#recordRange(i);
    const tail = Buffer.allocUnsafe(8);
    const got = readExact(this.#idxFd, tail, end - 8);
    if (got !== 8) return { offset: 0, size: 0 };
    return { offset: tail.readUInt32BE(0), size: tail.readUInt32BE(4) };
  }

  /** 读取正文原文（UTF-8 字符串）。 */
  #bodyAt(i) {
    const { offset, size } = this.#refAt(i);
    if (size <= 0 || offset >= this.#dictSize) return '';
    const len = Math.min(size, MAX_BODY_BYTES, this.#dictSize - offset);
    if (len <= 0) return '';
    if (this.#dictBuf) return this.#dictBuf.toString('utf8', offset, offset + len);
    const buf = Buffer.allocUnsafe(len);
    const got = readExact(this.#dictFd, buf, offset);
    return got > 0 ? buf.toString('utf8', 0, got) : '';
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 第一个满足 low(word_i) >= key 的下标（key 已 ASCII 折叠）。 */
  #lowerBound(key) {
    let lo = 0;
    let hi = this.#count;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cmpWordKey(this.#wordAt(mid), key) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 精确（ASCII 大小写不敏感）命中，返回同词的所有 idx 下标。
   * @returns {number[]}
   */
  #exactIndexes(word) {
    if (this.#count === 0) return [];
    const key = lowerKeyBuffer(word);
    let i = this.#lowerBound(key);
    if (i >= this.#count) return [];
    if (cmpWordKey(this.#wordAt(i), key) !== 0) return [];
    let lo = i;
    while (lo > 0 && cmpWordKey(this.#wordAt(lo - 1), key) === 0) lo--;
    let hi = i + 1;
    while (hi < this.#count && cmpWordKey(this.#wordAt(hi), key) === 0) hi++;
    const out = [];
    for (let k = lo; k < hi; k++) out.push(k);
    return out;
  }

  /**
   * 精确（大小写不敏感）查词。
   * @param {string} word
   * @returns {Promise<Array<{word: string, text: string}>>}
   */
  async lookup(word) {
    const w = String(word == null ? '' : word).trim();
    if (!w || !this.#ok) return [];
    try {
      return this.#exactIndexes(w).map((i) => ({
        word: this.#wordAt(i).toString('utf8'),
        text: this.#bodyAt(i),
      }));
    } catch {
      return [];
    }
  }

  /**
   * 精确命中，但返回 index → body 的结构，供上层（DictionaryHub）复用解析逻辑。
   * @param {string} word
   * @returns {Array<{word: string, text: string}>}
   */
  lookupSync(word) {
    const w = String(word == null ? '' : word).trim();
    if (!w || !this.#ok) return [];
    try {
      return this.#exactIndexes(w).map((i) => ({
        word: this.#wordAt(i).toString('utf8'),
        text: this.#bodyAt(i),
      }));
    } catch {
      return [];
    }
  }

  /**
   * 前缀补全（字母序，大小写不敏感匹配）。
   * @param {string} prefix
   * @param {number} limit
   * @returns {Promise<string[]>}
   */
  async suggest(prefix, limit = 20) {
    return this.suggestSync(prefix, limit);
  }

  suggestSync(prefix, limit = 20) {
    const p = String(prefix == null ? '' : prefix).trim();
    const max = Math.max(0, Math.min(200, Number(limit) || 0));
    if (!p || !max || !this.#ok) return [];
    const key = lowerKeyBuffer(p);
    const out = [];
    for (let i = this.#lowerBound(key); i < this.#count; i++) {
      const word = this.#wordAt(i);
      if (word.length < key.length) break;
      let match = true;
      for (let k = 0; k < key.length; k++) {
        if (asciiLowerByte(word[k]) !== key[k]) {
          match = false;
          break;
        }
      }
      if (!match) break; // 已排序 ⇒ 一旦不再匹配前缀即可停止
      const s = word.toString('utf8');
      if (out[out.length - 1] !== s) out.push(s);
      if (out.length >= max) break;
    }
    return out;
  }

  /** 词条总数（= idx 记录数）。 */
  get wordcount() {
    return this.#count;
  }

  /** 关闭文件描述符并释放正文 Buffer。 */
  dispose() {
    try {
      if (this.#idxFd >= 0) fs.closeSync(this.#idxFd);
    } catch {
      /* ignore */
    }
    try {
      if (this.#dictFd >= 0) fs.closeSync(this.#dictFd);
    } catch {
      /* ignore */
    }
    this.#idxFd = -1;
    this.#dictFd = -1;
    this.#dictBuf = null;
    this.#ok = false;
  }
}

/* -------------------------------------------------------------------------- */
/* ifo 解析                                                                    */
/* -------------------------------------------------------------------------- */

/** 解析 StarDict ifo（key=value 逐行，首行是固定标语）。 */
export function parseIfo(text) {
  const out = {};
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^StarDict's dict ifo file/.test(line)) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/** 供上层按需读取缓存目录位置。 */
export function cacheDir() {
  return CACHE_DIR;
}
