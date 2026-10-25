/**
 * Digest prompt shared by `/pop` and `/digest`
 * (docs/features/push-pop-context-stack.md §3, §4.6; docs/features/digest.md).
 *
 * Passed as PartialCompactOptions.promptOverride so it REPLACES the generic
 * partial-compact template. It still instructs the model to emit
 * <analysis> + <summary> so formatCompactSummary (strips <analysis>, turns
 * <summary> into a "Summary:" section) and the no-tools trailer stay consistent.
 * The four columns live inside <summary>.
 */
export const DIGEST_PROMPT = `Your task is to distill a DISCUSSION BRANCH that just concluded into a compact digest. This discussion branched off the mainline conversation; it is now being rolled up and only your digest will remain — the mainline continues on top of it. Capture only what the mainline needs; drop the back-and-forth, dead ends already resolved, and verbatim tool output.

First think in an <analysis> block (this is scratch work and will be discarded): what was actually decided, what was rejected and why, what stayed open, and what the mainline must now do.

Then write the digest in a <summary> block using EXACTLY these four sections, each a short bulleted list (omit a section's bullets only if truly empty, but keep the header):

<summary>
[Decisions] What the discussion concluded, with the key reasoning.
[Rejected] Options considered and turned down, with why (so the mainline does not revisit them).
[Open questions] Points the discussion did not resolve.
[Action items] Concrete effects on / TODOs for the mainline task.
</summary>

Be precise and faithful — do not invent conclusions the discussion did not reach.`

/** Entry point that scoped the branch being distilled. */
export type DigestSource = 'pop' | 'digest'

const DIGEST_FOCUS: Record<DigestSource, string> = {
  pop: 'The branch was opened explicitly with /push and is now closed with /pop. Prioritize decisions and their rationale; keep it tight.',
  digest:
    'The branch was selected after the fact with /digest (it was not marked beforehand), so it may begin mid-exploration. Prioritize conclusions and their rationale; keep it tight.',
}

/**
 * Builds the promptOverride for a digest. The entry-specific focus is part of
 * the prompt itself (not user feedback), so optional user context is appended
 * on top as "Additional Instructions" and summarizeMetadata.userContext only
 * ever records what the user actually typed.
 */
export function buildDigestPrompt(source: DigestSource): string {
  return `${DIGEST_PROMPT}\n\n${DIGEST_FOCUS[source]}`
}
