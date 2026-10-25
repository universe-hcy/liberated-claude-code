import { describe, expect, test } from 'bun:test'
import { layoutContextGauge } from '../contextGauge'

const render = (input: Parameters<typeof layoutContextGauge>[0]) => {
  const runs = layoutContextGauge(input)
  return { runs, text: runs.map(r => r.text).join('') }
}

describe('layoutContextGauge', () => {
  test('fills exactly the requested width with percent, threshold, and window labels', () => {
    const { text } = render({
      width: 100,
      percent: 3,
      contextWindow: 1_000_000,
      thresholdPercent: 95,
    })
    expect([...text].length).toBe(100)
    expect(text.endsWith('1M─')).toBe(true)
    expect(text.indexOf('3%')).toBeLessThan(text.indexOf('┃'))
    expect(text.indexOf('┃')).toBeLessThan(text.indexOf('1M'))
  })

  test('used share scales to cells left of the window label', () => {
    const { runs } = render({
      width: 100,
      percent: 50,
      contextWindow: 200_000,
      thresholdPercent: null,
    })
    // scale = 100 - "200K".length - 1 = 95 → round(47.5) = 48 lit cells; label follows the fill edge
    const used = runs
      .filter(r => r.kind === 'used')
      .reduce((n, r) => n + r.text.length, 0)
    expect(used).toBe(48)
    expect(runs[1]).toEqual({ kind: 'percent', text: '50%' })
  })

  test('percent label moves off the threshold marker instead of hiding it', () => {
    const { text } = render({
      width: 100,
      percent: 83,
      contextWindow: 200_000,
      thresholdPercent: 83.5,
    })
    expect(text).toContain('┃')
    expect(text).toContain('83%')
  })

  test('usage over the window clamps the bar and puts the percent after the window label', () => {
    const { runs, text } = render({
      width: 60,
      percent: 130,
      contextWindow: 200_000,
      thresholdPercent: 83.5,
    })
    expect(text.endsWith('200K─130%')).toBe(true)
    expect(runs.at(-1)!.kind).toBe('overflow')
    const windowIdx = runs.findIndex(r => r.kind === 'window')
    expect(runs.slice(0, windowIdx).some(r => r.kind === 'unused')).toBe(false)
  })

  test('unknown usage omits the percent but keeps the window label', () => {
    const { runs } = render({
      width: 60,
      percent: null,
      contextWindow: 1_000_000,
      thresholdPercent: 95,
    })
    expect(runs.some(r => r.kind === 'percent')).toBe(false)
    expect(runs.find(r => r.kind === 'window')!.text).toBe('1M')
  })

  test('too narrow for labels draws a bare rule', () => {
    const { text } = render({
      width: 6,
      percent: 3,
      contextWindow: 1_000_000,
      thresholdPercent: 95,
    })
    expect(text).toBe('──────')
  })

  test('unknown window draws an unlit rule', () => {
    const { runs } = render({
      width: 20,
      percent: 10,
      contextWindow: 0,
      thresholdPercent: null,
    })
    expect(runs).toEqual([{ kind: 'unused', text: '─'.repeat(20) }])
  })
})
