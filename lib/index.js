/**
 * HappyCode host entry.
 *
 * DSH boots all-or-nothing, so nothing in this module may throw on the boot
 * path: the import graph is plain ESM with no side effects, `apply` is wrapped
 * in try/catch, and the HTTP routes are only mounted once the host composes the
 * web server. Any failure leaves the host untouched and degrades this plugin to
 * "no routes", which the client renders as an empty graph.
 *
 * @module dsh-happycode
 */

import { resolvePaths } from './paths.js'
import { mountRoutes } from './routes.js'
import { HappyCodeStore } from './store.js'

/** Cordis plugin name; also the module id the client bundle registers. */
export const name = 'dsh-happycode'

function logger (ctx) {
  const prefix = '[dsh-happycode]'
  const safe = (method, fallback) => (message) => {
    try {
      const scoped = typeof ctx.logger === 'function' ? ctx.logger('dsh-happycode') : undefined
      if (scoped && typeof scoped[method] === 'function') scoped[method](message)
      else fallback(`${prefix} ${message}`)
    } catch {
      // Logging must never become the failure.
    }
  }
  return {
    info: safe('info', console.info.bind(console)),
    warn: safe('warn', console.warn.bind(console)),
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config] - profile configuration; no field is required.
 */
export function apply (ctx, config) {
  try {
    if (!ctx || typeof ctx.inject !== 'function') return
    ctx.inject(['webServer'], (hostCtx) => {
      try {
        mount(ctx, hostCtx)
      } catch (error) {
        logger(ctx).warn(`not mounting: ${message(error)}`)
      }
    })
  } catch (error) {
    logger({}).warn(`apply failed: ${message(error)}`)
  }
}

function mount (ctx, hostCtx) {
  const log = logger(ctx)
  const paths = resolvePaths(ctx)
  const store = new HappyCodeStore({
    dataDir: paths.dataDir,
    sessionsRoot: paths.sessionsRoot,
    projcacheRoot: paths.projcacheRoot,
    logger: log,
  })

  hostCtx.effect(() => {
    const disposeRoutes = mountRoutes(hostCtx.webServer, store, { logger: log })
    // First index runs in the background: the host must finish booting, and
    // the popup reads whatever the cache already holds.
    void store.load()
      .then(() => store.refresh())
      .then(result => {
        log.info(`indexed ${result.scanned} session(s) in ${result.durationMs}ms (${result.parsed} parsed, ${result.reused} reused, ${result.failed} failed)`)
      })
      .catch(error => log.warn(`initial index failed: ${message(error)}`))

    return () => {
      try { disposeRoutes() } catch (error) { log.warn(`dispose failed: ${message(error)}`) }
    }
  }, 'dsh-happycode: http routes')

  log.info(`serving /dsh-happycode/api from ${paths.dataDir}`)
}

function message (error) {
  return error && error.message ? error.message : String(error)
}
