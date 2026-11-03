/**
 * dsh-dictionary — Host 半。
 *
 * 职责：
 * 1. 加载离线 StarDict 词库（默认自动探测本机词典目录，也可用 config.dictionaryPaths 指定）；
 * 2. 维护单词记录本（JSON 落盘，原子写入）；
 * 3. 用同源 HTTP 路由 /dict-rpc 把查词与单词本能力暴露给页面里的 Client 半。
 *
 * 词库与引擎实现见 src/host/dict.js、src/host/wordbook.js。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
const PHONETIC_FILE = path.join(SRC_DIR, '..', 'data', 'phonetics.json.gz')

const ROUTE = '/dict-rpc'
const MAX_BODY = 1_000_000
const MAX_QUERY = 64

/** 常见词典目录候选（自动探测用）。 */
function defaultDictionaryRoots() {
  const home = os.homedir()
  return [
    path.join(home, 'Documents', 'Readest词典'),
    path.join(home, 'Documents', 'ReadestDictionaries'),
    path.join(home, 'Documents', 'Dictionaries'),
    path.join(home, 'Dictionaries'),
  ]
}

/** 单词记录本默认落盘位置：优先 profile 旁的 dsh-dictionary 目录。 */
function defaultWordbookPath() {
  const profileDir = process.env.DSH_PROFILE_DIR
  const root = profileDir
    ? path.join(path.dirname(profileDir), 'dsh-dictionary')
    : path.join(os.homedir(), '.dsh', 'dsh-dictionary')
  return path.join(root, 'wordbook.json')
}

function normalizePaths(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean)
  if (typeof value === 'string') return value.split(/[;\n]+/).map((item) => item.trim()).filter(Boolean)
  return []
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/** 在候选根目录下找出所有包含 .ifo + .idx 的 StarDict 词典目录。 */
async function autoDetectDictionaries(extraPaths) {
  const found = []
  const seen = new Set()
  const push = (dir) => {
    const key = dir.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    found.push(dir)
  }
  for (const dir of extraPaths) push(dir)
  for (const root of defaultDictionaryRoots()) {
    if (!(await isDirectory(root))) continue
    let entries = []
    try {
      entries = await fs.readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      let files = []
      try {
        files = await fs.readdir(dir)
      } catch {
        continue
      }
      const hasIfo = files.some((file) => file.toLowerCase().endsWith('.ifo'))
      const hasIdx = files.some((file) => file.toLowerCase().endsWith('.idx'))
      if (hasIfo && hasIdx) push(dir)
    }
  }
  return found
}

