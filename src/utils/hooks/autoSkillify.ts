import { homedir } from 'os'
import { join } from 'path'
import { mkdir, readdir, writeFile } from 'fs/promises'
import type { REPLHookContext } from './postSamplingHooks.js'
import type { ToolUseContext } from '../../Tool.js'
import type {
  AssistantMessage,
  SystemLocalCommandMessage,
  SystemMessage,
} from '../../types/message.js'
import { logForDebugging } from '../debug.js'
import {
  createCacheSafeParams,
  runForkedAgent,
} from '../forkedAgent.js'
import { createUserMessage } from '../messages.js'
import { logEvent } from '../../services/analytics/index.js'

type AppendSystemMessageFn = (
  msg: Exclude<SystemMessage, SystemLocalCommandMessage>,
) => void

const MIN_TOOL_CALLS = 8

function countToolCalls(context: REPLHookContext): number {
  let count = 0
  for (const msg of context.messages) {
    if (msg.type !== 'assistant') continue
    const content = (msg as AssistantMessage).message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'tool_use') count++
    }
  }
  return count
}

function extractRecentMessages(context: REPLHookContext, limit: number): string {
  const msgs: string[] = []
  const recent = context.messages.slice(-limit)
  for (const msg of recent) {
    if (msg.type === 'user') {
      const content = msg.message.content
      if (typeof content === 'string') {
        msgs.push(`[User]: ${content}`)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if ('type' in block && block.type === 'text' && 'text' in block) {
            msgs.push(`[User]: ${(block as { text: string }).text}`)
          }
        }
      }
    } else if (msg.type === 'assistant') {
      const content = (msg as AssistantMessage).message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            msgs.push(`[Assistant]: ${block.text}`)
          } else if (block.type === 'tool_use') {
            msgs.push(`[Tool]: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`)
          }
        }
      }
    }
  }
  return msgs.join('\n')
}

async function getExistingAutoSkills(): Promise<string[]> {
  const dir = join(homedir(), '.claude', 'skills', 'auto-generated')
  try {
    const entries = await readdir(dir)
    return entries
  } catch {
    return []
  }
}

const JUDGE_PROMPT = `You are evaluating whether a conversation represents a reusable workflow worth saving as a Skill.

Existing auto-generated skills: {{existingSkills}}

Conversation summary:
<conversation>
{{conversation}}
</conversation>

Decide if this conversation is worth saving as a reusable Skill. Criteria:
1. Has clear, repeatable steps applicable to similar future tasks
2. Does not duplicate an existing auto-generated skill
3. Is not a one-off task specific to the current context
4. Has at least 3 meaningful steps

Conservative strategy — if unsure, output NO.

If YES, output exactly:
YES
skill-name: <kebab-case name>
description: <one-line description>
steps: <numbered list of steps>

If NO, output exactly:
NO
reason: <brief reason>`

const SKILL_TEMPLATE = `---
name: {{name}}
description: {{description}}
when_to_use: {{whenToUse}}
---

# {{title}}

## Goal
{{description}}

## Steps
{{steps}}
`

export async function executeAutoSkillify(
  context: REPLHookContext,
  appendSystemMessage?: AppendSystemMessageFn,
): Promise<void> {
  try {
    const toolCallCount = countToolCalls(context)
    if (toolCallCount < MIN_TOOL_CALLS) return

    const conversationSummary = extractRecentMessages(context, 60)
    const existingSkills = await getExistingAutoSkills()

    const prompt = JUDGE_PROMPT
      .replace('{{existingSkills}}', existingSkills.join(', ') || '(none)')
      .replace('{{conversation}}', conversationSummary)

    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: prompt })],
      cacheSafeParams: createCacheSafeParams(context),
      querySource: 'auto_skillify',
      forkLabel: 'auto_skillify',
      skipTranscript: true,
      maxTurns: 2,
    })

    const lastAssistant = result.messages
      .filter((m): m is AssistantMessage => m.type === 'assistant')
      .pop()
    if (!lastAssistant) return

    let responseText = ''
    for (const block of lastAssistant.message.content) {
      if (block.type === 'text') responseText += block.text
    }

    if (!responseText.trim().startsWith('YES')) {
      logForDebugging('[autoSkillify] skipped — model judged not worth saving')
      return
    }

    const nameMatch = responseText.match(/skill-name:\s*(.+)/)
    const descMatch = responseText.match(/description:\s*(.+)/)
    const stepsMatch = responseText.match(/steps:\s*([\s\S]+)/)

    if (!nameMatch || !descMatch || !stepsMatch) {
      logForDebugging('[autoSkillify] skipped — could not parse model output')
      return
    }

    const skillName = nameMatch[1].trim()
    const description = descMatch[1].trim()
    const steps = stepsMatch[1].trim()

    const skillDir = join(homedir(), '.claude', 'skills', 'auto-generated', skillName)
    await mkdir(skillDir, { recursive: true })

    const stepsFormatted = steps
      .split(/\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .map(line => {
        if (/^\d+\./.test(line)) {
          return `### ${line}\n**Success criteria**: Step completed successfully\n`
        }
        return line
      })
      .join('\n')

    const skillContent = SKILL_TEMPLATE
      .replace('{{name}}', skillName)
      .replace(/\{\{description\}\}/g, description)
      .replace('{{whenToUse}}', `Use when performing: ${description}`)
      .replace('{{title}}', skillName.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
      .replace('{{steps}}', stepsFormatted)

    await writeFile(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

    logForDebugging(`[autoSkillify] created skill: ${skillName}`)
    logEvent('tengu_auto_skillify_created', {})

    appendSystemMessage?.({
      type: 'system',
      content: [{
        type: 'text',
        text: `Auto-generated a new skill "${skillName}" at ~/.claude/skills/auto-generated/${skillName}/SKILL.md based on this session's workflow. You can edit it to refine.`,
      }],
    } as Exclude<SystemMessage, SystemLocalCommandMessage>)
  } catch (error) {
    logForDebugging(`[autoSkillify] error: ${error}`)
  }
}
