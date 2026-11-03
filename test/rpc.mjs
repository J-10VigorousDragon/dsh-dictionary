/**
 * 不依赖 DSH 运行时的 Host 端到端自测：
 * 用假的 ctx 捕获 /dict-rpc 路由，再起一个本地 HTTP 服务真实走一遍 RPC。
 *
 * 运行：node test/rpc.mjs
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { apply } = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

let captured = null
const ctx = {
  logger: { warn: (message) => console.warn('[warn]', message) },
  inject(names, callback) {
    if (!names.includes('webServer')) return
    callback({
      effect(fn) {
        fn()
      },
      webServer: {
        register(route) {
          captured = route
          return () => {
            captured = null
          }
        },
      },
    })
  },
}

const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-dict-rpc-'))
const wordbookPath = path.join(workdir, 'wordbook.json')
apply(ctx, { wordbookPath })

if (!captured) {
  console.error('FAIL: 没有捕获到 /dict-rpc 路由')
  process.exit(1)
}

const server = http.createServer((req, res) => captured.handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port

async function rpc(op, payload = {}) {
  const res = await fetch(base + '/dict-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, ...payload }),
  })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('响应不是 JSON：' + text.slice(0, 200))
  }
}

let passed = 0
let failed = 0
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  ok  ' + name)
  } else {
    failed += 1
    console.log('  FAIL ' + name + (detail ? ' → ' + JSON.stringify(detail).slice(0, 400) : ''))
  }
}

console.log('== status ==')
const status = await rpc('status')
check('status.ok', status.ok === true, status)
check('识别到词库', Array.isArray(status.dictionaries) && status.dictionaries.length > 0, status.dictionaries)
const readyDicts = (status.dictionaries || []).filter((item) => item.ok)
check('词库可用', readyDicts.length > 0, status.dictionaries)
console.log('  词典：' + readyDicts.map((item) => item.name + '(' + item.wordcount + ')').join(' / '))

console.log('== lookup ==')
const apple = await rpc('lookup', { q: 'apple' })
check('apple 有结果', apple.ok && apple.entries.length > 0, apple)
const first = apple.entries && apple.entries[0]
check('apple 词条字段完整', Boolean(first && first.word && first.dict && Array.isArray(first.definitions)), first)
check('apple 释义非空', Boolean(first && first.definitions.length), first && first.definitions)
console.log('  ' + first.word + ' [' + (first.phonetic || '') + '] — ' + first.definitions.slice(0, 2).map((d) => (d.pos ? d.pos + ' ' : '') + d.text).join(' | '))

const glasses = await rpc('lookup', { q: 'glasses' })
check('glasses 有结果（含词形回退/跨词典）', glasses.ok && glasses.entries.length > 0, glasses)

const missing = await rpc('lookup', { q: 'zzzzqqqxxxnotaword' })
check('生僻输入不报错', missing.ok === true && missing.entries.length === 0, missing)
check('生僻输入给候选', Array.isArray(missing.suggestions), missing.suggestions)

const empty = await rpc('lookup', { q: '   ' })
check('空查询被拒', empty.ok === false && Boolean(empty.error), empty)

console.log('== suggest ==')
const suggest = await rpc('suggest', { q: 'serend', limit: 20 })
check(
  'suggest 前缀命中',
  suggest.ok && suggest.items.length > 0 && suggest.items.every((item) => item.toLowerCase().startsWith('serend')),
  suggest.items,
)
const suggestTight = await rpc('suggest', { q: 'serendipity', limit: 5 })
check('suggest 精确前缀命中 serendipity', suggestTight.ok && suggestTight.items.includes('serendipity'), suggestTight.items)
console.log('  ' + suggest.items.slice(0, 6).join(', '))

console.log('== wordbook ==')
const added = await rpc('wordbook.add', {
  word: first.word,
  phonetic: first.phonetic,
  brief: first.definitions[0].text,
  dictName: first.dict,
})
check('收藏成功', added.ok && added.count === 1, added)

const added2 = await rpc('wordbook.add', { word: 'serendipity', brief: '意外发现珍奇事物的运气' })
check('第二条收藏', added2.ok && added2.count === 2, added2)

const dup = await rpc('wordbook.add', { word: 'Apple', brief: '重复大小写' })
check('大小写不敏感去重', dup.ok && dup.count === 2, dup)

const list = await rpc('wordbook.list')
check('列表两条', list.ok && list.items.length === 2, list)
check('最新在前', list.items[0].word === 'serendipity', list.items.map((item) => item.word))
check('带 addedAt', list.items.every((item) => Boolean(item.addedAt)), list.items)

const favored = await rpc('lookup', { q: 'apple' })
check('lookup 回带 favorited', (favored.favorited || []).length === 1, favored.favorited)

console.log('== export ==')
const csv = await rpc('wordbook.export', { format: 'csv' })
check('CSV 导出成功', csv.ok === true && Boolean(csv.path), csv)
if (csv.ok) {
  const text = await fs.readFile(csv.path, 'utf8')
  check('CSV 含表头与两行', text.includes('单词,音标,释义') && text.trim().split(/\r?\n/).length === 3, text.slice(0, 200))
  check('CSV 带 BOM', text.charCodeAt(0) === 0xfeff)
  await fs.rm(csv.path, { force: true })
  console.log('  ' + csv.path)
}

const md = await rpc('wordbook.export', { format: 'md' })
check('Markdown 导出成功', md.ok === true && Boolean(md.path), md)
if (md.ok) {
  const text = await fs.readFile(md.path, 'utf8')
  check('MD 是表格', text.includes('| 单词 | 音标 | 释义 |'), text.slice(0, 200))
  await fs.rm(md.path, { force: true })
}

console.log('== remove / clear ==')
const removed = await rpc('wordbook.remove', { word: 'apple' })
check('删除成功', removed.ok && removed.count === 1, removed)
const notFound = await rpc('wordbook.remove', { word: 'apple' })
check('删除不存在返回 removed:false', notFound.ok && notFound.removed === false, notFound)

const cleared = await rpc('wordbook.clear')
check('清空成功', cleared.ok && cleared.count === 0, cleared)

const persisted = JSON.parse(await fs.readFile(wordbookPath, 'utf8'))
check(
  '落盘文件存在且为空表',
  Array.isArray(persisted.entries) && persisted.entries.length === 0,
  persisted,
)

console.log('== 错误处理 ==')
const unknown = await rpc('nope')
check('未知 op 返回错误', unknown.ok === false && Boolean(unknown.error), unknown)

server.close()
await fs.rm(workdir, { recursive: true, force: true })
try {
  await fs.rm(path.join(os.homedir(), 'Documents', 'dsh-dictionary-export'), { recursive: true, force: true })
} catch {
  /* ignore */
}

console.log('\n结果：' + passed + ' 通过 / ' + failed + ' 失败')
process.exit(failed ? 1 : 0)
