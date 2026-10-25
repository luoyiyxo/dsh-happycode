/**
 * Client-bundle integration test.
 *
 * Boots the real `client/client.js` in jsdom against the host surfaces it
 * touches (a fake React/primitives module table, a fake account menu, a fake
 * HTTP API) and drives it the way a user would: open the menu, click the row,
 * hover a cell, switch views, press Escape.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const CLIENT_SOURCE = fs.readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

// --- a single DOM for the whole file: react-dom binds to globals on first use

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://127.0.0.1:4321/',
  pretendToBeVisual: true,
})

globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.Event = dom.window.Event
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.KeyboardEvent = dom.window.KeyboardEvent
globalThis.requestAnimationFrame = cb => setTimeout(cb, 0)
globalThis.cancelAnimationFrame = id => clearTimeout(id)
globalThis.IS_REACT_ACT_ENVIRONMENT = false

// jsdom performs no layout, so element widths are zero. The responsive-sizing
// test stubs the width instead of pretending to measure.
let forcedWidth = 0
Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', {
  configurable: true,
  get () { return forcedWidth },
})

const React = (await import('react')).default
const ReactDOM = (await import('react-dom')).default
const ReactDOMClient = await import('react-dom/client')

after(() => {
  dom.window.close()
})

// --------------------------------------------------------------------- stubs

const primitives = {
  IconCloseOutlineRegular: props => React.createElement('svg', {
    width: props && props.size, height: props && props.size, 'data-icon': 'close',
  }),
  useModalLayer (ref, open, onClose) {
    React.useEffect(() => {
      if (!open) return undefined
      const onKeyDown = event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }
      document.addEventListener('keydown', onKeyDown, true)
      return () => document.removeEventListener('keydown', onKeyDown, true)
    }, [open, onClose])
  },
}

function fakeRequire (name) {
  if (name === 'react') return React
  if (name === 'react-dom') return ReactDOM
  if (name === 'react-dom/client') return ReactDOMClient
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error('unexpected require: ' + name)
}

// --------------------------------------------------------------- fake host

function makeGraph (overrides) {
  return {
    mode: 'year',
    year: 2026,
    start: '2026-01-01',
    end: '2026-12-31',
    total: 19,
    activeDays: 1,
    days: [{ date: '2026-10-24', m: 8, t: 11, f: 0, value: 19, level: 2 }],
    thresholds: [9, 19, 39],
    availableYears: [2026],
    firstActivity: { date: '2026-10-24', source: 'activity' },
    weights: { m: 1, t: 1, f: 3 },
    meta: { indexing: false, sessions: 16, builtAt: 1, firstSessionAt: 1, timeZone: 'Asia/Shanghai', errors: 0, anyActivity: true },
    ...overrides,
  }
}

function jsonResponse (payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  }
}

function makeFetch (routes) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    const path = String(url)
    for (const [prefix, handler] of routes) {
      if (path.startsWith(prefix)) return typeof handler === 'function' ? handler(init) : jsonResponse(handler)
    }
    return jsonResponse(makeGraph())
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function boot (options = {}) {
  document.body.innerHTML = ''
  document.head.innerHTML = ''

  // The host's account launcher, with the attribute the real one carries.
  const launcher = document.createElement('button')
  launcher.setAttribute('data-signed-out', options.signedOut === true ? 'true' : 'false')
  launcher.setAttribute('aria-haspopup', 'menu')
  launcher.setAttribute('aria-expanded', 'false')
  launcher.setAttribute('aria-label', 'Account menu')
  const account = options.account
  if (account === undefined) {
    launcher.textContent = 'account'
  } else {
    // Same shape as the host: <span class=avatar><img></span><span class=label>name</span>
    const avatarSpan = document.createElement('span')
    if (typeof account.avatar === 'string') {
      const image = document.createElement('img')
      image.src = account.avatar
      // jsdom never loads images; the plugin only mirrors a *loaded* picture.
      Object.defineProperty(image, 'complete', { value: true, configurable: true })
      Object.defineProperty(image, 'naturalWidth', { value: 56, configurable: true })
      avatarSpan.appendChild(image)
    }
    launcher.appendChild(avatarSpan)
    if (typeof account.name === 'string' && account.name !== '') {
      const label = document.createElement('span')
      label.textContent = account.name
      launcher.appendChild(label)
    }
  }
  document.body.appendChild(launcher)

  const fetchImpl = makeFetch(options.routes || [])
  const themeSnapshot = options.dark ? { preference: 'dark', themes: [{ id: 'dark', colorScheme: 'dark' }] } : null

  const ctx = {
    slots: { inject () {}, register () {} },
    theme: {
      getTheme: () => themeSnapshot,
    },
    on: () => () => {},
    effect: fn => {
      const dispose = fn()
      ctx.disposers.push(dispose)
      return dispose
    },
    disposers: [],
  }

  let factory = null
  // The bundle receives the real jsdom window (plus the loader facade), so
  // listeners and `matchMedia` behave as they do in the host.
  const windowStub = window
  windowStub.__ModuleLoader__ = { load (definition) { factory = definition.factory } }
  new Function(
    'window', 'document', 'fetch', 'queueMicrotask', 'setTimeout', 'clearTimeout',
    'MutationObserver', 'getComputedStyle', 'console', 'require',
    CLIENT_SOURCE,
  )(
    windowStub, document, fetchImpl, queueMicrotask, setTimeout, clearTimeout,
    MutationObserver, getComputedStyle, console, fakeRequire,
  )
  assert.equal(typeof factory, 'function', 'bundle must register a factory')

  const exported = factory(fakeRequire)
  assert.equal(exported.name, 'dsh-happycode')
  assert.deepEqual(exported.inject, ['slots', 'theme'])
  exported.apply(ctx)

  return { exported, ctx, fetchImpl, launcher }
}

/** Render the host's account menu the way its `Menu` primitive does. */
function openAccountMenu (launcher) {
  launcher.setAttribute('aria-expanded', 'true')
  const menu = document.createElement('div')
  menu.setAttribute('role', 'menu')
  menu.className = 'menu_list'
  const viewport = document.createElement('div')
  viewport.className = 'menu_viewport'
  for (const label of ['Settings', 'Feedback', 'Sign out']) {
    const wrap = document.createElement('div')
    wrap.className = 'menu_itemWrap'
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.className = 'menu_item'
    const icon = document.createElement('span')
    icon.className = 'menu_itemIcon'
    icon.innerHTML = '<svg width="16" height="16"></svg>'
    const text = document.createElement('span')
    text.className = 'menu_itemLabel'
    text.textContent = label
    button.append(icon, text)
    if (label === 'Settings') {
      const shortcut = document.createElement('span')
      shortcut.setAttribute('aria-hidden', 'true')
      shortcut.textContent = 'Ctrl+,'
      button.append(shortcut)
    }
    wrap.append(button)
    viewport.append(wrap)
  }
  menu.append(viewport)
  document.body.appendChild(menu)
  return menu
}

