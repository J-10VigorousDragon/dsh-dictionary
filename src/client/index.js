/**
 * dsh-dictionary — Client 半。
 *
 * 1) 侧边栏面板：主面板「查词 / 单词本」两个 Tab；
 * 2) 划词查询：注册到 shell.overlay，监听页面内的文本选中，浮层显示释义并可直接收藏。
 *
 * 所有数据来自 Host 的同源路由 /dict-rpc。
 */
window.__ModuleLoader__.load({
  id: 'dsh-dictionary',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const PANEL_ID = 'dsh-dictionary'
    const OVERLAY_ID = 'dsh-dictionary-selection'
    const RPC = '/dict-rpc'
    const SETTINGS_KEY = 'dsh-dictionary.settings.v1'

    /* ---------------- 设置（模块级共享，供页面与浮层同步） ---------------- */

    const settings = { selectionPopup: true }
    const settingsListeners = new Set()

    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        if (raw) Object.assign(settings, JSON.parse(raw))
      } catch (error) {
        /* ignore */
      }
    }
    function saveSettings() {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
      } catch (error) {
        /* ignore */
      }
    }
    function setSelectionPopup(value) {
      settings.selectionPopup = Boolean(value)
      saveSettings()
      settingsListeners.forEach((fn) => {
        try {
          fn()
        } catch (error) {
          /* ignore */
        }
      })
    }
    function useSelectionPopup() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((value) => value + 1)
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      }, [])
      return settings.selectionPopup
    }

    loadSettings()

    /* ---------------- RPC ---------------- */

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

    /* ---------------- 小工具 ---------------- */

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
        /* ignore */
      }
    }

    function formatPhonetic(raw) {
      const text = String(raw || '').trim()
      if (!text) return ''
      if (text.startsWith('/') || text.startsWith('[')) return text
      return '/' + text + '/'
    }

    function usPhonetic(entry) {
      return formatPhonetic(entry && entry.phoneticUs)
    }
    function gbPhonetic(entry) {
      return formatPhonetic(entry && entry.phoneticGb)
    }
    function anyPhonetic(entry) {
      return usPhonetic(entry) || gbPhonetic(entry) || formatPhonetic(entry && entry.phonetic)
    }

    function briefOf(entry) {
      const defs = (entry && entry.definitions) || []
      const first = defs.find((item) => item && item.text && item.text.trim())
      if (!first) return ''
      const text = String(first.text).replace(/\s+/g, ' ').trim()
      return text.length > 96 ? text.slice(0, 96) + '…' : text
    }

    function fmtTime(value) {
      const date = value ? new Date(value) : null
      if (!date || Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return (
        date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      )
    }

    function isTextInput(target) {
      if (!target || !target.tagName) return false
      const tag = target.tagName.toUpperCase()
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true
    }

    /* ---------------- 图标 ---------------- */

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
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 15, height: 15, 'aria-hidden': 'true' },
        h('path', {
          d: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z',
          fill: props && props.filled ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
      )
    }

    function SpeakerIcon(props) {
      const size = props && props.size ? props.size : 16
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M5 9.5h3l4-3.2v11.4l-4-3.2H5z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('path', { d: 'M15.5 9c1 .8 1.6 1.8 1.6 3s-.6 2.2-1.6 3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', { d: 'M18 6.6c1.6 1.3 2.5 3.2 2.5 5.4s-.9 4.1-2.5 5.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.6 }),
      )
    }

    function TrashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 15, height: 15, fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M5.5 7h13M9.5 7V5.4c0-.5.4-.9.9-.9h3.2c.5 0 .9.4.9.9V7M7.2 7l.7 11.2c0 .5.4.8.9.8h6.4c.5 0 .9-.3.9-.8L16.8 7',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function CloseIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M6.5 6.5l11 11M17.5 6.5l-11 11', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
      )
    }

    function ArrowIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M7 17L17 7M17 7H9M17 7v8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      )
    }

    /* ---------------- 音标展示 ---------------- */

    function PhoneticGroup(props) {
      const entry = props.entry || {}
      const us = usPhonetic(entry)
      const gb = gbPhonetic(entry)
      const plain = formatPhonetic(entry.phonetic)
      if (!us && !gb) {
        return plain ? h('span', { className: 'dsd-pho dsd-pho-plain' }, plain) : null
      }
      return h(
        'span',
        { className: 'dsd-phos' },
        us ? h('span', { className: 'dsd-pho' }, h('em', null, '美'), h('span', null, us)) : null,
        gb ? h('span', { className: 'dsd-pho' }, h('em', null, '英'), h('span', null, gb)) : null,
      )
    }

    /* ---------------- 样式 ---------------- */

    const styles = [
      '.dsd-root{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:15px;}',
      '.dsd-head{flex:0 0 auto;padding:24px 32px 0;}',
      '.dsd-head-inner{max-width:880px;margin:0 auto;}',
      '.dsd-title-row{display:flex;align-items:center;justify-content:space-between;gap:18px;}',
      '.dsd-title{display:flex;align-items:center;gap:10px;font-size:19px;font-weight:650;letter-spacing:.2px;}',
      '.dsd-sub{margin-top:5px;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6;}',
      '.dsd-head-right{display:flex;align-items:center;gap:10px;flex:0 0 auto;}',
      '.dsd-tabs{display:flex;gap:4px;padding:3px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-tab{display:inline-flex;align-items:center;gap:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;padding:7px 15px;border-radius:8px;cursor:pointer;transition:background .15s,color .15s;}',
      '.dsd-tab:hover{color:var(--dsw-alias-label-primary);}',
      '.dsd-tab.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600;}',
      '.dsd-badge{min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;}',
      '.dsd-tab.is-active .dsd-badge{background:var(--dsw-alias-brand-primary);color:#fff;}',
      '.dsd-switch{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;cursor:pointer;}',
      '.dsd-switch:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-switch .dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);}',
      '.dsd-switch.is-on{color:var(--dsw-alias-label-primary);}',
      '.dsd-switch.is-on .dot{background:var(--dsw-alias-state-success-primary);}',
      '.dsd-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:22px 32px 56px;}',
      '.dsd-body-inner{max-width:880px;margin:0 auto;}',
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
      '.dsd-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto;}',
      '.dsd-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .15s,color .15s;}',
      '.dsd-icon-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-star{display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;cursor:pointer;transition:background .15s,color .15s,border-color .15s;}',
      '.dsd-star:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-star.is-on{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-bg-layer-2);font-weight:600;}',
      '.dsd-phos{display:inline-flex;align-items:baseline;gap:12px;flex-wrap:wrap;}',
      '.dsd-pho{display:inline-flex;align-items:baseline;gap:5px;font-size:14.5px;color:var(--dsw-alias-label-secondary);}',
      '.dsd-pho em{font-style:normal;font-size:11px;font-weight:600;letter-spacing:.5px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 4px;line-height:1.5;}',
      '.dsd-pho-plain{font-size:14.5px;color:var(--dsw-alias-label-secondary);}',
      '.dsd-dict-tag{margin-top:16px;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:2px 8px;}',
      '.dsd-defs{margin-top:10px;}',
      '.dsd-def{display:flex;gap:14px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-def:first-child{border-top:0;}',
      '.dsd-pos{flex:0 0 56px;padding-top:3px;font-size:13px;color:var(--dsw-alias-label-tertiary);}',
      '.dsd-text{flex:1 1 auto;min-width:0;font-size:15.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word;}',
      '.dsd-foot{margin-top:16px;padding-top:14px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.7;display:flex;flex-wrap:wrap;gap:8px 18px;}',
      '.dsd-empty{margin-top:26px;padding:38px 26px;border-radius:16px;border:1px dashed var(--dsw-alias-border-l2);text-align:center;color:var(--dsw-alias-label-tertiary);}',
      '.dsd-empty-title{font-size:15.5px;color:var(--dsw-alias-label-secondary);margin-bottom:8px;}',
      '.dsd-book-head{display:flex;align-items:center;gap:10px;margin-bottom:14px;}',
      '.dsd-book-filter{flex:1 1 auto;display:flex;align-items:center;gap:9px;height:40px;padding:0 13px;border-radius:11px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-book-filter input{flex:1 1 auto;min-width:0;border:0;outline:0;background:transparent;color:inherit;font-family:inherit;font-size:14px;}',
      '.dsd-mini-btn{flex:0 0 auto;height:40px;padding:0 14px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;cursor:pointer;}',
      '.dsd-mini-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-mini-btn.is-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}',
      '.dsd-export{position:relative;flex:0 0 auto;}',
      '.dsd-export-menu{position:absolute;right:0;top:46px;z-index:30;min-width:196px;padding:5px;border-radius:11px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 14px 34px rgba(0,0,0,.22);}',
      '.dsd-export-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13.5px;padding:9px 11px;border-radius:8px;cursor:pointer;}',
      '.dsd-export-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-notice{margin-top:12px;display:flex;align-items:flex-start;gap:10px;padding:10px 13px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65;}',
      '.dsd-notice span{flex:1 1 auto;min-width:0;word-break:break-all;}',
      '.dsd-notice button{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:12.5px;cursor:pointer;padding:0;}',
      '.dsd-table{border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);overflow:hidden;}',
      '.dsd-tr{display:grid;grid-template-columns:minmax(120px,1.1fr) minmax(150px,1.3fr) minmax(180px,2.4fr) 132px 40px;align-items:center;gap:12px;padding:11px 14px;border-top:1px solid var(--dsw-alias-border-l1);}',
      '.dsd-tr.dsd-th{border-top:0;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11.5px;letter-spacing:.4px;padding:9px 14px;}',
      '.dsd-tr.dsd-row{cursor:pointer;}',
      '.dsd-tr.dsd-row:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-cell-word{font-size:15.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsd-cell-pho{font-size:13px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsd-cell-pho em{font-style:normal;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-right:4px;}',
      '.dsd-cell-brief{font-size:13.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.dsd-cell-time{font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}',
      '.dsd-del{width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;opacity:0;transition:opacity .12s,background .12s,color .12s;display:inline-flex;align-items:center;justify-content:center;justify-self:end;}',
      '.dsd-tr:hover .dsd-del{opacity:1;}',
      '.dsd-del:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);}',
      '.dsd-err{margin-top:16px;padding:12px 14px;border-radius:11px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:13.5px;line-height:1.7;}',
      '.dsd-loading{margin-top:18px;font-size:13.5px;color:var(--dsw-alias-label-tertiary);}',
      '.dsd-sel-layer{position:fixed;inset:0;z-index:60;pointer-events:none;}',
      '.dsd-sel-card{position:fixed;width:400px;max-width:calc(100vw - 24px);pointer-events:auto;border-radius:14px;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 18px 46px rgba(0,0,0,.34);padding:14px 16px 12px;color:var(--dsw-alias-label-primary);}',
      '.dsd-sel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;}',
      '.dsd-sel-word{font-size:20px;font-weight:680;line-height:1.2;word-break:break-word;}',
      '.dsd-sel-pho{margin-top:3px;}',
      '.dsd-sel-actions{display:flex;align-items:center;gap:6px;flex:0 0 auto;}',
      '.dsd-sel-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}',
      '.dsd-sel-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}',
      '.dsd-sel-defs{margin-top:10px;display:flex;flex-direction:column;gap:6px;}',
      '.dsd-sel-def{display:flex;gap:9px;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.dsd-sel-def b{flex:0 0 auto;font-weight:500;color:var(--dsw-alias-label-tertiary);font-size:12.5px;padding-top:1px;}',
      '.dsd-sel-def span{flex:1 1 auto;min-width:0;word-break:break-word;}',
      '.dsd-sel-more{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px;}',
      '.dsd-sel-foot{margin-top:11px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;align-items:center;justify-content:space-between;gap:10px;}',
      '.dsd-sel-open{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font-family:inherit;font-size:12.5px;cursor:pointer;padding:0;}',
      '.dsd-sel-star{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;cursor:pointer;}',
      '.dsd-sel-star:hover{background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsd-sel-star.is-on{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);font-weight:600;}',
    ].join('\n')

    /* ---------------- 查词 / 单词本页面 ---------------- */

    function Page(props) {
      const openPanel = props && props.openPanel ? props.openPanel : () => {}
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
      const selectionPopupOn = useSelectionPopup()
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

      const doLookup = useCallback(async (raw) => {
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
      }, [])

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
              phonetic: anyPhonetic(entry),
              phoneticUs: usPhonetic(entry),
              phoneticGb: gbPhonetic(entry),
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
          await call('wordbook.clear')
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
          return String(item.word || '').toLowerCase().indexOf(term) >= 0 || String(item.brief || '').toLowerCase().indexOf(term) >= 0
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
              { className: 'dsd-head-right' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsd-switch' + (selectionPopupOn ? ' is-on' : ''),
                  title: '在页面上选中英文单词时弹出释义卡片',
                  onClick: () => setSelectionPopup(!selectionPopupOn),
                },
                h('span', { className: 'dot' }),
                '划词查询',
              ),
              h(
                'div',
                { className: 'dsd-tabs' },
                h('button', { type: 'button', className: 'dsd-tab' + (tab === 'search' ? ' is-active' : ''), onClick: () => setTab('search') }, '查词'),
                h('button', { type: 'button', className: 'dsd-tab' + (tab === 'wordbook' ? ' is-active' : ''), onClick: () => setTab('wordbook') }, '单词本', tabBadge),
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
                  { style: { minWidth: 0 } },
                  h('div', { className: 'dsd-word-line' }, h('span', { className: 'dsd-word' }, entry.word)),
                  h('div', { className: 'dsd-word-line', style: { marginTop: 6 } }, h(PhoneticGroup, { entry })),
                ),
                h(
                  'div',
                  { className: 'dsd-actions' },
                  h('button', { type: 'button', className: 'dsd-icon-btn', title: '朗读（美音）', onClick: () => speak(entry.word) }, h(SpeakerIcon, null)),
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
                ? h('div', { className: 'dsd-foot' }, h('span', null, '词形变化：' + (result.entries || [])[0].exchange.join(' / ')))
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
              h('div', null, '支持离线查词与划词：输入单词回车查询；在页面任意位置选中英文单词会弹出释义卡片（可在右上角关闭划词查询）。词形变化（如 glasses → glass）会自动回退。'),
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
              { type: 'button', className: 'dsd-mini-btn', disabled: !items.length, title: '把单词本导出成文件', onClick: () => setExportMenu((value) => !value) },
              '导出',
            ),
            exportMenu
              ? h(
                  'div',
                  { className: 'dsd-export-menu' },
                  h('button', { type: 'button', className: 'dsd-export-item', onClick: () => doExport('csv') }, '导出为 CSV（Excel 可直接打开）'),
                  h('button', { type: 'button', className: 'dsd-export-item', onClick: () => doExport('md') }, '导出为 Markdown 表格'),
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
              h('div', null, '在查词页点「收藏」，或在页面上划词后点「收藏」，单词就会出现在这里。'),
            )
          : filtered.length === 0
            ? h('div', { className: 'dsd-empty' }, h('div', { className: 'dsd-empty-title' }, '没有匹配「' + filter + '」的单词'))
            : h(
                'div',
                { className: 'dsd-table' },
                h(
                  'div',
                  { className: 'dsd-tr dsd-th' },
                  h('div', null, '单词'),
                  h('div', null, '音标'),
                  h('div', null, '基本意思'),
                  h('div', null, '添加时间'),
                  h('div', null, ''),
                ),
                filtered.map((item) =>
                  h(
                    'div',
                    {
                      key: item.word,
                      className: 'dsd-tr dsd-row',
                      onClick: () => {
                        setTab('search')
                        doLookup(item.word)
                      },
                    },
                    h('div', { className: 'dsd-cell-word' }, item.word),
                    h(
                      'div',
                      { className: 'dsd-cell-pho' },
                      item.phoneticUs ? h('em', null, '美') : item.phoneticGb ? h('em', null, '英') : null,
                      item.phoneticUs || item.phoneticGb || formatPhonetic(item.phonetic) || '—',
                    ),
                    h('div', { className: 'dsd-cell-brief' }, item.brief || '（无释义摘要）'),
                    h('div', { className: 'dsd-cell-time' }, fmtTime(item.addedAt)),
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

      return h('div', { className: 'dsd-root' }, h('style', null, styles), header, h('div', { className: 'dsd-body' }, tab === 'search' ? searchPane : bookPane))
    }

    /* ---------------- 划词浮层 ---------------- */

    const SELECTION_PATTERN = /^[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,2}$/

    function SelectionPopup(props) {
      const openPanel = props && props.openPanel ? props.openPanel : () => {}
      const enabled = useSelectionPopup()
      const [card, setCard] = useState(null)
      const cardRef = useRef(null)

      useEffect(() => {
        if (!enabled) {
          setCard(null)
          return undefined
        }
        let timer = null

        const close = () => setCard((current) => (current ? null : current))

        const onMouseUp = (event) => {
          if (cardRef.current && cardRef.current.contains(event.target)) return
          if (isTextInput(event.target)) {
            close()
            return
          }
          const target = event.target
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            let selection = null
            try {
              selection = window.getSelection()
            } catch (error) {
              selection = null
            }
            if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
              close()
              return
            }
            const text = String(selection.toString() || '').trim().replace(/\s+/g, ' ')
            if (!text || text.length > 40 || !SELECTION_PATTERN.test(text)) {
              close()
              return
            }
            if (!target || !target.isConnected) return
            let rect = null
            try {
              rect = selection.getRangeAt(0).getBoundingClientRect()
            } catch (error) {
              rect = null
            }
            if (!rect || (rect.width === 0 && rect.height === 0)) {
              close()
              return
            }
            const width = 400
            const left = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12)
            const spaceBelow = window.innerHeight - rect.bottom
            const placeAbove = spaceBelow < 280 && rect.top > 280
            const top = placeAbove ? rect.top - 10 : rect.bottom + 10
            setCard({ word: text, left: Math.max(12, left), top: Math.max(12, top), placeAbove, loading: true, data: null, error: '', favorited: false })
            call('lookup', { q: text })
              .then((data) => {
                setCard((current) => {
                  if (!current || current.word !== text) return current
                  const first = data.entries && data.entries.length ? data.entries[0] : null
                  return Object.assign({}, current, {
                    loading: false,
                    data,
                    favorited: Boolean(first && (data.favorited || []).indexOf(first.word) >= 0),
                  })
                })
              })
              .catch((error) => {
                setCard((current) =>
                  current && current.word === text
                    ? Object.assign({}, current, { loading: false, error: String((error && error.message) || error) })
                    : current,
                )
              })
          }, 30)
        }

        const onMouseDown = (event) => {
          if (cardRef.current && cardRef.current.contains(event.target)) return
          close()
        }

        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }

        const onScroll = () => close()

        document.addEventListener('mouseup', onMouseUp, true)
        document.addEventListener('mousedown', onMouseDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onScroll, true)
        return () => {
          window.clearTimeout(timer)
          document.removeEventListener('mouseup', onMouseUp, true)
          document.removeEventListener('mousedown', onMouseDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [enabled])

      if (!enabled || !card) return null

      const data = card.data
      const entry = data && data.entries && data.entries.length ? data.entries[0] : null
      const defs = (entry && entry.definitions) || []
      const shown = defs.slice(0, 3)
      const rest = defs.length - shown.length

      const toggleFav = async () => {
        if (!entry) return
        try {
          if (card.favorited) {
            await call('wordbook.remove', { word: entry.word })
            setCard(Object.assign({}, card, { favorited: false }))
          } else {
            await call('wordbook.add', {
              word: entry.word,
              phonetic: anyPhonetic(entry),
              phoneticUs: usPhonetic(entry),
              phoneticGb: gbPhonetic(entry),
              brief: briefOf(entry),
              dictName: entry.dict || '',
            })
            setCard(Object.assign({}, card, { favorited: true }))
          }
        } catch (error) {
          setCard(Object.assign({}, card, { error: String((error && error.message) || error) }))
        }
      }

      const style = card.placeAbove
        ? { left: card.left + 'px', top: card.top + 'px', transform: 'translateY(-100%)' }
        : { left: card.left + 'px', top: card.top + 'px' }

      return h(
        'div',
        { className: 'dsd-sel-layer' },
        h('style', null, styles),
        h(
          'div',
          { className: 'dsd-sel-card', style, ref: cardRef },
          h(
            'div',
            { className: 'dsd-sel-head' },
            h(
              'div',
              { style: { minWidth: 0 } },
              h('div', { className: 'dsd-sel-word' }, card.word),
              h('div', { className: 'dsd-sel-pho' }, entry ? h(PhoneticGroup, { entry }) : null),
            ),
            h(
              'div',
              { className: 'dsd-sel-actions' },
              h('button', { type: 'button', className: 'dsd-sel-icon', title: '朗读（美音）', onClick: () => speak(card.word) }, h(SpeakerIcon, null)),
              h('button', { type: 'button', className: 'dsd-sel-icon', title: '关闭', onClick: () => setCard(null) }, h(CloseIcon, null)),
            ),
          ),
          card.loading
            ? h('div', { className: 'dsd-sel-more' }, '查询中…')
            : card.error
              ? h('div', { className: 'dsd-sel-more' }, card.error)
              : entry
                ? h(
                    'div',
                    { className: 'dsd-sel-defs' },
                    shown.map((def, index) =>
                      h('div', { key: index, className: 'dsd-sel-def' }, def.pos ? h('b', null, def.pos) : null, h('span', null, def.text || '')),
                    ),
                    rest > 0 ? h('div', { className: 'dsd-sel-more' }, '还有 ' + rest + ' 条释义，打开词典查看') : null,
                  )
                : h('div', { className: 'dsd-sel-more' }, '词典里没有收录这个词'),
          h(
            'div',
            { className: 'dsd-sel-foot' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-sel-open',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  openPanel()
                  setCard(null)
                },
              },
              '在词典中打开',
              h(ArrowIcon, null),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsd-sel-star' + (card.favorited ? ' is-on' : ''),
                disabled: !entry,
                onMouseDown: (event) => event.preventDefault(),
                onClick: toggleFav,
              },
              h(StarIcon, { filled: card.favorited }),
              card.favorited ? '已收藏' : '收藏',
            ),
          ),
        ),
      )
    }

    function PanelIcon(props) {
      return h(IconMark, props || {})
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const openPanel = () => {
          try {
            if (ctx.layout && typeof ctx.layout.selectPanel === 'function') ctx.layout.selectPanel(PANEL_ID)
          } catch (error) {
            /* ignore */
          }
        }

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(Page, { openPanel })))
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => '英汉词典' }, PanelIcon),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 60 }, () => h(SelectionPopup, { openPanel })),
        )
      },
    }
  },
})
