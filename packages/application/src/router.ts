import { randomUUID } from 'node:crypto'
import type {
  DomainEventMessage,
  DomainPolicy,
  EventPublisher,
  Mandate,
  RouterAgent,
  RouterDecision,
  Trigger,
} from '@carina/contracts'
import type { Logger } from '@carina/contracts'
import { DEFAULT_BATCH_LIMITS, admitDecision, parseRouterDecision, planBatch, type BatchLimits } from '@carina/core'
import type { Store } from '@carina/persistence'
import type { LeaseManager, WakeupBus } from '@carina/queue'
import { defaultBudget, routerPrompt } from './prompts.js'

export interface RouterServiceConfig {
  batch: BatchLimits
  leaseMs: number
  workerRuntime: string
}

const defaultConfig = (): RouterServiceConfig => ({
  batch: DEFAULT_BATCH_LIMITS,
  leaseMs: 60_000,
  workerRuntime: process.env.WORKER_RUNTIME ?? 'stub',
})

export class RouterService {
  constructor(
    private readonly store: Store,
    private readonly agent: RouterAgent,
    private readonly leases: LeaseManager,
    private readonly events: EventPublisher,
    private readonly wakeup: WakeupBus,
    private readonly logger: Logger,
    private readonly config: RouterServiceConfig = defaultConfig(),
  ) {}

  private async publish(event: DomainEventMessage): Promise<void> {
    await this.events.publish(event).catch(() => undefined)
  }

  /** Process at most one Router batch for a domain. Returns the number of Threads evaluated. */
  async runDomain(domainId: string): Promise<number> {
    const domain = await this.store.getDomain(domainId)
    if (!domain || domain.policy.paused) return 0

    const leaseKey = `lease:domain:${domainId}:router`
    const token = randomUUID()
    if (!(await this.leases.acquire(leaseKey, token, this.config.leaseMs))) return 0

    try {
      const claimed = await this.store.claimRouterBatch(domainId, this.config.batch.maxEvents)
      if (claimed.length === 0) return 0

      const groups = new Map<string, typeof claimed>()
      for (const item of claimed) {
        const group = groups.get(item.threadKey) ?? []
        group.push(item)
        groups.set(item.threadKey, group)
      }

      let evaluated = 0
      for (const [threadKey, items] of groups) {
        const batch = planBatch(
          items.map(item => ({ ...item, chars: 0 })),
          this.config.batch,
          new Date(),
        )
        if (batch.length === 0) {
          for (const item of items) await this.store.requeueRouterInbox(item.id)
          continue
        }
        const ready = new Set(batch.map(item => item.id))
        const skipped = items.filter(item => !ready.has(item.id))
        for (const item of skipped) await this.store.requeueRouterInbox(item.id)
        if (!(await this.leases.held(leaseKey, token))) break
        await this.evaluate(domain.id, domain.tenantId, domain.policy, threadKey, batch)
        evaluated += 1
        if (skipped.length > 0 && this.wakeup) {
          await this.wakeup.notify({ queue: 'router', domainId }).catch(() => undefined)
        }
      }
      return evaluated
    } finally {
      await this.leases.release(leaseKey, token).catch(() => undefined)
    }
  }

  private async evaluate(
    domainId: string,
    tenantId: string,
    policy: DomainPolicy,
    threadKey: string,
    items: Array<{ id: string; triggerId: string; threadKey: string; createdAt: string }>,
  ): Promise<void> {
    const triggerIds = items.map(item => item.triggerId)
    const triggers = (await Promise.all(triggerIds.map(id => this.store.getTrigger(id)))).filter(
      (trigger): trigger is Trigger => trigger !== undefined,
    )
    if (triggers.length === 0) {
      for (const item of items) await this.store.finishRouterInbox(item.id, 'failed')
      return
    }

    const existing = await this.store.listTasksForThread(threadKey)
    const evaluationId = randomUUID()
    await this.store.createEvaluation({
      id: evaluationId,
      tenantId,
      domainId,
      threadKey,
      triggerIds,
      policyVersion: policy.version,
      status: 'running',
      startedAt: new Date().toISOString(),
    })

    try {
      const prompt = routerPrompt({
        domainId,
        policy,
        threadKey,
        triggers,
        tasks: existing,
      })
      const result = await this.agent.evaluate({ tenantId, domainId, prompt })
      const decision = parseRouterDecision(result.text)
      const knownTaskIds = new Set(existing.map(task => task.id))
      const admitted = admitDecision(decision, policy, knownTaskIds)
      await this.store.finishEvaluation({
        id: evaluationId,
        status: 'decided',
        decision: admitted,
      })
      await this.applyDecision({ domainId, tenantId, threadKey, triggers, decision: admitted, evaluationId })
      for (const item of items) {
        await this.store.finishRouterInbox(item.id, 'done')
      }
      await this.publish({
        type: 'decision.recorded',
        tenantId,
        domainId,
        at: new Date().toISOString(),
        data: { evaluationId, threadKey, kind: admitted.kind, triggerIds },
      })
    } catch (error) {
      this.logger.error('router evaluation failed', { domainId, threadKey, evaluationId, error: String(error) })
      await this.store.finishEvaluation({ id: evaluationId, status: 'failed' })
      for (const item of items) await this.store.requeueRouterInbox(item.id)
      await this.publish({
        type: 'evaluation.failed',
        tenantId,
        domainId,
        at: new Date().toISOString(),
        data: { evaluationId, threadKey, error: String(error) },
      })
    }
  }

  private async applyDecision(input: {
    domainId: string
    tenantId: string
    threadKey: string
    triggers: Trigger[]
    decision: RouterDecision
    evaluationId: string
  }): Promise<void> {
    const { decision, triggers, domainId, tenantId, threadKey, evaluationId } = input
    const origin = triggers[0]!
    switch (decision.kind) {
      case 'ignore':
        for (const trigger of triggers) await this.store.recordDisposition(trigger.id, 'ignored', decision.reason)
        return
      case 'reply': {
        if (!origin.channel) return
        await this.store.enqueueOutbox({
          id: randomUUID(),
          tenantId,
          domainId,
          channel: origin.channel,
          text: decision.text,
          kind: 'reply',
          idemKey: `reply:${evaluationId}`,
        })
        return
      }
      case 'link':
        return
      case 'cancel':
        await this.store.cancelTask(decision.taskId, decision.reason)
        return
      case 'create_task': {
        const mandate: Mandate = {
          policyVersion: (await this.store.getDomain(domainId))?.policy.version ?? 'unknown',
          strength: decision.strength,
          scope: decision.scope,
          allowedActions: decision.allowedActions,
          grantedBy: origin.actor,
          grantedAt: new Date().toISOString(),
        }
        const taskId = randomUUID()
        await this.store.createTask({
          id: taskId,
          tenantId,
          domainId,
          title: decision.title,
          scope: decision.scope,
          acceptance: decision.acceptance,
          mandate,
          originTriggerId: origin.id,
          budget: defaultBudget(),
          threadKey,
          assignmentId: randomUUID(),
          runtimeType: this.config.workerRuntime,
        })
        await this.publish({
          type: 'task.created',
          tenantId,
          domainId,
          at: new Date().toISOString(),
          data: { taskId, evaluationId, strength: decision.strength },
        })
        await this.wakeup.notify({ queue: 'executor', domainId }).catch(() => undefined)
        return
      }
      case 'unavailable':
        for (const trigger of triggers) await this.store.recordDisposition(trigger.id, 'ignored', decision.reason)
        return
    }
  }
}
