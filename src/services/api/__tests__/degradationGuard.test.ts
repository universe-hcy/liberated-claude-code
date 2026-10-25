import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  collectAssistantResponseTexts,
  detectContextBleed,
  detectContextBleedInTurn,
  stripMarkdownCode,
} from '../degradationGuard'

const LONG = 150_000
const BLOCK =
  '<system-reminder>Warning: this tool result is 5 hours old.</system-reminder>'

describe('detectContextBleed', () => {
  test('fires on a closed reminder block whose body matches a harness fingerprint', () => {
    // Real sample from session 816c6bda (2026-07-27): a whole assistant text
    // block that is just a regurgitated internal reminder.
    const text =
      '<system-reminder>\n' +
      'Warning: this tool result is 5 hours old. ' +
      'The user may have continued working since sending it.\n' +
      '</system-reminder>'
    const notice = detectContextBleed(text)
    expect(notice).not.toBeNull()
    expect(notice).toContain('/rewind')
  })

  test('does not fire when a fingerprinted block is wrapped in neutral prose (intentional quote)', () => {
    // Tightened: a block embedded in substantial neutral explanation is a quote,
    // not a bleed. (Previously this mid-text case fired; layer 3 now spares it.)
    const text =
      '这是 harness 注入的提醒:' +
      '<system-reminder>' +
      'This memory is 3 days old, verify before trusting.' +
      '</system-reminder> 它只是用来标注记忆的年龄。'
    expect(detectContextBleed(text)).toBeNull()
  })

  test('does not fire on normal prose that merely mentions "system reminder"', () => {
    const text =
      'The harness injects a system reminder into the user turn, not the assistant.'
    expect(detectContextBleed(text)).toBeNull()
  })

  test('does not fire when the tag is named without a closed block', () => {
    const text = '模型不应该在输出里回吐 <system-reminder> 这种内部标记。'
    expect(detectContextBleed(text)).toBeNull()
  })

  test('does not fire on source code that references the tag literal', () => {
    const text = "const SYSTEM_REMINDER_OPEN = '<system-reminder>'"
    expect(detectContextBleed(text)).toBeNull()
  })

  test('does not fire when discussing the degradation, quoting its hallucination phrases', () => {
    // This is exactly what a CCB dev session does: it names the tag and quotes
    // the symptom phrases. The old naive `includes('<system-reminder>')` check
    // false-fired here; the tightened one must not.
    const text =
      '收紧后,即使我在回复里提到 <system-reminder> 并引用"文件被污染/工具未执行"这些幻觉短语,也不该误报。'
    expect(detectContextBleed(text)).toBeNull()
  })

  test('does not fire on a closed block whose body has no harness fingerprint', () => {
    // e.g. quoting the language-restriction reminder verbatim for illustration.
    const text =
      '<system-reminder>语言限制：只允许中文或英文。</system-reminder>'
    expect(detectContextBleed(text)).toBeNull()
  })

  test('returns null for null, empty, and whitespace-only input', () => {
    expect(detectContextBleed(null)).toBeNull()
    expect(detectContextBleed('')).toBeNull()
    expect(detectContextBleed('   \n\t ')).toBeNull()
  })

  test('returns null for ordinary assistant output', () => {
    expect(
      detectContextBleed('Task 1 done. Now onemin_cut_process.py.'),
    ).toBeNull()
  })

  test('layer 1 (token gate): does not fire in a short context even on a bleed', () => {
    expect(detectContextBleed(BLOCK, 5_000)).toBeNull()
    expect(detectContextBleed(BLOCK, 99_999)).toBeNull()
  })

  test('layer 1 (token gate): fires once the live context is long enough', () => {
    expect(detectContextBleed(BLOCK, 100_000)).not.toBeNull()
    expect(detectContextBleed(BLOCK, LONG)).not.toBeNull()
  })

  test('layer 2 (meta-discussion): does not fire when outside prose discusses the guard', () => {
    const text =
      '<system-reminder>Warning: this tool result is 5 hours old.</system-reminder> —— 这正是 degradationGuard 要检测的回吐形态。'
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('layer 3 (quote): does not fire when a fingerprinted block is wrapped in neutral prose', () => {
    const text =
      '这是 harness 每轮开头附加的内容,用来标注工具结果已经存在多久,方便判断新鲜度:<system-reminder>Warning: this tool result is 5 hours old.</system-reminder> 它属于正常的会话机制,不影响结果。'
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('does not fire on a fingerprinted reminder quoted in a fenced code block', () => {
    // A teaching example: the whole reminder lives inside a ``` fence, and the
    // surrounding prose even carries symptom words. Without code-span exclusion
    // this would false-fire; the guard must treat code as documentation.
    const text =
      '举个例子，模型不该虚构文件被污染。它长这样：\n' +
      '```\n' +
      '<system-reminder>Warning: this tool result is 5 hours old.' +
      '</system-reminder>\n' +
      '```'
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('does not fire on a fingerprinted reminder quoted in an inline code span', () => {
    const text =
      '内部提醒块 `<system-reminder>gentle reminder' +
      '</system-reminder>` 只是被当作代码引用，文件被污染这类幻觉词也在。'
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('layer 3 (symptoms): fires when outside prose carries the hallucination symptoms', () => {
    // The real 2026-07-27 signature: block regurgitated, then bogus claims that
    // files were corrupted and tools never ran.
    const text =
      '<system-reminder>Warning: this tool result is 5 hours old.</system-reminder> 我发现文件被污染了,刚才的工具未执行。'
    expect(detectContextBleed(text, LONG)).not.toBeNull()
  })

  test('layer 2 (meta-discussion): backticked identifiers still mark a quote', () => {
    const text =
      '`detectContextBleed` 盯的就是这种输出：' +
      BLOCK +
      ' 紧接着模型说工具未执行。'
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('does not fire on a reminder quoted in a ~~~ fence', () => {
    const text = `模型说工具未执行。\n~~~\n${BLOCK}\n~~~`
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('does not fire on a reminder inside a nested 4-backtick fence', () => {
    const text =
      '模型说工具未执行。\n````md\n```\n' + BLOCK + '\n```\n' + BLOCK + '\n````'
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('does not fire on a reminder inside an unclosed fence', () => {
    const text = `模型说工具未执行。\n\`\`\`\n${BLOCK}\n(output truncated)`
    expect(detectContextBleed(text, LONG)).toBeNull()
  })

  test('does not fire on a reminder in indented code or a blockquote', () => {
    expect(
      detectContextBleed(`模型说工具未执行。\n\n    ${BLOCK}`, LONG),
    ).toBeNull()
    expect(
      detectContextBleed(`模型说工具未执行。\n> ${BLOCK}`, LONG),
    ).toBeNull()
  })

  test('a stray backtick does not swallow a real bleed across lines', () => {
    const text = `run \`x\n${BLOCK}\n文件被污染 y\``
    expect(detectContextBleed(text, LONG)).not.toBeNull()
  })
})

describe('stripMarkdownCode', () => {
  test('closing fence must use the same char and be at least as long', () => {
    const text = '````\n```\nhidden\n~~~\nstill hidden\n````\nvisible'
    expect(stripMarkdownCode(text).trim()).toBe('visible')
  })

  test('accepts up to 3 leading spaces on fences', () => {
    expect(stripMarkdownCode('   ```\nhidden\n   ```\nshown').trim()).toBe(
      'shown',
    )
  })

  test('an indented line continuing a paragraph is not code', () => {
    expect(stripMarkdownCode('para\n    still prose')).toContain('still prose')
  })

  test('inline code spans never cross a newline', () => {
    expect(stripMarkdownCode('a `b\nc` d')).toBe('a `b\nc` d')
    expect(stripMarkdownCode('a `b` c')).toBe('a   c')
  })

  test('a one-line ```x``` span is inline code, not a fence opener', () => {
    expect(stripMarkdownCode('```x```\nshown')).toContain('shown')
  })
})

function assistant(
  id: string,
  content: Array<{ type: string; text?: string }>,
): Message {
  return {
    type: 'assistant',
    uuid: `${id}-${content.length}-${Math.random()}`,
    message: { id, content },
  } as unknown as Message
}

describe('detectContextBleedInTurn', () => {
  test('groups text blocks by API response and skips non-text blocks', () => {
    const turn = [
      assistant('r1', [{ type: 'text', text: 'a' }]),
      assistant('r1', [{ type: 'tool_use' }]),
      { type: 'user', uuid: 'u' } as unknown as Message,
      assistant('r1', [{ type: 'text', text: 'b' }]),
      assistant('r2', [{ type: 'text', text: 'c' }]),
    ]
    expect(collectAssistantResponseTexts(turn)).toEqual(['a\nb', 'c'])
  })

  test('catches a bleed followed by a tool retry (last block is tool_use)', () => {
    const turn = [
      assistant('r1', [{ type: 'text', text: BLOCK }]),
      assistant('r1', [{ type: 'tool_use' }]),
      { type: 'user', uuid: 'tr' } as unknown as Message,
      assistant('r2', [{ type: 'tool_use' }]),
    ]
    expect(detectContextBleedInTurn(turn, LONG)).not.toBeNull()
    expect(detectContextBleedInTurn(turn, 1_000)).toBeNull()
  })

  test('returns null when no response carries a bleed', () => {
    const turn = [assistant('r1', [{ type: 'text', text: 'done' }])]
    expect(detectContextBleedInTurn(turn, LONG)).toBeNull()
  })
})
