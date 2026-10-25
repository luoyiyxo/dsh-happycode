/**
 * Server-side tests: decoding, counting, caching, windows, levels and routes.
 *
 * Fixtures are synthetic session logs written in the real on-disk shape —
 * concatenated checksummed Zstandard frames, one per append batch.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import zlib from 'node:zlib'

import { analyzeSessionText, dayKey, DEFAULT_EDIT_TOOLS } from '../lib/aggregate.js'
import { computeThresholds, levelOf } from '../lib/levels.js'
import { resolveDshHome, resolveProfile, resolvePaths, isProfileName } from '../lib/paths.js'
import { mountRoutes } from '../lib/routes.js'
import { HappyCodeStore, pickGeneration } from '../lib/store.js'
import { decodeFrames, scanFrames, parseJsonl } from '../lib/zstd.js'

// ------------------------------------------------------------------ fixtures

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

function frame (text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM)
}

function at (year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0).getTime()
}

function sessionHeader (id, createdAt) {
  return { type: 'session', version: 4, id, createdAt, cwd: 'C:\\work', isSeeded: false, delegationDepth: 0 }
}

function userMessage (time, id, kind = 'user') {
  return { type: 'user/message', seq: 1, time, data: { content: [{ type: 'text', text: 'hi' }], source: kind === null ? undefined : { kind }, role: 'user', id } }
}

function toolCall (time, name, id = 'call_' + Math.random().toString(16).slice(2)) {
  return { type: 'tool/call', seq: 2, time, data: { turn: 1, step: 1, callId: id, name, arguments: '{}' } }
}

function writeSession (sessionsRoot, slug, id, events, options = {}) {
  const dir = path.join(sessionsRoot, slug, id)
  fs.mkdirSync(dir, { recursive: true })
  const header = options.header || sessionHeader(id, events.length > 0 ? events[0].time : at(2026, 1, 1))
  const lines = [JSON.stringify(header), ...events.map(event => JSON.stringify(event))]
  const frames = []
  // one frame for the header, then up to two rows per frame
  frames.push(frame(lines[0]))
  for (let index = 1; index < lines.length; index += 2) {
    frames.push(frame(lines.slice(index, index + 2).join('\n') + '\n'))
  }
  const file = path.join(dir, options.name || 'session.v4.jsonl.zstd')
  const buffer = Buffer.concat(frames)
  // A corrupt artifact keeps a valid magic number but carries a reserved block
  // type, which the frame scanner must reject rather than treat as a torn tail.
  const corrupt = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x06, 0x00, 0x00])
  fs.writeFileSync(file, options.corrupt === true ? corrupt : buffer)
  return dir
}

function tempRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-test-'))
}

function makeStore (overrides = {}) {
  const root = tempRoot()
  const store = new HappyCodeStore({
    dataDir: path.join(root, 'data'),
    sessionsRoot: path.join(root, 'sessions'),
    projcacheRoot: path.join(root, 'projcache'),
    logger: { info () {}, warn () {} },
    ...overrides,
  })
  return { store, root }
}

// -------------------------------------------------------------------- decode

test('zstd: scans concatenated frames and tolerates a torn tail', () => {
  const a = frame('{"a":1}\n')
  const b = frame('{"b":2}\n')
  const whole = Buffer.concat([a, b])
  assert.equal(scanFrames(whole).frames.length, 2)
  assert.equal(decodeFrames(whole).text, '{"a":1}\n{"b":2}\n')

  const torn = Buffer.concat([a, b.subarray(0, Math.max(1, b.length - 5))])
  const decoded = decodeFrames(torn)
  assert.equal(decoded.torn, true)
  assert.equal(decoded.text, '{"a":1}\n')
})

test('zstd: rejects a corrupt frame instead of guessing', () => {
  const broken = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from([0x18, 0, 0, 0])])
  assert.throws(() => decodeFrames(broken))
})

test('jsonl: skips unreadable rows and keeps the rest', () => {
  const rows = [...parseJsonl('{"a":1}\nnot json\n\n{"b":2}\n')]
  assert.equal(rows.length, 2)
})

// ------------------------------------------------------------------ counting

test('counting: only real user prompts count as turns', () => {
  const time = at(2026, 10, 24)
  const text = [
    JSON.stringify(sessionHeader('s1', time)),
    JSON.stringify(userMessage(time, 'm1', 'user')),
    JSON.stringify(userMessage(time, 'm2', 'runtime-context')),
    JSON.stringify(userMessage(time, 'm3', 'skill-catalog')),
    JSON.stringify(userMessage(time, 'm4', 'time-context')),
    JSON.stringify(toolCall(time, 'edit')),
    JSON.stringify(toolCall(time, 'pwsh')),
    JSON.stringify(toolCall(time, 'read')),
  ].join('\n')

  const result = analyzeSessionText(text)
  const day = result.days[dayKey(time)]
  assert.deepEqual(day, { m: 1, t: 3, f: 1 })
})

test('counting: a missing source is treated as a prompt (older logs)', () => {
  const time = at(2026, 10, 24)
  const text = [
    JSON.stringify(sessionHeader('s1', time)),
    JSON.stringify(userMessage(time, 'm1', null)),
  ].join('\n')
  assert.equal(analyzeSessionText(text).days[dayKey(time)].m, 1)
})

test('counting: sub-agent sessions contribute nothing', () => {
  const time = at(2026, 10, 24)
  const text = [
    JSON.stringify({ ...sessionHeader('s1', time), delegationDepth: 2 }),
    JSON.stringify(userMessage(time, 'm1')),
    JSON.stringify(toolCall(time, 'edit')),
  ].join('\n')
  const result = analyzeSessionText(text)
  assert.equal(Object.keys(result.days).length, 0)
})

test('counting: the default edit tools cover the write family', () => {
  assert.deepEqual([...DEFAULT_EDIT_TOOLS].sort(), ['apply_patch', 'edit', 'multi_edit', 'patch', 'str_replace_editor', 'write'])
})

// -------------------------------------------------------------------- levels

test('levels: fewer than eight active days falls back to fixed thresholds', () => {
  assert.deepEqual(computeThresholds([1, 2, 3]), [9, 19, 39])
  assert.deepEqual(computeThresholds([]), [9, 19, 39])
})

test('levels: quartiles split a healthy distribution', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  const thresholds = computeThresholds(values)
  assert.equal(thresholds.length, 3)
  assert.ok(thresholds[0] < thresholds[1] && thresholds[1] < thresholds[2])
  assert.equal(levelOf(0, thresholds), 0)
  assert.equal(levelOf(1, thresholds), 1)
  assert.equal(levelOf(1000, thresholds), 4)
})

test('levels: tied quartiles fall back instead of producing an empty bucket', () => {
  const values = new Array(20).fill(1)
  assert.deepEqual(computeThresholds(values), [9, 19, 39])
})

// --------------------------------------------------------------------- store

test('store: aggregates a session and reuses it on the next pass', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const time = at(2026, 10, 24)
  writeSession(sessionsRoot, '--C-work--', 'session-a', [
    userMessage(time, 'm1'),
    toolCall(time, 'write'),
    toolCall(time, 'pwsh'),
  ])

  await store.load()
  const first = await store.refresh()
  assert.equal(first.scanned, 1)
  assert.equal(first.parsed, 1)

  const graph = store.graph({ year: 2026 })
  assert.equal(graph.total, 1 + 2 + 3, '1 turn + 2 calls (one of them a write) + 3 for the edit')
  assert.equal(graph.days.length, 1)
  assert.equal(graph.days[0].date, '2026-10-24')
  assert.equal(graph.availableYears[0], 2026)

  const second = await store.refresh()
  assert.equal(second.parsed, 0)
  assert.equal(second.reused, 1)
})

test('store: a changed file is reparsed and an unchanged one is not', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const time = at(2026, 10, 24)
  writeSession(sessionsRoot, '--C-work--', 'session-a', [userMessage(time, 'm1')])
  const b = writeSession(sessionsRoot, '--C-work--', 'session-b', [toolCall(time, 'read')])

  await store.load()
  await store.refresh()
  assert.equal(store.graph({ year: 2026 }).total, 2)

  // Rewrite b with more events and a bumped mtime.
  fs.rmSync(b, { recursive: true, force: true })
  writeSession(sessionsRoot, '--C-work--', 'session-b', [toolCall(time, 'read'), toolCall(time, 'edit')])
  const stamp = new Date(Date.now() + 5000)
  fs.utimesSync(path.join(b, 'session.v4.jsonl.zstd'), stamp, stamp)

  const again = await store.refresh()
  assert.equal(again.parsed, 1)
  assert.equal(again.reused, 1)
  assert.equal(store.graph({ year: 2026 }).total, 1 + 2 + 3, '1 turn, then two calls of which one is an edit')
})

test('store: a deleted session is subtracted from the aggregate', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const time = at(2026, 10, 24)
  const dir = writeSession(sessionsRoot, '--C-work--', 'session-a', [userMessage(time, 'm1')])
  writeSession(sessionsRoot, '--C-work--', 'session-b', [userMessage(time, 'm2')])
  await store.load()
  await store.refresh()
  assert.equal(store.graph({ year: 2026 }).total, 2)

  fs.rmSync(dir, { recursive: true, force: true })
  await store.refresh({ force: true })
  assert.equal(store.graph({ year: 2026 }).total, 1)
})

test('store: a corrupt log is skipped and the rest still count', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const time = at(2026, 10, 24)
  writeSession(sessionsRoot, '--C-work--', 'session-good', [userMessage(time, 'm1')])
  writeSession(sessionsRoot, '--C-work--', 'session-bad', [userMessage(time, 'm2')], { corrupt: true })

  await store.load()
  const result = await store.refresh()
  assert.equal(result.failed, 1)
  assert.equal(store.graph({ year: 2026 }).total, 1)
  assert.equal(store.status().errors.length, 1)
})

test('store: a blank session from the projection cache is never decoded', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const projcacheRoot = path.join(root, 'projcache')
  fs.mkdirSync(projcacheRoot, { recursive: true })
  const time = at(2026, 10, 24)
  // Garbage bytes: if the store tried to decode this it would record an error.
  const dir = path.join(sessionsRoot, '--C-work--', 'session-blank')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not zstd at all'))
  fs.writeFileSync(path.join(projcacheRoot, 'session-blank.json'), JSON.stringify({
    record: {
      identity: { createdAt: time },
      rows: { sessionListMetadata: { val: { blank: true } } },
    },
  }))

  await store.load()
  const result = await store.refresh()
  assert.equal(result.failed, 0)
  assert.equal(store.status().errors.length, 0)
  assert.equal(store.graph({ year: 2026 }).total, 0)
})

test('store: picks the highest canonical generation', () => {
  assert.equal(pickGeneration(['session.v3.jsonl.zstd', 'session.v4.jsonl.zstd', 'session.v2.jsonl']), 'session.v4.jsonl.zstd')
  assert.equal(pickGeneration(['session.jsonl.zstd', 'session.v4.jsonl']), 'session.v4.jsonl')
  assert.equal(pickGeneration(['session.v4.jsonl', 'session.v4.jsonl.zstd']), 'session.v4.jsonl.zstd')
  assert.equal(pickGeneration(['notes.txt']), null)
})

test('store: weights are applied to totals and levels', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const time = at(2026, 10, 24)
  writeSession(sessionsRoot, '--C-work--', 'session-a', [
    userMessage(time, 'm1'),
    toolCall(time, 'edit'),
  ])
  await store.load()
  await store.refresh()
  assert.equal(store.graph({ year: 2026 }).total, 1 + 1 + 3, 'one turn and one edit')

  await store.updateSettings({ weights: { m: 10, t: 1, f: 0 } })
  assert.equal(store.graph({ year: 2026 }).total, 10 + 1 + 0)
  assert.equal(store.settings.weights.m, 10)
  assert.equal(store.settings.weights.f, 0)
})

test('store: persisted settings and cache survive a restart', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  writeSession(sessionsRoot, '--C-work--', 'session-a', [userMessage(at(2026, 10, 24), 'm1')])
  await store.load()
  await store.refresh()
  await store.updateSettings({ weights: { m: 4, t: 1, f: 3 } })

  const reopened = new HappyCodeStore({
    dataDir: path.join(root, 'data'),
    sessionsRoot,
    projcacheRoot: path.join(root, 'projcache'),
    logger: { info () {}, warn () {} },
  })
  await reopened.load()
  assert.equal(reopened.settings.weights.m, 4)
  assert.equal(reopened.graph({ year: 2026 }).total, 4, 'the cached day map is reused before any refresh')

  const result = await reopened.refresh()
  assert.equal(result.reused, 1)
})

test('store: an incompatible cache schema is rebuilt, not trusted', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  writeSession(sessionsRoot, '--C-work--', 'session-a', [userMessage(at(2026, 10, 24), 'm1')])
  await store.load()
  await store.refresh()

  const dailyFile = path.join(root, 'data', 'daily.json')
  const payload = JSON.parse(fs.readFileSync(dailyFile, 'utf8'))
  payload.schemaVersion = 1
  fs.writeFileSync(dailyFile, JSON.stringify(payload))
  fs.writeFileSync(path.join(root, 'data', 'sessions.json'), JSON.stringify({ schemaVersion: 1, sessions: {} }))

  const reopened = new HappyCodeStore({
    dataDir: path.join(root, 'data'),
    sessionsRoot,
    projcacheRoot: path.join(root, 'projcache'),
    logger: { info () {}, warn () {} },
  })
  await reopened.load()
  const result = await reopened.refresh()
  assert.equal(result.parsed, 1, 'a stale schema forces a reparse')
  assert.equal(reopened.graph({ year: 2026 }).total, 1)
})

// ------------------------------------------------------------------- windows

test('graph: by-year window covers Jan 1 to Dec 31', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  writeSession(sessionsRoot, '--C-work--', 'session-a', [
    userMessage(at(2025, 12, 31, 23)),
    userMessage(at(2026, 1, 1, 0)),
    userMessage(at(2026, 12, 31, 23)),
  ])
  await store.load()
  await store.refresh()

  const graph = store.graph({ year: 2026 })
  assert.equal(graph.mode, 'year')
  assert.equal(graph.start, '2026-01-01')
  assert.equal(graph.end, '2026-12-31')
  assert.equal(graph.total, 2)
  assert.deepEqual(graph.days.map(day => day.date), ['2026-01-01', '2026-12-31'])
})

test('graph: the rolling window ends today and spans 365 days', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const now = new Date(2026, 9, 25, 15, 0, 0)
  writeSession(sessionsRoot, '--C-work--', 'session-a', [
    userMessage(at(2025, 10, 25)),
    userMessage(at(2025, 10, 26)),
    userMessage(at(2026, 10, 25)),
    userMessage(at(2026, 10, 26)),
  ])
  await store.load()
  await store.refresh()

  const graph = store.graph({ range: 'last365', now })
  assert.equal(graph.mode, 'last365')
  assert.equal(graph.start, '2025-10-26')
  assert.equal(graph.end, '2026-10-25')
  assert.equal(graph.total, 2, 'days outside the window are excluded')
})

test('graph: the current year is always listed, and older years roll out (R5)', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  writeSession(sessionsRoot, '--C-work--', 'session-a', [
    userMessage(at(2022, 5, 5)),
    userMessage(at(2023, 5, 5)),
    userMessage(at(2024, 5, 5)),
    userMessage(at(2025, 5, 5)),
  ])
  await store.load()
  await store.refresh()

  // The current year keeps a button even while it has no activity of its own.
  assert.deepEqual(store.availableYears(new Date(2026, 9, 25)), [2026, 2025, 2024])
  // Far enough ahead, the fixed three-year window rolls the old years out.
  assert.deepEqual(store.availableYears(new Date(2028, 0, 1)), [2028, 2025, 2024])

  // Once the newer years have activity they take the newest slots.
  writeSession(sessionsRoot, '--C-work--', 'session-b', [
    userMessage(at(2026, 5, 5)),
    userMessage(at(2027, 5, 5)),
  ])
  await store.refresh()
  assert.deepEqual(store.availableYears(new Date(2027, 1, 1)), [2027, 2026, 2025])

  writeSession(sessionsRoot, '--C-work--', 'session-c', [userMessage(at(2028, 5, 5))])
  await store.refresh()
  assert.deepEqual(store.availableYears(new Date(2029, 1, 1)), [2029, 2028, 2027])
})

test('graph: no data at all still lists the current year and reports the empty state', async () => {
  const { store } = makeStore()
  await store.load()
  await store.refresh()
  const graph = store.graph({ year: 2026, now: new Date(2026, 9, 25) })
  assert.deepEqual(graph.availableYears, [2026])
  assert.equal(graph.total, 0)
  assert.equal(graph.meta.anyActivity, false)
  assert.deepEqual(graph.days, [])
})

test('graph: firstActivity is the earliest active day (R11)', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  writeSession(sessionsRoot, '--C-work--', 'session-a', [
    userMessage(at(2026, 10, 24)),
    userMessage(at(2025, 3, 2)),
  ])
  await store.load()
  await store.refresh()

  assert.deepEqual(store.graph({ year: 2026 }).firstActivity, { date: '2025-03-02', source: 'activity' })
  // It is a machine-wide anchor, not a per-year one.
  assert.deepEqual(store.graph({ year: 2025 }).firstActivity, { date: '2025-03-02', source: 'activity' })
})

test('graph: firstActivity falls back to the first session, and to null without one', async () => {
  const { store, root } = makeStore()
  const sessionsRoot = path.join(root, 'sessions')
  const createdAt = at(2026, 10, 6)
  writeSession(sessionsRoot, '--C-work--', 'session-blank', [], {
    header: sessionHeader('session-blank', createdAt),
  })
  await store.load()
  await store.refresh()

  const graph = store.graph({ year: 2026 })
  assert.equal(graph.total, 0)
  assert.deepEqual(graph.firstActivity, { date: '2026-10-06', source: 'session' })

  const empty = makeStore()
  await empty.store.load()
  await empty.store.refresh()
  assert.equal(empty.store.graph({ year: 2026 }).firstActivity, null)
})

// -------------------------------------------------------------------- routes

async function withServer (store, run) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname
    const handler = handlers.get(pathname)
    if (handler === undefined) {
      response.writeHead(404).end()
      return
    }
    void handler(request, response)
  })
  const handlers = new Map()
  const webServer = {
    register (route) {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  }
  const dispose = mountRoutes(webServer, store, { logger: { warn () {}, info () {} } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await run({ port, dispose, handlers })
  } finally {
    dispose()
    await new Promise(resolve => server.close(resolve))
  }
}

test('routes: graph answers JSON for both windows', async () => {
  const { store, root } = makeStore()
  writeSession(path.join(root, 'sessions'), '--C-work--', 'session-a', [userMessage(at(2026, 10, 24), 'm1')])
  await store.load()
  await store.refresh()

  await withServer(store, async ({ port }) => {
    const year = await (await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/graph?year=2026`)).json()
    assert.equal(year.mode, 'year')
    assert.equal(year.year, 2026)
    assert.equal(year.total, 1)

    const rolling = await (await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/graph?range=last365`)).json()
    assert.equal(rolling.mode, 'last365')

    const bad = await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/graph?range=nope`)
    assert.equal(bad.status, 400)

    const status = await (await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/status`)).json()
    assert.equal(status.sessions, 1)
  })
})

test('routes: settings round-trip and refusals', async () => {
  const { store } = makeStore()
  await store.load()

  await withServer(store, async ({ port }) => {
    const initial = await (await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/settings`)).json()
    assert.deepEqual(initial.weights, { m: 1, t: 1, f: 3 })

    const saved = await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weights: { m: 2, t: 3, f: 4 } }),
    })
    assert.equal(saved.status, 200)
    assert.deepEqual((await saved.json()).weights, { m: 2, t: 3, f: 4 })

    const invalid = await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ weights: { m: -1 } }),
    })
    assert.equal(invalid.status, 400)

    const hostile = await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ weights: { m: 1 } }),
    })
    assert.equal(hostile.status, 403, 'a cross-origin write is refused')
  })
})

test('routes: refresh picks up new sessions, and only re-decodes on request', async () => {
  const { store, root } = makeStore()
  await store.load()
  await store.refresh()

  await withServer(store, async ({ port }) => {
    writeSession(path.join(root, 'sessions'), '--C-work--', 'session-late', [userMessage(at(2026, 10, 24), 'm1')])
    const response = await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/refresh`, { method: 'POST', body: '{}' })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.parsed, 1, 'the new session is decoded')
    assert.equal(payload.status.sessions, 1)
    assert.equal(store.graph({ year: 2026 }).total, 1)

    // Nothing changed: an ordinary refresh must reuse every cached session.
    const again = await (await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/refresh`, { method: 'POST', body: '{}' })).json()
    assert.equal(again.parsed, 0)
    assert.equal(again.reused, 1)

    // `force` re-decodes on purpose, for diagnostics.
    const forced = await (await fetch(`http://127.0.0.1:${port}/dsh-happycode/api/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    })).json()
    assert.equal(forced.parsed, 1)
  })
})

// --------------------------------------------------------------------- paths

test('paths: home and profile resolution', () => {
  assert.equal(resolveDshHome(undefined, { HOME: 'x', USERPROFILE: 'C:\\Users\\me' }), path.resolve(os.homedir(), '.dsh'))
  assert.equal(resolveDshHome('D:\\custom', {}), path.resolve('D:\\custom'))
  assert.equal(resolveDshHome('   ', { DSH_HOME: 'D:\\env' }), path.resolve('D:\\env'))

  assert.equal(isProfileName('desktop'), true)
  assert.equal(isProfileName('..'), false)
  assert.equal(isProfileName('a/b'), false)

  const fromContext = resolveProfile({ get: () => ({ name: 'desktop', dir: 'D:\\profiles\\desktop' }) })
  assert.deepEqual(fromContext, { name: 'desktop', dir: path.resolve('D:\\profiles\\desktop') })

  const withFlag = resolvePaths({ get: () => undefined }, { DSH_HOME: 'D:\\home' }, ['node', 'dsh', '--profile', 'web'])
  assert.equal(withFlag.profile, 'web')
  assert.equal(withFlag.profileDir, path.join(path.resolve('D:\\home'), 'profiles', 'web'))
  assert.equal(withFlag.dataDir, path.join(path.resolve('D:\\home'), 'profiles', 'web', '.dsh-happycode'))
})
