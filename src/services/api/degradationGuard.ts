import type { Message } from '../../types/message.js'

// Context-bleed / degradation guard.
//
// When the model regurgitates a whole internal <system-reminder> block as its
// own assistant output, that is a clean early signal of long-context
// inference-side degradation. These blocks are injected by the harness into the
// USER side and are never legitimately authored by the model.
//
// Seen 2026-07-27 (session 816c6bda): after regurgitating a
// "<system-reminder>...tool result is 5 hours old...</system-reminder>" block,
// the model went on to hallucinate "file corrupted" / "tool calls were rendered
// as literal text and not executed" — while every tool had actually run and
// every edit had landed. Same inference-side hallucination family documented in
// the context-contamination investigation.
//
// Detection is deliberately narrow. This repo's whole job is discussing the
// <system-reminder> mechanism (90+ references across 34 files) and it routinely
// quotes real reminder blocks verbatim to explain, teach, or analyse transcripts
// — none of that must trip the guard. A false alarm nags the most expert user in
// the room, so we bias hard toward missing a novel regurgitation over firing on
// legitimate discussion. Three tightening layers on top of the closed-block +
// body-fingerprint requirement:
//
//   1. Length gate — regurgitation is a long-context phenomenon. Skip entirely
//      until the live (post-compact-boundary) context is large enough
//      (contextTokens >= MIN_CONTEXT_TOKENS_FOR_DEGRADATION).
//   2. Meta-discussion exclusion — if the prose *outside* the block talks about
//      this mechanism (names the guard, "回吐"/"误报", "例如"/"for example"…),
//      it's an intentional quote, not a bleed. Matched on the original text
//      (only reminder blocks removed): identifiers like `detectContextBleed`
//      are almost always backticked, so code stripping must not hide them.
//   3. Position / symptom constraint — only fire when the block essentially *is*
//      the whole output (nothing but the block), or the surrounding prose carries
//      the degradation's own hallucination symptoms ("文件被污染", "工具未执行",
//      "not executed"…). A block wrapped in substantial neutral prose is a quote.

const SYSTEM_REMINDER_OPEN = '<system-reminder>'

// Matches a fully closed reminder block; capture group 1 is the body.
const CLOSED_REMINDER_BLOCK = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi

// Markdown code. A reminder block quoted as a code example is documentation,
// never a bleed, so code is blanked out before fingerprint matching and the
// outside-prose emptiness/symptom checks. Parsed line by line (CommonMark
// subset) because a lazy regex mis-pairs nested fences and lets a stray
// backtick swallow real prose across lines.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const INDENTED_CODE_LINE = /^(?: {4}|\t)/
const BLOCKQUOTE_LINE = /^ {0,3}>/
const INLINE_CODE = /`[^`\n]+`/g

/**
 * Blanks Markdown code (and quotes) so reminders quoted there can't match the
 * fingerprint or affect the outside-prose analysis:
 *  - fenced blocks: ``` or ~~~ (3+), up to 3 leading spaces; the closer must use
 *    the same char and be at least as long; an unclosed fence (e.g. output cut
 *    by max_tokens) runs to the end of the text;
 *  - indented code: 4-space/tab lines that start after a blank line (they can't
 *    interrupt a paragraph, so an indented body line inside a regurgitated
 *    block stays visible);
 *  - `>` blockquote lines: quoting is by definition intentional, and a real
 *    regurgitation is never `>`-prefixed — consistent with the bias toward
 *    missing over nagging;
 *  - inline code spans, never across a newline.
 */
export function stripMarkdownCode(text: string): string {
  const out: string[] = []
  let fence: { char: string; length: number } | null = null
  let inIndentedCode = false
  let prevBlank = true
  for (const line of text.split('\n')) {
    if (fence) {
      const close = FENCE_CLOSE.exec(line)
      if (
        close &&
        close[1][0] === fence.char &&
        close[1].length >= fence.length
      ) {
        fence = null
        prevBlank = true
      }
      out.push('')
      continue
    }
    const open = FENCE_OPEN.exec(line)
    // A backtick fence's info string may not contain backticks (CommonMark),
    // so "```x```" on one line is inline code, not an opener.
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length }
      inIndentedCode = false
      out.push('')
      continue
    }
    if (line.trim() === '') {
      prevBlank = true
      out.push(line)
      continue
    }
    if (INDENTED_CODE_LINE.test(line) && (inIndentedCode || prevBlank)) {
      inIndentedCode = true
      prevBlank = false
      out.push('')
      continue
    }
    inIndentedCode = false
    prevBlank = false
    out.push(BLOCKQUOTE_LINE.test(line) ? '' : line.replace(INLINE_CODE, ' '))
  }
  return out.join('\n')
}

// Body-text fingerprints that appear *inside* harness-generated reminders
// (tool-result staleness, memory age, todo nudge, hook context, the former
// task-anchor injection…). Discussing the mechanism references the tag, not
// these full internal sentences, so requiring one of these inside a closed
// block is what keeps the false-positive rate low.
const REMINDER_BODY_FINGERPRINTS = [
  /tool result is\b/i,
  /\b(?:hours?|minutes?) old\b/i,
  /this memory is\b[\s\S]*\bdays? old\b/i,
  /gentle reminder/i,
  /never mention this reminder/i,
  /hook additional context/i,
  /generated by the client/i,
  /not sent by the user/i,
]

// Layer 1: regurgitation only shows up deep into a long context (the 2026-07-27
// sample was a many-hour session). Measured in tokens of the live context —
// what the model actually attends to after the last compaction — not message
// count: every content block, tool_result and local notice is its own message,
// and pre-compact history stays in the REPL array. 100k is half a standard
// 200k window: short teaching/quoting sessions never get there, while the
// sessions where inference-side degradation was observed are well past it.
// Bias toward missing over nagging.
const MIN_CONTEXT_TOKENS_FOR_DEGRADATION = 100_000

