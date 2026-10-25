import { formatTokens } from '../../utils/format.js'

/** Cell role in the context gauge; the renderer maps each to a color. */
export type ContextGaugeRunKind =
  | 'used'
  | 'unused'
  | 'percent'
  | 'overflow'
  | 'threshold'
  | 'window'

export type ContextGaugeRun = { kind: ContextGaugeRunKind; text: string }

export type ContextGaugeInput = {
  /** Gauge width in terminal cells. */
  width: number
  /** Context used as a percent of the window; null when unknown (no API response yet). */
  percent: number | null
  /** Model context window in tokens; <= 0 when unknown. */
  contextWindow: number
  /** Auto-compact trigger as a percent of the window; null when proactive autocompact is off. */
  thresholdPercent: number | null
}

export const CONTEXT_GAUGE_RULE = '─'
export const CONTEXT_GAUGE_THRESHOLD = '┃'

/** Below this width the threshold marker can't read as a position. */
const MIN_MARKER_WIDTH = 8

function formatContextGaugePercent(percent: number): string {
  return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`
}

/** `1M`, `200K`, `32.8K` — compact uppercase window label. */
function formatContextGaugeWindow(contextWindow: number): string {
  return formatTokens(contextWindow).toUpperCase()
}

/** Width the gauge needs to fit its labels, each padded by one rule cell on both sides. */
function contextGaugeLabelWidth(
  percent: number | null,
  contextWindow: number,
): number {
  const percentWidth =
    percent === null ? 0 : formatContextGaugePercent(percent).length + 2
  return percentWidth + formatContextGaugeWindow(contextWindow).length + 2
}

/**
 * Lay out the context gauge as color runs:
 * `───3%──────────┃──────1M─`
 * - used share in `used`, remainder in `unused`, scaled to the cells left of the window label;
 * - percent label rides the fill edge, nudged off the threshold marker;
 * - `┃` marks where auto-compact fires;
 * - >100% (window shrank under the usage) clamps the bar full and moves the
 *   percent past the window label as `overflow`.
 * Precedence per cell: percent > threshold > window label > rule.
 */
export function layoutContextGauge({
  width,
  percent,
  contextWindow,
  thresholdPercent,
}: ContextGaugeInput): ContextGaugeRun[] {
  if (width <= 0) return []
  if (contextWindow <= 0) {
    return [{ kind: 'unused', text: CONTEXT_GAUGE_RULE.repeat(width) }]
  }

  const clampedPct = percent === null ? 0 : Math.min(100, Math.max(0, percent))
  const overflow = percent !== null && percent > 100
  let percentLabel = ''
  let windowLabel = ''
  let percentStart = -1
  let windowStart = -1
  let scaleWidth = width
  if (width >= contextGaugeLabelWidth(percent, contextWindow)) {
    percentLabel =
      percent === null
        ? ''
        : formatContextGaugePercent(overflow ? percent : clampedPct)
    windowLabel = formatContextGaugeWindow(contextWindow)
    if (overflow) {
      percentStart = width - percentLabel.length
      windowStart = percentStart - 1 - windowLabel.length
    } else {
      windowStart = width - windowLabel.length - 1
    }
    scaleWidth = windowStart
  }

  // At least one lit cell so a fresh session still shows where the bar starts.
  const usedCount = Math.min(
    scaleWidth,
    Math.max(1, Math.round((clampedPct / 100) * scaleWidth)),
  )

  let thresholdIdx = -1
  if (thresholdPercent !== null && width >= MIN_MARKER_WIDTH) {
    thresholdIdx = Math.min(
      scaleWidth - 1,
      Math.max(0, Math.round((thresholdPercent / 100) * scaleWidth)),
    )
  }

  if (percentLabel && percentStart < 0) {
    const maxStart = scaleWidth - percentLabel.length - 1
    const preferredStart = Math.min(maxStart, Math.max(1, usedCount))
    const overlapsThreshold = (start: number): boolean =>
      thresholdIdx >= start && thresholdIdx < start + percentLabel.length
    for (let distance = 0; distance <= maxStart; distance++) {
      const left = preferredStart - distance
      if (left >= 1 && !overlapsThreshold(left)) {
        percentStart = left
        break
      }
      if (distance === 0) continue
      const right = preferredStart + distance
      if (right <= maxStart && !overlapsThreshold(right)) {
        percentStart = right
        break
      }
    }
  }

  const percentEnd = percentStart >= 0 ? percentStart + percentLabel.length : -1
  const windowEnd = windowStart >= 0 ? windowStart + windowLabel.length : -1
  const runs: ContextGaugeRun[] = []
  let i = 0
  while (i < width) {
    if (i >= percentStart && i < percentEnd) {
      runs.push({
        kind: overflow ? 'overflow' : 'percent',
        text: percentLabel.slice(i - percentStart),
      })
      i = percentEnd
    } else if (i === thresholdIdx) {
      runs.push({ kind: 'threshold', text: CONTEXT_GAUGE_THRESHOLD })
      i++
    } else {
      const inWindow = i >= windowStart && i < windowEnd
      let end = Math.min(
        inWindow ? windowEnd : i < usedCount ? usedCount : width,
        width,
      )
      if (percentStart > i && percentStart < end) end = percentStart
      if (thresholdIdx > i && thresholdIdx < end) end = thresholdIdx
      if (!inWindow && windowStart > i && windowStart < end) end = windowStart
      if (inWindow) {
        runs.push({
          kind: 'window',
          text: windowLabel.slice(i - windowStart, end - windowStart),
        })
      } else {
        runs.push({
          kind: i < usedCount ? 'used' : 'unused',
          text: CONTEXT_GAUGE_RULE.repeat(end - i),
        })
      }
      i = end
    }
  }
  return runs
}
