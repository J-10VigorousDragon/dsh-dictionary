/**
 * dict.js — 词典门面（DictionaryHub）与释义解析
 *
 * 职责分层：
 *   stardict.js 只管「拿到某个词条的原始正文」；
 *   本文件负责多词典优先级、词形回退、正文解析成结构化条目。
 */

import { StardictBook, asciiLower } from './stardict.js';

/* -------------------------------------------------------------------------- */
/* 正文解析                                                                    */
/* -------------------------------------------------------------------------- */

/** 可识别的词性缩写（不含点号）。 */
const POS_TOKENS = new Set([
  'n', 'v', 'vt', 'vi', 'adj', 'a', 'ad', 'adv', 'prep', 'conj', 'pron', 'num',
  'art', 'interj', 'int', 'aux', 'pl', 'abbr', 'pref', 'suff', 'suf', 'p', 'pp',
  'det', 'excl', 'modal', 'phr', 'na',
]);

/** 视为「词形变化」结构的方括号标签（ECDICT 用 [时态]/[原型]/[级别]）。 */
const EXCHANGE_TAGS = new Set([
  '时态', '原型', '级别', '词形变化', '复数', '过去式', '过去分词', '现在分词',
  '第三人称单数', '比较级', '最高级', '派生', '变形', 'exchange', 'forms',
]);

/** ECDICT 词频元数据行，如 (中高 2695/2446)、(35981/-)、(高研四六 -/11804)。 */
const FREQ_META_RE = /^\([^()]*\/[^()]*\)$/;

/** 首行音标：可选的 * 前缀 + [音标]，后面允许有 -K3 之类残渣。 */
const PHONETIC_RE = /^\*?\s*\[([^\[\]]{1,80})\]/;

/** 含 CJK / 全角标点 / 中文括号 ⇒ 一定不是音标。 */
const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/;

/** 音标里应出现的字符（拉丁字母、IPA、重音符）。 */
const PHONETIC_CHAR_RE = /[A-Za-zæɑɒɔəɜɪʊʌʒʃθðŋɡˈˌː'’]/;

/** 形如 "n. 苹果, 家伙" / "vt. 使跑" 的行首词性。 */
const POS_LINE_RE = /^((?:[A-Za-z]{1,7}\.\s*){1,3})([\s\S]+)$/;

/** 形如 "[时态] ran, run, running, runs" 的词形行。 */
const EXCHANGE_LINE_RE = /^\[([^\]\n]{1,10})\]\s*([\s\S]+)$/;

/**
 * 判断方括号内容是否像音标（排除 [网络]/[地名]/[医] 这类标签）。
 * @param {string} inner
 */
function looksLikePhonetic(inner) {
  if (!inner || inner.length > 80) return false;
  if (CJK_RE.test(inner)) return false;
  return PHONETIC_CHAR_RE.test(inner);
}

/**
 * 把一个词条的原始正文解析为结构化字段。
 *
 * 规则（与 API 契约一致）：
 *  - 首行 `[...]`（可带 * 前缀）且内容非中文 ⇒ phonetic；
 *  - 行首词性 n./vt./adj./prep. … ⇒ 拆进 pos，其余进 text；
 *  - `[网络]` `[地名]` `【医】` 这类标签行原样保留在 text；
 *  - `[时态]`/`[原型]`/`[级别]` 等结构 ⇒ exchange；
 *  - ECDICT 词频元数据 `(中高 2695/2446)` ⇒ 丢弃；
 *  - tags 恒为空数组（两本词库正文里没有可靠的标签字段）。
 *
 * @param {string} text
 * @returns {{ phonetic: string, definitions: Array<{pos: string, text: string}>, tags: string[], exchange: string[] }}
 */
export function parseEntryBody(text) {
  const result = { phonetic: '', definitions: [], tags: [], exchange: [] };
  if (text == null) return result;
  const body = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!body.trim()) return result;

  const lines = body.split('\n');
  let start = 0;

  // 首行音标
  const first = lines[0].trim();
  if (first) {
    const m = PHONETIC_RE.exec(first);
    if (m && looksLikePhonetic(m[1])) {
      result.phonetic = m[1].trim();
      start = 1;
    }
  }

  for (let i = start; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    // ECDICT 词频元数据
    if (FREQ_META_RE.test(t)) continue;

    // 词形变化行
    const ex = EXCHANGE_LINE_RE.exec(t);
    if (ex && EXCHANGE_TAGS.has(ex[1].trim())) {
      const value = ex[2].trim();
      if (value) result.exchange.push(value);
      continue;
    }

    // 词性行
    const pos = POS_LINE_RE.exec(t);
    if (pos) {
      const tokens = pos[1].trim().split(/\s+/);
      const allPos = tokens.every((tok) => {
        const bare = tok.replace(/\.$/, '').toLowerCase();
        return tok.endsWith('.') && POS_TOKENS.has(bare);
      });
      if (allPos) {
        result.definitions.push({ pos: pos[1].trim(), text: pos[2].trim() });
        continue;
      }
    }

    // 其余（含 [网络]/[地名]/【医】/相关词组/中文释义）原样进 text
    result.definitions.push({ pos: '', text: t });
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* 词形回退                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 生成屈折形式候选原形，顺序：s → es → ies → ed → ing → 's。
 * 已 ASCII 折叠（入参为小写 key）。
 * @param {string} w
 * @returns {string[]}
 */
export function inflectionCandidates(w) {
  const out = [];
  const add = (s) => {
    if (!s || s.length < 2 || s === w) return;
    if (!out.includes(s)) out.push(s);
  };
  // 双写辅音还原：stopped→stopp→stop，running→runn→run
  const addBase = (base) => {
    add(base);
    if (base.length >= 3) {
      const a = base[base.length - 1];
      const b = base[base.length - 2];
      if (a === b && !'aeiou'.includes(a)) add(base.slice(0, -1));
    }
  };

  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith("'s")) add(w.slice(0, -1));
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('ies')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('ied')) add(`${w.slice(0, -3)}y`);
  if (w.endsWith('ed')) {
    addBase(w.slice(0, -2));
    add(w.slice(0, -1));
  }
  if (w.endsWith('ing')) {
    addBase(w.slice(0, -3));
    add(`${w.slice(0, -3)}e`);
  }
  if (w.endsWith("'s")) add(w.slice(0, -2));
  return out;
}