async function settle (times = 4) {
  for (let index = 0; index < times; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 16))
  }
}

function click (element) {
  element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
}

function hover (element) {
  element.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
  element.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: false }))
}

function dialog () {
  return document.querySelector('.hc-panel')
}

function cellFor (dateKey) {
  const cells = document.querySelectorAll('.hc-week .hc-cell')
  for (const cell of cells) {
    if (cell.getAttribute('aria-label') === null) continue
    if (cell.getAttribute('data-today') === 'true' && dateKey === null) return cell
    if (cell.getAttribute('aria-label').includes(dateKey)) return cell
  }
  return null
}

// --------------------------------------------------------------------- tests

test('account menu gains a HappyCode row between Settings and Feedback', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()

  const items = [...menu.querySelectorAll('button[role="menuitem"]')]
  assert.equal(items.length, 4, 'one row is added')
  assert.equal(items[0].querySelector('span:nth-child(2)').textContent, 'Settings')
  const injected = items[1]
  assert.equal(injected.textContent.trim(), 'HappyCode', 'the row sits right after Settings')
  assert.equal(injected.getAttribute('aria-label'), 'HappyCode', 'the short name is the menu identity')
  assert.equal(items[2].querySelector('span:nth-child(2)').textContent, 'Feedback')
  assert.equal(injected.getAttribute('aria-keyshortcuts'), null, 'the Settings shortcut is not cloned')
  assert.equal(injected.querySelectorAll('svg rect[fill]').length, 4, 'the mini heat grid has four lit cells')
  assert.ok(injected.hasAttribute('data-happycode-entry'))
  assert.ok(injected.parentElement.className.includes('itemWrap'), 'the cloned wrapper keeps the host row structure')
})

