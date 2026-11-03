/**
 * wordbook.js — 单词本持久化（零依赖、原子写入、坏文件自愈）
 *
 * 文件格式（JSON）：
 *   { "version": 1, "entries": [ { word, phonetic, phoneticUs, phoneticGb, brief, dictName, addedAt }, ... ] }
 * 数组顺序即展示顺序：**最新收藏在前**。
 * 兼容旧文件：缺失 phoneticUs / phoneticGb 的条目按空字符串读入。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 单词本条目上限，超出后淘汰最旧（数组尾部）。 */
const MAX_ENTRIES = 5000;
/** 落盘格式版本。 */
const FILE_VERSION = 1;

/** 只保留契约里声明的字段，避免把内部字段写进文件。 */
function toRecord(item) {
  return {
    word: item.word,
    phonetic: item.phonetic || '',
    phoneticUs: item.phoneticUs || '',
    phoneticGb: item.phoneticGb || '',
    brief: item.brief || '',
    dictName: item.dictName || '',
    addedAt: item.addedAt,
  };
}

/** 把任意来源的数据规整为合法条目；非法返回 null。 */
function normalize(item) {
  if (!item || typeof item !== 'object') return null;
  const word = typeof item.word === 'string' ? item.word.trim() : '';
  if (!word) return null;
  const addedAt = Number.isFinite(item.addedAt) ? item.addedAt : Date.now();
  return {
    word,
    phonetic: typeof item.phonetic === 'string' ? item.phonetic : '',
    phoneticUs: typeof item.phoneticUs === 'string' ? item.phoneticUs : '',
    phoneticGb: typeof item.phoneticGb === 'string' ? item.phoneticGb : '',
    brief: typeof item.brief === 'string' ? item.brief : '',
    dictName: typeof item.dictName === 'string' ? item.dictName : '',
    addedAt,
  };
}

/** 大小写不敏感的归一键（只折叠 ASCII，与词典大小写策略保持一致）。 */
function keyOf(word) {
  let out = '';
  for (let i = 0; i < word.length; i++) {
    const c = word.charCodeAt(i);
    out += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : word[i];
  }
  return out;
}

export class Wordbook {
  #file;
  /** @type {Array<{word: string, phonetic: string, phoneticUs: string, phoneticGb: string, brief: string, dictName: string, addedAt: number}>} */
  #entries = [];
  /** @type {Map<string, number>} lower(word) → 在 #entries 中的下标 */
  #index = new Map();
  #loaded = false;
  /** 串行化所有写操作，避免并发 add/remove 互相覆盖。 */
  #queue = Promise.resolve();

