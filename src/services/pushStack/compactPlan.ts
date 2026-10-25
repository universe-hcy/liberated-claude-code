import type { Message } from '../../types/message.js'
import { isCompactBoundaryMessage } from '../../utils/messages.js'
import type { PushMarker } from './state.js'

/**
 * Pure decision for push-stack-aware auto-compaction (autoCompactIfNeeded,
 * docs/features/push-pop-context-stack.md §4.2). A partial `up_to` compaction
 * at a marker keeps everything from the marker's anchor onward, so it only
 * helps when there is real mainline content before the anchor AND the kept
 * part fits under the auto-compact threshold. Otherwise it would re-summarize
 * the previous summary every turn without freeing space (and never trip the
 * circuit breaker, since each partial "succeeds"), so the caller falls back to
 * full compaction instead.
 */
export type StackAwareFullReason =
  /** Marker anchor is no longer in the active context. */
  | 'stale-marker'
  /** Only compact boundaries / summaries / progress precede the anchor. */
  | 'nothing-to-compress'
  /** The kept branch alone is at/above the auto-compact threshold. */
  | 'branch-too-large'

/** Why autoCompactIfNeeded ran full compaction despite live push points. */
export type StackAwareFallbackReason =
  | StackAwareFullReason
  /** The partial ran but left the context at/above the threshold. */
  | 'stalled'
  /** The partial threw (not an abort). */
  | 'partial-failed'

export type StackAwareCompactPlan =
  | { kind: 'partial'; pivotIndex: number }
  | { kind: 'full'; reason: StackAwareFullReason }

export type StackAwareBudget = {
  /** Tokens sent besides the messages (system prompt, tools), estimated. */
  overheadTokens: number
  /** getAutoCompactThreshold(model). */
  threshold: number
  estimateTokens: (messages: readonly Message[]) => number
}

/**
 * Content a partial up_to would actually condense: not progress, boundaries or
 * an earlier plain compact summary. Digests (`/pop`, `/digest`) count — they
 * are real conclusions that a partial folds into the new summary.
 */
function isCompressible(m: Message): boolean {
  if (m.type === 'progress' || isCompactBoundaryMessage(m)) return false
  return !(
    m.type === 'user' &&
    m.isCompactSummary &&
    m.isDigestSummary !== true
  )
}

/**
 * Plans a partial `up_to` compaction at `markerId`. `activeMessages` are the
 * messages after the last compact boundary (the slice partial compaction
 * receives), so the returned pivotIndex indexes into them. Viability is
 * monotone in marker depth: an older pivot compresses a prefix of what a newer
 * one does and keeps a superset, so if the nearest marker is not viable no
 * marker is.
 */
export function planStackAwareCompact(
  activeMessages: readonly Message[],
  stack: readonly PushMarker[],
  markerId: string,
  budget: StackAwareBudget,
): StackAwareCompactPlan {
  const anchor = stack.find(m => m.id === markerId)?.messageUuid
  const pivotIndex =
    anchor === undefined ? -1 : activeMessages.findIndex(m => m.uuid === anchor)
  if (pivotIndex === -1) return { kind: 'full', reason: 'stale-marker' }
  if (!activeMessages.slice(0, pivotIndex).some(isCompressible)) {
    return { kind: 'full', reason: 'nothing-to-compress' }
  }
  const keptTokens = budget.estimateTokens(activeMessages.slice(pivotIndex))
  if (keptTokens + budget.overheadTokens >= budget.threshold) {
    return { kind: 'full', reason: 'branch-too-large' }
  }
  return { kind: 'partial', pivotIndex }
}

/** Notification prefix: why stack-aware auto-compact ran full compaction. */
export function describeStackAwareFallback(
  reason: StackAwareFallbackReason,
  depth: number,
): string {
  switch (reason) {
    case 'stale-marker':
      return `Push point #${depth} was no longer in the context, so auto-compact compacted everything.`
    case 'nothing-to-compress':
      return `Nothing was left to compact before push point #${depth}, so auto-compact compacted everything.`
    case 'branch-too-large':
    case 'stalled':
      return `The branch after push point #${depth} alone is over the auto-compact threshold, so auto-compact compacted everything.`
    case 'partial-failed':
      return `Compacting to push point #${depth} failed, so auto-compact compacted everything.`
  }
}
