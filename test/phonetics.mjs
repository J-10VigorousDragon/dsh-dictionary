#!/usr/bin/env node
/**
 * test/phonetics.mjs — 美音/英音双音标数据与单词本扩展字段回归测试
 *
 * 运行：node test/phonetics.mjs
 * 覆盖：数据加载（耗时/内存）、双音标取值、大小写、缺词、错误处理、
 *       makePhoneticIndex 纯函数、Wordbook 双音标落盘与旧格式向后兼容。
 * 失败时进程退出码非零。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { loadPhonetics, makePhoneticIndex } from '../src/host/phonetics.js';
import { Wordbook } from '../src/host/wordbook.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = process.env.DSH_PHONETICS_FILE || path.join(ROOT, 'data', 'phonetics.json.gz');

let checks = 0;
let failures = 0;

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : String(n));
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;

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

async function main() {
  section('0. 数据文件');
  if (!fs.existsSync(DATA_FILE)) {
    console.log(`  [FAIL] 数据文件不存在：${DATA_FILE}`);
    console.log('  先运行：node scripts/build-phonetics.mjs');
    process.exitCode = 1;
    return;
  }
  const gz = await fsp.readFile(DATA_FILE);
  check(gz[0] === 0x1f && gz[1] === 0x8b, 'data/phonetics.json.gz 是合法 gzip');
  console.log(`  ${path.relative(ROOT, DATA_FILE)}：${mb(gz.length)}`);

  /* ---------------------------- 1. 加载 ---------------------------- */
  section('1. loadPhonetics（耗时 / 内存）');
  const before = process.memoryUsage();
  const t1 = performance.now();
  const index = await loadPhonetics(DATA_FILE);
  const loadMs = performance.now() - t1;
  const heapDelta = process.memoryUsage().heapUsed - before.heapUsed;

  // 再跑一次（重新解压 + 重建索引，排除首次进程冷启动/调度抖动）
  const t2 = performance.now();
  const index2 = await loadPhonetics(DATA_FILE);
  const loadMs2 = performance.now() - t2;
  const bestMs = Math.min(loadMs, loadMs2);

  console.log(`  首次 ${fmt(loadMs)}ms · 二次 ${fmt(loadMs2)}ms · 取较优 ${fmt(bestMs)}ms`);
  console.log(`  size=${index.size.toLocaleString('en-US')} · heap 增量 ${mb(heapDelta)} · rss 增量 ${mb(process.memoryUsage().rss - before.rss)}`);

  check(index.size > 100000, `size > 100000（实际 ${index.size.toLocaleString('en-US')}）`);
  check(index2.size === index.size, '两次加载条目数一致');
  check(bestMs < 300, `解压+建索引 < 300ms（实测 ${fmt(bestMs)}ms）`);
  check(heapDelta < 60 * 1048576, `内存增量 < 60MB（实测 ${mb(heapDelta)}）`);

  /* ---------------------------- 2. 双音标取值 ---------------------------- */
  section('2. 取样词：美音 / 英音');
  const differents = ['schedule', 'tomato', 'either', 'advertisement'];
  for (const word of differents) {
    const p = index.get(word);
    const ok = !!p && p.us.length > 0 && p.gb.length > 0 && p.us !== p.gb;
    check(ok, `${word} 美英都非空且不同`, p ? `us=${JSON.stringify(p.us)} gb=${JSON.stringify(p.gb)}` : 'null');
    if (p) console.log(`    ${word}: 美 /${p.us}/ · 英 /${p.gb}/`);
  }

  const apple = index.get('apple');
  check(!!apple && apple.us.length > 0 && apple.gb.length > 0, 'apple 美英都有音标', JSON.stringify(apple));
  if (apple) {
    console.log(
      `    apple: 美 /${apple.us}/ · 英 /${apple.gb}/` +
        (apple.us === apple.gb ? '（两侧一致）' : '（两侧存在细微差异，属数据源事实）'),
    );
  }

  /* ---------------------------- 3. 大小写与缺词 ---------------------------- */
  section('3. 大小写 / 缺词');
  const lower = index.get('apple');
  const title = index.get('Apple');
  const upper = index.get('APPLE');
  check(JSON.stringify(title) === JSON.stringify(lower), 'Apple（首字母大写）命中');
  check(JSON.stringify(upper) === JSON.stringify(lower), 'APPLE（全大写）命中');
  check(index.get('zzzznotaword') === null, '不存在的词返回 null');
  check(index.get('') === null, '空字符串返回 null');
  check(index.get(null) === null, '非字符串输入返回 null');
  check(index.has('APPLE') === true && index.has('zzzznotaword') === false, 'has() 行为正确');

  // 单侧缺失：英音源只有 6.5 万词，很多词只有美音
  const usOnly = index.get('read');
  check(!!usOnly && usOnly.us.length > 0 && usOnly.gb === '', '单侧缺失时另一边为空串（read）', JSON.stringify(usOnly));

  /* ---------------------------- 4. 错误处理 ---------------------------- */
  section('4. 错误处理');
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-phonetics-'));
  try {
    const missing = path.join(tmpdir, 'nope.json.gz');
    let errMissing = null;
    try {
      await loadPhonetics(missing);
    } catch (err) {
      errMissing = err;
    }
    check(!!errMissing, '文件缺失时抛错');
    check(
      !!errMissing && errMissing.message.includes(missing),
      '错误信息包含具体路径',
      errMissing && errMissing.message,
    );
    check(
      !!errMissing && errMissing.message.includes('build-phonetics'),
      '错误信息给出修复提示（构建脚本）',
      errMissing && errMissing.message,
    );
    if (errMissing) console.log(`    缺文件报错：${errMissing.message.split('\n')[0]}`);

    const notGzip = path.join(tmpdir, 'plain.json');
    fs.writeFileSync(notGzip, '{"apple":["x","y"]}', 'utf8');
    let errGzip = null;
    try {
      await loadPhonetics(notGzip);
    } catch (err) {
      errGzip = err;
    }
    check(!!errGzip && errGzip.message.includes('gzip'), '非 gzip 文件报错明确', errGzip && errGzip.message);

    const badJson = path.join(tmpdir, 'bad.json.gz');
    fs.writeFileSync(badJson, zlib.gzipSync(Buffer.from('{not json', 'utf8')));
    let errJson = null;
    try {
      await loadPhonetics(badJson);
    } catch (err) {
      errJson = err;
    }
    check(!!errJson && /JSON|数据/.test(errJson.message), '损坏 JSON 报错明确', errJson && errJson.message);

    const emptyObj = path.join(tmpdir, 'empty.json.gz');
    fs.writeFileSync(emptyObj, zlib.gzipSync(Buffer.from('{}', 'utf8')));
    let errEmpty = null;
    try {
      await loadPhonetics(emptyObj);
    } catch (err) {
      errEmpty = err;
    }
    check(!!errEmpty && errEmpty.message.includes('空'), '空数据报错明确', errEmpty && errEmpty.message);
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }

  /* ---------------------------- 5. makePhoneticIndex ---------------------------- */
  section('5. makePhoneticIndex（纯函数注入）');
  const injected = makePhoneticIndex({
    Test: ['tɛst', 'test'],
    Empty: ['', ''],
    UsOnly: ['ˈjuːz', ''],
  });
  check(injected.size === 2, '两边为空的条目不收录', `size=${injected.size}`);
  check(JSON.stringify(injected.get('test')) === JSON.stringify({ us: 'tɛst', gb: 'test' }), '注入数据可查（大小写不敏感）');
  check(injected.get('empty') === null, '注入的空条目返回 null');
  check(JSON.stringify(injected.get('usonly')) === JSON.stringify({ us: 'ˈjuːz', gb: '' }), '注入的单侧条目保留空串');

  const byMap = makePhoneticIndex(new Map([['Alpha', ['a', 'b']]]));
  check(byMap.size === 1 && byMap.get('ALPHA').us === 'a', '支持 Map 形态输入');
  const byArray = makePhoneticIndex([['beta', ['c', 'd']]]);
  check(byArray.size === 1 && byArray.get('beta').gb === 'd', '支持 [word, pair] 数组输入');
  let errBad = null;
  try {
    makePhoneticIndex('nope');
  } catch (err) {
    errBad = err;
  }
  check(!!errBad, '非法输入抛 TypeError');

  /* ---------------------------- 6. Wordbook 双音标 ---------------------------- */
  section('6. Wordbook 双音标字段');
  const wbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wb-dual-'));
  const wbFile = path.join(wbDir, 'wordbook.json');
  try {
    const wb = new Wordbook(wbFile);
    await wb.load();
    const saved = await wb.add({
      word: 'schedule',
      phonetic: 'ˈʃedjuːl',
      phoneticUs: 'ˈskɛdʒuɫ',
      phoneticGb: 'ʃˈɛdjuːl',
      brief: 'n. 时间表',
      dictName: '朗道英汉字典5.0',
    });
    check(saved.phoneticUs === 'ˈskɛdʒuɫ' && saved.phoneticGb === 'ʃˈɛdjuːl', 'add 返回对象带双音标');
    const list = await wb.list();
    check(
      list.length === 1 && list[0].phoneticUs === 'ˈskɛdʒuɫ' && list[0].phoneticGb === 'ʃˈɛdjuːl',
      'list() 原样带出双音标',
      JSON.stringify(list[0]),
    );

    // 落盘后可重载
    const wb2 = new Wordbook(wbFile);
    await wb2.load();
    const reloaded = (await wb2.list())[0];
    check(reloaded.phoneticUs === 'ˈskɛdʒuɫ' && reloaded.phoneticGb === 'ʃˈɛdjuːl', '重载后双音标保留');

    // 重复 add：更新音标但保持位置
    await wb2.add({ word: 'SCHEDULE', phoneticUs: 'ˈskedʒuːl', phoneticGb: '' });
    const dup = (await wb2.list())[0];
    check(wb2.count === 1, '重复 add 不新增条目');
    check(dup.phoneticUs === 'ˈskedʒuːl', '重复 add 更新美音', JSON.stringify(dup));
    check(dup.phoneticGb === 'ʃˈɛdjuːl', '空值不覆盖已有英音', JSON.stringify(dup));

    // 旧格式文件（无 phoneticUs/Gb）向后兼容
    const legacyFile = path.join(wbDir, 'legacy.json');
    fs.writeFileSync(
      legacyFile,
      JSON.stringify({
        version: 1,
        entries: [
          { word: 'legacy', phonetic: 'ˈleɡəsi', brief: 'n. 遗产', dictName: '朗道英汉字典5.0', addedAt: 1700000000000 },
        ],
      }),
      'utf8',
    );
    const wbLegacy = new Wordbook(legacyFile);
    await wbLegacy.load();
    const legacyList = await wbLegacy.list();
    check(wbLegacy.count === 1, '旧格式文件可读');
    check(
      legacyList[0].phoneticUs === '' && legacyList[0].phoneticGb === '',
      '旧格式缺失字段补空串',
      JSON.stringify(legacyList[0]),
    );
    check(legacyList[0].phonetic === 'ˈleɡəsi' && legacyList[0].brief === 'n. 遗产', '旧格式其他字段不受影响');
    // 旧条目再次收藏时补上双音标
    await wbLegacy.add({ word: 'legacy', phoneticUs: 'ˈleɡəsi-us', phoneticGb: 'ˈleɡəsi-gb' });
    const upgraded = (await wbLegacy.list())[0];
    check(upgraded.phoneticUs === 'ˈleɡəsi-us' && upgraded.phoneticGb === 'ˈleɡəsi-gb', '旧条目可补写双音标');
    const afterReload = new Wordbook(legacyFile);
    await afterReload.load();
    check((await afterReload.list())[0].phoneticUs === 'ˈleɡəsi-us', '补写后落盘生效');
  } finally {
    fs.rmSync(wbDir, { recursive: true, force: true });
  }

  /* ---------------------------- 7. 汇总 ---------------------------- */
  section('7. 汇总');
  console.log(`  数据文件：${path.relative(ROOT, DATA_FILE)}（${mb(gz.length)}）`);
  console.log(`  条目数：${index.size.toLocaleString('en-US')}`);
  console.log(`  加载：${fmt(bestMs)}ms（首次 ${fmt(loadMs)}ms）· heap 增量 ${mb(heapDelta)}`);
  console.log(`  断言 ${checks} 项，失败 ${failures} 项`);
  if (failures > 0) {
    console.log('  ✗ 测试未全部通过');
    process.exitCode = 1;
  } else {
    console.log('  ✓ 全部通过');
  }
}

main().catch((err) => {
  console.error('\n[phonetics.test] 未捕获异常：', err);
  process.exitCode = 1;
});