  /**
   * @param {string} filePath JSON 文件路径
   */
  constructor(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('Wordbook: filePath must be a non-empty string');
    }
    this.#file = filePath;
  }

  /** 收藏条数。 */
  get count() {
    return this.#entries.length;
  }

  /** 单词本文件路径。 */
  get filePath() {
    return this.#file;
  }

  /* ------------------------------ 读入 ------------------------------ */

  /** 载入（幂等）。文件缺失按空表处理；损坏则备份后回退空表。 */
  async load() {
    if (this.#loaded) return this;
    await this.#enqueue(async () => {
      if (this.#loaded) return;
      await this.#loadFromDisk();
    });
    return this;
  }

  async #loadFromDisk() {
    let raw = null;
    try {
      raw = await fs.readFile(this.#file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // 首次使用：空表即可，不在读取阶段创建文件
        this.#entries = [];
        this.#index = new Map();
        this.#loaded = true;
        return;
      }
      throw err;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    const list = Array.isArray(parsed)
      ? parsed
      : parsed && Array.isArray(parsed.entries)
        ? parsed.entries
        : null;

    if (!list) {
      // 文件损坏：备份后回退为空表，绝不让宿主崩
      await this.#backupCorrupt(raw);
      this.#entries = [];
      this.#index = new Map();
      this.#loaded = true;
      return;
    }

    const entries = [];
    const index = new Map();
    for (const item of list) {
      const rec = normalize(item);
      if (!rec) continue;
      const k = keyOf(rec.word);
      if (index.has(k)) {
        // 文件里出现重复词：保留更靠前（更新）的那条
        continue;
      }
      index.set(k, entries.length);
      entries.push(rec);
    }
    this.#entries = entries;
    this.#index = index;
    this.#loaded = true;
  }

  async #backupCorrupt(raw) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${this.#file}.corrupt-${stamp}.bak`;
    try {
      await fs.rename(this.#file, backup);
    } catch {
      try {
        await fs.writeFile(backup, raw == null ? '' : raw, 'utf8');
      } catch {
        /* 备份失败也不影响降级为空表 */
      }
    }
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 全部条目，最新收藏在前（返回副本，外部修改不影响内部状态）。 */
  async list() {
    await this.load();
    return this.#entries.map(toRecord);
  }

  /** 是否已收藏（大小写不敏感）。 */
  async has(word) {
    await this.load();
    if (typeof word !== 'string' || !word.trim()) return false;
    return this.#index.has(keyOf(word.trim()));
  }

  /* ------------------------------ 写入 ------------------------------ */

  /**
   * 收藏一个单词。
   * - 大小写不敏感去重：已存在则更新 brief（其余字段按传入值更新，未传则保留），
   *   位置与 addedAt 不变；
   * - 超出上限（5000）淘汰最旧一条；
   * - phoneticUs / phoneticGb 为美音 / 英音双音标，可空字符串（缺数据）。
   * @param {{word: string, phonetic?: string, phoneticUs?: string, phoneticGb?: string, brief?: string, dictName?: string}} item
   * @returns {Promise<{word: string, phonetic: string, phoneticUs: string, phoneticGb: string, brief: string, dictName: string, addedAt: number}>}
   */
  async add(item) {
    const rec = normalize(item);
    if (!rec) throw new TypeError('Wordbook.add: word must be a non-empty string');
    await this.load();

    return this.#enqueue(async () => {
      const k = keyOf(rec.word);
      const at = this.#index.get(k);
      if (at !== undefined) {
        const existing = this.#entries[at];
        // 保留原位置与 addedAt
        existing.brief = rec.brief || existing.brief;
        existing.phonetic = rec.phonetic || existing.phonetic;
        existing.phoneticUs = rec.phoneticUs || existing.phoneticUs;
        existing.phoneticGb = rec.phoneticGb || existing.phoneticGb;
        existing.dictName = rec.dictName || existing.dictName;
        await this.#persist();
        return toRecord(existing);
      }

      const entry = { ...rec, addedAt: Date.now() };
      this.#entries.unshift(entry);
      this.#reindex();
      if (this.#entries.length > MAX_ENTRIES) {
        this.#entries.length = MAX_ENTRIES; // 淘汰最旧（尾部）
        this.#reindex();
      }
      await this.#persist();
      return toRecord(entry);
    });
  }

  /**
   * 删除单词（大小写不敏感）。
   * @param {string} word
   * @returns {Promise<boolean>} 是否真的删除了
   */
  async remove(word) {
    if (typeof word !== 'string' || !word.trim()) return false;
    await this.load();
    const k = keyOf(word.trim());
    return this.#enqueue(async () => {
      const at = this.#index.get(k);
      if (at === undefined) return false;
      this.#entries.splice(at, 1);
      this.#reindex();
      await this.#persist();
      return true;
    });
  }

  /**
   * 清空单词本。
   * @returns {Promise<number>} 被清除的条数
   */
  async clear() {
    await this.load();
    return this.#enqueue(async () => {
      const removed = this.#entries.length;
      this.#entries = [];
      this.#index = new Map();
      await this.#persist();
      return removed;
    });
  }

  /* ------------------------------ 内部 ------------------------------ */

  #reindex() {
    const index = new Map();
    for (let i = 0; i < this.#entries.length; i++) index.set(keyOf(this.#entries[i].word), i);
    this.#index = index;
  }

  /** 原子落盘：写 <file>.tmp 后 rename 覆盖。 */
  async #persist() {
    const payload = JSON.stringify(
      { version: FILE_VERSION, entries: this.#entries.map(toRecord) },
      null,
      2,
    );
    const dir = path.dirname(this.#file);
    const tmp = `${this.#file}.tmp`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, payload, 'utf8');
    try {
      await fs.rename(tmp, this.#file);
    } catch (err) {
      // Windows 上目标被其他进程短暂占用时重试一次
      if (err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EBUSY')) {
        await new Promise((r) => setTimeout(r, 50));
        await fs.rename(tmp, this.#file);
      } else {
        throw err;
      }
    }
  }

  /** 串行执行写操作。 */
  #enqueue(fn) {
    const run = this.#queue.then(fn, fn);
    // 无论成败都继续排队，但异常仍回传给调用方
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
