/**
 * Render a documentation preview of the dialog as SVG.
 *
 * This is a build-time documentation tool, not part of the plugin: it mirrors the
 * geometry the client bundle draws (21px cells, 3px gaps, Monday-based columns,
 * Jan–Dec labels, the profile row, the brand at the right of the title bar) so the
 * README can show the layout before a real screen recording exists. Replace the
 * output with a real screenshot after the plugin runs in DSH — see
 * docs/RELEASE-CHECKLIST.md.
 *
 * Usage: node scripts/render-preview.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'screenshots')

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const THEMES = {
  light: { l0: '#ebedf0', l1: '#9be9a8', l2: '#40c463', l3: '#30a14e', l4: '#216e39', bg: '#ffffff', text: '#1f2328', muted: '#57606a', border: 'rgba(31,35,40,.15)', brand: '#0969da', divider: 'rgba(31,35,40,.1)' },
  dark: { l0: '#161b22', l1: '#0e4429', l2: '#006d32', l3: '#26a641', l4: '#39d353', bg: '#161b22', text: '#e6edf3', muted: '#8b949e', border: 'rgba(240,246,252,.15)', brand: '#4f6ef7', divider: 'rgba(240,246,252,.1)' },
}

// Sample identity for the profile row — deliberately not a real account.
const SAMPLE = { name: 'Ada Lovelace', initial: 'A', since: 'Coding since Oct 2026' }

function addDays (date, days) {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  next.setDate(next.getDate() + days)
  return next
}

function mondayOf (date) {
  return addDays(date, -((date.getDay() + 6) % 7))
}

function dayKey (date) {
  const m = date.getMonth() + 1
  const d = date.getDate()
  return date.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d)
}

/** Contribution values for the preview: a plausible year of coding activity. */
function sampleDays (year) {
  const days = new Map()
  const start = new Date(year, 0, 1)
  const end = new Date(year, 11, 31)
  let cursor = start
  // Deterministic pseudo-random walk so the picture is stable between builds.
  let seed = 20261025
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  while (cursor.getTime() <= end.getTime()) {
    const weekday = cursor.getDay()
    const weekend = weekday === 0 || weekday === 6
    const roll = random()
    const active = roll > (weekend ? 0.55 : 0.28)
    if (active) {
      const burst = random() > 0.92 ? 40 + Math.floor(random() * 60) : 1 + Math.floor(random() * 24)
      days.set(dayKey(cursor), burst)
    }
    cursor = addDays(cursor, 1)
  }
  return days
}

function levelFor (value, thresholds) {
  if (!(value > 0)) return 0
  if (value <= thresholds[0]) return 1
  if (value <= thresholds[1]) return 2
  if (value <= thresholds[2]) return 3
  return 4
}

function thresholdsFor (values) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length < 8) return [9, 19, 39]
  const quantile = (p) => {
    const position = (sorted.length - 1) * p
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
  }
  const triple = [quantile(0.25), quantile(0.5), quantile(0.75)].map(value => Math.max(1, Math.round(value)))
  return triple[0] < triple[1] && triple[1] < triple[2] ? triple : [9, 19, 39]
}