// Layer 2: prose outside the block that discusses/teaches this very mechanism.
// Its presence marks the block as an intentional quote (illustration, transcript
// analysis, or a note about the guard itself), never a bleed.
const META_DISCUSSION =
  /degradation.?guard|detect.?context.?bleed|context.?bleed|回吐|误报|误杀|误触发|fingerprint|指纹|示例|样例|例如|比如|如下所示|长啥样|长什么样|for example|illustrat/i

// Layer 3: the degradation's own hallucination symptoms. When the block is NOT
// the whole output, we still fire if the surrounding prose carries these — that
// is the real 2026-07-27 signature (block + "file corrupted / tool not run").
const HALLUCINATION_SYMPTOMS =
  /文件被污染|文件.{0,4}损坏|工具未执行|工具没执行|工具未运行|未真正执行|未被执行|file (?:is |was )?corrupt|not (?:actually )?executed|were not (?:run|executed)|rendered as (?:literal )?text/i

const CONTEXT_BLEED_NOTICE =
  '检测到模型在输出中回吐了完整的内部 <system-reminder> 提醒块——' +
  '这通常是超长上下文下推理侧退化/上下文回吐的早期信号，' +
  '模型接下来可能虚构"文件被污染/工具未执行"等并不存在的问题。' +
  '建议 /rewind 回到上一轮，或先核对文件与工具结果均正常再继续。'

/**
 * Returns a display-only, user-facing warning when `assistantText` looks like a
 * regurgitated internal <system-reminder> block (long-context degradation
 * signal), else null. Zero token cost — the caller surfaces this as a local
 * 'warning' system message, never sent to the model.
 *
 * Layered to avoid false alarms in a repo that constantly quotes real reminders:
 *  - requires a closed <system-reminder>…</system-reminder> block whose body
 *    matches a harness fingerprint;
 *  - `contextTokens` (live post-compact context size), when provided, gates
 *    out short contexts (degradation is a long-context phenomenon);
 *  - prose outside the block that discusses the mechanism → treated as a quote;
 *  - fires only when the block is essentially the entire output, or the outside
 *    prose carries the degradation's hallucination symptoms.
 */
export function detectContextBleed(
  assistantText: string | null,
  contextTokens?: number,
): string | null {
  if (!assistantText) {
    return null
  }
  // Blank out Markdown code first: a reminder block quoted as a code example is
  // documentation, not a bleed. Fingerprint matching and the outside-prose
  // emptiness/symptom checks run on this copy.
  const scannable = stripMarkdownCode(assistantText)
  if (!scannable.includes(SYSTEM_REMINDER_OPEN)) {
    return null
  }
  // Layer 1: length gate — don't even look at short contexts.
  if (
    typeof contextTokens === 'number' &&
    contextTokens < MIN_CONTEXT_TOKENS_FOR_DEGRADATION
  ) {
    return null
  }
  // Require a closed block whose body carries a harness fingerprint.
  let hasFingerprintedBlock = false
  for (const match of scannable.matchAll(CLOSED_REMINDER_BLOCK)) {
    if (REMINDER_BODY_FINGERPRINTS.some(re => re.test(match[1]))) {
      hasFingerprintedBlock = true
      break
    }
  }
  if (!hasFingerprintedBlock) {
    return null
  }
  // Layer 2: outside prose discusses the mechanism → intentional quote. Uses
  // the original text so backticked identifiers still count as discussion.
  if (META_DISCUSSION.test(assistantText.replace(CLOSED_REMINDER_BLOCK, ' '))) {
    return null
  }
  // Layer 3: fire only if the block is essentially the whole output, or the
  // surrounding (non-code) prose shows the degradation's hallucination symptoms.
  const outside = scannable.replace(CLOSED_REMINDER_BLOCK, ' ')
  if (outside.trim().length === 0 || HALLUCINATION_SYMPTOMS.test(outside)) {
    return CONTEXT_BLEED_NOTICE
  }
  return null
}

/**
 * Joins the text blocks of each assistant API response in `turnMessages` (the
 * messages a turn appended). A response streams as one message per content
 * block, so blocks are grouped by API message id: each group is one model
 * utterance and is judged on its own, like a single assistant reply.
 */
export function collectAssistantResponseTexts(
  turnMessages: readonly Message[],
): string[] {
  const byResponse = new Map<string, string[]>()
  for (const message of turnMessages) {
    if (message.type !== 'assistant') {
      continue
    }
    const content = message.message?.content
    if (!Array.isArray(content)) {
      continue
    }
    const texts = (content as Array<{ type: string; text?: string }>)
      .filter(block => block.type === 'text' && block.text)
      .map(block => block.text as string)
    if (texts.length === 0) {
      continue
    }
    const key = message.message?.id ?? message.uuid
    const group = byResponse.get(key)
    if (group) {
      group.push(...texts)
    } else {
      byResponse.set(key, texts)
    }
  }
  return [...byResponse.values()].map(texts => texts.join('\n'))
}

/**
 * Runs `detectContextBleed` over every assistant response the turn produced,
 * not only the last block: a regurgitation followed by a tool retry (the real
 * 2026-07-27 shape) leaves a tool_use as the turn's final block.
 */
export function detectContextBleedInTurn(
  turnMessages: readonly Message[],
  contextTokens?: number,
): string | null {
  for (const text of collectAssistantResponseTexts(turnMessages)) {
    const notice = detectContextBleed(text, contextTokens)
    if (notice) {
      return notice
    }
  }
  return null
}
