import type { UUID } from 'crypto'
import type { Notification } from '../../context/notifications.js'
import type { ToolUseContext } from '../../Tool.js'
import type { AgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { getMessagesAfterCompactBoundary } from '../../utils/messages.js'

/**
 * Push/Pop context stack (docs/features/push-pop-context-stack.md).
 *
 * A PushMarker records the point where a discussion branch was opened. `/push`
 * appends one; `/pop` distills everything after it into a digest and rewinds.
 */
export type PushMarker = {
  /** Stable id for the marker (also used as the display "#N" ordinal source). */
  id: string
  /** UUID of the last message at push time — this message stays on the mainline. */
  messageUuid: UUID
  /** Optional free-text note supplied as `/push <note>`. */
  note: string
  /** Epoch ms at push time (for relative-time display in `/push --list`). */
  timestamp: number
  /** Preview of the user's most recent instruction at push time (what the branch is about). */
  anchorPreview: string
}

/** Options for `/pop` parsed from its flags, passed to the REPL apply callback. */
export type PopOptions = {
  /** `--to #N`: cross-layer pop back to marker ordinal N (1-based). */
  to?: number
  /** `--discard`: truncate without generating a digest. */
  discard?: boolean
  /** `--keep-code`: suppress the post-pop file-change hint (no automatic rollback exists). */
  keepCode?: boolean
}

/** A push marker as surfaced to the auto-compact strategy picker (§4.2). */
export type CompactStrategyMarker = {
  id: string
  note: string
  /** 1-based ordinal (#1 = oldest). */
  depth: number
}

/**
 * The user's choice in the stack-aware auto-compact dialog (§4.2):
 *   'full'    → run full compaction, dropping every push point.
 *   'partial' → compact up to markerId, keeping it and any newer markers.
 */
export type CompactStrategyChoice =
  | { kind: 'full' }
  | { kind: 'partial'; markerId: string }

/** Max nesting depth for the push stack (§4.3). Beyond this, `/push` errors. */
export const MAX_PUSH_DEPTH = 3

// Write-through mirror of AppState.pushStack. autoCompactIfNeeded /
// shouldAutoCompact run outside the React tree and cannot read AppState, so the
// REPL mirrors the stack here whenever it changes. Read-only for consumers.
let pushStackMirror: PushMarker[] = []
const NO_MARKERS: readonly PushMarker[] = Object.freeze([])

/**
 * Synchronous read of the current push stack (for the auto-compact path). The
 * stack belongs to the main thread: subagents / forks / teammates (any context
 * with an agentId) always see an empty stack, even when their messages share
 * uuids with the main thread (fork-style subagents).
 */
export function getPushStackMirror(
  agentId: AgentId | undefined,
): readonly PushMarker[] {
  return agentId === undefined ? pushStackMirror : NO_MARKERS
}

/** Called by the REPL to keep the mirror in sync with AppState.pushStack. */
export function setPushStackMirror(stack: readonly PushMarker[]): void {
  pushStackMirror = [...stack]
}

/**
 * Projects a persisted push stack back onto the live message sequence at resume
 * time. A marker only survives if its anchor message (`messageUuid`) is still in
 * the active context — i.e. not carried off by compaction or history-snip. This
 * mirrors the validation `/pop` performs (REPL) so a restored marker can never
 * point at a message that no longer exists. Dropped markers are counted so the
 * caller can transparently notify the user (never silently lose a stack marker).
 */
export function projectPushStackOntoMessages(
  persisted: readonly PushMarker[],
  messages: Message[],
): { validMarkers: PushMarker[]; droppedCount: number } {
  const activeUuids = new Set(
    getMessagesAfterCompactBoundary(messages).map(m => m.uuid),
  )
  const validMarkers = persisted.filter(m => activeUuids.has(m.messageUuid))
  return {
    validMarkers,
    droppedCount: persisted.length - validMarkers.length,
  }
}

type PushStackContext = Pick<
  ToolUseContext,
  'agentId' | 'getAppState' | 'setAppState'
>

/**
 * Drops markers whose anchor is no longer in `activeMessages`' active context
 * (carried off by compaction, /rewind, snip, ...) from AppState.pushStack and
 * the mirror. Main thread only (no-op with an agentId). Persistence follows via
 * the REPL's pushStack effect. Returns how many markers were dropped.
 */
export function pruneStalePushMarkers(
  context: PushStackContext,
  activeMessages: Message[],
): number {
  if (context.agentId !== undefined) return 0
  const stack = context.getAppState().pushStack
  if (stack.length === 0) return 0
  const { validMarkers, droppedCount } = projectPushStackOntoMessages(
    stack,
    activeMessages,
  )
  if (droppedCount === 0) return 0
  context.setAppState(prev => ({ ...prev, pushStack: validMarkers }))
  setPushStackMirror(validMarkers)
  return droppedCount
}

/**
 * pruneStalePushMarkers after a successful compaction (auto, manual /compact,
 * reactive, /pop, /digest), plus a notification with the actual count so
 * markers are never dropped silently. `reason` prefixes the text (e.g. why a
 * stack-aware auto-compact fell back to full compaction).
 */
export function prunePushMarkersAfterCompaction(
  context: PushStackContext & Pick<ToolUseContext, 'addNotification'>,
  postCompactMessages: Message[],
  reason?: string,
): number {
  const dropped = pruneStalePushMarkers(context, postCompactMessages)
  if (dropped > 0) {
    context.addNotification?.({
      key: 'push-stack-pruned',
      text: `${reason ? `${reason} ` : ''}Removed ${dropped} push point(s) whose anchor is no longer in the context.`,
      priority: 'medium',
      timeoutMs: 10000,
    })
  }
  return dropped
}

/**
 * Projects a resumed session's persisted stack onto its restored messages
 * (every resume entry point: --resume / -c, the startup picker, /resume).
 * `notification` is set when markers had to be dropped; the caller re-persists
 * the projected stack so the transcript stops carrying the stale markers.
 */
export function projectResumedPushStack(
  persisted: readonly PushMarker[] | undefined,
  messages: Message[],
): { pushStack: PushMarker[]; notification: Notification | undefined } {
  const { validMarkers, droppedCount } = projectPushStackOntoMessages(
    persisted ?? [],
    messages,
  )
  return {
    pushStack: validMarkers,
    notification:
      droppedCount > 0
        ? {
            key: 'push-stack-resume-dropped',
            text: `${droppedCount} push point(s) became invalid after resume (carried off by compaction/snip) and were removed.`,
            priority: 'medium',
            timeoutMs: 6000,
          }
        : undefined,
  }
}
