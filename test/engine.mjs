#!/usr/bin/env node
/**
 * test/engine.mjs — 词典引擎回归测试
 *
 * 运行：node test/engine.mjs
 * 覆盖：两本 StarDict 建索引、热态查词、词形回退、前缀补全、释义解析、单词本持久化。
 *
 * 词库路径可用环境变量覆盖：
 *   DSH_DICT_LANDAO_DIR / DSH_DICT_ECDICT_DIR
 * 失败时进程退出码非零。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { StardictBook, cacheDir } from '../src/host/stardict.js';
import { DictionaryHub, parseEntryBody, inflectionCandidates } from '../src/host/dict.js';
import { Wordbook } from '../src/host/wordbook.js';

const HOME = os.homedir();
const DEFAULT_ROOT = path.join(HOME, 'Documents', 'Readest词典');
const LANDAO_DIR =
  process.env.DSH_DICT_LANDAO_DIR || path.join(DEFAULT_ROOT, '朗道英汉5.0');
const ECDICT_DIR =
  process.env.DSH_DICT_ECDICT_DIR || path.join(DEFAULT_ROOT, 'ECDICT-英汉-Stardict');

/** 必须能查到的 5 个词（验收口径）。 */
const WORDS = ['apple', 'serendipity', 'glasses', 'hello', 'recursion'];

let checks = 0;
let failures = 0;

const fmt = (ms) => `${ms.toFixed(2)}ms`;

