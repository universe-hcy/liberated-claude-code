import type { AppState } from '../../state/AppState.js'
import { TEAM_LEAD_NAME } from '../../utils/swarm/constants.js'
import type { Task } from '../../utils/tasks.js'
import { getAgentId, getAgentName, isTeamLead } from '../../utils/teammate.js'

// Unfinished tasks are re-surfaced to the *user* (never injected into the model
// request) after a turn ends with work still pending. See the long-session
// drift investigation (2026-07-23): rather than silently re-injecting a
// <system-reminder> — which a degraded model can misread as a prompt-injection
// attack — we let the user re-anchor with one keystroke that pre-fills a real
// user instruction into the input box.

const STATUS_ORDER: Record<string, number> = {
  in_progress: 0,
  pending: 1,
}

/**
 * Owner identities that mean "this REPL's main thread": its own swarm
 * name/id when it is a teammate, plus the lead's name/id when it leads a team.
 * Tasks owned by anything else belong to other agents.
 */
export function getMainThreadTaskOwners(
  teamContext: AppState['teamContext'],
): Set<string> {
  const owners = [
    getAgentName(),
    getAgentId(),
    teamContext?.selfAgentName,
    teamContext?.selfAgentId,
  ]
  if (isTeamLead(teamContext)) {
    owners.push(TEAM_LEAD_NAME, teamContext?.leadAgentId)
  }
  return new Set(owners.filter((o): o is string => Boolean(o)))
}

/**
 * Narrows a task list (which in a swarm is the whole team's) to the
 * unfinished tasks the main thread can act on: unowned or owned by one of
 * `selfOwners`, and — for pending tasks — not waiting on an unfinished
 * blocker (same rule as claimTask; a blocker id that no longer exists counts
 * as resolved).
 */
export function selectActionableTasks(
  tasks: Task[],
  selfOwners: ReadonlySet<string>,
): Task[] {
  const unresolved = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )
  return tasks.filter(
    t =>
      t.status !== 'completed' &&
      (!t.owner || selfOwners.has(t.owner)) &&
      !(t.status === 'pending' && t.blockedBy.some(id => unresolved.has(id))),
  )
}

/**
 * Identity of a reminder: the task list plus each task's id, status and
 * subject. The REPL re-surfaces the notice only when this changes, so ending
 * turn after turn on a side topic with the same tasks open doesn't spam it.
 */
export function taskReminderKey(taskListId: string, tasks: Task[]): string {
  return [
    taskListId,
    ...[...tasks]
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map(t => `${t.id}:${t.status}:${t.subject}`),
  ].join('\n')
}

/**
 * Picks the highest-priority unfinished task (in_progress before pending, then
 * by numeric id) and returns a ready-to-send user instruction re-anchoring the
 * model to it, e.g. "按计划继续 Task #2 改 onemin_cut_process.py". Returns null
 * when nothing is unfinished. The caller pre-fills this into the input box; it
 * is sent only when the user actually presses Enter, so it costs no extra token
 * and is never injected behind the user's back.
 */
export function buildContinuationPrompt(tasks: Task[]): string | null {
  const unfinished = tasks.filter(t => t.status !== 'completed')
  if (unfinished.length === 0) {
    return null
  }
  const [top] = [...unfinished].sort((a, b) => {
    const byStatus =
      (STATUS_ORDER[a.status] ?? 2) - (STATUS_ORDER[b.status] ?? 2)
    if (byStatus !== 0) {
      return byStatus
    }
    return Number(a.id) - Number(b.id)
  })
  return `按计划继续 Task #${top.id} ${top.subject}`
}

// How many in_progress task names to spell out in the local notice.
const MAX_NOTICE_TASK_NAMES = 3

/**
 * Builds a display-only, user-facing notice for when a turn ends naturally while
 * tasks are still in_progress — a strong signal the model stopped mid-work. Only
 * in_progress tasks trigger it (a pending backlog the user is pacing does not).
 * Returns null when there is nothing worth surfacing. This text is shown in the
 * REPL and never sent to the model (zero token cost).
 */
export function buildUnfinishedTaskNotice(tasks: Task[]): string | null {
  const inProgress = tasks.filter(t => t.status === 'in_progress')
  if (inProgress.length === 0) {
    return null
  }
  const pendingCount = tasks.filter(t => t.status === 'pending').length
  const names = inProgress
    .slice(0, MAX_NOTICE_TASK_NAMES)
    .map(t => `#${t.id} ${t.subject}`)
    .join('、')
  const overflow = inProgress.length - MAX_NOTICE_TASK_NAMES
  const namesSuffix = overflow > 0 ? ` 等 ${inProgress.length} 个` : ''
  const pendingSuffix = pendingCount > 0 ? `，另有 ${pendingCount} 个待办` : ''
  return `还有进行中的任务未完成：${names}${namesSuffix}${pendingSuffix}。按 Tab 填入续跑指令（可编辑后回车发送）。`
}
