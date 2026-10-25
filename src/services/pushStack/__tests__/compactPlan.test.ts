import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { Message } from '../../../types/message.js'
import {
  describeStackAwareFallback,
  planStackAwareCompact,
  type StackAwareBudget,
} from '../compactPlan.js'
import type { PushMarker } from '../state.js'

const uuid = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` as UUID
const marker = (id: string, n: number): PushMarker => ({
  id,
  messageUuid: uuid(n),
  note: id,
  timestamp: 0,
  anchorPreview: '',
})
const msg = (n: number, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', uuid: uuid(n), ...extra }) as unknown as Message
const summary = (n: number, extra: Record<string, unknown> = {}) =>
  msg(n, { type: 'user', isCompactSummary: true, ...extra })
const boundary = (n: number) =>
  msg(n, { type: 'system', subtype: 'compact_boundary' })

// 1 token per message keeps the arithmetic obvious.
const budget = (threshold: number, overheadTokens = 0): StackAwareBudget => ({
  overheadTokens,
  threshold,
  estimateTokens: msgs => msgs.length,
})

describe('planStackAwareCompact', () => {
  const stack = [marker('a', 3)]

  test('partial when mainline precedes the anchor and the branch fits', () => {
    const active = [msg(1), msg(2), msg(3), msg(4)]
    expect(planStackAwareCompact(active, stack, 'a', budget(10))).toEqual({
      kind: 'partial',
      pivotIndex: 2,
    })
  })

  test('full when the marker anchor left the active context', () => {
    expect(
      planStackAwareCompact([msg(1), msg(2)], stack, 'a', budget(10)),
    ).toEqual({ kind: 'full', reason: 'stale-marker' })
    expect(
      planStackAwareCompact([msg(3)], stack, 'missing', budget(10)),
    ).toEqual({ kind: 'full', reason: 'stale-marker' })
  })

  test('full when only an earlier boundary + summary precede the anchor', () => {
    // Exactly the state after a first partial: re-running it would only
    // summarize the summary and free nothing.
    const active = [boundary(1), summary(2), msg(3), msg(4)]
    expect(planStackAwareCompact(active, stack, 'a', budget(10))).toEqual({
      kind: 'full',
      reason: 'nothing-to-compress',
    })
  })

  test('a digest before the anchor is real content to compress', () => {
    const active = [summary(2, { isDigestSummary: true }), msg(3)]
    expect(planStackAwareCompact(active, stack, 'a', budget(10)).kind).toBe(
      'partial',
    )
  })

  test('full when the kept branch plus overhead reaches the threshold', () => {
    const active = [msg(1), msg(2), msg(3), msg(4), msg(5)]
    // kept = [3,4,5] = 3 tokens; 3 + 7 overhead >= 10.
    expect(planStackAwareCompact(active, stack, 'a', budget(10, 7))).toEqual({
      kind: 'full',
      reason: 'branch-too-large',
    })
    expect(planStackAwareCompact(active, stack, 'a', budget(10, 6)).kind).toBe(
      'partial',
    )
  })
})

describe('describeStackAwareFallback', () => {
  test('names the push point and says a full compaction ran', () => {
    for (const reason of [
      'stale-marker',
      'nothing-to-compress',
      'branch-too-large',
      'stalled',
      'partial-failed',
    ] as const) {
      const text = describeStackAwareFallback(reason, 2)
      expect(text).toContain('#2')
      expect(text).toContain('compacted everything')
    }
  })
})