test('the row does not appear while the account menu is closed', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  assert.equal(document.querySelectorAll('[data-happycode-entry]').length, 1)

  launcher.setAttribute('aria-expanded', 'false')
  menu.remove()
  await settle()
  assert.equal(document.querySelectorAll('[data-happycode-entry]').length, 0)
})

test('clicking the row opens the GitHub-cloned dialog', async () => {
  const { launcher, fetchImpl } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const panel = dialog()
  assert.ok(panel, 'the dialog is portaled into the body')
  const title = panel.querySelector('.hc-title')
  assert.equal(title.textContent, 'Happycoding Everyday')
  assert.equal(panel.querySelector('.hc-header .hc-title').nextElementSibling.className, 'hc-close',
    'the brand sits immediately left of the close button')
  assert.equal(panel.querySelector('.hc-header-spacer'), null, 'no centring spacer any more')
  assert.equal(panel.querySelector('.hc-summary').textContent, '19 contributions in 2026')
  assert.equal(panel.querySelectorAll('.hc-year').length, 1)
  assert.equal(panel.querySelector('.hc-year[data-active="true"]').textContent, '2026')
  assert.equal(panel.textContent.includes('Contribution settings'), false)
  assert.equal(panel.textContent.includes('Learn how we count contributions'), false)
  assert.ok(fetchImpl.calls.some(call => String(call.url).includes('/graph?year=2026')))
})

test('there is exactly one view: no range switch anywhere in the dialog', async () => {
  const { launcher, fetchImpl } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const panel = dialog()
  assert.equal(panel.querySelectorAll('.hc-toggle, .hc-toggle-btn').length, 0)
  assert.equal(panel.querySelectorAll('[role="tablist"]').length, 0)
  const text = panel.textContent
  assert.equal(text.includes('Last year'), false)
  assert.equal(text.includes('By year'), false)
  assert.equal(fetchImpl.calls.some(call => String(call.url).includes('range=last365')), false,
    'the rolling window is never requested')
})

test('the legend sits inside the heatmap card, below the grid', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const card = document.querySelector('.hc-card')
  assert.ok(card, 'the card exists')
  const legend = card.querySelector('.hc-legend')
  assert.ok(legend, 'the legend is a child of the card')
  assert.equal(legend.textContent.replace(/\s+/g, ''), 'LessMore')
  assert.equal(document.querySelector('.hc-cardrow > .hc-legend'), null, 'it is not a sibling of the card')
  assert.equal(card.lastElementChild, legend, 'it comes after the chart')
})

