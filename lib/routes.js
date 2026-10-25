/**
 * The plugin's HTTP surface. Loopback-only in practice (the host serves it),
 * same-origin enforced on the mutating routes, JSON in and JSON out.
 *
 *   GET  /dsh-happycode/api/graph?year=YYYY
 *   GET  /dsh-happycode/api/graph?range=last365
 *   POST /dsh-happycode/api/refresh
 *   GET  /dsh-happycode/api/settings
 *   POST /dsh-happycode/api/settings
 *   GET  /dsh-happycode/api/status
 *
 * @module dsh-happycode/routes
 */

/** Route prefix; the client builds the same paths. */
export const BASE_PATH = '/dsh-happycode/api'

const JSON_HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
}

function sendJson (response, status, payload) {
  response.writeHead(status, JSON_HEADERS)
  response.end(JSON.stringify(payload))
}

function sendError (response, status, message) {
  sendJson(response, status, { error: message })
}

function loopbackAuthority (host) {
  if (typeof host !== 'string' || host === '') return false
  const lower = host.toLowerCase()
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

/**
 * Whether a mutating request came from this page.
 *
 * `Host` is the header a rebinding page cannot forge, so it has to name a
 * loopback authority; `Origin`, when present, must match it. An absent
 * `Origin` means the caller is not a page (a proxy may strip it), which is
 * how the desktop shell's own forwarding reaches the host.
 */
export function sameOrigin (request) {
  const host = request.headers.host
  if (typeof host === 'string' && host !== '' && !loopbackAuthority(host)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readBody (request, maxBytes = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Register every route on the host's web server.
 *
 * @param {{ register(route: { kind: 'exact' | 'prefix', path: string, handler: Function }): Function }} webServer
 * @param {import('./store.js').HappyCodeStore} store
 * @param {{ logger?: { warn: Function, info: Function } }} [options]
 * @returns {() => void} disposer removing every route again.
 */
export function mountRoutes (webServer, store, options = {}) {
  const logger = options.logger ?? { warn () {}, info () {} }
  const disposers = []

  const graph = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const range = url.searchParams.get('range')
    const yearParam = url.searchParams.get('year')
    const year = yearParam === null ? undefined : Number.parseInt(yearParam, 10)
    if (range !== null && range !== 'last365') return sendError(response, 400, 'unknown range')
    if (range === null && yearParam !== null && !Number.isInteger(year)) return sendError(response, 400, 'invalid year')
    store.ensureFresh()
    sendJson(response, 200, store.graph({ range: range ?? undefined, year }))
  }

  const refresh = async (request, response) => {
    if (!sameOrigin(request)) return sendError(response, 403, 'untrusted origin')
    // A refresh looks for changed session files; re-decoding everything is a
    // diagnostic, asked for explicitly, because it costs a full pass.
    let force = false
    try {
      const body = await readBody(request)
      force = body !== null && typeof body === 'object' && body.force === true
    } catch {
      force = false
    }
    const result = await store.refresh({ force })
    sendJson(response, 200, { ok: result.error === undefined, ...result, status: store.status() })
  }

  const getSettings = async (request, response) => {
    sendJson(response, 200, {
      weights: { ...store.settings.weights },
      editTools: [...store.settings.editTools],
      updatedAt: store.settings.updatedAt,
    })
  }

  const postSettings = async (request, response) => {
    if (!sameOrigin(request)) return sendError(response, 403, 'untrusted origin')
    const body = await readBody(request)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return sendError(response, 400, 'invalid body')
    const weights = body.weights
    if (weights !== undefined) {
      if (weights === null || typeof weights !== 'object') return sendError(response, 400, 'invalid weights')
      for (const field of ['m', 't', 'f']) {
        if (weights[field] === undefined) continue
        const value = Number(weights[field])
        if (!Number.isFinite(value) || value < 0 || value > 1000) return sendError(response, 400, `invalid weight ${field}`)
      }
    }
    if (body.editTools !== undefined && !Array.isArray(body.editTools)) return sendError(response, 400, 'invalid editTools')
    const next = await store.updateSettings({ weights, editTools: body.editTools })
    sendJson(response, 200, {
      weights: { ...next.weights },
      editTools: [...next.editTools],
      updatedAt: next.updatedAt,
    })
  }

  const status = async (request, response) => {
    store.ensureFresh()
    sendJson(response, 200, store.status())
  }

  // The host's web server registers a path, not a path+method pair, so one
  // handler per path dispatches on the method itself.
  const routes = [
    { path: `${BASE_PATH}/graph`, methods: { GET: graph } },
    { path: `${BASE_PATH}/refresh`, methods: { POST: refresh } },
    { path: `${BASE_PATH}/settings`, methods: { GET: getSettings, POST: postSettings } },
    { path: `${BASE_PATH}/status`, methods: { GET: status } },
  ]

  for (const route of routes) {
    const handler = async (request, response) => {
      try {
        const method = (request.method ?? 'GET').toUpperCase()
        const target = route.methods[method]
        if (target === undefined) {
          response.setHeader('allow', Object.keys(route.methods).join(', '))
          sendError(response, 405, 'method not allowed')
          return
        }
        await target(request, response)
      } catch (error) {
        logger.warn(`route ${route.path} failed: ${error && error.message ? error.message : error}`)
        if (!response.headersSent) sendError(response, 500, 'internal error')
        else response.end()
      }
    }
    const dispose = webServer.register({ kind: 'exact', path: route.path, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch (error) { logger.warn(`route dispose failed: ${error && error.message ? error.message : error}`) }
    }
  }
}
