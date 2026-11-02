import type { DomainPolicy, RouterDecision, Strength, Task } from '@carina/contracts'
import { routerDecisionSchema } from '@carina/contracts'

/** Actions a Worker may be granted in the first phase. Merge and deploy are deliberately absent. */
export const ALLOWED_ACTIONS = ['read', 'write_workspace', 'run_command', 'comment', 'create_pr'] as const
export type AllowedAction = (typeof ALLOWED_ACTIONS)[number]

const INFERRED_ACTIONS: readonly string[] = ['read', 'write_workspace', 'run_command', 'comment']

export class DecisionRejected extends Error {}

/** A Router decision is only actionable after the deterministic policy layer accepts it. */
export const admitDecision = (
  decision: RouterDecision,
  policy: DomainPolicy,
  knownTaskIds: ReadonlySet<string>,
): RouterDecision => {
  if (decision.kind === 'link' || decision.kind === 'cancel') {
    if (!knownTaskIds.has(decision.taskId)) throw new DecisionRejected(`unknown task ${decision.taskId}`)
    return decision
  }
  if (decision.kind !== 'create_task') return decision

  if (decision.strength === 'inferred') {
    if (policy.acceptMode !== 'inferred') throw new DecisionRejected('inferred work is disabled for this domain')
    if (!policy.rules.some(rule => rule.enabled && rule.inferred)) {
      throw new DecisionRejected('no enabled inferred rule')
    }
  }
  const unknown = decision.allowedActions.filter(action => !ALLOWED_ACTIONS.includes(action as AllowedAction))
  if (unknown.length > 0) throw new DecisionRejected(`actions not allowed: ${unknown.join(', ')}`)

  if (decision.strength === 'inferred') {
    const widened = decision.allowedActions.filter(action => !INFERRED_ACTIONS.includes(action))
    if (widened.length > 0) throw new DecisionRejected(`inferred work cannot grant: ${widened.join(', ')}`)
  }
  return decision
}

/** Parse model output defensively. Fenced JSON is accepted; anything else is rejected. */
export const parseRouterDecision = (text: string): RouterDecision => {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  const body = fenced?.[1] ?? trimmed
  const value: unknown = JSON.parse(body)
  return routerDecisionSchema.parse(value)
}

export const inferStrength = (strength: Strength, policy: DomainPolicy): Strength =>
  strength === 'inferred' && policy.acceptMode === 'inferred' ? 'inferred' : 'explicit'

/** Tasks on the same Thread, including ended ones, so the Router can avoid duplicates. */
export const sameThreadTasks = (tasks: readonly Task[], threadKey: string, taskThreads: ReadonlyMap<string, readonly string[]>): Task[] =>
  tasks.filter(task => taskThreads.get(task.id)?.includes(threadKey))