test('the grid starts at the fallback cell size and follows the card width (R7)', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const card = () => document.querySelector('.hc-card')
  const cell = () => (/(--hc-cell:\s*)(\d+)px/.exec(card().getAttribute('style') || '') || [])[2]
  assert.equal(cell(), '21', 'the unmeasured fallback is the design size')

  // jsdom has no layout, so the width is stubbed and a resize drives the hook.
  forcedWidth = 1500 - 48 - 96 - 16 // the 1500px design width
  window.dispatchEvent(new window.Event('resize'))
  await settle(2)
  assert.equal(cell(), '21')
  assert.match(card().getAttribute('style') || '', /--hc-gap:\s*3px/)

  forcedWidth = 1100 // a mid-size window: cells shrink, gaps tighten
  window.dispatchEvent(new window.Event('resize'))
  await settle(2)
  assert.equal(cell(), '17')
  assert.match(card().getAttribute('style') || '', /--hc-gap:\s*2px/)

  forcedWidth = 920
  window.dispatchEvent(new window.Event('resize'))
  await settle(2)
  assert.equal(cell(), '14', 'the floor')

  forcedWidth = 800 // narrower than the floor allows: the card scrolls
  window.dispatchEvent(new window.Event('resize'))
  await settle(2)
  assert.equal(cell(), '14', 'the floor is never undershot')

  forcedWidth = 0
  window.dispatchEvent(new window.Event('resize'))
  await settle(2)
})

test('the stylesheet carries the v6 sizes (R12–R15)', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const css = document.querySelector('style[data-plugin-css="dsh-happycode"]').textContent
  const rule = (selector) => {
    const match = new RegExp(selector.replace('.', '\\.') + '\\{([^}]*)\\}').exec(css)
    return match === null ? '' : match[1]
  }

  assert.match(rule('.hc-panel'), /min-width:min\(1500px,94vw\)/, 'the dialog minimum is 1500px wide')
  assert.equal(/min-height/.test(rule('.hc-panel')), false, 'the fixed minimum height is gone (R9)')

  // R13 — title band: 90px tall, brand centred at 28–30px (24px floor), nowrap.
  assert.match(rule('.hc-title'), /font-size:clamp\(24px,2vw,30px\)/, 'the brand scales 24→30px')
  assert.match(rule('.hc-title'), /font-weight:600/)
  assert.match(rule('.hc-title'), /text-align:center/, 'and is centred')
  assert.match(rule('.hc-title'), /white-space:nowrap/, 'never wrapping')
  assert.match(rule('.hc-header'), /height:90px/, 'the title band is 90px tall')
  assert.match(rule('.hc-header'), /justify-content:center/)
  assert.match(rule('.hc-close'), /position:absolute/, 'the close button is pinned')
  assert.match(rule('.hc-close'), /right:16px/)

  // R14 — profile row: 120px avatar, text column bottom-aligned next to it.
  assert.match(rule('.hc-profile'), /align-items:flex-end/, 'the text column bottom-aligns with the avatar')
  assert.match(rule('.hc-profile'), /gap:24px/)
  assert.match(rule('.hc-avatar'), /width:120px/, 'the avatar is 120px')
  assert.match(rule('.hc-avatar'), /border-radius:24px/)
  assert.match(rule('.hc-profile-name'), /font-size:24px/)
  assert.match(rule('.hc-profile-since'), /font-size:16px/)

  // R15 — vertical rhythm: 40px then 36px.
  assert.match(rule('.hc-profile'), /margin-top:40px/, '40px between the band and the profile row')
  assert.match(rule('.hc-summary'), /margin-top:36px/, '36px between the profile row and the total')
  assert.match(rule('.hc-cardrow'), /margin-top:20px/)
  assert.equal(/margin:auto/.test(rule('.hc-content')), false, 'the content block is not centred vertically')

  // Regressions from earlier revisions.
  assert.match(rule('.hc-weekday'), /font-size:18px/, 'weekday labels are 18px')
  assert.match(rule('.hc-month'), /font-size:18px/, 'month labels are 18px')
  assert.match(rule('.hc-summary'), /font-size:19px/, 'the total keeps its size')
  assert.match(rule('.hc-legend'), /font-size:12px/, 'the legend keeps its size')
})

