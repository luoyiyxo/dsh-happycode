/**
 * Host-entry tests: the cordis side must never throw on the boot path, must
 * degrade to "no routes" when the host does not publish a web server, and must
 * hand the host one route per path.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { apply, name } from '../lib/index.js'

function fakeCordis (services) {
  const effects = []
  const context = {
    get: key => services[key],
    logger: () => ({ warn () {}, info () {} }),
    inject (deps, callback) {
      for (const dep of deps) {
        if (services[dep] === undefined) return
      }
      const scoped = {
        ...context,
        // cordis runs the effect body immediately and keeps what it returns.
        effect (fn, label) {
          const dispose = fn()
          effects.push({ label, dispose })
          return dispose
        },
        webServer: services.webServer,
      }
      callback(scoped)
    },
    effect (fn) {
      const dispose = fn()
      effects.push({ dispose })
      return dispose
    },
  }
  return { context, effects }
}

test('the module exports the plugin name', () => {
  assert.equal(name, 'dsh-happycode')
})

test('apply survives an empty host context', () => {
  assert.doesNotThrow(() => apply({}, {}))
  assert.doesNotThrow(() => apply(undefined, undefined))
  assert.doesNotThrow(() => apply({ inject: () => { throw new Error('nope') } }, {}))
})

test('apply waits for the web server and registers one route per path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-host-'))
  const profileDir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })

  const routes = []
  const { context, effects } = fakeCordis({
    webServer: {
      register (route) {
        routes.push(route)
        return () => {}
      },
    },
    profileContext: { name: 'desktop', dir: profileDir },
  })
  context.get = key => (key === 'profileContext' ? { name: 'desktop', dir: profileDir } : undefined)

  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    apply(context, {})
    assert.equal(effects.length, 1, 'one effect owns the routes')
    assert.deepEqual(routes.map(route => route.path).sort(), [
      '/dsh-happycode/api/graph',
      '/dsh-happycode/api/refresh',
      '/dsh-happycode/api/settings',
      '/dsh-happycode/api/status',
    ])
    assert.ok(routes.every(route => route.kind === 'exact'))
    assert.ok(routes.every(route => typeof route.handler === 'function'))

    // Disposal must not throw even though the index never ran.
    const dispose = effects[0].dispose
    assert.equal(typeof dispose, 'function')
    assert.doesNotThrow(() => dispose())
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('a host without a web server never calls the mount', () => {
  const { context, effects } = fakeCordis({})
  apply(context, {})
  assert.equal(effects.length, 0)
})
