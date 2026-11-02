import type { Logger } from '@carina/contracts'
import type { Store } from '@carina/persistence'
import type { WakeupBus } from '@carina/queue'

export interface WatchdogConfig {
  stuckRouterMs: number
  staleAssignmentMs: number
}

const defaults = (): WatchdogConfig => ({
  stuckRouterMs: Number(process.env.WATCHDOG_STUCK_ROUTER_MS ?? 5 * 60_000),
  staleAssignmentMs: Number(process.env.WATCHDOG_STALE_ASSIGNMENT_MS ?? 45 * 60_000),
})

export class WatchdogService {
  constructor(
    private readonly store: Store,
    private readonly wakeup: WakeupBus,
    private readonly logger: Logger,
    private readonly config: WatchdogConfig = defaults(),
  ) {}

  async tick(): Promise<{ requeued: number; failed: number }> {
    let requeued = 0
    let failed = 0

    const stuck = await this.store.listStuckRouterInbox(this.config.stuckRouterMs)
    for (const item of stuck) {
      await this.store.requeueRouterInbox(item.id)
      await this.wakeup.notify({ queue: 'router', domainId: item.domainId }).catch(() => undefined)
      await this.store.insertWatchAlert({
        tenantId: 'system',
        domainId: item.domainId,
        kind: 'router.stuck',
        severity: 'warning',
        detail: `router inbox item ${item.id} requeued`,
      })
      requeued += 1
    }

    const stale = await this.store.listStaleAssignments(this.config.staleAssignmentMs)
    for (const item of stale) {
      await this.store.finishAssignment({
        assignmentId: item.id,
        taskId: item.taskId,
        assignmentState: 'failed',
        taskState: 'failed',
        result: 'watchdog: assignment exceeded its wall clock',
      })
      await this.store.insertWatchAlert({
        tenantId: item.tenantId,
        domainId: item.domainId,
        taskId: item.taskId,
        kind: 'assignment.stale',
        severity: 'critical',
        detail: `assignment ${item.id} exceeded its wall clock`,
      })
      failed += 1
    }

    if (requeued || failed) {
      this.logger.warn('watchdog intervened', { requeued, failed })
    }
    return { requeued, failed }
  }
}