function csvCell(value) {
  const text = String(value == null ? '' : value).replace(/\r?\n/g, ' ').trim()
  if (/[",\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

function fmtStamp(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  )
}

function wrapPhonetic(raw) {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (text.startsWith('/') || text.startsWith('[')) return text
  return '/' + text + '/'
}

function toCsv(items) {
  const lines = ['单词,美音,英音,释义,词典,收藏时间']
  for (const item of items) {
    lines.push(
      [
        item.word,
        wrapPhonetic(item.phoneticUs) || wrapPhonetic(item.phonetic),
        wrapPhonetic(item.phoneticGb),
        item.brief,
        item.dictName,
        fmtStamp(item.addedAt),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

function toMarkdown(items) {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ')
  const lines = [
    '# 单词本（' + items.length + ' 个单词）',
    '',
    '> 导出自 DSH 英汉词典插件 · ' + stamp,
    '',
    '| 单词 | 美音 | 英音 | 释义 | 收藏时间 |',
    '| --- | --- | --- | --- | --- |',
  ]
  for (const item of items) {
    const brief = String(item.brief || '').replace(/\|/g, '\\|')
    lines.push(
      '| ' +
        item.word +
        ' | ' +
        (wrapPhonetic(item.phoneticUs) || wrapPhonetic(item.phonetic)) +
        ' | ' +
        wrapPhonetic(item.phoneticGb) +
        ' | ' +
        brief +
        ' | ' +
        fmtStamp(item.addedAt) +
        ' |',
    )
  }
  return lines.join('\n') + '\n'
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    now.getFullYear() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    '-' +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  )
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(text)
}

async function readJsonBody(req) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.length
    if (received > MAX_BODY) throw new Error('payload too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

export function apply(ctx, config = {}) {
  const settings = {
    dictionaryPaths: normalizePaths(config.dictionaryPaths),
    wordbookPath:
      typeof config.wordbookPath === 'string' && config.wordbookPath.trim()
        ? path.resolve(config.wordbookPath.trim())
        : defaultWordbookPath(),
    lookupLimit: Number.isFinite(config.lookupLimit) ? Number(config.lookupLimit) : 3,
  }

  let runtime = null
  let runtimeError = null
  let phonetics = null

  const ready = (async () => {
    try {
      const [{ DictionaryHub }, { Wordbook }] = await Promise.all([
        import('./host/dict.js'),
        import('./host/wordbook.js'),
      ])
      const paths = await autoDetectDictionaries(settings.dictionaryPaths)
      const hub = new DictionaryHub({ paths })
      await hub.init()
      const wordbook = new Wordbook(settings.wordbookPath)
      await wordbook.load()
      runtime = { hub, wordbook, paths }
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error)
      try {
        ctx.logger?.warn?.(`[dsh-dictionary] 初始化失败：${runtimeError}`)
      } catch {
        /* ignore */
      }
    }
    // 双音标表是可选增强，加载失败只降级为单音标
    try {
      const { loadPhonetics } = await import('./host/phonetics.js')
      phonetics = await loadPhonetics(PHONETIC_FILE)
    } catch (error) {
      phonetics = null
      try {
        ctx.logger?.warn?.(
          `[dsh-dictionary] 双音标表未加载：${error instanceof Error ? error.message : String(error)}`,
        )
      } catch {
        /* ignore */
      }
    }
  })()

  /** 给词条补上美音/英音（表里没有就留空，前端回退到词典自带音标）。 */
  function attachPhonetics(entries) {
    if (!Array.isArray(entries) || !entries.length) return entries
    for (const entry of entries) {
      if (!entry) continue
      let pair = null
      if (phonetics) {
        try {
          pair = phonetics.get(entry.word)
        } catch {
          pair = null
        }
      }
      entry.phoneticUs = (pair && pair.us) || ''
      entry.phoneticGb = (pair && pair.gb) || ''
    }
    return entries
  }

  async function lookupResult(query) {
    const { hub, wordbook } = runtime
    const result = await hub.lookup(query)
    attachPhonetics(result.entries)
    const favorited = []
    const seen = new Set()
    for (const entry of result.entries) {
      const key = String(entry.word || '').toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      if (await wordbook.has(entry.word)) favorited.push(entry.word)
    }
    return {
      ok: true,
      query,
      entries: result.entries,
      suggestions: result.suggestions,
      favorited,
      wordbookCount: wordbook.count,
    }
  }

  async function handle(payload) {
    await ready
    if (!runtime) return { ok: false, error: runtimeError || '词典引擎未初始化' }
    const { hub, wordbook } = runtime
    const op = String(payload.op || '')

    switch (op) {
      case 'status': {
        return {
          ok: true,
          dictionaries: hub.status,
          wordbookCount: wordbook.count,
          wordbookPath: settings.wordbookPath,
          phoneticsSize: phonetics ? phonetics.size : 0,
        }
      }
      case 'lookup': {
        const query = String(payload.q || '').trim().slice(0, MAX_QUERY)
        if (!query) return { ok: false, error: '请输入要查询的单词' }
        return lookupResult(query)
      }
      case 'suggest': {
        const query = String(payload.q || '').trim().slice(0, MAX_QUERY)
        const limit = Math.min(Math.max(Number(payload.limit) || 8, 1), 20)
        if (!query) return { ok: true, items: [] }
        return { ok: true, items: await hub.suggest(query, limit) }
      }
      case 'wordbook.list': {
        return { ok: true, items: await wordbook.list(), count: wordbook.count }
      }
      case 'wordbook.add': {
        const word = String(payload.word || '').trim()
        if (!word) return { ok: false, error: '缺少 word' }
        let pair = null
        if (phonetics) {
          try {
            pair = phonetics.get(word)
          } catch {
            pair = null
          }
        }
        await wordbook.add({
          word,
          phonetic: String(payload.phonetic || ''),
          phoneticUs: String(payload.phoneticUs || '') || (pair && pair.us) || '',
          phoneticGb: String(payload.phoneticGb || '') || (pair && pair.gb) || '',
          brief: String(payload.brief || ''),
          dictName: String(payload.dictName || ''),
        })
        return { ok: true, items: await wordbook.list(), count: wordbook.count }
      }
      case 'wordbook.remove': {
        const word = String(payload.word || '').trim()
        if (!word) return { ok: false, error: '缺少 word' }
        const removed = await wordbook.remove(word)
        return { ok: true, removed, items: await wordbook.list(), count: wordbook.count }
      }
      case 'wordbook.clear': {
        const removed = await wordbook.clear()
        return { ok: true, removed, items: [], count: 0 }
      }
      case 'wordbook.export': {
        const format = String(payload.format || 'csv').toLowerCase() === 'md' ? 'md' : 'csv'
        const list = await wordbook.list()
        if (!list.length) return { ok: false, error: '单词本还是空的，先收藏几个词' }
        const content = format === 'md' ? toMarkdown(list) : toCsv(list)
        const dir = path.join(os.homedir(), 'Documents', 'dsh-dictionary-export')
        await fs.mkdir(dir, { recursive: true })
        const file = path.join(dir, '单词本-' + timestamp() + '.' + format)
        await fs.writeFile(file, content, 'utf8')
        return { ok: true, path: file, count: list.length, format }
      }
      default:
        return { ok: false, error: `未知操作：${op || '(空)'}` }
    }
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler: async (req, res) => {
          // 同源栅栏：只接受回环 Host；有 Origin 时必须同源。
          // DSH 桌面端会把 dsh-app://app 页面的同源 fetch 经主进程代理转发并剥掉 Origin，故缺 Origin 放行。
          const hostHeader = String(req.headers.host || '')
          const hostAuth = hostHeader.replace(/^(.*[^:]):\d+$/, '$1')
          const loopback =
            hostAuth === '127.0.0.1' || hostAuth === 'localhost' || hostAuth === '[::1]' || hostAuth === '::1'
          if (!loopback) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          const origin = req.headers.origin ? String(req.headers.origin) : ''
          if (
            origin &&
            origin !== 'http://' + hostHeader &&
            origin !== 'https://' + hostHeader &&
            origin !== 'dsh-app://app'
          ) {
            res.writeHead(403)
            res.end('forbidden')
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '仅支持 POST' })
            return
          }
          try {
            const payload = await readJsonBody(req)
            const result = await handle(payload)
            sendJson(res, 200, result)
          } catch (error) {
            sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )
  })
}
