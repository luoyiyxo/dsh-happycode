/**
 * The day-aggregate cache: scan, decode, aggregate, persist, serve.
 *
 * Two files live in `<profile>/.dsh-happycode/`:
 *
 *   sessions.json  per-session progress (path, size, mtime, decoded day map)
 *   daily.json     the materialised union of those day maps
 *
 * `sessions.json` keeps the per-session map so a deleted log can be subtracted
 * without rescanning anything else; `daily.json` is what the graph routes read.
 * Both carry `schemaVersion` and a time-zone signature: a mismatch discards the
 * cache and rebuilds, because a day key baked under another time zone is wrong
 * rather than merely stale.
 *
 * @module dsh-happycode/store
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

import { analyzeSessionText, dayKey, mergeDays, timeZoneSignature, valueOf, DEFAULT_EDIT_TOOLS } from './aggregate.js'
import { computeThresholds, levelOf } from './levels.js'
import { decodeFrames, zstdAvailable } from './zstd.js'

/** Bumped when a cached shape changes in a way an old file cannot satisfy. */
export const CACHE_SCHEMA_VERSION = 2
/** Bumped when `settings.json` changes shape. */
export const SETTINGS_SCHEMA_VERSION = 1

export const DEFAULT_WEIGHTS = Object.freeze({ m: 1, t: 1, f: 3 })

/** How many session files are decoded at once. */
const PARSE_CONCURRENCY = 4

/** Cap on recorded per-session errors, so one broken install cannot grow a file. */
const MAX_ERRORS = 50

/** Sessions larger than this are skipped rather than read into memory. */
const MAX_SESSION_BYTES = 512 * 1024 * 1024

/** Ordered months for the client, kept server-side so both ends agree. */
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * One cache instance per plugin mount. All methods are safe to call before
 * `load()`; they simply answer from empty state.
 */
export class HappyCodeStore {
  /**
   * @param {{ dataDir: string, sessionsRoot: string, projcacheRoot: string, logger?: {warn:Function,info:Function} }} options
   */
  constructor (options) {
    this.dataDir = options.dataDir
    this.sessionsRoot = options.sessionsRoot
    this.projcacheRoot = options.projcacheRoot
    this.logger = options.logger ?? { warn () {}, info () {} }

    this.settings = { weights: { ...DEFAULT_WEIGHTS }, editTools: [...DEFAULT_EDIT_TOOLS], updatedAt: 0 }
    this.sessions = new Map()
    this.daily = Object.create(null)
    this.builtAt = 0
    this.firstSessionAt = 0
    this.errors = []
    this.indexing = false
    this.lastError = null
    this.lastIndex = null
    this.timeZone = timeZoneSignature()

    this._inflight = null
    this._loaded = false
  }

  // ---------------------------------------------------------------- loading

  /**
   * Read persisted state. Never throws: a missing or corrupt cache is simply
   * an empty cache that the next refresh replaces.
   */
  async load () {
    if (this._loaded) return
    this._loaded = true
    this.timeZone = timeZoneSignature()

    const settings = await readJson(path.join(this.dataDir, 'settings.json'))
    if (settings && settings.schemaVersion === SETTINGS_SCHEMA_VERSION) {
      this.settings = normaliseSettings(settings)
    }

    const sessionsFile = await readJson(path.join(this.dataDir, 'sessions.json'))
    const dailyFile = await readJson(path.join(this.dataDir, 'daily.json'))
    const compatible = value => value !== null &&
      typeof value === 'object' &&
      value.schemaVersion === CACHE_SCHEMA_VERSION &&
      value.timeZone === this.timeZone

    if (compatible(sessionsFile) && sessionsFile.sessions && typeof sessionsFile.sessions === 'object') {
      for (const [id, entry] of Object.entries(sessionsFile.sessions)) {
        if (entry && typeof entry === 'object') this.sessions.set(id, entry)
      }
      this.builtAt = Number(sessionsFile.builtAt) || 0
      this.firstSessionAt = Number(sessionsFile.firstSessionAt) || 0
    }

    if (compatible(dailyFile) && dailyFile.days && typeof dailyFile.days === 'object') {
      for (const [key, row] of Object.entries(dailyFile.days)) {
        if (row && typeof row === 'object') this.daily[key] = { m: num(row.m), t: num(row.t), f: num(row.f) }
      }
      this.builtAt = this.builtAt || Number(dailyFile.builtAt) || 0
    } else if (this.sessions.size > 0) {
      // Sessions survived without their summary: rebuild it so the popup can
      // open before the next scan finishes.
      for (const entry of this.sessions.values()) {
        if (entry && entry.days) mergeDays(this.daily, entry.days)
      }
    }
  }

  // --------------------------------------------------------------- settings

