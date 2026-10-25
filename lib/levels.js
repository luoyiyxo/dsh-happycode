/**
 * The five-level bucket algorithm (spec §8).
 *
 * Thresholds come from the quartiles of the non-zero contribution values
 * inside the **current window** (one calendar year, or the last 365 days).
 * With fewer than eight active days, or when the quartiles collapse into each
 * other, the fixed GitHub-style thresholds are used instead.
 *
 * @module dsh-happycode/levels
 */

/** Fallback thresholds: level 1 ≤ 9 < level 2 ≤ 19 < level 3 ≤ 39 < level 4. */
export const FIXED_THRESHOLDS = Object.freeze([9, 19, 39])

/** Minimum number of active days before quartiles are trusted. */
export const MIN_QUARTILE_DAYS = 8

/**
 * Linear-interpolated quantile of an ascending array.
 * @param {number[]} sorted ascending values, non-empty.
 * @param {number} p fraction in [0, 1].
 */
function quantile (sorted, p) {
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * Bucket thresholds for a window.
 * @param {number[]} values non-zero contribution values in the window.
 * @returns {number[]} three ascending thresholds (integer).
 */
export function computeThresholds (values) {
  if (!Array.isArray(values) || values.length < MIN_QUARTILE_DAYS) return [...FIXED_THRESHOLDS]
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (sorted.length < MIN_QUARTILE_DAYS) return [...FIXED_THRESHOLDS]
  const raw = [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)]
  const rounded = raw.map(value => Math.max(1, Math.round(value)))
  // Ties make a bucket unreachable, and a non-ascending triple makes the
  // comparisons below meaningless: both fall back rather than invent a scale.
  if (!(rounded[0] < rounded[1] && rounded[1] < rounded[2])) return [...FIXED_THRESHOLDS]
  return rounded
}

/**
 * Level of one day's value.
 * @param {number} value weighted contribution (0 = no activity).
 * @param {number[]} thresholds ascending triple.
 * @returns {0|1|2|3|4}
 */
export function levelOf (value, thresholds) {
  if (!(value > 0)) return 0
  const [q1, q2, q3] = thresholds && thresholds.length === 3 ? thresholds : FIXED_THRESHOLDS
  if (value <= q1) return 1
  if (value <= q2) return 2
  if (value <= q3) return 3
  return 4
}
