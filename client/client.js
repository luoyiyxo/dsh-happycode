/**
 * Happycoding Everyday client half.
 *
 * Runs inside the DSH web shell as a module-loader bundle: the host serves this
 * file, it registers a factory under the package name, and the shell calls the
 * exported `apply(ctx)` once the client tree boots.
 *
 * What it adds:
 *   1. a `HappyCode` row in the sidebar account menu, between Settings and
 *      Feedback — the host builds that menu from a hardcoded array, so the row
 *      is a clone of the host's own row, inserted when the menu opens
 *      (see docs/host-ui-notes.md);
 *   2. the contribution dialog it opens — a GitHub-cloned heatmap of one
 *      calendar year, sized to the card it lives in;
 *   3. a small configuration card on the plugin's page under Plugins.
 *
 * The bundle is hand-written CJS on purpose: no build step, and no dependency
 * beyond the host's own module table (`react`, `react-dom`,
 * `@deepseek-ai/dsh-client-ui-primitives`).
 */
window.__ModuleLoader__.load({
  id: 'dsh-happycode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    const h = React.createElement

    const PACKAGE = 'dsh-happycode'
    const API = '/dsh-happycode/api'
    // Display names. The account-menu row keeps the short identity — it shares
    // the host's 14px menu typography and a long label fights the other rows —
    // while the dialog carries the full brand. The package name, the loader id
    // and the account-menu slot key all stay `dsh-happycode`.
    const MENU_LABEL = 'HappyCode'
    const BRAND = 'Happycoding Everyday'
    const ENTRY_ATTR = 'data-happycode-entry'
    const ROOT_ID = 'dsh-happycode-root'

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const MONTHS_LONG = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ]
    const ORDINALS = ['th', 'st', 'nd', 'rd']
    const WEEKDAY_LABELS = { 0: 'Mon', 2: 'Wed', 4: 'Fri' }
    const SVG_NS = 'http://www.w3.org/2000/svg'

    // ------------------------------------------------------------------ util

    function warn (message) {
      try { console.warn('[dsh-happycode] ' + message) } catch { /* ignore */ }
    }

    function describe (error) {
      return error && error.message ? error.message : String(error)
    }

    function ordinal (day) {
      const mod100 = day % 100
      if (mod100 >= 11 && mod100 <= 13) return day + 'th'
      return day + (ORDINALS[day % 10] || 'th')
    }

    function plural (count, word) {
      return count + ' ' + word + (count === 1 ? '' : 's')
    }

    /** Parse `YYYY-MM-DD` into a local Date at midnight. */
    function parseDay (key) {
      const parts = String(key).split('-')
      return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    }

    function dayKey (date) {
      const m = date.getMonth() + 1
      const d = date.getDate()
      return date.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d)
    }

    function addDays (date, days) {
      const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      next.setDate(next.getDate() + days)
      return next
    }

    function mondayOf (date) {
      return addDays(date, -((date.getDay() + 6) % 7))
    }

    function tooltipText (entry, date) {
      const label = MONTHS_LONG[date.getMonth()] + ' ' + ordinal(date.getDate())
      const value = entry && typeof entry.value === 'number' ? entry.value : 0
      if (!(value > 0)) return 'No contributions on ' + label + '.'
      return plural(value, 'contribution') + ' on ' + label + '.'
    }

    // ------------------------------------------------------------------ css

    const CSS = [
      '.hc-root{--hc-l0:#ebedf0;--hc-l1:#9be9a8;--hc-l2:#40c463;--hc-l3:#30a14e;--hc-l4:#216e39;',
      '--hc-cell:21px;--hc-gap:3px;--hc-text:var(--dsw-alias-label-primary,#1f2328);',
      '--hc-muted:var(--dsw-alias-label-secondary,#57606a);--hc-border:var(--dsw-alias-border-l2,rgba(31,35,40,.15));',
      '--hc-surface:var(--dsw-alias-bg-layer-2,#ffffff);--hc-hover:var(--dsw-alias-interactive-bg-hover,rgba(31,35,40,.06));',
      'font-family:inherit;color:var(--hc-text)}',
      '.hc-root[data-hc-theme="dark"]{--hc-l0:#161b22;--hc-l1:#0e4429;--hc-l2:#006d32;--hc-l3:#26a641;--hc-l4:#39d353;',
      '--hc-text:var(--dsw-alias-label-primary,#e6edf3);--hc-muted:var(--dsw-alias-label-secondary,#8b949e);',
      '--hc-border:var(--dsw-alias-border-l2,rgba(240,246,252,.15));--hc-surface:var(--dsw-alias-bg-layer-2,#161b22);',
      '--hc-hover:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',

      '.hc-overlay{position:fixed;inset:0;z-index:1000;display:flex;overflow:auto}',
      '.hc-mask{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.45));',
      'backdrop-filter:var(--dsw-mask-blur,blur(2px));-webkit-backdrop-filter:var(--dsw-mask-blur,blur(2px))}',
      '.hc-panel{position:relative;z-index:1;margin:auto;display:flex;flex-direction:column;box-sizing:border-box;',
      // Height follows the content (R9): no min-height, only a cap so a huge
      // window or a short screen still scrolls instead of overflowing.
      'width:min(1500px,94vw);min-width:min(1500px,94vw);max-height:88vh;',
      'border-radius:var(--dsw-radius-panel,16px);background:var(--hc-surface);',
      'box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.22));overflow:hidden;animation:hcEnter .14s ease-out}',
      '@keyframes hcEnter{from{opacity:.98;transform:scale(.995)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.hc-panel{animation:none}}',
      '.hc-panel:focus{outline:none}',
      // Title band (R13): 90px tall, brand centred at 28–30px, close button
      // pinned to the top-right corner. The horizontal padding is symmetric on
      // purpose — an asymmetric reserve for the close button would pull the
      // centred title off the panel's middle by half the difference.
      '.hc-header{position:relative;flex:none;display:flex;align-items:center;justify-content:center;',
      'height:90px;padding:0 24px;box-sizing:border-box}',
      '.hc-title{margin:0;font-size:clamp(24px,2vw,30px);line-height:1.2;font-weight:600;text-align:center;',
      'color:var(--hc-text);white-space:nowrap}',
      '.hc-close{position:absolute;top:50%;right:16px;transform:translateY(-50%);',
      'display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;',
      'border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;cursor:pointer;color:var(--hc-muted)}',
      '.hc-close:hover{background:var(--hc-hover)}',
      // Vertical rhythm (R15): band ↔ profile 40px, profile ↔ total 36px,
      // total ↔ card 20px, then the panel's own 24px bottom padding.
      '.hc-body{flex:1;min-height:0;overflow:auto;padding:0 24px 24px;display:flex;flex-direction:column}',
      '.hc-content{display:flex;flex-direction:column;width:100%;box-sizing:border-box}',

      // Profile row (R14): 120px rounded avatar, text column bottom-aligned.
      '.hc-profile{display:flex;align-items:flex-end;gap:24px;min-width:0;margin-top:40px}',
      '.hc-avatar{flex:none;width:120px;height:120px;border-radius:24px;overflow:hidden;background:var(--hc-l0);',
      'display:flex;align-items:center;justify-content:center}',
      '.hc-avatar img{width:100%;height:100%;object-fit:cover;display:block;border-radius:24px}',
      '.hc-avatar-initial{width:100%;height:100%;border-radius:24px;display:flex;align-items:center;justify-content:center;',
      'background:var(--dsw-alias-brand-primary,#0969da);color:#ffffff;font-size:48px;line-height:1;font-weight:600;',
      'user-select:none}',
      '.hc-profile-text{display:flex;flex-direction:column;gap:4px;min-width:0;align-items:flex-start}',
      '.hc-profile-name{font-size:24px;line-height:32px;font-weight:600;color:var(--hc-text);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.hc-profile-since{font-size:16px;line-height:24px;color:var(--hc-muted)}',

      '.hc-summary{margin-top:36px;font-size:19px;line-height:26px;font-weight:600;color:var(--hc-text)}',
      '.hc-cardrow{display:flex;align-items:flex-start;gap:16px;min-width:0;margin-top:20px}',
      '.hc-card{flex:1;min-width:0;overflow-x:auto;overflow-y:hidden}',
      '.hc-empty{display:flex;flex-direction:column;align-items:center;gap:6px;margin-top:12px;padding:4px 0 0;text-align:center}',
      '.hc-empty-title{font-size:14px;line-height:20px;color:var(--hc-text);font-weight:500}',
      '.hc-empty-body{font-size:12px;line-height:18px;color:var(--hc-muted)}',

      '.hc-chart{display:flex;gap:10px;min-width:max-content}',
      '.hc-weekdays{flex:none;display:flex;flex-direction:column;gap:var(--hc-gap);padding-top:24px;width:40px}',
      '.hc-weekday{height:var(--hc-cell);font-size:18px;line-height:var(--hc-cell);color:var(--hc-muted);text-align:right}',
      '.hc-plot{display:flex;flex-direction:column;gap:2px}',
      '.hc-months{position:relative;height:22px}',
      '.hc-month{position:absolute;top:0;font-size:18px;line-height:22px;color:var(--hc-muted);white-space:nowrap}',
      '.hc-weeks{display:flex;gap:var(--hc-gap)}',
      '.hc-week{display:flex;flex-direction:column;gap:var(--hc-gap)}',
      '.hc-cell{width:var(--hc-cell);height:var(--hc-cell);border-radius:2px;background:var(--hc-l0);box-sizing:border-box;flex:none}',
      '.hc-cell[data-level="1"]{background:var(--hc-l1)}',
      '.hc-cell[data-level="2"]{background:var(--hc-l2)}',
      '.hc-cell[data-level="3"]{background:var(--hc-l3)}',
      '.hc-cell[data-level="4"]{background:var(--hc-l4)}',
      '.hc-cell[data-blank="true"]{background:transparent;cursor:default}',
      '.hc-cell[data-today="true"]{box-shadow:inset 0 0 0 1px var(--hc-text)}',
      '.hc-cell:not([data-blank="true"]):hover{outline:1px solid var(--hc-muted);outline-offset:0}',
      // The legend lives inside the card, directly under the grid, right aligned.
      '.hc-legend{display:flex;align-items:center;justify-content:flex-end;gap:5px;padding:12px 2px 2px;',
      'font-size:12px;line-height:16px;color:var(--hc-muted)}',
      '.hc-legend .hc-cell{cursor:default}',
      '.hc-legend-label{padding:0 2px}',

      // The year rail starts level with the grid (month row 22px + 2px gap),
      // so it reads as top-aligned with the graph rather than with the labels.
      '.hc-years{flex:none;display:flex;flex-direction:column;gap:4px;width:96px;padding-top:24px}',
      '.hc-year{appearance:none;border:0;cursor:pointer;font:inherit;font-size:13px;line-height:20px;',
      'height:32px;padding:0 10px;border-radius:6px;color:var(--hc-text);background:transparent;text-align:center}',
      '.hc-year:hover{background:var(--hc-hover)}',
      '.hc-year[data-active="true"]{background:#0969da;color:#ffffff;font-weight:500}',
      '.hc-year[data-active="true"]:hover{background:#0969da}',

      '.hc-tooltip{position:fixed;z-index:1001;pointer-events:none;max-width:320px;',
      'background:#24292f;color:#ffffff;border-radius:6px;padding:5px 8px;font-size:12px;line-height:17px;',
      'white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)}',

      '.hc-skeleton{display:flex;flex-direction:column;gap:16px;margin-top:40px}',
      '.hc-sk-line{height:16px;width:220px;border-radius:4px;background:var(--hc-l0);animation:hcPulse 1.2s ease-in-out infinite}',
      '.hc-sk-grid{height:150px;border-radius:6px;background:var(--hc-l0);animation:hcPulse 1.2s ease-in-out infinite}',
      '@keyframes hcPulse{0%,100%{opacity:.55}50%{opacity:.85}}',
      '@media (prefers-reduced-motion:reduce){.hc-sk-line,.hc-sk-grid{animation:none}}',
      '.hc-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#cf222e)}',
      '.hc-error-row{display:flex;align-items:center;gap:10px;margin-top:24px}',
      '.hc-retry{appearance:none;border:1px solid var(--hc-border);background:transparent;color:var(--hc-text);',
      'font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;cursor:pointer}',
      '.hc-retry:hover{background:var(--hc-hover)}',

      '.hc-settings{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px;color:var(--hc-text)}',
      '.hc-settings-row{display:flex;flex-direction:column;gap:6px}',
      '.hc-settings-label{font-size:12px;line-height:18px;color:var(--hc-muted)}',
      '.hc-settings-inputs{display:flex;gap:12px;flex-wrap:wrap}',
      '.hc-field{display:flex;flex-direction:column;gap:4px}',
      '.hc-field-label{font-size:12px;line-height:16px;color:var(--hc-muted)}',
      '.hc-input{width:96px;box-sizing:border-box;font:inherit;font-size:13px;padding:5px 8px;border-radius:6px;',
      'border:1px solid var(--hc-border);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--hc-text)}',
      '.hc-input:focus{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,rgba(9,105,218,.35))}',
      '.hc-settings-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.hc-primary{appearance:none;border:0;cursor:pointer;font:inherit;font-size:12px;line-height:18px;',
      'padding:6px 14px;border-radius:6px;background:#0969da;color:#ffffff}',
      '.hc-primary:disabled{opacity:.55;cursor:default}',
      '.hc-status{font-size:12px;line-height:18px;color:var(--hc-muted)}',
      '.hc-status[data-error="true"]{color:var(--dsw-alias-state-error-primary,#cf222e)}',
    ].join('')

    function ensureStyles () {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + PACKAGE + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.pluginCss = PACKAGE
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------- theme

    function detectDarkNow (ctx) {
      try {
        if (ctx && ctx.theme && typeof ctx.theme.getTheme === 'function') {
          const snapshot = ctx.theme.getTheme()
          const active = snapshot && Array.isArray(snapshot.themes)
            ? snapshot.themes.find(theme => theme && theme.id === snapshot.preference)
            : undefined
          if (active && active.colorScheme) return active.colorScheme === 'dark'
        }
      } catch { /* fall through */ }
      try {
        const root = document.documentElement
        if (root && root.dataset) {
          if (root.dataset.theme === 'dark' || root.dataset.colorScheme === 'dark') return true
          if (root.dataset.theme === 'light' || root.dataset.colorScheme === 'light') return false
        }
        const background = getComputedStyle(document.body).backgroundColor
        const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(background || '')
        if (match !== null) {
          const r = Number(match[1])
          const g = Number(match[2])
          const b = Number(match[3])
          return (0.299 * r + 0.587 * g + 0.114 * b) < 128
        }
      } catch { /* fall through */ }
      try {
        return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)').matches
          : false
      } catch {
        return false
      }
    }

    function createThemeSource (ctx) {
      let dark = detectDarkNow(ctx)
      const listeners = new Set()
      let release = null

      function recompute () {
        const next = detectDarkNow(ctx)
        if (next === dark) return
        dark = next
        for (const listener of [...listeners]) {
          try { listener(dark) } catch { /* ignore */ }
        }
      }

      function attach () {
        const cleanups = []
        try {
          if (ctx && typeof ctx.on === 'function') {
            const off = ctx.on('theme/change', recompute)
            if (typeof off === 'function') cleanups.push(off)
          }
        } catch { /* ignore */ }
        try {
          if (typeof MutationObserver === 'function' && typeof document !== 'undefined') {
            const observer = new MutationObserver(recompute)
            observer.observe(document.documentElement, {
              attributes: true,
              attributeFilter: ['data-theme', 'data-color-scheme', 'class', 'style'],
            })
            cleanups.push(() => observer.disconnect())
          }
        } catch { /* ignore */ }
        try {
          if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            const media = window.matchMedia('(prefers-color-scheme: dark)')
            if (typeof media.addEventListener === 'function') {
              media.addEventListener('change', recompute)
              cleanups.push(() => media.removeEventListener('change', recompute))
            }
          }
        } catch { /* ignore */ }
        return () => {
          for (const cleanup of cleanups) {
            try { cleanup() } catch { /* ignore */ }
          }
        }
      }

      return {
        isDark: () => dark,
        subscribe (listener) {
          listeners.add(listener)
          if (listeners.size === 1) release = attach()
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && typeof release === 'function') {
              try { release() } catch { /* ignore */ }
              release = null
            }
          }
        },
      }
    }

    // ------------------------------------------------------------- transport

    async function requestJson (path, options) {
      const init = options && options.body !== undefined
        ? { ...options, headers: { accept: 'application/json', 'content-type': 'application/json' } }
        : { ...options, headers: { accept: 'application/json' } }
      const response = await fetch(API + path, init)
      const text = await response.text()
      let payload = null
      try { payload = text === '' ? null : JSON.parse(text) } catch { payload = null }
      if (!response.ok) throw new Error((payload && payload.error) || 'HTTP ' + response.status)
      return payload
    }

    // ---------------------------------------------------------------- store

    function createDialogStore (readTheme) {
      let state = {
        open: false,
        year: null,
        graph: null,
        loading: false,
        error: null,
        theme: readTheme(),
      }
      const listeners = new Set()
      let pollTimer = null
      let pollCount = 0

      function emit () {
        const snapshot = state
        for (const listener of [...listeners]) {
          try { listener(snapshot) } catch { /* a broken listener must not break the dialog */ }
        }
      }

      function set (patch) {
        state = { ...state, ...patch }
        emit()
      }

      function stopPolling () {
        if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null }
        pollCount = 0
      }

      function schedulePoll () {
        if (pollTimer !== null || pollCount >= 25) return
        pollCount += 1
        pollTimer = setTimeout(() => {
          pollTimer = null
          if (state.open) void load()
        }, 1200)
      }

      // One view only: a calendar year. The host still answers `range=last365`
      // (kept for the roadmap), but this UI never asks for it.
      async function load () {
        const year = state.year === null ? new Date().getFullYear() : state.year
        set({ loading: true, error: null })
        try {
          let data = await requestJson('/graph?year=' + encodeURIComponent(String(year)))
          const years = Array.isArray(data.availableYears) ? data.availableYears : []
          if (data.year !== year && years.length > 0) {
            data = await requestJson('/graph?year=' + encodeURIComponent(String(years[0])))
          }
          set({ graph: data, loading: false, error: null, year: data.year })
          if (data.meta && data.meta.indexing) schedulePoll()
        } catch (error) {
          warn('graph request failed: ' + describe(error))
          set({ loading: false, error: 'Could not load contributions.' })
        }
      }

      return {
        subscribe (listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        get () { return state },
        refreshTheme (dark) {
          if (state.theme !== dark) set({ theme: dark })
        },
        async open () {
          if (state.year === null) state = { ...state, year: new Date().getFullYear() }
          set({ open: true, loading: state.graph === null, error: null })
          await load()
        },
        close () {
          stopPolling()
          set({ open: false })
        },
        async setYear (year) {
          if (state.year === year) return
          set({ year })
          await load()
        },
        async reload () {
          await load()
        },
      }
    }

    function useStore (store) {
      const [snapshot, setSnapshot] = React.useState(() => store.get())
      React.useEffect(() => store.subscribe(setSnapshot), [store])
      return snapshot
    }

    // -------------------------------------------------------------- heatmap

    function buildGrid (startKey, endKey, dayMap) {
      const start = parseDay(startKey)
      const end = parseDay(endKey)
      const lastMonday = mondayOf(end)
      const columns = []
      let cursor = mondayOf(start)
      while (cursor.getTime() <= lastMonday.getTime()) {
        const cells = []
        for (let row = 0; row < 7; row += 1) {
          const date = addDays(cursor, row)
          const key = dayKey(date)
          const blank = date.getTime() < start.getTime() || date.getTime() > end.getTime()
          cells.push({ blank, key, date, entry: blank ? null : (dayMap.get(key) || null) })
        }
        columns.push({ cells })
        cursor = addDays(cursor, 7)
      }
      return columns
    }

    function monthLabels (columns) {
      const labels = []
      let lastMonth = -1
      let lastColumn = -10
      for (let index = 0; index < columns.length; index += 1) {
        const first = columns[index].cells.find(cell => !cell.blank)
        if (first === undefined) continue
        const month = first.date.getMonth()
        if (month === lastMonth) continue
        // Labels closer than three columns would collide; GitHub drops them too.
        if (index - lastColumn < 3) continue
        labels.push({ column: index, text: MONTHS[month] })
        lastMonth = month
        lastColumn = index
      }
      return labels
    }

    // ------------------------------------------------------------- geometry
    //
    // The graph spans the card, so the cell size follows the measured width:
    //   cell = (available − weekday column − chart gap) / 53 − gap
    // The card's own width already excludes the year rail to its right, so this
    // is the spec's `(content − label column − year rail) / 53 − gap` with the
    // rail measured rather than assumed.
    //
    // v4 asks for 21px (14–16px × 1.3) at the 1500px design width, with a 14px
    // floor: below that the card scrolls horizontally instead of shrinking.

    const LABEL_COLUMN = 40 // fits "Wed" at 18px, right aligned
    const CHART_GAP = 10
    const MIN_CELL = 14
    const MAX_CELL = 21
    const FALLBACK_CELL = 21

    /** Largest cell size that still fits `columnCount` weeks into `available`. */
    function measureCellSize (available, columnCount) {
      if (!(available > 0) || !(columnCount > 0)) return { cell: FALLBACK_CELL, gap: 3 }
      const left = LABEL_COLUMN + CHART_GAP
      const fits = (cell, gap) => left + columnCount * cell + (columnCount - 1) * gap <= available
      for (let cell = MAX_CELL; cell >= MIN_CELL; cell -= 1) {
        // 3px reads right on the large cells; 2px keeps narrow windows fitting.
        for (const gap of [3, 2]) {
          if (fits(cell, gap)) return { cell, gap }
        }
      }
      return { cell: MIN_CELL, gap: 2 }
    }

    /** Live width of an element, re-measured on resize. */
    function useElementWidth (ref) {
      const [width, setWidth] = React.useState(0)
      React.useEffect(() => {
        const node = ref.current
        if (node === null || node === undefined) return undefined
        const measure = () => {
          const next = typeof node.clientWidth === 'number' ? node.clientWidth : 0
          setWidth(current => (current === next ? current : next))
        }
        measure()
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(node)
        } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure)
        }
        return () => {
          if (observer !== null) observer.disconnect()
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('resize', measure)
          }
        }
      }, [ref])
      return width
    }

    function Chart (props) {
      const { columns, labels, metrics, todayKey, onHover, onLeave } = props
      const pitch = metrics.cell + metrics.gap

      const cellProps = (cell, key) => {
        const entry = cell.blank ? null : cell.entry
        return {
          key,
          className: 'hc-cell',
          'data-level': cell.blank ? undefined : String(entry ? entry.level : 0),
          'data-blank': cell.blank ? 'true' : undefined,
          'data-today': !cell.blank && cell.key === todayKey ? 'true' : undefined,
          role: cell.blank ? undefined : 'gridcell',
          tabIndex: cell.blank ? undefined : 0,
          'aria-label': cell.blank ? undefined : tooltipText(entry, cell.date),
          onMouseEnter: cell.blank ? undefined : event => onHover(event.currentTarget, tooltipText(entry, cell.date)),
          onMouseLeave: cell.blank ? undefined : onLeave,
          onFocus: cell.blank ? undefined : event => onHover(event.currentTarget, tooltipText(entry, cell.date)),
          onBlur: cell.blank ? undefined : onLeave,
        }
      }

      const weekColumns = columns.map((column, index) => h('div', { key: index, className: 'hc-week' },
        column.cells.map((cell, row) => h('div', cellProps(cell, row))),
      ))

      return h('div', { className: 'hc-chart' },
        h('div', { className: 'hc-weekdays', 'aria-hidden': 'true' },
          Array.from({ length: 7 }, (_, row) => h('div', { key: row, className: 'hc-weekday' }, WEEKDAY_LABELS[row] || '')),
        ),
        h('div', { className: 'hc-plot' },
          h('div', { className: 'hc-months', 'aria-hidden': 'true' },
            labels.map(label => h('div', {
              key: label.column,
              className: 'hc-month',
              style: { left: (label.column * pitch) + 'px' },
            }, label.text)),
          ),
          h('div', { className: 'hc-weeks', role: 'grid', 'aria-label': 'Contribution activity' }, weekColumns),
        ),
      )
    }

    function Legend () {
      return h('div', { className: 'hc-legend' },
        h('span', { className: 'hc-legend-label' }, 'Less'),
        [0, 1, 2, 3, 4].map(level => h('div', { key: level, className: 'hc-cell', 'data-level': String(level) })),
        h('span', { className: 'hc-legend-label' }, 'More'),
      )
    }

    /**
     * The card: measured once here so the chart and the legend below it share
     * one cell size, and the graph can span the whole content width.
     */
    function ContributionCard (props) {
      const { graph, todayKey, onHover, onLeave } = props
      const cardRef = React.useRef(null)
      const width = useElementWidth(cardRef)
      const dayMap = React.useMemo(() => {
        const map = new Map()
        for (const day of graph.days || []) map.set(day.date, day)
        return map
      }, [graph])
      const columns = React.useMemo(() => buildGrid(graph.start, graph.end, dayMap), [graph, dayMap])
      const labels = React.useMemo(() => monthLabels(columns), [columns])
      const metrics = React.useMemo(() => measureCellSize(width, columns.length), [width, columns.length])

      return h('div', {
        className: 'hc-card',
        ref: cardRef,
        style: { '--hc-cell': metrics.cell + 'px', '--hc-gap': metrics.gap + 'px' },
      },
      h(Chart, { columns, labels, metrics, todayKey, onHover, onLeave }),
      h(Legend),
      )
    }

    // -------------------------------------------------------------- profile

    /**
     * The host keeps its account identity to itself: `ui-settings-account`
     * publishes no client service, and the store that backs the launcher is
     * internal, so the only stable source is the launcher the host already
     * rendered in the sidebar.
     *
     * What we take from it, and what we refuse to take:
     *  - the name is the launcher's label text, which the host falls back to a
     *    masked contact when the profile has no name — an `@` therefore means
     *    "no name", never "show the e-mail";
     *  - the picture is reused only while the host's own `<img>` is loaded
     *    (`complete` + `naturalWidth`), so mirroring it can never start a
     *    request the host has not already made.
     *
     * The last successful read is cached: collapsing the sidebar hides the
     * label, and the dialog should not lose the name because of that.
     */
    let cachedIdentity = null

    function readAccountIdentity () {
      try {
        if (typeof document === 'undefined') return cachedIdentity
        const button = document.querySelector('button[data-signed-out]')
        if (button === null) return cachedIdentity
        if (button.getAttribute('data-signed-out') === 'true') {
          // Signed out: the launcher shows an ellipsis, not an identity.
          return null
        }

        const image = button.querySelector('img[src]')
        const avatar = image !== null && image.complete === true && image.naturalWidth > 0
          ? (image.currentSrc || image.src || null)
          : null

        let name = ''
        for (const span of button.querySelectorAll('span')) {
          const text = (span.textContent || '').trim()
          if (text !== '' && text.length <= 80 && span.querySelector('img') === null) name = text
        }
        if (name.includes('@')) name = ''

        if (name === '' && avatar === null) return cachedIdentity
        cachedIdentity = { name, avatar }
        return cachedIdentity
      } catch {
        return cachedIdentity
      }
    }

    /** `Oct 2026` from a `YYYY-MM-DD` key, or null when it is unusable. */
    function formatSince (firstActivity) {
      if (firstActivity === null || firstActivity === undefined || typeof firstActivity.date !== 'string') return null
      const parts = firstActivity.date.split('-')
      const year = Number(parts[0])
      const month = Number(parts[1])
      if (!Number.isInteger(year) || year < 1970 || !Number.isInteger(month) || month < 1 || month > 12) return null
      return MONTHS[month - 1] + ' ' + year
    }

    /**
     * The "Coding since" anchor for a graph payload.
     *
     * `firstActivity` is the server's answer (earliest active day, else the
     * earliest session). Older servers do not send it; `meta.firstSessionAt` has
     * been in the payload since the first release and carries the same fallback,
     * so a client-only update still shows the line.
     */
    function sinceForGraph (graph) {
      if (graph === null || graph === undefined) return null
      const fromServer = formatSince(graph.firstActivity)
      if (fromServer !== null) return fromServer
      const stamp = graph.meta && typeof graph.meta.firstSessionAt === 'number' ? graph.meta.firstSessionAt : 0
      if (!(stamp > 0)) return null
      return formatSince({ date: dayKey(new Date(stamp)) })
    }

    function ProfileRow (props) {
      const identity = props.identity
      if (identity === null || identity === undefined) return null
      const name = typeof identity.name === 'string' ? identity.name : ''
      const avatar = typeof identity.avatar === 'string' && identity.avatar !== '' ? identity.avatar : null
      const since = props.since
      // Neither half available: hide the row rather than drawing an empty shell.
      if (name === '' && avatar === null) return null

      const initial = name.trim().slice(0, 1).toUpperCase()
      return h('div', { className: 'hc-profile' },
        h('div', { className: 'hc-avatar' },
          avatar !== null
            ? h('img', { src: avatar, alt: '', referrerPolicy: 'no-referrer' })
            : h('span', { className: 'hc-avatar-initial', 'aria-hidden': 'true' }, initial),
        ),
        h('div', { className: 'hc-profile-text' },
          name !== '' ? h('div', { className: 'hc-profile-name' }, name) : null,
          since !== null ? h('div', { className: 'hc-profile-since' }, 'Coding since ' + since) : null,
        ),
      )
    }

    // --------------------------------------------------------------- dialog

    function fallbackModalLayer (ref, open, onClose) {
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape' && !event.shiftKey) {
            event.preventDefault()
            onClose()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        const element = ref.current
        if (element !== null && element !== undefined && typeof element.focus === 'function') {
          try { element.focus() } catch { /* ignore */ }
        }
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [open, onClose])
    }

    const useDialogLayer = typeof primitives.useModalLayer === 'function'
      ? (ref, open, onClose) => primitives.useModalLayer(ref, open, onClose)
      : fallbackModalLayer

    function CloseGlyph () {
      const Icon = primitives.IconCloseOutlineRegular
      if (typeof Icon === 'function') {
        try { return h(Icon, { size: 14 }) } catch { /* fall through to the inline glyph */ }
      }
      return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))
    }

    function Tooltip (props) {
      const tip = props.tip
      if (tip === null) return null
      return h('div', {
        className: 'hc-tooltip',
        style: { left: tip.left + 'px', top: tip.top + 'px', transform: 'translate(-50%,-100%)' },
        role: 'tooltip',
      }, tip.text)
    }

    function DialogBody (props) {
      const { store, state } = props
      const graph = state.graph
      const todayKey = dayKey(new Date())
      const [tip, setTip] = React.useState(null)
      // Read once per open: the dialog mounts on every open, and the launcher is
      // in the DOM at that moment.
      const [identity] = React.useState(() => readAccountIdentity())

      const onHover = React.useCallback((element, text) => {
        const rect = element.getBoundingClientRect()
        setTip({ text, left: rect.left + rect.width / 2, top: rect.top - 6 })
      }, [])
      const onLeave = React.useCallback(() => setTip(null), [])

      React.useEffect(() => {
        if (!state.open) setTip(null)
      }, [state.open])

      const title = graph === null
        ? ''
        : plural(graph.total, 'contribution') + ' in ' + graph.year

      const showEmpty = graph !== null && graph.meta && graph.meta.anyActivity === false

      // One view: the calendar year. No range control, no rolling window.
      const content = []

      // Profile row first: it carries the identity, which is independent of
      // whether the graph has answered yet.
      content.push(h(ProfileRow, {
        key: 'profile',
        identity,
        since: sinceForGraph(graph),
      }))

      if (graph === null && state.loading) {
        content.push(h('div', { key: 'skeleton', className: 'hc-skeleton' },
          h('div', { className: 'hc-sk-line' }),
          h('div', { className: 'hc-sk-grid' }),
        ))
      } else if (graph === null) {
        content.push(h('div', { key: 'failed', className: 'hc-error-row' },
          h('p', { className: 'hc-error' }, state.error || 'Could not load contributions.'),
          h('button', { type: 'button', className: 'hc-retry', onClick: () => { void store.reload() } }, 'Retry'),
        ))
      } else {
        content.push(h('div', { key: 'summary', className: 'hc-summary' }, title))
        if (showEmpty) {
          content.push(h('div', { key: 'empty', className: 'hc-empty' },
            h('div', { className: 'hc-empty-title' }, 'No contributions yet'),
            h('div', { className: 'hc-empty-body' }, 'Start using DSH and your activity will show up here.'),
          ))
        }
        content.push(h('div', { key: 'cardrow', className: 'hc-cardrow' },
          h(ContributionCard, { graph, todayKey, onHover, onLeave }),
          Array.isArray(graph.availableYears)
            ? h('div', { className: 'hc-years', role: 'group', 'aria-label': 'Year' },
              graph.availableYears.map(year => h('button', {
                key: year,
                type: 'button',
                className: 'hc-year',
                'data-active': year === graph.year ? 'true' : 'false',
                'aria-pressed': year === graph.year,
                onClick: () => { void store.setYear(year) },
              }, String(year))),
            )
            : null,
        ))
        if (state.error !== null) {
          content.push(h('div', { key: 'error', className: 'hc-error-row' },
            h('p', { className: 'hc-error' }, state.error),
            h('button', { type: 'button', className: 'hc-retry', onClick: () => { void store.reload() } }, 'Retry'),
          ))
        }
      }

      return h(React.Fragment, null,
        h('div', { className: 'hc-body' },
          h('div', { className: 'hc-content' }, content),
        ),
        h(Tooltip, { tip: state.open ? tip : null }),
      )
    }

    function Dialog (props) {
      const { store } = props
      const state = useStore(store)
      const panel = React.useRef(null)
      const close = React.useCallback(() => store.close(), [store])
      useDialogLayer(panel, state.open, close)

      if (!state.open) return null

      return h('div', {
        className: 'hc-root',
        'data-hc-theme': state.theme ? 'dark' : 'light',
      },
      h('div', { className: 'hc-overlay', role: 'presentation' },
        h('div', { className: 'hc-mask', 'aria-hidden': 'true', onClick: close }),
        h('div', {
          ref: panel,
          className: 'hc-panel',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dsh-happycode-title',
          tabIndex: -1,
        },
        h('div', { className: 'hc-header' },
          h('h2', { className: 'hc-title', id: 'dsh-happycode-title' }, BRAND),
          h('button', { type: 'button', className: 'hc-close', onClick: close, 'aria-label': 'Close' }, h(CloseGlyph)),
        ),
        h(DialogBody, { store, state }),
        ),
      ),
      )
    }

    // -------------------------------------------------------- settings card

    function SettingsCard () {
      const [status, setStatus] = React.useState(null)
      const [weights, setWeights] = React.useState({ m: 1, t: 1, f: 3 })
      const [message, setMessage] = React.useState(null)
      const [busy, setBusy] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        const run = async () => {
          try {
            const [settings, current] = await Promise.all([requestJson('/settings'), requestJson('/status')])
            if (cancelled) return
            setWeights({ m: settings.weights.m, t: settings.weights.t, f: settings.weights.f })
            setStatus(current)
          } catch (error) {
            if (!cancelled) setMessage({ text: 'Could not read settings: ' + describe(error), error: true })
          }
        }
        void run()
        return () => { cancelled = true }
      }, [])

      const field = (key, label) => h('div', { className: 'hc-field', key },
        h('label', { className: 'hc-field-label', htmlFor: 'hc-weight-' + key }, label),
        h('input', {
          id: 'hc-weight-' + key,
          className: 'hc-input',
          type: 'number',
          min: 0,
          max: 1000,
          step: 1,
          value: weights[key],
          onChange: (event) => {
            const next = { ...weights }
            next[key] = event.target.value
            setWeights(next)
          },
        }),
      )

      const save = async () => {
        setBusy(true)
        setMessage(null)
        try {
          const payload = { weights: { m: Number(weights.m) || 0, t: Number(weights.t) || 0, f: Number(weights.f) || 0 } }
          const saved = await requestJson('/settings', { method: 'POST', body: JSON.stringify(payload) })
          setWeights({ m: saved.weights.m, t: saved.weights.t, f: saved.weights.f })
          const refreshed = await requestJson('/refresh', { method: 'POST', body: '{}' })
          setStatus(refreshed.status || null)
          setMessage({ text: 'Recalculated.', error: false })
        } catch (error) {
          setMessage({ text: 'Could not save: ' + describe(error), error: true })
        } finally {
          setBusy(false)
        }
      }

      const counts = status === null
        ? null
        : h('div', { className: 'hc-status' },
          plural(status.sessions, 'session') + ' indexed · ' + plural(status.days, 'active day') +
          (Array.isArray(status.errors) && status.errors.length > 0
            ? ' · ' + plural(status.errors.length, 'unreadable log')
            : ''))

      return h('div', { className: 'hc-root hc-settings' },
        h('div', { className: 'hc-settings-row' },
          h('div', { className: 'hc-settings-label' }, 'Contribution weights'),
          h('div', { className: 'hc-settings-inputs' },
            field('m', 'Message turns'),
            field('t', 'Tool calls'),
            field('f', 'File edits'),
          ),
        ),
        h('div', { className: 'hc-settings-actions' },
          h('button', { type: 'button', className: 'hc-primary', disabled: busy, onClick: () => { void save() } }, 'Recalculate'),
          message !== null
            ? h('span', { className: 'hc-status', 'data-error': message.error ? 'true' : 'false' }, message.text)
            : null,
        ),
        counts,
      )
    }

    // --------------------------------------------------- account-menu entry

    function buildEntryIcon () {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('width', '16')
      svg.setAttribute('height', '16')
      svg.setAttribute('viewBox', '0 0 16 16')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('aria-hidden', 'true')
      const coords = [0.6, 5.7, 10.8]
      const size = 4.2
      // 3x3 outline grid, then the four lit cells of an ascending staircase.
      for (const x of coords) {
        for (const y of coords) {
          const rect = document.createElementNS(SVG_NS, 'rect')
          rect.setAttribute('x', String(x))
          rect.setAttribute('y', String(y))
          rect.setAttribute('width', String(size))
          rect.setAttribute('height', String(size))
          rect.setAttribute('rx', '0.9')
          rect.setAttribute('stroke', 'currentColor')
          rect.setAttribute('stroke-width', '0.9')
          rect.setAttribute('opacity', '0.4')
          svg.appendChild(rect)
        }
      }
      const lit = [
        [0.6, 10.8, '#9be9a8'],
        [5.7, 10.8, '#40c463'],
        [5.7, 5.7, '#30a14e'],
        [10.8, 5.7, '#216e39'],
      ]
      for (const [x, y, fill] of lit) {
        const rect = document.createElementNS(SVG_NS, 'rect')
        rect.setAttribute('x', String(x))
        rect.setAttribute('y', String(y))
        rect.setAttribute('width', String(size))
        rect.setAttribute('height', String(size))
        rect.setAttribute('rx', '0.9')
        rect.setAttribute('fill', fill)
        svg.appendChild(rect)
      }
      return svg
    }

    /**
     * Graft the Happycoding Everyday row into the host's account menu.
     *
     * The host renders that menu from a hardcoded array, so there is no slot to
     * register into. Cloning the Settings row keeps typography, spacing and the
     * hover state byte-identical, and the host's own keyboard navigation walks
     * `button:not(:disabled)` in the DOM — so the clone also joins ArrowUp /
     * ArrowDown / Tab traversal without extra work.
     */
    function createMenuEntry (onActivate) {
      let observer = null
      let installed = false
      let scheduled = false

      function openLauncher () {
        const buttons = document.querySelectorAll('button[data-signed-out]')
        for (const button of buttons) {
          if (button.getAttribute('aria-expanded') === 'true') return button
        }
        return null
      }

      function accountMenu () {
        const menus = document.querySelectorAll('[role="menu"]')
        for (let index = menus.length - 1; index >= 0; index -= 1) {
          const menu = menus[index]
          if (menu.querySelector('[' + ENTRY_ATTR + ']') !== null) return menu
          if (menu.querySelectorAll('button[role="menuitem"]').length >= 2) return menu
        }
        return null
      }

      function removeEntry () {
        const entry = document.querySelector('[' + ENTRY_ATTR + ']')
        if (entry === null) return
        const wrapper = entry.parentElement
        if (wrapper !== null) wrapper.remove()
      }

      function inject () {
        if (!installed) return
        if (openLauncher() === null) {
          // The account menu is closed; anything left behind belongs to a
          // closed portal and is removed by React anyway.
          return
        }
        const menu = accountMenu()
        if (menu === null) return
        if (menu.querySelector('[' + ENTRY_ATTR + ']') !== null) return

        const items = menu.querySelectorAll('button[role="menuitem"]')
        const first = items[0]
        if (first === undefined) return
        const template = first.parentElement
        if (template === null || template.parentElement === null) return

        const wrapper = template.cloneNode(true)
        const button = wrapper.querySelector('button[role="menuitem"]')
        if (button === null) return

        for (const attribute of ['aria-keyshortcuts', 'aria-haspopup', 'aria-expanded', 'aria-controls', 'disabled']) {
          button.removeAttribute(attribute)
        }
        button.setAttribute(ENTRY_ATTR, '')
        button.setAttribute('aria-label', MENU_LABEL)

        const spans = [...button.querySelectorAll('span')]
        const iconHost = spans.find(span => span.querySelector('svg') !== null)
        const label = spans.find(span => span !== iconHost && span.textContent !== '' && span.querySelector('svg') === null
          && !span.hasAttribute('aria-hidden'))
        if (iconHost !== null && iconHost !== undefined) {
          iconHost.replaceChildren(buildEntryIcon())
        }
        if (label !== undefined) {
          label.textContent = MENU_LABEL
          for (const span of spans) {
            if (span !== iconHost && span !== label) span.remove()
          }
        }

        button.addEventListener('click', (event) => {
          event.preventDefault()
          try {
            onActivate()
          } catch (error) {
            warn('failed to open the dialog: ' + describe(error))
          }
        })

        template.parentElement.insertBefore(wrapper, template.nextSibling)
      }

      function schedule () {
        if (scheduled) return
        scheduled = true
        const run = () => {
          scheduled = false
          try { inject() } catch (error) { warn('menu injection failed: ' + describe(error)) }
        }
        if (typeof queueMicrotask === 'function') queueMicrotask(run)
        else setTimeout(run, 0)
      }

      /**
       * Only menu traffic matters. The app mutates the DOM continuously while a
       * reply streams; re-querying the document on every character would be
       * wasteful, so the observer filters first and the click handler filters
       * for the launcher itself.
       */
      function touchesMenu (node) {
        if (node === null || node === undefined || node.nodeType !== 1) return false
        if (typeof node.matches === 'function' && node.matches('[role="menu"]')) return true
        return typeof node.querySelector === 'function' && node.querySelector('[role="menu"]') !== null
      }

      function onMutations (records) {
        for (const record of records) {
          if (record.type === 'attributes') { schedule(); return }
          for (const node of record.addedNodes) {
            if (touchesMenu(node)) { schedule(); return }
          }
          for (const node of record.removedNodes) {
            if (touchesMenu(node)) { schedule(); return }
          }
        }
      }

      function onDocumentClick (event) {
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        if (target.closest('button[data-signed-out]') === null) return
        schedule()
      }

      return {
        start () {
          if (installed) return
          if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return
          installed = true
          observer = new MutationObserver(onMutations)
          observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-expanded'],
          })
          document.addEventListener('click', onDocumentClick, true)
          schedule()
        },
        stop () {
          installed = false
          if (observer !== null) { observer.disconnect(); observer = null }
          document.removeEventListener('click', onDocumentClick, true)
          removeEntry()
        },
      }
    }

    // ------------------------------------------------------------- mounting

    function resolveReactDomClient () {
      let client = null
      try { client = require('react-dom/client') } catch { client = null }
      if (client && typeof client.createRoot === 'function') return client
      const legacy = require('react-dom')
      return {
        createRoot (element) {
          return {
            render (node) { legacy.render(node, element) },
            unmount () { legacy.unmountComponentAtNode(element) },
          }
        },
      }
    }

    function mountClientRoot (element) {
      const client = resolveReactDomClient()
      let container = document.getElementById(ROOT_ID)
      if (container === null) {
        container = document.createElement('div')
        container.id = ROOT_ID
        document.body.appendChild(container)
      }
      const root = client.createRoot(container)
      root.render(element)
      return () => {
        try { root.unmount() } catch { /* ignore */ }
        if (container.parentNode !== null) container.parentNode.removeChild(container)
      }
    }

    // ------------------------------------------------------------ registering

    function registerSettingsCard (ctx) {
      try {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          inject: () => ({}),
        }, (ownerProps) => {
          if (ownerProps && ownerProps.view === 'summary') return null
          return h(SettingsCard)
        }))
      } catch (error) {
        warn('settings card not registered: ' + describe(error))
      }
    }

    const name = PACKAGE
    const inject = ['slots', 'theme']

    function apply (ctx) {
      try {
        ensureStyles()
        const themeSource = createThemeSource(ctx)
        const store = createDialogStore(() => themeSource.isDark())
        const menu = createMenuEntry(() => { void store.open() })

        const disposeRoot = mountClientRoot(h(Dialog, { store }))
        const stopTheme = themeSource.subscribe(dark => store.refreshTheme(dark))
        menu.start()

        const dispose = () => {
          try { menu.stop() } catch { /* ignore */ }
          try { stopTheme() } catch { /* ignore */ }
          try { disposeRoot() } catch { /* ignore */ }
        }

        try {
          ctx.effect(() => dispose, 'dsh-happycode: account entry and dialog')
        } catch (error) {
          warn('could not register disposal: ' + describe(error))
        }

        registerSettingsCard(ctx)
      } catch (error) {
        warn('client mount failed: ' + describe(error))
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