  /** Persist a partial settings patch and return the stored settings. */
  async updateSettings (patch) {
    const next = normaliseSettings({
      ...this.settings,
      weights: { ...this.settings.weights, ...(patch && patch.weights) },
      editTools: Array.isArray(patch && patch.editTools) ? patch.editTools : this.settings.editTools,
      updatedAt: Date.now(),
    })
    this.settings = next
    await this._writeJson(path.join(this.dataDir, 'settings.json'), {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      ...next,
    })
    return this.settings
  }

  // --------------------------------------------------------------- indexing

  /**
   * Re-scan the session tree, reusing unchanged sessions.
   * A second call while one is running joins the running one.
   *
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ scanned: number, parsed: number, reused: number, failed: number, durationMs: number }>}
   */
  async refresh (options = {}) {
    if (this._inflight !== null) return this._inflight
    this.indexing = true
    this._inflight = this._refresh(options)
      .catch(error => {
        this.lastError = String(error && error.message ? error.message : error)
        this.logger.warn(`index build failed: ${this.lastError}`)
        // The scan itself may have succeeded; only persistence failed. Report
        // what was actually read so the caller does not claim "0 sessions".
        const partial = this.lastIndex ?? { scanned: 0, parsed: 0, reused: 0, failed: 0, durationMs: 0 }
        return { ...partial, error: this.lastError }
      })
      .finally(() => {
        this.indexing = false
        this._inflight = null
      })
    return this._inflight
  }

