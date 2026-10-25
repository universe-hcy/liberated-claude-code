import type { UUID } from 'crypto'
import type { Message } from '../../types/message.js'
import type { PopOptions, PushMarker } from './state.js'

/**
 * Pure planning step of `/pop` (REPL applyPop). Resolves the target marker and
 * slices the active context (messages after the last compact boundary) into
 * the kept mainline prefix and the discussion branch, so the side-effectful
 * REPL code only has to act on the result.
 */
export type PopPlan =
  | { kind: 'empty-stack' }
  | { kind: 'no-marker'; requested: number; depth: number }
  /** Target anchor left the active context (compaction / snip / rewind). */
  | { kind: 'stale'; targetIdx: number; marker: PushMarker }
  /** Nothing but progress noise after the push point. */
  | { kind: 'nothing-to-distill'; targetIdx: number; marker: PushMarker }
  | {
      kind: 'branch'
      targetIdx: number
      marker: PushMarker
      /** First discussion message (marker + 1); pivot for the 'from' digest. */
      pivotIndex: number
      pivotUuid: UUID
      /**
       * First user prompt inside the branch. File-history snapshots are keyed
       * by user prompt uuid, so this is the lookup key for "what did the
       * branch change on disk".
       */
      branchFirstPromptUuid: UUID | undefined
    }

export function planPop(
  stack: readonly PushMarker[],
  activeMessages: readonly Message[],
  opts: Pick<PopOptions, 'to'>,
  isUserPrompt: (m: Message) => boolean,
): PopPlan {
  if (stack.length === 0) return { kind: 'empty-stack' }

  // Plain pop → top; --to #N → markers[N-1].
  const targetIdx = opts.to !== undefined ? opts.to - 1 : stack.length - 1
  const marker = stack[targetIdx]
  if (!marker) {
    return {
      kind: 'no-marker',
      requested: opts.to ?? stack.length,
      depth: stack.length,
    }
  }

  const markerIndex = activeMessages.findIndex(
    m => m.uuid === marker.messageUuid,
  )
  if (markerIndex === -1) return { kind: 'stale', targetIdx, marker }

  // off-by-one: the marker IS the last main-line message; the pivot is the
  // first discussion message so the marker stays in the kept prefix (§3).
  const pivotIndex = markerIndex + 1
  const branch = activeMessages.slice(pivotIndex)
  // Progress messages are never kept or summarized by partial compaction, so
  // a branch made only of them has nothing to distill (§7.1 fast-path).
  if (!branch.some(m => m.type !== 'progress')) {
    return { kind: 'nothing-to-distill', targetIdx, marker }
  }

  return {
    kind: 'branch',
    targetIdx,
    marker,
    pivotIndex,
    pivotUuid: activeMessages[pivotIndex]!.uuid as UUID,
    branchFirstPromptUuid: branch.find(isUserPrompt)?.uuid as UUID | undefined,
  }
}

/**
 * Removes `markerId` and every marker above it (`--to #N` pops #N and above).
 * Looked up by id so a stack that changed since planning is never mis-sliced;
 * an unknown id leaves the stack untouched.
 */
export function popMarkersFrom(
  stack: PushMarker[],
  markerId: string,
): PushMarker[] {
  const idx = stack.findIndex(m => m.id === markerId)
  return idx === -1 ? stack : stack.slice(0, idx)
}