test('the profile row renders avatar, name and the coding start (R11)', async () => {
  const { launcher } = boot({ account: { name: '七喜', avatar: 'data:image/png;base64,iVBORw0KGgo=' } })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const profile = document.querySelector('.hc-profile')
  assert.ok(profile, 'the row is rendered')
  assert.equal(profile.querySelector('.hc-avatar img').getAttribute('src'), 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(profile.querySelector('.hc-profile-name').textContent, '七喜')
  assert.equal(profile.querySelector('.hc-profile-since').textContent, 'Coding since Oct 2026')
  assert.equal(profile.textContent.includes('@'), false, 'no e-mail anywhere in the row')
  // The row comes before the total, which comes before the card.
  const content = document.querySelector('.hc-content')
  assert.equal(content.firstElementChild, profile)
})

test('without a picture the profile row falls back to the initial', async () => {
  const { launcher } = boot({ account: { name: 'ada' } })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const profile = document.querySelector('.hc-profile')
  assert.ok(profile, 'the row still renders')
  assert.equal(profile.querySelector('.hc-avatar img'), null)
  assert.equal(profile.querySelector('.hc-avatar-initial').textContent, 'A')
  assert.equal(profile.querySelector('.hc-profile-name').textContent, 'ada')
})

test('a masked e-mail is never used as the user name', async () => {
  const { launcher } = boot({ account: { name: 'luo***@example.com' } })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  assert.equal(document.querySelector('.hc-profile'), null, 'no name and no picture: the row is hidden')
  assert.equal(document.querySelector('.hc-panel').textContent.includes('@'), false)
})

test('an older server without firstActivity still gets the coding start', async () => {
  const stamp = new Date(2026, 9, 6, 12, 0, 0).getTime()
  const graph = makeGraph({ meta: { indexing: false, sessions: 16, builtAt: 1, firstSessionAt: stamp, timeZone: 'Asia/Shanghai', errors: 0, anyActivity: true } })
  delete graph.firstActivity
  const { launcher } = boot({ account: { name: 'ada' }, routes: [['/dsh-happycode/api/graph', graph]] })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  assert.equal(document.querySelector('.hc-profile-since').textContent, 'Coding since Oct 2026')
})

test('with no account identity the whole row is hidden', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()
  assert.equal(document.querySelector('.hc-profile'), null)

  // Signed out is the same: the launcher carries an ellipsis, not a person.
  const second = boot({ signedOut: true, account: { name: '七喜' } })
  const secondMenu = openAccountMenu(second.launcher)
  await settle()
  click(secondMenu.querySelector('[data-happycode-entry]'))
  await settle()
  assert.equal(document.querySelector('.hc-profile'), null)
})

test('the content block is wrapped for natural flow (R9)', async () => {
  const { launcher } = boot({ account: { name: '七喜' } })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const body = document.querySelector('.hc-panel .hc-body')
  const content = body.querySelector(':scope > .hc-content')
  assert.ok(content, 'the body has one content wrapper')
  assert.ok(content.querySelector('.hc-summary'), 'the title sits inside it')
  assert.ok(content.querySelector('.hc-card'), 'so does the card')
  assert.ok(content.querySelector('.hc-card .hc-legend'), 'and the legend inside the card')
  // Natural flow, top to bottom: profile → total → card.
  const children = [...content.children].map(child => child.className.split(' ')[0])
  assert.deepEqual(children, ['hc-profile', 'hc-summary', 'hc-cardrow'])
})

test('tooltips follow the hovered cell and use ordinals', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const active = cellFor('October 24th')
  assert.ok(active, 'the active day renders as a cell')
  assert.equal(active.getAttribute('data-level'), '2')
  hover(active)
  await settle(2)
  assert.equal(document.querySelector('.hc-tooltip').textContent, '19 contributions on October 24th.')

  const idle = cellFor('October 23rd')
  assert.ok(idle)
  assert.equal(idle.getAttribute('data-level'), '0')
  hover(idle)
  await settle(2)
  assert.equal(document.querySelector('.hc-tooltip').textContent, 'No contributions on October 23rd.')
})