  async _refresh (options) {
    const started = Date.now()
    const zone = timeZoneSignature()
    if (zone !== this.timeZone) {
      // Day keys were computed under another zone; every cached map is wrong.
      this.sessions.clear()
      this.daily = Object.create(null)
      this.timeZone = zone
    }
    if (!zstdAvailable()) {
      this.logger.warn('this Node provides no zlib zstd support; compressed session logs are skipped')
    }

    const files = await listSessionFiles(this.sessionsRoot)
    const next = new Map()
    const daily = Object.create(null)
    const errors = []
    let parsed = 0
    let reused = 0
    let failed = 0
    let firstSessionAt = Number.POSITIVE_INFINITY

    const queue = files.slice()
    const workers = Array.from({ length: Math.min(PARSE_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const file = queue.shift()
        if (file === undefined) return
        const cached = this.sessions.get(file.id)
        const reusable = !options.force &&
          cached !== undefined &&
          cached.path === file.file &&
          cached.size === file.size &&
          cached.mtimeMs === file.mtimeMs &&
          cached.days !== undefined
        if (reusable) {
          reused += 1
          next.set(file.id, cached)
          mergeDays(daily, cached.days ?? {})
          if (cached.createdAt) firstSessionAt = Math.min(firstSessionAt, cached.createdAt)
          if (cached.error) errors.push({ id: file.id, message: cached.error })
          continue
        }
        parsed += 1
        const result = await parseOne(file, this.settings.editTools, this.logger, this.projcacheRoot)
        const entry = {
          id: file.id,
          path: file.file,
          size: file.size,
          mtimeMs: file.mtimeMs,
          days: result.days,
          createdAt: result.createdAt,
          ...(result.error === undefined ? {} : { error: result.error }),
        }
        next.set(file.id, entry)
        mergeDays(daily, result.days)
        if (result.createdAt) firstSessionAt = Math.min(firstSessionAt, result.createdAt)
        if (result.error !== undefined) {
          failed += 1
          if (errors.length < MAX_ERRORS) errors.push({ id: file.id, message: result.error })
        }
      }
    })
    await Promise.all(workers)

    this.sessions = next
    this.daily = daily
    this.errors = errors
    this.builtAt = Date.now()
    this.firstSessionAt = Number.isFinite(firstSessionAt) ? firstSessionAt : 0
    this.lastIndex = {
      scanned: files.length,
      parsed,
      reused,
      failed,
      durationMs: Date.now() - started,
    }

    const sessionsPayload = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      timeZone: this.timeZone,
      builtAt: this.builtAt,
      firstSessionAt: this.firstSessionAt,
      sessions: Object.fromEntries(next),
    }
    const dailyPayload = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      timeZone: this.timeZone,
      builtAt: this.builtAt,
      days: daily,
    }
    await this._writeJson(path.join(this.dataDir, 'sessions.json'), sessionsPayload)
    await this._writeJson(path.join(this.dataDir, 'daily.json'), dailyPayload)

    return this.lastIndex
  }

  /**
   * Serve from cache now, refresh in the background when it is stale.
   * @param {{ maxAgeMs?: number }} [options]
   */
  ensureFresh (options = {}) {
    const maxAgeMs = options.maxAgeMs ?? 5 * 60 * 1000
    if (this.indexing) return
    if (this.builtAt !== 0 && Date.now() - this.builtAt < maxAgeMs) return
    void this.refresh()
  }

  // ------------------------------------------------------------------ graph

  /**
   * Build one window's payload for `GET /graph`.
   *
   * @param {{ year?: number, range?: string, now?: Date }} query
   * @returns {object}
   */
  graph (query = {}) {
    const now = query.now instanceof Date ? query.now : new Date()
    const weights = this.settings.weights
    const mode = query.range === 'last365' ? 'last365' : 'year'

    let start
    let end
    let year
    if (mode === 'last365') {
      end = startOfDay(now)
      start = addDays(end, -364)
      year = undefined
    } else {
      year = clampYear(query.year, now)
      start = new Date(year, 0, 1)
      end = new Date(year, 11, 31)
    }

    const startKey = dayKey(start.getTime())
    const endKey = dayKey(end.getTime())
    const values = []
    const days = []
    let total = 0
    let activeDays = 0

    for (const key of Object.keys(this.daily)) {
      if (key < startKey || key > endKey) continue
      const row = this.daily[key]
      const value = valueOf(row, weights)
      if (value <= 0) continue
      values.push(value)
      total += value
      activeDays += 1
    }

    const thresholds = computeThresholds(values)
    for (const key of Object.keys(this.daily)) {
      if (key < startKey || key > endKey) continue
      const row = this.daily[key]
      const value = valueOf(row, weights)
      if (value <= 0) continue
      days.push({ date: key, m: row.m, t: row.t, f: row.f, value, level: levelOf(value, thresholds) })
    }
    days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

    let anyActivity = false
    for (const key of Object.keys(this.daily)) {
      const row = this.daily[key]
      if (row.m + row.t + row.f > 0) { anyActivity = true; break }
    }

    return {
      mode: mode === 'last365' ? 'last365' : 'year',
      ...(mode === 'year' ? { year } : {}),
      start: startKey,
      end: endKey,
      total,
      activeDays,
      days,
      thresholds,
      availableYears: this.availableYears(now),
      // "Coding since …" comes from here: the first day with activity, or the
      // first session when the user has not contributed yet.
      firstActivity: this.firstActivity(),
      weights: { ...weights },
      meta: {
        indexing: this.indexing,
        sessions: this.sessions.size,
        builtAt: this.builtAt,
        firstSessionAt: this.firstSessionAt,
        timeZone: this.timeZone,
        errors: this.errors.length,
        anyActivity,
      },
    }
  }

  /**
   * The earliest day this machine has any activity for — the window's own
   * "Coding since" anchor. Falls back to the earliest session's creation date,
   * and to `null` when nothing has ever been recorded.
   *
   * @returns {{ date: string, source: 'activity' | 'session' } | null}
   */
  firstActivity () {
    for (const key of Object.keys(this.daily).sort()) {
      const row = this.daily[key]
      if (row.m + row.t + row.f > 0) return { date: key, source: 'activity' }
    }
    if (this.firstSessionAt > 0) return { date: dayKey(this.firstSessionAt), source: 'session' }
    return null
  }

  /**
   * The year picker's list (R5): the current year always appears — so a new
   * year shows an empty graph instead of vanishing from the picker — unioned
   * with every year that has activity, newest first, capped at three.
   *
   * 2027 → [2027, 2026, 2025]; 2029 → [2029, 2028, 2027] once 2026 and 2027
   * have data, and `[2029]` on a machine with no history at all.
   */
  availableYears (now = new Date()) {
    const years = new Set([now.getFullYear()])
    for (const key of Object.keys(this.daily)) {
      const row = this.daily[key]
      if (row.m + row.t + row.f > 0) years.add(Number(key.slice(0, 4)))
    }
    return [...years].filter(Number.isFinite).sort((a, b) => b - a).slice(0, 3)
  }

  /** Small status payload for the settings card and diagnostics. */
  status () {
    return {
      indexing: this.indexing,
      sessions: this.sessions.size,
      builtAt: this.builtAt,
      firstSessionAt: this.firstSessionAt,
      timeZone: this.timeZone,
      days: Object.keys(this.daily).length,
      errors: this.errors.slice(0, MAX_ERRORS),
      settings: { weights: { ...this.settings.weights }, editTools: [...this.settings.editTools] },
      dataDir: this.dataDir,
      zstd: zstdAvailable(),
    }
  }

  // ------------------------------------------------------------------ files

  async _writeJson (file, payload) {
    const temporary = `${file}.${process.pid}.tmp`
    await fsp.mkdir(this.dataDir, { recursive: true })
    await fsp.writeFile(temporary, JSON.stringify(payload), 'utf8')
    await fsp.rename(temporary, file)
  }
}

// ------------------------------------------------------------------ helpers

