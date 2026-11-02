import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ArtifactStore,
  Logger,
  RuntimeContext,
  TaskState,
  Trigger,
  WorkerEvent,
  WorkerSpec,
} from '@carina/contracts'
import type { Store } from '@carina/persistence'
import type { WakeupBus } from '@carina/queue'
import type { WorkerRuntimeRegistry } from '@carina/runtime'
import type { EventPublisher } from '@carina/contracts'
import { workerPrompt } from './prompts.js'

export interface ExecutorConfig {
  workspaceRoot: string
}

const taskStateForOutcome = (outcome: 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'awaiting_input'): {
  assignmentState: 'succeeded' | 'failed' | 'cancelled'
  taskState: TaskState
} => {
  switch (outcome) {
    case 'succeeded':
      return { assignmentState: 'succeeded', taskState: 'succeeded' }
    case 'failed':
      return { assignmentState: 'failed', taskState: 'failed' }
    case 'cancelled':
      return { assignmentState: 'cancelled', taskState: 'cancelled' }
    case 'blocked':
      return { assignmentState: 'succeeded', taskState: 'blocked' }
    case 'awaiting_input':
      return { assignmentState: 'succeeded', taskState: 'awaiting_input' }
  }
}

export class ExecutorService {
  constructor(
    private readonly store: Store,
    private readonly runtimes: WorkerRuntimeRegistry,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventPublisher,
    private readonly wakeup: WakeupBus,
    private readonly logger: Logger,
    private readonly config: ExecutorConfig,
  ) {}

  private async publish(type: string, tenantId: string, domainId: string, data: Record<string, unknown>): Promise<void> {
    await this.events
      .publish({ type, tenantId, domainId, at: new Date().toISOString(), data })
      .catch(() => undefined)
  }

  /** Claim and run pending assignments. Returns how many were started. */
  async runOnce(limit = 1): Promise<number> {
    const claimed = await this.store.claimAssignments(limit)
    for (const { assignment, task } of claimed) {
      await this.runAssignment(assignment.id, assignment.attempt, assignment.runtimeType, task).catch(async error => {
        this.logger.error('assignment crashed', { taskId: task.id, assignmentId: assignment.id, error: String(error) })
        await this.store.finishAssignment({
          assignmentId: assignment.id,
          taskId: task.id,
          assignmentState: 'failed',
          taskState: 'failed',
          result: String(error),
        })
        await this.wakeup.notify({ queue: 'executor', domainId: task.domainId }).catch(() => undefined)
      })
    }
    return claimed.length
  }