/* -------------------------------------------------------------------------- */
/* DictionaryHub                                                               */
/* -------------------------------------------------------------------------- */

export class DictionaryHub {
  #paths;
  #order;
  /** @type {StardictBook[]} */
  #books = [];
  #inited = false;

  /**
   * @param {{ paths?: string[], order?: string[] }} [options]
   *   paths: 每个元素是一个 StarDict 词库目录
   *   order: 词典名优先级（命中名字即前置；未列出的按 paths 顺序排在后面）
   */
  constructor({ paths = [], order = [] } = {}) {
    this.#paths = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
    this.#order = Array.isArray(order) ? order.filter((o) => typeof o === 'string' && o.trim()) : [];
  }

  /** 建立索引（打开全部词库）。可重复调用，已初始化则直接返回。 */
  async init() {
    if (this.#inited) return;
    const books = [];
    for (const p of this.#paths) {
      books.push(await StardictBook.open(p)); // open 内部不抛异常
    }
    if (this.#order.length) {
      const rank = (name) => {
        const n = asciiLower(String(name || ''));
        for (let i = 0; i < this.#order.length; i++) {
          const o = asciiLower(this.#order[i]);
          if (n === o || n.includes(o) || o.includes(n)) return i;
        }
        return this.#order.length + 1;
      };
      // Array.prototype.sort 在 V8 中是稳定排序 ⇒ 同优先级保持 paths 顺序
      books.sort((a, b) => rank(a.info.name) - rank(b.info.name));
    }
    this.#books = books;
    this.#inited = true;
  }

  /** @returns {Array<{name: string, wordcount: number, dir: string, ok: boolean, error?: string}>} */
  get status() {
    return this.#books.map((b) => b.info);
  }

  /** 已就绪（ok=true）的词库数量。 */
  get readyCount() {
    return this.#books.filter((b) => b.ready).length;
  }

  /** 按优先级顺序收集所有命中的原始词条。 */
  #collect(word) {
    const hits = [];
    for (const book of this.#books) {
      if (!book.ready) continue;
      const info = book.info;
      for (const rec of book.lookupSync(word)) {
        hits.push({ word: rec.word, text: rec.text, dict: info.name });
      }
    }
    return hits;
  }

  /**
   * 查词。
   * 词形回退：精确（大小写不敏感）→ 去屈折后缀 → 前缀候选（放进 suggestions）。
   * @param {string} rawQuery
   * @returns {Promise<{
   *   entries: Array<{word: string, dict: string, phonetic: string, definitions: Array<{pos: string, text: string}>, tags: string[], exchange: string[]}>,
   *   suggestions: string[]
   * }>}
   */
  async lookup(rawQuery) {
    const query = String(rawQuery == null ? '' : rawQuery).trim();
    if (!query) return { entries: [], suggestions: [] };
    if (!this.#inited) await this.init();

    const key = asciiLower(query);
    let hits = this.#collect(key);
    if (!hits.length) {
      for (const cand of inflectionCandidates(key)) {
        hits = this.#collect(cand);
        if (hits.length) break;
      }
    }

    if (!hits.length) {
      return { entries: [], suggestions: await this.suggest(query, 20) };
    }

    const entries = hits.map((h) => {
      const parsed = parseEntryBody(h.text);
      return {
        word: h.word,
        dict: h.dict,
        phonetic: parsed.phonetic,
        definitions: parsed.definitions,
        tags: parsed.tags,
        exchange: parsed.exchange,
      };
    });
    return { entries, suggestions: [] };
  }

  /**
   * 跨词典前缀补全（去重，字母序）。
   * @param {string} prefix
   * @param {number} [limit]
   * @returns {Promise<string[]>}
   */
  async suggest(prefix, limit = 20) {
    const p = String(prefix == null ? '' : prefix).trim();
    const max = Math.max(1, Math.min(200, Number(limit) || 20));
    if (!p) return [];
    if (!this.#inited) await this.init();

    /** @type {Map<string, string>} lower → 首次出现的原始写法 */
    const seen = new Map();
    for (const book of this.#books) {
      if (!book.ready) continue;
      for (const w of book.suggestSync(p, max * 3)) {
        const k = asciiLower(w);
        if (!seen.has(k)) seen.set(k, w);
        if (seen.size >= max * 4) break;
      }
      if (seen.size >= max * 4) break;
    }
    return [...seen.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, max)
      .map((e) => e[1]);
  }

  /** 单本词典的索引耗时/缓存命中情况，供测试与诊断使用。 */
  get diagnostics() {
    return this.#books.map((b) => ({
      ...b.info,
      buildMs: b.buildMs,
      cacheHit: b.cacheHit,
    }));
  }

  /** 关闭文件描述符，释放资源（Electron 退出时调用）。 */
  dispose() {
    for (const b of this.#books) b.dispose();
    this.#books = [];
    this.#inited = false;
  }
}