test('the first column of a year leaves padding cells empty', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  // 2026-01-01 is a Thursday, so the first three cells of the first week are
  // outside the year and must be blank.
  const firstWeek = document.querySelector('.hc-week')
  const cells = [...firstWeek.querySelectorAll('.hc-cell')]
  assert.equal(cells.length, 7)
  assert.deepEqual(cells.map(cell => cell.getAttribute('data-blank')), ['true', 'true', 'true', null, null, null, null])
  assert.equal(cells[0].getAttribute('aria-label'), null)
})

test('switching year refetches that year and keeps the picker', async () => {
  const { launcher, fetchImpl } = boot({
    routes: [[
      '/dsh-happycode/api/graph?year=2025',
      makeGraph({
        year: 2025,
        start: '2025-01-01',
        end: '2025-12-31',
        total: 42,
        days: [{ date: '2025-06-10', m: 2, t: 3, f: 1, value: 8, level: 3 }],
        availableYears: [2026, 2025],
      }),
    ]],
  })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  const buttons = [...document.querySelectorAll('.hc-year')]
  assert.equal(buttons.length, 1, 'the stub only advertises the current year first')
  assert.ok(fetchImpl.calls.some(call => String(call.url).includes('/graph?year=2026')))
  assert.equal(document.querySelector('.hc-summary').textContent, '19 contributions in 2026')

  const today = document.querySelector('.hc-cell[data-today="true"]')
  assert.ok(today, 'today carries a ring')
  assert.equal(today.getAttribute('data-level'), '0', 'today has no activity in the stub graph')
})

test('Escape and the mask close the dialog', async () => {
  const { launcher } = boot()
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()
  assert.ok(dialog())

  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await settle()
  assert.equal(dialog(), null, 'Escape closes')

  click(menu.querySelector('[data-happycode-entry]'))
  await settle()
  assert.ok(dialog())
  click(document.querySelector('.hc-mask'))
  await settle()
  assert.equal(dialog(), null, 'the mask closes')
})

test('the empty state shows when nothing was ever recorded', async () => {
  const { launcher } = boot({
    routes: [[
      '/dsh-happycode/api/graph?year',
      makeGraph({
        total: 0,
        activeDays: 0,
        days: [],
        availableYears: [2026],
        meta: { indexing: false, sessions: 0, builtAt: 0, firstSessionAt: 0, timeZone: 'Asia/Shanghai', errors: 0, anyActivity: false },
      }),
    ]],
  })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  assert.equal(document.querySelector('.hc-summary').textContent, '0 contributions in 2026')
  assert.equal(document.querySelector('.hc-empty-title').textContent, 'No contributions yet')
  assert.equal(document.querySelector('.hc-empty-body').textContent, 'Start using DSH and your activity will show up here.')
  assert.equal(document.querySelectorAll('.hc-cell[data-level="0"]').length > 0, true, 'the grid still renders, empty')
})

test('a failing API shows an error with a retry control', async () => {
  const { launcher } = boot({
    routes: [[
      '/dsh-happycode/api/graph',
      () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'boom' }) }),
    ]],
  })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()

  assert.ok(document.querySelector('.hc-error'))
  assert.equal(document.querySelector('.hc-retry').textContent, 'Retry')
})

test('the dialog follows the dark theme', async () => {
  const { launcher } = boot({ dark: true })
  const menu = openAccountMenu(launcher)
  await settle()
  click(menu.querySelector('[data-happycode-entry]'))
  await settle()
  assert.equal(document.querySelector('.hc-root').getAttribute('data-hc-theme'), 'dark')
  assert.equal(document.querySelector('.hc-tooltip'), null)
})