  private async runAssignment(
    assignmentId: string,
    attempt: number,
    runtimeType: string,
    task: Awaited<ReturnType<Store['getTask']>> & {},
  ): Promise<void> {
    const domain = await this.store.getDomain(task.domainId)
    if (!domain) {
      await this.store.finishAssignment({
        assignmentId,
        taskId: task.id,
        assignmentState: 'failed',
        taskState: 'failed',
        result: 'domain not found',
      })
      return
    }

    const origin = await this.store.getTrigger(task.originTriggerId)
    const pending = await this.store.listPendingInputs(task.id)
    const pendingTriggers = (
      await Promise.all(pending.filter(input => input.triggerId).map(input => this.store.getTrigger(input.triggerId!)))
    ).filter((trigger): trigger is Trigger => trigger !== undefined)
    const related = (await this.store.listTasks(task.domainId, 30)).filter(item => item.id !== task.id).slice(0, 10)

    const workspaceDir = join(this.config.workspaceRoot, task.domainId, task.id)
    await mkdir(workspaceDir, { recursive: true })
    const sessionId = `worker-${task.id}-${assignmentId}`
    await this.store.createWorkerSession({
      id: sessionId,
      taskId: task.id,
      assignmentId,
      runtimeType,
      workspaceRef: workspaceDir,
    })

    const spec: WorkerSpec = {
      taskId: task.id,
      assignmentId,
      domainId: task.domainId,
      tenantId: task.tenantId,
      title: task.title,
      goal: task.scope,
      acceptance: task.acceptance,
      scope: task.scope,
      strength: task.mandate.strength,
      allowedActions: task.mandate.allowedActions,
      budget: task.budget,
      planVersion: task.planVersion,
      workspaceRef: workspaceDir,
      originTriggerId: task.originTriggerId,
      prompt: workerPrompt({
        task,
        ...(origin ? { trigger: origin } : {}),
        policy: domain.policy,
        relatedTasks: related,
        pendingTriggers,
      }),
      context: {
        confirmedRules: domain.policy.rules.filter(rule => rule.enabled).map(rule => rule.instruction),
        relatedTaskIds: related.map(item => item.id),
        threadKeys: origin?.threadKeys ?? [],
      },
    }

    this.logger.info('assignment started', { taskId: task.id, assignmentId, attempt, sessionId })
    await this.publish('assignment.started', task.tenantId, task.domainId, { taskId: task.id, assignmentId, sessionId })

    for (const input of pending) {
      await this.store.markInputDelivered(input.id, assignmentId)
      await this.store.markInputConsumed(input.id)
    }

    const runtime = this.runtimes.get(runtimeType)
    const controller = new AbortController()
    const context: RuntimeContext = {
      tenantId: task.tenantId,
      domainId: task.domainId,
      workspaceDir,
      artifacts: this.artifacts,
      signal: controller.signal,
      log: this.logger.child({ taskId: task.id, assignmentId }),
      usage: usage => {
        void this.store
          .insertUsage({
            tenantId: task.tenantId,
            domainId: task.domainId,
            taskId: task.id,
            model: usage.model,
            tokensIn: usage.tokensIn,
            tokensOut: usage.tokensOut,
            ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
          })
          .catch(error => this.logger.warn('usage insert failed', { error: String(error) }))
      },
    }

    const handle = await runtime.start(spec, context)
    let finished: Extract<WorkerEvent, { type: 'finished' }> | undefined

    let polling = false
    const inputPoll = setInterval(() => {
      if (polling || finished) return
      polling = true
      void (async () => {
        try {
          const inputs = await this.store.listPendingInputs(task.id)
          for (const input of inputs) {
            let text = input.text
            if (input.triggerId) {
              const trigger = await this.store.getTrigger(input.triggerId)
              if (trigger) text = `New event on ${trigger.objectType} ${trigger.objectId}: ${trigger.summary}`
            }
            if (!text) continue
            try {
              await handle.send({
                id: input.id,
                taskId: task.id,
                assignmentId,
                kind: 'trigger',
                ...(input.triggerId ? { triggerId: input.triggerId } : {}),
                text,
                state: 'pending',
                createdAt: new Date().toISOString(),
              })
              await this.store.markInputDelivered(input.id, assignmentId)
              await this.store.markInputConsumed(input.id)
            } catch (error) {
              this.logger.debug('input not delivered', { taskId: task.id, inputId: input.id, error: String(error) })
            }
          }
        } finally {
          polling = false
        }
      })()
    }, 2_000)

    for await (const event of handle.events()) {
      await this.store.appendSessionEvent(handle.sessionId, event)
      await this.publish('session.event', task.tenantId, task.domainId, {
        taskId: task.id,
        assignmentId,
        sessionId: handle.sessionId,
        event,
      })
      if (event.type === 'report') {
        await this.store.insertReport({
          id: randomUUID(),
          taskId: task.id,
          assignmentId,
          kind: event.report.kind,
          body: event.report.body,
          evidence: event.report.evidence,
          unresolved: event.report.unresolved,
        })
        if (event.report.kind === 'waiting' || event.report.kind === 'blocked') {
          await this.store.updateTaskState(task.id, event.report.kind === 'waiting' ? 'awaiting_input' : 'blocked')
        }
      } else if (event.type === 'finished') {
        finished = event
      }
    }

    clearInterval(inputPoll)
    await handle.dispose().catch(() => undefined)
    await this.store.endWorkerSession(sessionId, 'ended')
    const outcome = finished?.outcome ?? 'failed'
    const mapped = taskStateForOutcome(outcome)
    await this.store.finishAssignment({
      assignmentId,
      taskId: task.id,
      assignmentState: mapped.assignmentState,
      taskState: mapped.taskState,
      result: finished?.summary ?? 'worker ended without a final event',
    })

    if (origin?.channel) {
      await this.store.enqueueOutbox({
        id: randomUUID(),
        tenantId: task.tenantId,
        domainId: task.domainId,
        channel: origin.channel,
        text: finished?.summary ?? `Task ${task.title} ended (${outcome}).`,
        kind: 'notice',
        idemKey: `task:${task.id}:${assignmentId}:finished`,
      })
      await this.wakeup.notify({ queue: 'outbox', domainId: task.domainId }).catch(() => undefined)
    }

    this.logger.info('assignment finished', { taskId: task.id, assignmentId, outcome })
    await this.publish('assignment.finished', task.tenantId, task.domainId, {
      taskId: task.id,
      assignmentId,
      outcome,
      taskState: mapped.taskState,
      summary: finished?.summary,
    })
  }
}
