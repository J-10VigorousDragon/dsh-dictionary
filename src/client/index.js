/**
 * dsh-dictionary — Client 半。
 *
 * 在侧边栏注册一个面板图标（id = dsh-dictionary），主面板注册同名页面：
 * 「查词」页负责离线查词与收藏，「单词本」页负责查看 / 过滤 / 删除收藏。
 * 所有数据来自 Host 的同源路由 /dict-rpc。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dictionary',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const PANEL_ID = 'dsh-dictionary'
    const RPC = '/dict-rpc'

    async function call(op, payload) {
      const res = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ op }, payload || {})),
      })
      const text = await res.text()
      let data
      try {
        data = JSON.parse(text)
      } catch (error) {
        throw new Error('Host 返回内容无法解析（HTTP ' + res.status + '）')
      }
      if (!data || data.ok !== true) throw new Error((data && data.error) || '请求失败（HTTP ' + res.status + '）')
      return data
    }

    function speak(word) {
      try {
        const synth = window.speechSynthesis
        if (!synth) return
        synth.cancel()
        const utter = new SpeechSynthesisUtterance(word)
        utter.lang = 'en-US'
        utter.rate = 0.92
        synth.speak(utter)
      } catch (error) {
        /* 桌面端可能不支持 TTS，静默忽略 */
      }
    }

    function briefOf(entry) {
      const first = entry && entry.definitions && entry.definitions[0]
      if (!first) return ''
      const text = String(first.text || '').replace(/\s+/g, ' ').trim()
      return text.length > 72 ? text.slice(0, 72) + '…' : text
    }

    function fmtTime(iso) {
      const date = iso ? new Date(iso) : null
      if (!date || Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
    }

    const styles = [
      '.dsd-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:15px;}',
      '.dsd-head{flex:0 0 auto;padding:24px 32px 0;}',
      '.dsd-head-inner{max-width:860px;margin:0 auto;}',
      '.dsd-title-row{display:flex;align-items:center;justify-content:space-between;gap:18px;}',
      '.dsd-title{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:650;letter-spacing:.2px;}',
      '.dsd-title svg{flex:0 0 auto;}',
      '.dsd-sub{margin-top:5px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6;}',
      '.dsd-tabs{display:flex;gap:4px;padding:3px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-tab{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;padding:7px 15px;border-radius:8px;cursor:pointer;transition:background .15s,color .15s;}',
      '.dsd-tab:hover{color:var(--dsw-alias-label-primary);}',
      '.dsd-tab.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dsd-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;}',
      '.dsd-tab.is-active .dsd-badge{background:var(--dsw-alias-brand-primary);color:#fff;}',
      '.dsd-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:22px 32px 56px;}',
      '.dsd-body-inner{max-width:860px;margin:0 auto;}',
      '.dsd-search{position:relative;}',
      '.dsd-input-wrap{display:flex;align-items:center;gap:11px;height:52px;padding:0 16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);transition:border-color .15s;}',
      '.dsd-input-wrap:focus-within{border-color:var(--dsw-alias-brand-primary);}',
      '.dsd-input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:inherit;font-family:inherit;font-size:16.5px;}',
      '.dsd-input::placeholder{color:var(--dsw-alias-label-tertiary);}',
      '.dsd-kbd{flex:0 0 auto;font-size:11.5px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 7px;}',
      '.dsd-pop{position:absolute;left:0;right:0;top:60px;z-index:20;border-radius:12px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 14px 34px rgba(0,0,0,.22);overflow:hidden;padding:5px;}',
      '.dsd-pop-item{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:8px;font-size:14px;cursor:pointer;color:var(--dsw-alias-label-secondary);}',
      '.dsd-pop-item.is-active,.dsd-pop-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-hint{margin-top:14px;font-size:13px;color:var(--dsw-alias-label-tertiary);line-height:1.8;}',
      '.dsd-chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}',
      '.dsd-chip{border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;padding:6px 12px;border-radius:999px;cursor:pointer;}',
      '.dsd-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-card{margin-top:18px;border-radius:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);padding:22px 24px 20px;}',
      '.dsd-word-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;}',
      '.dsd-word-line{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;min-width:0;}',
      '.dsd-word{font-size:29px;font-weight:680;line-height:1.15;letter-spacing:.2px;word-break:break-word;}',
      '.dsd-phonetic{font-size:14.5px;color:var(--dsw-alias-label-secondary);}',
      '.dsd-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;}',
      '.dsd-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s;}',
      '.dsd-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-star{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;cursor:pointer;transition:background .15s,color .15s,border-color .15s;}',
      '.dsd-star:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-star.is-on{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
      '.dsd-dict-tag{margin-top:16px;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 8px;}',
      '.dsd-defs{margin-top:10px;}',
      '.dsd-def{display:flex;gap:14px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-def:first-child{border-top:0;}',
      '.dsd-pos{flex:0 0 56px;padding-top:3px;font-size:13px;color:var(--dsw-alias-label-tertiary);}',
      '.dsd-text{flex:1 1 auto;min-width:0;font-size:15.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word;}',
      '.dsd-foot{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.7;display:flex;flex-wrap:wrap;gap:8px 18px;}',
      '.dsd-empty{margin-top:26px;padding:38px 26px;border-radius:16px;border:1px dashed var(--dsw-alias-border-l2);text-align:center;color:var(--dsw-alias-label-tertiary);}',
      '.dsd-empty-title{font-size:15.5px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;}',
      '.dsd-book-head{display:flex;align-items:center;gap:12px;margin-bottom:14px;}',
      '.dsd-book-filter{flex:1 1 auto;display:flex;align-items:center;gap:9px;height:40px;padding:0 13px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-book-filter input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:inherit;font-family:inherit;font-size:14px;}',
      '.dsd-mini-btn{flex:0 0 auto;height:40px;padding:0 14px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;cursor:pointer;}',
      '.dsd-mini-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-mini-btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.dsd-export{position:relative;flex:0 0 auto;}',
      '.dsd-export-menu{position:absolute;right:0;top:46px;z-index:30;min-width:184px;padding:5px;border-radius:11px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 14px 34px rgba(0,0,0,.22);}',
      '.dsd-export-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;padding:9px 11px;border-radius:8px;cursor:pointer;}',
      '.dsd-export-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-notice{margin-top:12px;display:flex;align-items:flex-start;gap:10px;padding:10px 13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65;}',
      '.dsd-notice span{flex:1 1 auto;min-width:0;word-break:break-all;}',
      '.dsd-notice button{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:12.5px;cursor:pointer;padding:0;}',
      '.dsd-book-list{display:flex;flex-direction:column;gap:2px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:6px;}',
      '.dsd-book-row{display:flex;align-items:center;gap:12px;padding:12px 13px;border-radius:10px;cursor:pointer;}',
      '.dsd-book-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-book-main{flex:1 1 auto;min-width:0;}',
      '.dsd-book-word{display:flex;align-items:baseline;gap:9px;font-size:15.5px;font-weight:600;}',
      '.dsd-book-word em{font-style:normal;font-weight:400;font-size:12.5px;color:var(--dsw-alias-label-tertiary);}',
      '.dsd-book-brief{margin-top:3px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsd-book-time{flex:0 0 auto;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}',
      '.dsd-del{flex:0 0 auto;width:30px;height:30px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;transition:opacity .12s,background .12s,color .12s;display:inline-flex;align-items:center;justify-content:center;}',
      '.dsd-book-row:hover .dsd-del{opacity:1;}',
      '.dsd-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}',
      '.dsd-err{margin-top:16px;padding:12px 14px;border-radius:11px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:13.5px;line-height:1.7;}',
      '.dsd-loading{margin-top:18px;font-size:13.5px;color:var(--dsw-alias-label-tertiary);}',
    ].join('\n')

    function IconMark(props) {
      const size = props && props.size ? props.size : 18
      const color = props && props.active ? 'var(--dsw-alias-label-primary)' : 'currentColor'
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 5.2c0-.9.7-1.6 1.6-1.6h4.6c1.2 0 2.2.6 2.8 1.5.6-.9 1.6-1.5 2.8-1.5h2.6c.9 0 1.6.7 1.6 1.6v13.2c0 .9-.7 1.6-1.6 1.6h-2.9c-.9 0-1.7.3-2.5.8-.8-.5-1.6-.8-2.5-.8H5.6c-.9 0-1.6-.7-1.6-1.6z',
          stroke: color,
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 6v12', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.65 }),
        h('path', { d: 'M14.9 8.2l.8 1.7 1.9.2-1.4 1.3.4 1.9-1.7-.9-1.7.9.4-1.9-1.4-1.3 1.9-.2z', fill: color, opacity: 0.9 }),
      )
    }

    function SearchIcon(props) {
      const size = props && props.size ? props.size : 18
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 11, cy: 11, r: 6.4, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('path', { d: 'M15.8 15.8L20 20', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      )
    }

    function StarIcon(props) {
      const filled = props && props.filled
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' },
        h('path', {
          d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z',
          fill: filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
      )
    }

    function SpeakerIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5 9.5h3l4-3.2v11.4l-4-3.2H5z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M15.5 9c1 .8 1.6 1.8 1.6 3s-.6 2.2-1.6 3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M18 6.6c1.6 1.3 2.5 3.2 2.5 5.4s-.9 4.1-2.5 5.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.6 }),
      )
    }

    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5.5 7h13M9.5 7V5.4c0-.5.4-.9.9-.9h3.2c.5 0 .9.4.9.9V7M7.2 7l.7 11.2c0 .5.4.8.9.8h6.4c.5 0 .9-.3.9-.8L16.8 7', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    function Page() {
      const [tab, setTab] = useState('search')
      const [status, setStatus] = useState(null)
      const [statusError, setStatusError] = useState('')
      const [query, setQuery] = useState('')
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)
      const [suggestions, setSuggestions] = useState([])
      const [activeIndex, setActiveIndex] = useState(-1)
      const [items, setItems] = useState([])
      const [count, setCount] = useState(0)
      const [filter, setFilter] = useState('')
      const [busy, setBusy] = useState(false)
      const [confirmClear, setConfirmClear] = useState(false)
      const [exportMenu, setExportMenu] = useState(false)
      const [notice, setNotice] = useState('')
      const [noticePath, setNoticePath] = useState('')
      const inputRef = useRef(null)
      const seqRef = useRef(0)

      const refreshBook = useCallback(async () => {
        try {
          const data = await call('wordbook.list')
          setItems(data.items || [])
          setCount(typeof data.count === 'number' ? data.count : (data.items || []).length)
        } catch (err) {
          setError(err.message || String(err))
        }
      }, [])

      useEffect(() => {
        let alive = true
        call('status')
          .then((data) => {
            if (!alive) return
            setStatus(data)
            setCount(data.wordbookCount || 0)
          })
          .catch((err) => {
            if (alive) setStatusError(err.message || String(err))
          })
        refreshBook()
        return () => {
          alive = false
        }
      }, [refreshBook])

      useEffect(() => {
        if (tab !== 'wordbook') return
        refreshBook()
      }, [tab, refreshBook])

      const doLookup = useCallback(
        async (raw) => {
          const word = String(raw || '').trim()
          if (!word) return
          setSuggestions([])
          setActiveIndex(-1)
          setLoading(true)
          setError('')
          try {
            const data = await call('lookup', { q: word })
            setResult(data)
            setQuery(word)
            setCount(data.wordbookCount)
          } catch (err) {
            setError(err.message || String(err))
            setResult(null)
          } finally {
            setLoading(false)
          }
        },
        [],
      )

      useEffect(() => {
        const term = query.trim()
        if (!term || result) {
          setSuggestions([])
          return undefined
        }
        const seq = ++seqRef.current
        const timer = setTimeout(() => {
          call('suggest', { q: term, limit: 8 })
            .then((data) => {
              if (seq !== seqRef.current) return
              setSuggestions(data.items || [])
              setActiveIndex(-1)
            })
            .catch(() => {
              if (seq === seqRef.current) setSuggestions([])
            })
        }, 170)
        return () => clearTimeout(timer)
      }, [query, result])

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown' && suggestions.length) {
          event.preventDefault()
          setActiveIndex((index) => (index + 1) % suggestions.length)
          return
        }
        if (event.key === 'ArrowUp' && suggestions.length) {
          event.preventDefault()
          setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1))
          return
        }
        if (event.key === 'Escape') {
          setSuggestions([])
          setActiveIndex(-1)
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          const picked = activeIndex >= 0 && suggestions[activeIndex] ? suggestions[activeIndex] : query
          doLookup(picked)
        }
      }

      const entry = result && result.entries && result.entries.length ? result.entries[0] : null
      const favoritedNow = Boolean(result && entry && (result.favorited || []).indexOf(entry.word) >= 0)

      const toggleFavorite = async () => {
        if (!entry || busy) return
        setBusy(true)
        setError('')
        try {
          if (favoritedNow) {
            const data = await call('wordbook.remove', { word: entry.word })
            setResult(Object.assign({}, result, { favorited: (result.favorited || []).filter((w) => w !== entry.word), wordbookCount: data.count }))
            setCount(data.count)
          } else {
            const data = await call('wordbook.add', {
              word: entry.word,
              phonetic: entry.phonetic || '',
              brief: briefOf(entry),
              dictName: entry.dict || '',
            })
            setResult(Object.assign({}, result, { favorited: (result.favorited || []).concat([entry.word]), wordbookCount: data.count }))
            setCount(data.count)
          }
          await refreshBook()
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setBusy(false)
        }
      }

      const removeWord = async (word) => {
        setError('')
        try {
          const data = await call('wordbook.remove', { word })
          setItems(data.items || [])
          setCount(data.count)
          if (entry && entry.word.toLowerCase() === word.toLowerCase()) {
            setResult(Object.assign({}, result, { favorited: (result.favorited || []).filter((w) => w.toLowerCase() !== word.toLowerCase()) }))
          }
        } catch (err) {
          setError(err.message || String(err))
        }
      }

      const clearBook = async () => {
        if (!confirmClear) {
          setConfirmClear(true)
          return
        }
        setConfirmClear(false)
        setError('')
        try {
          const data = await call('wordbook.clear')
          setItems([])
          setCount(0)
          if (result) setResult(Object.assign({}, result, { favorited: [] }))
        } catch (err) {
          setError(err.message || String(err))
        }
      }

      const doExport = async (format) => {
        setExportMenu(false)
        setNotice('')
        setNoticePath('')
        setError('')
        try {
          const data = await call('wordbook.export', { format })
          setNotice('已导出 ' + data.count + ' 个单词')
          setNoticePath(data.path)
        } catch (err) {
          setError(err.message || String(err))
        }
      }

      const copyNotice = () => {
        if (!noticePath) return
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(noticePath).then(
              () => setNotice('路径已复制到剪贴板'),
              () => {},
            )
          }
        } catch (error) {
          /* ignore */
        }
      }

      const filtered = useMemo(() => {
        const term = filter.trim().toLowerCase()
        if (!term) return items
        return items.filter((item) => {
          return (
            String(item.word || '').toLowerCase().indexOf(term) >= 0 ||
            String(item.brief || '').toLowerCase().indexOf(term) >= 0
          )
        })
      }, [items, filter])

      const subline = useMemo(() => {
        if (statusError) return '词典引擎未就绪：' + statusError
        if (!status) return '正在加载词库…'
        const dicts = status.dictionaries || []
        const ready = dicts.filter((item) => item.ok).length
        const words = dicts.reduce((total, item) => total + (item.ok ? Number(item.wordcount) || 0 : 0), 0)
        const names = dicts.filter((item) => item.ok).map((item) => item.name).join(' · ')
        if (!ready) return '未找到可用词库，请在插件配置里指定 StarDict 词典目录'
        return names + ' · ' + words.toLocaleString('en-US') + ' 词条 · 单词本 ' + count + ' 个'
      }, [status, statusError, count])

      const tabBadge = count > 0 ? h('span', { className: 'dsd-badge' }, String(count)) : null

      const header = h(
        'div',
        { className: 'dsd-head' },
        h(
          'div',
          { className: 'dsd-head-inner' },
          h(
            'div',
            { className: 'dsd-title-row' },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'dsd-title' }, h(IconMark, { size: 20 }), '英汉词典'),
              h('div', { className: 'dsd-sub' }, subline),
            ),
            h(
              'div',
              { className: 'dsd-tabs' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-tab' + (tab === 'search' ? ' is-active' : ''),
                  onClick: () => setTab('search'),
                },
                '查词',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-tab' + (tab === 'wordbook' ? ' is-active' : ''),
                  onClick: () => setTab('wordbook'),
                },
                '单词本',
                tabBadge,
              ),
            ),
          ),
        ),
      )

      const searchPane = h(
        'div',
        { className: 'dsd-body-inner' },
        h(
          'div',
          { className: 'dsd-search' },
          h(
            'div',
            { className: 'dsd-input-wrap' },
            h(SearchIcon, { size: 19 }),
            h('input', {
              ref: inputRef,
              className: 'dsd-input',
              value: query,
              placeholder: '输入英文单词，回车查询',
              spellCheck: false,
              autoComplete: 'off',
              autoFocus: true,
              onChange: (event) => {
                setQuery(event.target.value)
                setResult(null)
                setError('')
              },
              onKeyDown,
            }),
            h('span', { className: 'dsd-kbd' }, 'Enter'),
          ),
          suggestions.length
            ? h(
                'div',
                { className: 'dsd-pop' },
                suggestions.map((item, index) =>
                  h(
                    'div',
                    {
                      key: item,
                      className: 'dsd-pop-item' + (index === activeIndex ? ' is-active' : ''),
                      onMouseDown: (event) => {
                        event.preventDefault()
                        doLookup(item)
                      },
                      onMouseEnter: () => setActiveIndex(index),
                    },
                    h(SearchIcon, { size: 13 }),
                    item,
                  ),
                ),
              )
            : null,
        ),
        error ? h('div', { className: 'dsd-err' }, error) : null,
        loading ? h('div', { className: 'dsd-loading' }, '查询中…') : null,
        entry
          ? h(
              'div',
              { className: 'dsd-card' },
              h(
                'div',
                { className: 'dsd-word-head' },
                h(
                  'div',
                  { className: 'dsd-word-line' },
                  h('span', { className: 'dsd-word' }, entry.word),
                  entry.phonetic ? h('span', { className: 'dsd-phonetic' }, entry.phonetic) : null,
                ),
                h(
                  'div',
                  { className: 'dsd-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsd-icon-btn',
                      title: '朗读',
                      onClick: () => speak(entry.word),
                    },
                    h(SpeakerIcon, null),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsd-star' + (favoritedNow ? ' is-on' : ''),
                      title: favoritedNow ? '从单词本移除' : '收藏到单词本',
                      disabled: busy,
                      onClick: toggleFavorite,
                    },
                    h(StarIcon, { filled: favoritedNow }),
                    favoritedNow ? '已收藏' : '收藏',
                  ),
                ),
              ),
              (result.entries || []).map((group, index) =>
                h(
                  'div',
                  { key: (group.dict || '') + index },
                  (result.entries || []).length > 1 ? h('div', { className: 'dsd-dict-tag' }, group.dict || '词典') : null,
                  h(
                    'div',
                    { className: 'dsd-defs' },
                    (group.definitions || []).map((def, defIndex) =>
                      h(
                        'div',
                        { key: defIndex, className: 'dsd-def' },
                        h('span', { className: 'dsd-pos' }, def.pos || ''),
                        h('span', { className: 'dsd-text' }, def.text || ''),
                      ),
                    ),
                  ),
                ),
              ),
              (result.entries || []).length && (result.entries || [])[0].exchange && (result.entries || [])[0].exchange.length
                ? h(
                    'div',
                    { className: 'dsd-foot' },
                    h('span', null, '词形变化：' + (result.entries || [])[0].exchange.join(' / ')),
                  )
                : null,
            )
          : null,
        !entry && !loading && result && (!result.entries || !result.entries.length)
          ? h(
              'div',
              { className: 'dsd-empty' },
              h('div', { className: 'dsd-empty-title' }, '没有找到「' + (result.query || query) + '」'),
              h('div', null, '试试拼写纠正，或用下面的候选词：'),
              (result.suggestions || []).length
                ? h(
                    'div',
                    { className: 'dsd-chips', style: { justifyContent: 'center' } },
                    (result.suggestions || []).slice(0, 10).map((item) =>
                      h('button', { key: item, type: 'button', className: 'dsd-chip', onClick: () => doLookup(item) }, item),
                    ),
                  )
                : null,
            )
          : null,
        !entry && !loading && !result && !error
          ? h(
              'div',
              { className: 'dsd-hint' },
              h('div', null, '支持离线查词：输入单词回车即可。常见缩写与词形变化（如 glasses → glass）也会自动回退。'),
              h(
                'div',
                { className: 'dsd-chips' },
                ['serendipity', 'ubiquitous', 'resilience', 'ephemeral', 'ambiguous'].map((item) =>
                  h('button', { key: item, type: 'button', className: 'dsd-chip', onClick: () => doLookup(item) }, item),
                ),
              ),
            )
          : null,
      )

      const bookPane = h(
        'div',
        { className: 'dsd-body-inner' },
        h(
          'div',
          { className: 'dsd-book-head' },
          h(
            'div',
            { className: 'dsd-book-filter' },
            h(SearchIcon, { size: 15 }),
            h('input', {
              value: filter,
              placeholder: '在单词本里筛选',
              spellCheck: false,
              onChange: (event) => setFilter(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dsd-export' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-mini-btn',
                disabled: !items.length,
                title: '把单词本导出成文件',
                onClick: () => setExportMenu((value) => !value),
              },
              '导出',
            ),
            exportMenu
              ? h(
                  'div',
                  { className: 'dsd-export-menu' },
                  h(
                    'button',
                    { type: 'button', className: 'dsd-export-item', onClick: () => doExport('csv') },
                    '导出为 CSV（Excel 可直接打开）',
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsd-export-item', onClick: () => doExport('md') },
                    '导出为 Markdown 表格',
                  ),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsd-mini-btn' + (confirmClear ? ' is-danger' : ''),
              onClick: clearBook,
              onBlur: () => setConfirmClear(false),
              disabled: !items.length,
            },
            confirmClear ? '确认清空？' : '清空',
          ),
        ),
        notice
          ? h(
              'div',
              { className: 'dsd-notice' },
              h('span', null, notice + (noticePath && notice !== '路径已复制到剪贴板' ? '：' + noticePath : '')),
              noticePath ? h('button', { type: 'button', onClick: copyNotice }, '复制路径') : null,
            )
          : null,
        error ? h('div', { className: 'dsd-err' }, error) : null,
        items.length === 0
          ? h(
              'div',
              { className: 'dsd-empty' },
              h('div', { className: 'dsd-empty-title' }, '单词本还是空的'),
              h('div', null, '在查词页点「收藏」，单词就会出现在这里。'),
            )
          : filtered.length === 0
            ? h('div', { className: 'dsd-empty' }, h('div', { className: 'dsd-empty-title' }, '没有匹配「' + filter + '」的单词'))
            : h(
                'div',
                { className: 'dsd-book-list' },
                filtered.map((item) =>
                  h(
                    'div',
                    {
                      key: item.word,
                      className: 'dsd-book-row',
                      onClick: () => {
                        setTab('search')
                        doLookup(item.word)
                      },
                    },
                    h(
                      'div',
                      { className: 'dsd-book-main' },
                      h(
                        'div',
                        { className: 'dsd-book-word' },
                        item.word,
                        item.phonetic ? h('em', null, item.phonetic) : null,
                      ),
                      h('div', { className: 'dsd-book-brief' }, item.brief || '（无释义摘要）'),
                    ),
                    h('span', { className: 'dsd-book-time' }, fmtTime(item.addedAt)),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsd-del',
                        title: '从单词本删除',
                        onClick: (event) => {
                          event.stopPropagation()
                          removeWord(item.word)
                        },
                      },
                      h(TrashIcon, null),
                    ),
                  ),
                ),
              ),
      )

      return h(
        'div',
        { className: 'dsd-root' },
        h('style', null, styles),
        header,
        h('div', { className: 'dsd-body' }, tab === 'search' ? searchPane : bookPane),
      )
    }

    function PanelIcon(props) {
      return h(IconMark, props || {})
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Page),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '英汉词典' },
            PanelIcon,
          ),
        )
      },
    }
  },
})
