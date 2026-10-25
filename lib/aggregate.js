/**
 * Turning one decoded session log into per-day contribution counts.
 *
 * Counting rules are calibrated against real logs — see `docs/data-schema.md`:
 *
 *   message turns  = `user/message` rows whose `data.source.kind` is `user`
 *   tool calls     = `tool/call` rows
 *   file edits     = `tool/call` rows whose tool name is in the edit set
 *
 * Each counted event is attributed to a **local** calendar day via its epoch
 * millisecond `time`. The session header carries `createdAt` instead and is
 * used only for "when did this user start", never for contributions.
 *
 * @module dsh-happycode/aggregate
 */

import { parseJsonl } from './zstd.js'

/** Tools that write files. `write`/`edit` are what this host ships today. */
export const DEFAULT_EDIT_TOOLS = Object.freeze([
  'write',
  'edit',
  'str_replace_editor',
  'apply_patch',
  'multi_edit',
  'patch',
])

const PAD = ['01', '02', '03', '04', '05', '06', '07', '08', '09']

/**
 * Local-time `YYYY-MM-DD` key for an epoch-millisecond timestamp.
 * @param {number} ms
 * @returns {string}
 */
export function dayKey (ms) {
  const date = new Date(ms)
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${date.getFullYear()}-${month < 10 ? PAD[month - 1] : month}-${day < 10 ? PAD[day - 1] : day}`
}

/** A stable signature of the local time zone, used to invalidate caches. */
export function timeZoneSignature (now = new Date()) {
  let zone = ''
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch { /* keep empty */ }
  return `${zone}|${now.getTimezoneOffset()}`
}

function emptyRow () {
  return { m: 0, t: 0, f: 0 }
}

/**
 * Analyse decoded session text.
 *
 * @param {string} text - decoded JSONL.
 * @param {{ editTools?: readonly string[], onBadLine?: (line: string, index: number) => void }} [options]
 * @returns {{ days: Record<string, {m:number,t:number,f:number}>, header: object|null, events: number, skipped: number }}
 */
export function analyzeSessionText (text, options = {}) {
  const editTools = new Set(options.editTools && options.editTools.length > 0 ? options.editTools : DEFAULT_EDIT_TOOLS)
  const days = Object.create(null)
  const seenMessages = new Set()
  let header = null
  let events = 0
  let skipped = 0

  for (const event of parseJsonl(text, line => {
    skipped += 1
    if (options.onBadLine) options.onBadLine(line, skipped)
  })) {
    if (event === null || typeof event !== 'object') { skipped += 1; continue }
    events += 1
    if (event.type === 'session' && header === null) { header = event; continue }
    const time = event.time
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    const data = event.data

    if (event.type === 'user/message') {
      // Injected context (`runtime-context`, `skill-catalog`, `time-context`,
      // `user-approval`, …) arrives as user rows too; only a real prompt counts.
      const kind = data && data.source ? data.source.kind : undefined
      if (kind !== undefined && kind !== 'user') continue
      const id = data && typeof data.id === 'string' ? data.id : undefined
      if (id !== undefined) {
        if (seenMessages.has(id)) continue
        seenMessages.add(id)
      }
      add(days, time, 'm')
      continue
    }

    if (event.type === 'tool/call') {
      add(days, time, 't')
      const tool = data && typeof data.name === 'string' ? data.name : undefined
      if (tool !== undefined && editTools.has(tool)) add(days, time, 'f')
    }
  }

  // Sub-agent sessions replay the parent's activity under another id; counting
  // them would double every delegated turn.
  const depth = header && typeof header.delegationDepth === 'number' ? header.delegationDepth : 0
  return { days: depth > 0 ? Object.create(null) : days, header, events, skipped }
}

function add (days, ms, field) {
  const key = dayKey(ms)
  let row = days[key]
  if (row === undefined) {
    row = emptyRow()
    days[key] = row
  }
  row[field] += 1
}

/** Sum one day map into another (mutating `target`). */
export function mergeDays (target, source) {
  for (const key of Object.keys(source)) {
    const src = source[key]
    let dst = target[key]
    if (dst === undefined) {
      dst = emptyRow()
      target[key] = dst
    }
    dst.m += src.m
    dst.t += src.t
    dst.f += src.f
  }
  return target
}

/** Weighted contribution value of one day row. */
export function valueOf (row, weights) {
  if (row === undefined) return 0
  return row.m * weights.m + row.t * weights.t + row.f * weights.f
}
