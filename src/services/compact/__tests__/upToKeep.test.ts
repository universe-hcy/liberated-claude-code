import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import type { Message } from '../../../types/message.js'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)

// Dynamic: the mocks above must be registered before compact.ts loads.
const { selectUpToMessagesToKeep } = await import('../compact.js')

const m = (uuid: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', uuid, ...extra }) as unknown as Message

describe('selectUpToMessagesToKeep', () => {
  test('keeps digests after the pivot, strips boundaries, summaries, progress', () => {
    const all = [
      m('before'),
      m('pivot', { type: 'user' }),
      m('old-boundary', { type: 'system', subtype: 'compact_boundary' }),
      m('old-summary', { type: 'user', isCompactSummary: true }),
      m('digest', {
        type: 'user',
        isCompactSummary: true,
        isDigestSummary: true,
      }),
      m('progress', { type: 'progress' }),
      m('after'),
    ]
    expect(selectUpToMessagesToKeep(all, 1).map(x => String(x.uuid))).toEqual([
      'pivot',
      'digest',
      'after',
    ])
  })
})