function num (value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function clampYear (year, now) {
  const parsed = Number(year)
  if (!Number.isInteger(parsed) || parsed < 1970 || parsed > 9999) return now.getFullYear()
  return parsed
}

function normaliseSettings (input) {
  const weights = {}
  for (const field of ['m', 't', 'f']) {
    const value = input && input.weights ? input.weights[field] : undefined
    const parsed = Number(value)
    weights[field] = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1000 ? parsed : DEFAULT_WEIGHTS[field]
  }
  const tools = Array.isArray(input && input.editTools)
    ? [...new Set(input.editTools.filter(name => typeof name === 'string' && name.length > 0 && name.length < 64))]
    : [...DEFAULT_EDIT_TOOLS]
  return {
    weights,
    editTools: tools.length > 0 ? tools : [...DEFAULT_EDIT_TOOLS],
    updatedAt: Number(input && input.updatedAt) || 0,
  }
}

function startOfDay (date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays (date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

/**
 * Every `session-*` directory under the sessions root, reduced to the highest
 * canonical generation of that session.
 *
 * @returns {Promise<Array<{ id: string, file: string, size: number, mtimeMs: number }>>}
 */
export async function listSessionFiles (sessionsRoot) {
  const out = []
  let workspaces
  try {
    workspaces = await fsp.readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(sessionsRoot, workspace.name)
    let sessions
    try {
      sessions = await fsp.readdir(workspaceDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const session of sessions) {
      if (!session.isDirectory() || !session.name.startsWith('session-')) continue
      const sessionDir = path.join(workspaceDir, session.name)
      let files
      try {
        files = await fsp.readdir(sessionDir)
      } catch {
        continue
      }
      const chosen = pickGeneration(files)
      if (chosen === null) continue
      const file = path.join(sessionDir, chosen)
      let stat
      try {
        stat = await fsp.stat(file)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      out.push({ id: session.name, file, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/**
 * The highest version among `session[.vN].jsonl[.zstd]` files, preferring the
 * compressed artifact when both encodings of one version are present.
 */
export function pickGeneration (names) {
  let best = null
  for (const name of names) {
    const match = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(name)
    if (match === null) continue
    const version = match[1] === undefined ? 0 : Number(match[1])
    const compressed = match[2] === '.zstd'
    if (
      best === null ||
      version > best.version ||
      (version === best.version && compressed && !best.compressed)
    ) {
      best = { name, version, compressed }
    }
  }
  return best === null ? null : best.name
}

/** Read a projection-cache entry when it is present and readable. */
async function readProjCache (projcacheRoot, id) {
  if (!projcacheRoot) return null
  try {
    const raw = await fsp.readFile(path.join(projcacheRoot, `${id}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    const record = parsed && parsed.record
    const blank = record && record.rows && record.rows.sessionListMetadata && record.rows.sessionListMetadata.val
      ? record.rows.sessionListMetadata.val.blank === true
      : false
    const createdAt = record && record.identity && typeof record.identity.createdAt === 'number'
      ? record.identity.createdAt
      : 0
    return { blank, createdAt }
  } catch {
    return null
  }
}

async function parseOne (file, editTools, logger, projcacheRoot) {
  const meta = await readProjCache(projcacheRoot, file.id)
  const createdAt = meta && meta.createdAt ? meta.createdAt : 0
  if (meta && meta.blank) {
    // The projection cache says this session never received a prompt: nothing
    // to count, and the file need not be decompressed at all.
    return { days: Object.create(null), createdAt, events: 0 }
  }
  if (file.size > MAX_SESSION_BYTES) {
    return { days: Object.create(null), createdAt, error: `session log exceeds ${MAX_SESSION_BYTES} bytes` }
  }
  try {
    const buffer = await fsp.readFile(file.file)
    const { text, torn } = file.file.endsWith('.zstd')
      ? decodeFrames(buffer)
      : { text: buffer.toString('utf8'), torn: false }
    const { days, header, skipped } = analyzeSessionText(text, { editTools })
    const headerCreatedAt = header && typeof header.createdAt === 'number' ? header.createdAt : 0
    if (torn) logger.info(`${path.basename(file.file)} ends in an unfinished frame; counted its complete rows only`)
    if (skipped > 0) logger.info(`${path.basename(file.file)}: skipped ${skipped} unreadable row(s)`)
    return { days, createdAt: createdAt || headerCreatedAt, events: Object.keys(days).length }
  } catch (error) {
    const message = String(error && error.message ? error.message : error)
    logger.warn(`skipping ${path.basename(file.file)}: ${message}`)
    return { days: Object.create(null), createdAt, error: message }
  }
}

/** Read JSON, returning null for anything unreadable. */
async function readJson (file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return null
  }
}