function check(cond, label, detail) {
  checks++;
  if (cond) {
    console.log(`  [ok]   ${label}`);
  } else {
    failures++;
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`);
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 取第一条释义的可读摘要。 */
function briefOf(entry) {
  const def = entry.definitions && entry.definitions[0];
  if (!def) return '(empty)';
  return def.pos ? `${def.pos} ${def.text}` : def.text;
}

function truncate(str, n = 64) {
  const s = String(str).replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function median(xs) {
  const a = [...xs].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * 生成一个最小可用的合成 StarDict 词库（用于验证缓存/失效/.dict.dz 逻辑，
 * 不依赖本机真实词库）。
 * @param {string} dir
 * @param {{bookname: string, entries: Array<[string, string]>, dz?: boolean}} options
 */
function writeSyntheticDict(dir, { bookname, entries, dz = false }) {
  fs.mkdirSync(dir, { recursive: true });
  // StarDict idx 按 ASCII 大小写不敏感排序，这里按小写序生成以保证二分查找成立
  const sorted = [...entries].sort((a, b) => {
    const x = a[0].toLowerCase();
    const y = b[0].toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const idxParts = [];
  const bodies = [];
  let offset = 0;
  for (const [word, text] of sorted) {
    const w = Buffer.from(word, 'utf8');
    const body = Buffer.from(text, 'utf8');
    const rec = Buffer.alloc(w.length + 1 + 8);
    w.copy(rec, 0);
    rec.writeUInt32BE(offset, w.length + 1);
    rec.writeUInt32BE(body.length, w.length + 5);
    idxParts.push(rec);
    bodies.push(body);
    offset += body.length;
  }
  const idx = Buffer.concat(idxParts);
  const dict = Buffer.concat(bodies);
  fs.writeFileSync(path.join(dir, 'test.idx'), idx);
  if (dz) fs.writeFileSync(path.join(dir, 'test.dict.dz'), zlib.gzipSync(dict));
  else fs.writeFileSync(path.join(dir, 'test.dict'), dict);
  fs.writeFileSync(
    path.join(dir, 'test.ifo'),
    [
      "StarDict's dict ifo file",
      'version=2.4.2',
      `wordcount=${sorted.length}`,
      `idxfilesize=${idx.length}`,
      `bookname=${bookname}`,
      'sametypesequence=m',
      '',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

/* -------------------------------------------------------------------------- */

async function main() {
  section('0. 词库定位');
  console.log(`  朗道: ${LANDAO_DIR}`);
  console.log(`  ECDICT: ${ECDICT_DIR}`);
  const haveLan = exists(path.join(LANDAO_DIR, 'langdao-ec-gb.ifo'));
  const haveEcd = exists(ECDICT_DIR) && fs.readdirSync(ECDICT_DIR).some((f) => f.endsWith('.ifo'));
  if (!haveLan && !haveEcd) {
    console.log('  [SKIP] 本机未找到任何 StarDict 词库，跳过（可用 DSH_DICT_*_DIR 指定）');
    return;
  }
  check(haveLan, '发现朗道词库', LANDAO_DIR);
  check(haveEcd, '发现 ECDICT 词库', ECDICT_DIR);

  /* ---------------------------- 1. 单本建索引 ---------------------------- */
  section('1. 单本词典建索引（StardictBook.open）');
  const books = [];
  for (const dir of [LANDAO_DIR, ECDICT_DIR]) {
    if (dir === LANDAO_DIR && !haveLan) continue;
    if (dir === ECDICT_DIR && !haveEcd) continue;
    const t0 = performance.now();
    const book = await StardictBook.open(dir);
    const ms = performance.now() - t0;
    books.push({ book, ms });
    const info = book.info;
    console.log(
      `  ${info.name} | wordcount=${info.wordcount} | 建索引 ${fmt(ms)} | ` +
        `缓存命中=${book.cacheHit} | ok=${info.ok}${info.error ? ` | error=${info.error}` : ''}`,
    );
    check(info.ok, `${info.name} 打开成功`, info.error);
    check(info.wordcount > 1000, `${info.name} 词条数合理（${info.wordcount}）`);
    if (dir === LANDAO_DIR) {
      check(ms < 3000, `朗道建索引 < 3s（实测 ${fmt(ms)}）`);
    } else {
      check(ms < 10000, `ECDICT 建索引 < 10s（实测 ${fmt(ms)}）`);
    }
  }

  // 索引缓存确实落到仓库根 .cache/
  const cacheFiles = fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir()).filter((f) => f.endsWith('.starts')) : [];
  check(cacheFiles.length > 0, `索引缓存已写入 .cache/（${cacheFiles.length} 个文件）`, cacheDir());

  /* ---------------------------- 2. Hub 初始化 ---------------------------- */
  section('2. DictionaryHub 初始化（两本词库）');
  const paths = [LANDAO_DIR, ECDICT_DIR].filter((d, i) => (i === 0 ? haveLan : haveEcd));
  const hub = new DictionaryHub({ paths });
  const tHub = performance.now();
  await hub.init();
  const hubMs = performance.now() - tHub;
  console.log(`  init 耗时 ${fmt(hubMs)}`);
  for (const st of hub.status) {
    console.log(`  - ${st.name} | ${st.wordcount} 词条 | ok=${st.ok}`);
  }
  check(hub.status.length === paths.length, 'status 覆盖全部词库');
  check(hub.readyCount === paths.length, '所有词库就绪');

  /* ---------------------------- 3. 查词 ---------------------------- */
  section('3. 查词（首次 → 热态 5 次）');
  const results = new Map();
  for (const word of WORDS) {
    // 预热（首次查词可能触发页面读盘）
    const cold0 = performance.now();
    const cold = await hub.lookup(word);
    const coldMs = performance.now() - cold0;

    const timings = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const r = await hub.lookup(word);
      timings.push(performance.now() - t0);
      if (i === 0) results.set(word, r);
    }
    if (!results.has(word)) results.set(word, cold);

    const r = results.get(word);
    const med = median(timings);
    console.log(
      `\n  "${word}"  首次 ${fmt(coldMs)} | 热态 5 次 ` +
        `[${timings.map((t) => t.toFixed(2)).join(', ')}]ms | 中位 ${fmt(med)}`,
    );
    if (r.entries.length === 0) {
      console.log(`    ✗ 未命中；suggestions=[${r.suggestions.slice(0, 8).join(', ')}]`);
    } else {
      const byDict = new Map();
      for (const e of r.entries) {
        if (!byDict.has(e.dict)) byDict.set(e.dict, []);
        byDict.get(e.dict).push(e);
      }
      for (const [dict, list] of byDict) {
        const e = list[0];
        console.log(
          `    ✓ ${dict}：${e.word}  phonetic=${e.phonetic || '(无)'}  ` +
            `首条释义=${truncate(briefOf(e))}  defs=${e.definitions.length}  exchange=${e.exchange.length}`,
        );
      }
    }

    check(r.entries.length > 0, `"${word}" 能查到`);
    check(med < 10, `"${word}" 热态查词中位 < 10ms（实测 ${fmt(med)}）`);
    check(r.suggestions.length === 0, `"${word}" 命中时 suggestions 为空`);
  }

  /* ---------------------------- 4. 契约细节 ---------------------------- */
  section('4. API 契约细节');

  // 4.1 两本词典都能命中 apple
  const apple = results.get('apple');
  const appleDicts = new Set(apple.entries.map((e) => e.dict));
  check(appleDicts.size === paths.length, `apple 在两本词典都命中（${[...appleDicts].join(' / ')}）`);

  // 4.2 优先级：entries 按词典顺序排列
  if (paths.length > 1) {
    const order = hub.status.map((s) => s.name);
    const idx = apple.entries.map((e) => order.indexOf(e.dict));
    check(
      idx.every((v, i) => i === 0 || idx[i - 1] <= v),
      `entries 按词典优先级排列（${order.join(' > ')}）`,
    );
  }

  // 4.3 首本未命中顺延下一本：glasses 只在 ECDICT 有
  const glasses = results.get('glasses');
  console.log(`  glasses 命中词典：${[...new Set(glasses.entries.map((e) => e.dict))].join(' / ')}`);
  check(glasses.entries.length > 0, 'glasses 命中（跨词典顺延成功）');

  // 4.4 词形回退：精确优先（屈折形式本身是词条时不得降级为原形）
  for (const form of ['apples', 'studies', 'running', 'stopped']) {
    const r = await hub.lookup(form);
    const words = [...new Set(r.entries.map((e) => e.word.toLowerCase()))];
    check(words.includes(form), `精确优先：${form} 直接命中自身`, `实际 [${words.join(', ')}]`);
  }

  // 这两本词库收录极全，以下词条「精确缺失、只能靠屈折回退」（实测筛出的真实样例）
  const inflectCases = [
    ['weltschmerzes', 'weltschmerz'],
    ['laconics', 'laconic'],
    ['gubbinses', 'gubbins'],
    ['nerdied', 'nerdy'],
  ];
  for (const [from, to] of inflectCases) {
    const r = await hub.lookup(from);
    const words = r.entries.map((e) => e.word.toLowerCase());
    check(
      words.includes(to) && !words.includes(from),
      `屈折回退 ${from} → ${to}`,
      r.entries.length ? `实际命中 [${[...new Set(words)].join(', ')}]` : '未命中',
    );
  }

  // 4.4b inflectionCandidates 单元断言
  const cand = (w) => inflectionCandidates(w);
  check(cand('stopped').includes('stop'), 'candidate: stopped → stop');
  check(cand('running').includes('run'), 'candidate: running → run');
  check(cand('studies').includes('study'), 'candidate: studies → study');
  check(cand("teacher's").includes('teacher'), "candidate: teacher's → teacher");
  check(cand('glasses').includes('glass'), 'candidate: glasses → glass');
  check(
    cand('recursion').length === 0,
    'candidate: 无后缀词不产生候选',
    JSON.stringify(cand('recursion')),
  );

  // 4.5 前缀补全
  const sug = await hub.suggest('appl', 10);
  console.log(`  suggest("appl") = [${sug.join(', ')}]`);
  check(sug.length > 0, 'suggest 前缀补全非空');
  check(sug.some((s) => s.toLowerCase().startsWith('appl')), 'suggest 结果均以前缀开头');
  const sorted = [...sug].map((s) => s.toLowerCase());
  check(
    sorted.every((v, i) => i === 0 || sorted[i - 1] <= v),
    'suggest 结果按字母序',
  );

  // 4.6 完全未命中 → 空 entries + suggestions
  const miss = await hub.lookup('zzzqqxx');
  console.log(`  lookup("zzzqqxx") → entries=${miss.entries.length} suggestions=${miss.suggestions.length}`);
  check(miss.entries.length === 0, '未命中时 entries 为空');
  check(Array.isArray(miss.suggestions), '未命中时 suggestions 是数组');

  // 4.7 大小写不敏感
  const upper = await hub.lookup('APPLE');
  check(upper.entries.length > 0, '大写 APPLE 也能命中');

  // 4.8 解析结构完整性
  const a = apple.entries[0];
  check(typeof a.word === 'string' && a.word.length > 0, 'entry.word 是字符串');
  check(typeof a.phonetic === 'string' && a.phonetic.length > 0, `entry.phonetic 非空（${a.phonetic}）`);
  check(Array.isArray(a.definitions) && a.definitions.length > 0, 'entry.definitions 非空');
  check(
    a.definitions.every((d) => typeof d.pos === 'string' && typeof d.text === 'string'),
    'definitions 每项含 pos/text 字符串',
  );
  check(Array.isArray(a.tags), 'entry.tags 是数组');
  check(Array.isArray(a.exchange), 'entry.exchange 是数组');
  const posSample = a.definitions.find((d) => d.pos);
  check(!!posSample, '释义行首词性被拆进 pos', JSON.stringify(a.definitions.slice(0, 3)));
  // 标签行保留在 text
  const tagged = (await hub.lookup('apple')).entries[0].definitions.some((d) => /^[[【]/.test(d.text));
  check(tagged, '标签行（[医]/【医】）保留在 text');
  // exchange：ECDICT 的 [时态] 行
  const runEntry = (await hub.lookup('run')).entries.find((e) => e.exchange.length > 0);
  check(!!runEntry, 'run 的 exchange 收集到词形变化', runEntry ? '' : '未收集到');
  if (runEntry) console.log(`  run.exchange = ${JSON.stringify(runEntry.exchange)}`);

  // 4.9 parseEntryBody 单元断言（不依赖磁盘数据）
  const sample = parseEntryBody("*['æpl]   -K3\nn. 苹果, 家伙\n[医] 苹果\n(中高 2695/2446)");
  check(sample.phonetic === "'æpl", `音标去括号且丢弃 -K3 残渣（${sample.phonetic}）`);
  check(sample.definitions.length === 2, '词频元数据行被丢弃（2 条释义）', JSON.stringify(sample.definitions));
  check(sample.definitions[0].pos === 'n.' && sample.definitions[0].text === '苹果, 家伙', '词性拆分正确');
  check(
    sample.definitions[1].pos === '' && sample.definitions[1].text === '[医] 苹果',
    '标签行保留在 text',
  );
  const netSample = parseEntryBody('[网络] 游戏；一个游戏');
  check(netSample.phonetic === '' && netSample.definitions[0].text.startsWith('[网络]'), '[网络] 不被误判为音标');
  const exSample = parseEntryBody("[时态] ran, run, running, runs\nn. 跑");
  check(
    exSample.exchange.length === 1 && exSample.exchange[0] === 'ran, run, running, runs',
    'exchange 收集 [时态] 行',
    JSON.stringify(exSample.exchange),
  );
  check(parseEntryBody('').definitions.length === 0, '空正文解析为空结构');

  // 4.10 空查询
  const empty = await hub.lookup('   ');
  check(empty.entries.length === 0 && empty.suggestions.length === 0, '空查询返回空结果');

  // 4.11 降级：坏路径不拖垮整体
  const degraded = new DictionaryHub({
    paths: [path.join(LANDAO_DIR, '__not_exist__'), ...(haveEcd ? [ECDICT_DIR] : [])],
  });
  await degraded.init();
  const degStatus = degraded.status;
  console.log(
    `  降级场景 status: ${degStatus.map((s) => `${s.name}(ok=${s.ok}${s.error ? `, ${s.error}` : ''})`).join(' | ')}`,
  );
  check(degStatus.length === (haveEcd ? 2 : 1), '坏路径仍出现在 status 里');
  check(degStatus.some((s) => s.ok === false && typeof s.error === 'string'), '坏路径 ok=false 且带 error');
  if (haveEcd) {
    const deg = await degraded.lookup('apple');
    check(deg.entries.length > 0, '坏路径存在时好词典仍可查词');
  }
  degraded.dispose();

  /* ---------------------------- 5. 合成词库 ---------------------------- */
  section('5. 合成词库：缓存命中/失效、.dict.dz、order 优先级');
  const synthRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dict-synth-'));
  const cacheBefore = new Set(fs.existsSync(cacheDir()) ? fs.readdirSync(cacheDir()) : []);
  try {
    const SAMPLE = [
      ['alpha', 'n. 阿尔法\n[网络] 第一个'],
      ['beta', "*['bi:tə]\nn. 贝塔"],
      ['betamax', 'n. 贝塔迈克斯'],
      ['gamma', "*['gæmə]\nn. 伽马"],
    ];
    const dirA = writeSyntheticDict(path.join(synthRoot, 'alpha'), {
      bookname: 'Alpha Dict',
      entries: [...SAMPLE, ['shared', 'n. A 词典释义']],
    });
    const dirB = writeSyntheticDict(path.join(synthRoot, 'beta'), {
      bookname: 'Beta Dict',
      entries: [...SAMPLE, ['shared', 'n. B 词典释义']],
      dz: true,
    });

    // 5.1 合成词库可读
    const a1 = await StardictBook.open(dirA);
    check(a1.info.ok, '合成词库打开成功', a1.error);
    check(a1.info.name === 'Alpha Dict', `ifo bookname 解析（${a1.info.name}）`);
    check(a1.info.wordcount === 5, `合成词库词条数 5（${a1.info.wordcount}）`);
    const betaRec = await a1.lookup('beta');
    check(
      betaRec.length === 1 && betaRec[0].word === 'beta' && betaRec[0].text.includes('贝塔'),
      '合成词库查词正确',
      JSON.stringify(betaRec),
    );
    check((await a1.lookup('BETA')).length === 1, '合成词库大小写不敏感');
    const sugBet = await a1.suggest('bet', 10);
    check(
      JSON.stringify(sugBet) === JSON.stringify(['beta', 'betamax']),
      '合成词库前缀补全按字母序',
      JSON.stringify(sugBet),
    );
    check((await a1.lookup('nope')).length === 0, '合成词库未命中返回空数组');
    check(a1.cacheHit === false, '首次打开未命中缓存');

    // 5.2 第二次打开命中缓存
    const a2 = await StardictBook.open(dirA);
    check(a2.cacheHit === true, '第二次打开命中索引缓存');
    check(a2.info.wordcount === 5 && a2.info.ok, '缓存载入后词条数一致');

    // 5.3 idx 变化后缓存失效
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dirA, 'test.idx'), future, future);
    const a3 = await StardictBook.open(dirA);
    check(a3.cacheHit === false, 'idx mtime 变化 ⇒ 缓存失效重建');
    check(a3.info.wordcount === 5, '重建后词条数仍正确');
    a1.dispose();
    a2.dispose();
    a3.dispose();

    // 5.4 .dict.dz（= gzip）可解压查词
    const b1 = await StardictBook.open(dirB);
    check(b1.info.ok, '.dict.dz 词库打开成功', b1.error);
    const gamma = await b1.lookup('gamma');
    check(gamma.length === 1 && gamma[0].text.includes('伽马'), '.dict.dz 解压后查词正确', JSON.stringify(gamma));
    b1.dispose();

    // 5.5 order 决定同词命中优先级
    const hubDefault = new DictionaryHub({ paths: [dirA, dirB] });
    await hubDefault.init();
    const dflt = await hubDefault.lookup('shared');
    check(dflt.entries.length === 2, '两本词典同时命中 shared', `entries=${dflt.entries.length}`);
    check(dflt.entries[0].dict === 'Alpha Dict', '默认按 paths 顺序（Alpha）', dflt.entries.map((e) => e.dict).join(' > '));
    hubDefault.dispose();

    const hubOrdered = new DictionaryHub({ paths: [dirA, dirB], order: ['Beta Dict'] });
    await hubOrdered.init();
    const ordered = await hubOrdered.lookup('shared');
    check(ordered.entries[0].dict === 'Beta Dict', 'order 生效（Beta 前置）', ordered.entries.map((e) => e.dict).join(' > '));
    check(hubOrdered.status[0].name === 'Beta Dict', 'status 也按 order 排列');
    hubOrdered.dispose();
  } finally {
    // 清理合成词库与其产生的缓存文件
    fs.rmSync(synthRoot, { recursive: true, force: true });
    if (fs.existsSync(cacheDir())) {
      for (const f of fs.readdirSync(cacheDir())) {
        if (!cacheBefore.has(f) && f.endsWith('.starts')) {
          try {
            fs.rmSync(path.join(cacheDir(), f));
          } catch {
            /* ignore */
          }
        }
      }
    }
  }

  /* ---------------------------- 6. Wordbook ---------------------------- */
  section('6. Wordbook 单词本');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dict-wb-'));
  const file = path.join(dir, 'wordbook.json');
  try {
    const wb = new Wordbook(file);
    await wb.load();
    check(wb.count === 0, '初始为空');
    check((await wb.list()).length === 0, '空表 list 返回 []');

    await wb.add({ word: 'apple', phonetic: 'ˈæpl', brief: 'n. 苹果', dictName: '朗道英汉字典5.0' });
    await wb.add({ word: 'banana', phonetic: 'bəˈnɑːnə', brief: 'n. 香蕉', dictName: '朗道英汉字典5.0' });
    check(wb.count === 2, 'add 后 count=2');
    const list1 = await wb.list();
    check(list1[0].word === 'banana', '最新收藏在前', JSON.stringify(list1.map((x) => x.word)));

    // 大小写不敏感去重 + 更新 brief + 保持位置
    await wb.add({ word: 'Apple', phonetic: '', brief: 'n. 苹果（更新）', dictName: '' });
    check(wb.count === 2, '重复 add 不增加条数', `count=${wb.count}`);
    const list2 = await wb.list();
    const appleRec = list2.find((x) => x.word.toLowerCase() === 'apple');
    check(appleRec && appleRec.brief.includes('更新'), '重复 add 更新 brief', JSON.stringify(appleRec));
    check(list2[1].word === 'apple', '重复 add 保持原位置', JSON.stringify(list2.map((x) => x.word)));
    check(appleRec.phonetic === 'ˈæpl', '重复 add 未传字段保留原值', JSON.stringify(appleRec));

    check(await wb.has('APPLE'), 'has 大小写不敏感');
    check((await wb.has('cherry')) === false, 'has 未收藏词返回 false');

    // 落盘可重载
    const wb2 = new Wordbook(file);
    await wb2.load();
    check(wb2.count === 2, '重新打开后条目保留');
    check((await wb2.list())[0].word === 'banana', '重新打开后顺序保留');
    check(!fs.existsSync(`${file}.tmp`), '原子写入未残留 .tmp 文件');

    // 上限淘汰：默认 5000，这里验证插入顺序语义（少量数据不应淘汰）
    for (let i = 0; i < 20; i++) await wb.add({ word: `w${i}`, brief: `b${i}` });
    check(wb.count === 22, '批量 add 后 count=22', `count=${wb.count}`);
    check((await wb.list())[0].word === 'w19', '最新在前（批量）');

    check((await wb.remove('BANANA')) === true, 'remove 大小写不敏感返回 true');
    check((await wb.remove('nope')) === false, 'remove 不存在返回 false');
    check(wb.count === 21, 'remove 后 count=21');

    const removed = await wb.clear();
    check(removed === 21, `clear 返回清除条数（${removed}）`);
    check(wb.count === 0, 'clear 后 count=0');

    // 坏文件自愈
    const badPath = path.join(dir, 'bad.json');
    fs.writeFileSync(badPath, '{ this is not json ', 'utf8');
    const wb3 = new Wordbook(badPath);
    await wb3.load();
    check(wb3.count === 0, '损坏文件回退为空表且不抛异常');
    const backups = fs.readdirSync(dir).filter((f) => f.includes('.corrupt-') && f.endsWith('.bak'));
    check(backups.length > 0, '损坏文件已备份', backups.join(', '));
    // 坏文件后仍可正常写
    await wb3.add({ word: 'recover', brief: '恢复' });
    check(wb3.count === 1, '坏文件后仍可正常写入');

    // 上限 5000：预置 5000 条后新增 1 条应淘汰最旧
    const capPath = path.join(dir, 'cap.json');
    const seed = {
      version: 1,
      entries: Array.from({ length: 5000 }, (_, i) => ({
        word: `cap${i}`,
        phonetic: '',
        brief: `b${i}`,
        dictName: '',
        addedAt: 1700000000000 + i,
      })),
    };
    fs.writeFileSync(capPath, JSON.stringify(seed), 'utf8');
    const wbCap = new Wordbook(capPath);
    await wbCap.load();
    check(wbCap.count === 5000, '预置 5000 条载入成功', `count=${wbCap.count}`);
    await wbCap.add({ word: 'overflow', brief: '溢出' });
    const capList = await wbCap.list();
    check(capList.length === 5000, '超限后仍为 5000 条', `count=${capList.length}`);
    check(capList[0].word === 'overflow', '新词在最前');
    check(!capList.some((x) => x.word === 'cap4999'), '淘汰最旧一条（cap4999）');
    check(capList.some((x) => x.word === 'cap0'), '较早的 cap0 保留（未被误删）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ---------------------------- 6. 收尾 ---------------------------- */
  section('7. 汇总');
  const diag = hub.diagnostics;
  for (const d of diag) {
    console.log(
      `  ${d.name}: ${d.wordcount} 词条 | 建索引 ${fmt(d.buildMs)} | 缓存命中=${d.cacheHit} | ok=${d.ok}`,
    );
  }
  hub.dispose();
  for (const { book } of books) book.dispose();

  console.log(`\n  断言 ${checks} 项，失败 ${failures} 项`);
  if (failures > 0) {
    console.log('  ✗ 测试未全部通过');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部通过');
  }
}

main().catch((err) => {
  console.error('\n[engine.test] 未捕获异常：', err);
  process.exitCode = 1;
});