function render (themeName, year) {
  const theme = THEMES[themeName]
  const days = sampleDays(year)
  const values = [...days.values()]
  const thresholds = thresholdsFor(values)
  const total = values.reduce((sum, value) => sum + value, 0)
  const start = new Date(year, 0, 1)
  const end = new Date(year, 11, 31)
  const columns = []
  let cursor = mondayOf(start)
  while (cursor.getTime() <= mondayOf(end).getTime()) {
    columns.push(cursor)
    cursor = addDays(cursor, 7)
  }

  // Same geometry the client computes for the 1500px dialog: 21px cells, 3px
  // gaps, a 40px weekday column, a 10px chart gap, 18px axis labels, a 90px
  // title band and the 40/36px vertical rhythm (v6).
  const CELL = 21
  const GAP = 3
  const PITCH = CELL + GAP
  const LABEL_WIDTH = 40
  const CHART_GAP = 10
  const MONTH_ROW = 22
  const PAD = 24
  const BAND = 90
  const AVATAR = 120
  const SUMMARY = 26
  const BAND_GAP = 40
  const PROFILE_GAP = 36
  const SUMMARY_GAP = 20

  const plotLeft = PAD + LABEL_WIDTH + CHART_GAP
  const plotWidth = columns.length * CELL + (columns.length - 1) * GAP
  const width = plotLeft + plotWidth + PAD
  const bodyTop = BAND
  const profileTop = bodyTop + BAND_GAP
  const summaryTop = profileTop + AVATAR + PROFILE_GAP
  const cardTop = summaryTop + SUMMARY + SUMMARY_GAP
  const gridTop = cardTop + MONTH_ROW + 2
  const gridBottom = gridTop + 7 * CELL + 6 * GAP
  const legendTop = gridBottom + 14
  const height = legendTop + CELL + PAD

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif">`)
  parts.push(`<rect width="${width}" height="${height}" rx="16" fill="${theme.bg}" stroke="${theme.border}" stroke-width="1"/>`)

  // Title band: brand centred in a 90px strip, close glyph pinned right.
  parts.push(`<text x="${width / 2}" y="${BAND / 2 + 11}" font-size="30" font-weight="600" text-anchor="middle" fill="${theme.text}">Happycoding Everyday</text>`)
  const closeSize = 28
  const closeX = width - 16 - closeSize
  parts.push(`<path d="M${closeX + 9} ${BAND / 2 - 7}l10 10M${closeX + 19} ${BAND / 2 - 7}l-10 10" stroke="${theme.muted}" stroke-width="1.4" stroke-linecap="round"/>`)

  // Profile row: 120px rounded avatar, text column bottom-aligned with it.
  parts.push(`<rect x="${PAD}" y="${profileTop}" width="${AVATAR}" height="${AVATAR}" rx="24" fill="${theme.brand}"/>`)
  parts.push(`<text x="${PAD + AVATAR / 2}" y="${profileTop + AVATAR / 2 + 17}" font-size="48" font-weight="600" text-anchor="middle" fill="#ffffff">${SAMPLE.initial}</text>`)
  const textX = PAD + AVATAR + 24
  parts.push(`<text x="${textX}" y="${profileTop + AVATAR - 28}" font-size="24" font-weight="600" fill="${theme.text}">${SAMPLE.name}</text>`)
  parts.push(`<text x="${textX}" y="${profileTop + AVATAR - 4}" font-size="16" fill="${theme.muted}">${SAMPLE.since}</text>`)

  // Total.
  parts.push(`<text x="${PAD}" y="${summaryTop + 20}" font-size="19" font-weight="600" fill="${theme.text}">${total} contributions in ${year}</text>`)

  // Month labels at the first column whose month differs from the previous one.
  let lastMonth = -1
  let lastColumn = -10
  columns.forEach((monday, index) => {
    let day = monday
    while (day.getTime() < start.getTime()) day = addDays(day, 1)
    if (day.getTime() > end.getTime()) return
    const month = day.getMonth()
    if (month === lastMonth || index - lastColumn < 3) return
    lastMonth = month
    lastColumn = index
    parts.push(`<text x="${plotLeft + index * PITCH}" y="${cardTop + MONTH_ROW - 6}" font-size="18" fill="${theme.muted}">${MONTHS[month]}</text>`)
  })

  // Weekday labels.
  for (const [label, row] of [['Mon', 0], ['Wed', 2], ['Fri', 4]]) {
    parts.push(`<text x="${PAD + LABEL_WIDTH}" y="${gridTop + row * PITCH + CELL - 4}" font-size="18" text-anchor="end" fill="${theme.muted}">${label}</text>`)
  }

  // Cells.
  columns.forEach((monday, index) => {
    for (let row = 0; row < 7; row += 1) {
      const date = addDays(monday, row)
      if (date.getTime() < start.getTime() || date.getTime() > end.getTime()) continue
      const value = days.get(dayKey(date)) || 0
      const level = levelFor(value, thresholds)
      const x = plotLeft + index * PITCH
      const y = gridTop + row * PITCH
      parts.push(`<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${level === 0 ? theme.l0 : theme['l' + level]}"/>`)
    }
  })

  // Legend: inside the card, directly under the grid, right aligned.
  const legendWidth = 30 + 5 * PITCH + 34
  const legendX = width - PAD - legendWidth
  parts.push(`<text x="${legendX}" y="${legendTop + CELL - 5}" font-size="12" fill="${theme.muted}">Less</text>`)
  for (let level = 0; level < 5; level += 1) {
    parts.push(`<rect x="${legendX + 32 + level * PITCH}" y="${legendTop}" width="${CELL}" height="${CELL}" rx="2" fill="${level === 0 ? theme.l0 : theme['l' + level]}"/>`)
  }
  parts.push(`<text x="${legendX + 32 + 5 * PITCH + 6}" y="${legendTop + CELL - 5}" font-size="12" fill="${theme.muted}">More</text>`)
  parts.push('</svg>')
  return parts.join('\n')
}

mkdirSync(OUT, { recursive: true })
for (const theme of ['light', 'dark']) {
  const file = join(OUT, `dialog-${theme}.svg`)
  writeFileSync(file, render(theme, 2026), 'utf8')
  console.log('wrote', file)
}
