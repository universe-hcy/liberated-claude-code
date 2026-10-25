import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { AppState } from '../../../state/AppState.js'
import type { Message } from '../../../types/message.js'
import {
  getPushStackMirror,
  type PushMarker,
  projectResumedPushStack,
  prunePushMarkersAfterCompaction,
  setPushStackMirror,
} from '../state.js'

const uuid = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` as UUID
const marker = (id: string, n: number): PushMarker => ({
  id,
  messageUuid: uuid(n),
  note: id,
  timestamp: 0,
  anchorPreview: '',
})
const msg = (n: number) =>
  ({ type: 'assistant', uuid: uuid(n) }) as unknown as Message
const boundary = (n: number) =>
  ({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: uuid(n),
  }) as unknown as Message

function makeContext(stack: PushMarker[], agentId?: string) {
  let state = { pushStack: stack } as unknown as AppState
  const notifications: { key: string; text: string }[] = []
  return {
    ctx: {
      agentId,
      getAppState: () => state,
      setAppState: (f: (prev: AppState) => AppState) => {
        state = f(state)
      },
      addNotification: (n: { key: string; text: string }) => {
        notifications.push(n)
      },
    } as unknown as Parameters<typeof prunePushMarkersAfterCompaction>[0],
    getStack: () => state.pushStack,
    notifications,
  }
}

describe('getPushStackMirror', () => {
  test('only the main thread sees the stack', () => {
    setPushStackMirror([marker('a', 1)])
    expect(getPushStackMirror(undefined).map(m => m.id)).toEqual(['a'])
    expect(
      getPushStackMirror(
        'sub@agent' as Parameters<typeof getPushStackMirror>[0],
      ),
    ).toEqual([])
    setPushStackMirror([])
  })
})

describe('prunePushMarkersAfterCompaction', () => {
  test('full compaction drops every marker, updates mirror, notifies', () => {
    const { ctx, getStack, notifications } = makeContext([
      marker('a', 1),
      marker('b', 2),
    ])
    // Post-full-compact: boundary + fresh summary only, no old uuids.
    const dropped = prunePushMarkersAfterCompaction(ctx, [
      boundary(10),
      msg(11),
    ])
    expect(dropped).toBe(2)
    expect(getStack()).toEqual([])
    expect(getPushStackMirror(undefined)).toEqual([])
    expect(notifications).toHaveLength(1)
    expect(notifications[0]!.text).toContain('Removed 2 push point(s)')
  })

  test('partial up_to keeps markers whose anchor survived', () => {
    const { ctx, getStack, notifications } = makeContext([
      marker('old', 1),
      marker('kept', 3),
    ])
    const dropped = prunePushMarkersAfterCompaction(
      ctx,
      [boundary(10), msg(11), msg(3), msg(4)],
      'Reason.',
    )
    expect(dropped).toBe(1)
    expect(getStack().map(m => m.id)).toEqual(['kept'])
    expect(notifications[0]!.text.startsWith('Reason. Removed 1')).toBe(true)
  })

  test('no-op (no notification) when nothing is stale', () => {
    const { ctx, notifications } = makeContext([marker('a', 1)])
    expect(prunePushMarkersAfterCompaction(ctx, [msg(1)])).toBe(0)
    expect(notifications).toEqual([])
  })

  test('subagent contexts never touch the main stack', () => {
    const { ctx, getStack } = makeContext([marker('a', 1)], 'sub@agent')
    expect(prunePushMarkersAfterCompaction(ctx, [msg(9)])).toBe(0)
    expect(getStack().map(m => m.id)).toEqual(['a'])
  })
})

describe('projectResumedPushStack', () => {
  test('no persisted stack resumes as empty (never inherits the old one)', () => {
    expect(projectResumedPushStack(undefined, [msg(1)])).toEqual({
      pushStack: [],
      notification: undefined,
    })
  })

  test('drops markers carried off by compaction and reports it', () => {
    const { pushStack, notification } = projectResumedPushStack(
      [marker('gone', 1), marker('live', 3)],
      [msg(1), boundary(2), msg(3)],
    )
    expect(pushStack.map(m => m.id)).toEqual(['live'])
    expect(notification?.key).toBe('push-stack-resume-dropped')
    expect(
      notification && 'text' in notification && notification.text,
    ).toContain('1 push point(s)')
  })
})
