import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { Message } from '../../../types/message.js'
import { planPop, popMarkersFrom } from '../popPlan.js'
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
const msg = (n: number, type: Message['type'] = 'assistant') =>
  ({ type, uuid: uuid(n) }) as unknown as Message
const isPrompt = (m: Message) => m.type === 'user'

describe('planPop', () => {
  test('empty stack', () => {
    expect(planPop([], [msg(1)], {}, isPrompt)).toEqual({
      kind: 'empty-stack',
    })
  })

  test('--to beyond the stack reports requested and depth', () => {
    expect(planPop([marker('a', 1)], [msg(1)], { to: 3 }, isPrompt)).toEqual({
      kind: 'no-marker',
      requested: 3,
      depth: 1,
    })
  })

  test('anchor missing from the active context is stale', () => {
    const plan = planPop([marker('a', 9)], [msg(1), msg(2)], {}, isPrompt)
    expect(plan.kind).toBe('stale')
  })

  test('only progress after the anchor has nothing to distill', () => {
    const plan = planPop(
      [marker('a', 1)],
      [msg(1), msg(2, 'progress')],
      {},
      isPrompt,
    )
    expect(plan.kind).toBe('nothing-to-distill')
  })

  test('plain pop pivots on marker+1 of the top marker', () => {
    const messages = [msg(1), msg(2), msg(3, 'user'), msg(4), msg(5, 'user')]
    const plan = planPop(
      [marker('a', 1), marker('b', 2)],
      messages,
      {},
      isPrompt,
    )
    expect(plan).toMatchObject({
      kind: 'branch',
      targetIdx: 1,
      pivotIndex: 2,
      pivotUuid: uuid(3),
      branchFirstPromptUuid: uuid(3),
    })
  })

  test('--to #1 targets the oldest marker; file key is first branch prompt', () => {
    const messages = [msg(1), msg(2, 'progress'), msg(3), msg(4, 'user')]
    const plan = planPop(
      [marker('a', 1), marker('b', 3)],
      messages,
      { to: 1 },
      isPrompt,
    )
    expect(plan).toMatchObject({
      kind: 'branch',
      targetIdx: 0,
      pivotIndex: 1,
      pivotUuid: uuid(2),
      branchFirstPromptUuid: uuid(4),
    })
  })

  test('branch without a user prompt has no file-history key', () => {
    const plan = planPop([marker('a', 1)], [msg(1), msg(2)], {}, isPrompt)
    expect(plan).toMatchObject({
      kind: 'branch',
      branchFirstPromptUuid: undefined,
    })
  })
})

describe('popMarkersFrom', () => {
  const stack = [marker('a', 1), marker('b', 2), marker('c', 3)]

  test('removes the marker and everything above it', () => {
    expect(popMarkersFrom(stack, 'b').map(m => m.id)).toEqual(['a'])
    expect(popMarkersFrom(stack, 'a')).toEqual([])
  })

  test('unknown id leaves the stack untouched', () => {
    expect(popMarkersFrom(stack, 'zz')).toBe(stack)
  })
})
