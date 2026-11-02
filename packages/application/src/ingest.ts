import { randomUUID } from 'node:crypto'
import type { DomainEventMessage, EventPublisher, RawRequest, SourceInstance, Trigger } from '@carina/contracts'
import type { WakeupBus } from '@carina/queue'
import type { Store } from '@carina/persistence'
import type { SourceRegistry } from '@carina/sources'

export interface IngestResult {
  accepted: number
  duplicates: number
  triggerIds: string[]
}

export class IngestService {
  constructor(
    private readonly store: Store,
    private readonly sources: SourceRegistry,
    private readonly events: EventPublisher,
    private readonly wakeup?: WakeupBus,
    private readonly runtimeType: string = process.env.WORKER_RUNTIME ?? 'stub',
  ) {}

  private async publish(event: DomainEventMessage): Promise<void> {
    await this.events.publish(event).catch(() => undefined)
  }

  async ingest(source: SourceInstance, request: RawRequest): Promise<IngestResult> {
    const kind = this.sources.get(source.kind)
    const config = kind.configSchema.parse(source.config)
    if (!kind.webhook) throw new Error(`source ${source.kind} has no webhook receiver`)
    await kind.webhook.verify(request, config)
    const rawEvents = await kind.webhook.parse(request, config)

    const result: IngestResult = { accepted: 0, duplicates: 0, triggerIds: [] }
    for (const raw of rawEvents) {
      const normalized = kind.normalize(raw, config)
      const occurred = new Date(normalized.occurredAt)
      const occurredAt = Number.isNaN(occurred.getTime()) ? new Date().toISOString() : occurred.toISOString()
      const trigger: Trigger = {
        id: randomUUID(),
        tenantId: source.tenantId,
        domainId: source.domainId,
        sourceInstanceId: source.id,
        sourceKind: source.kind,
        sourceEventId: normalized.sourceEventId,
        objectType: normalized.objectType,
        objectId: normalized.objectId,
        ...(normalized.objectVersion ? { objectVersion: normalized.objectVersion } : {}),
        actor: normalized.actor,
        occurredAt,
        receivedAt: raw.receivedAt,
        threadKeys: normalized.threadKeys,
        contentType: normalized.contentType,
        summary: normalized.summary,
        channel: {
          sourceKind: source.kind,
          sourceInstanceId: source.id,
          address: normalized.channelAddress ?? { objectId: normalized.objectId },
        },
        ...(normalized.payload ? { raw: normalized.payload } : {}),
      }
      const inserted = await this.store.ingestTrigger(trigger)
      if (!inserted.inserted) {
        result.duplicates += 1
        continue
      }
      let resumed = false
      for (const taskId of inserted.taskIds) {
        if (await this.store.resumeTaskIfNeeded(taskId, this.runtimeType)) resumed = true
      }
      result.accepted += 1
      result.triggerIds.push(trigger.id)
      await this.publish({
        type: 'trigger.received',
        tenantId: trigger.tenantId,
        domainId: trigger.domainId,
        at: new Date().toISOString(),
        data: { triggerId: trigger.id, threadKeys: trigger.threadKeys, taskIds: inserted.taskIds, resumed },
      })
      if (this.wakeup) {
        await this.wakeup
          .notify({
            queue: inserted.taskIds.length > 0 ? 'executor' : 'router',
            domainId: trigger.domainId,
          })
          .catch(() => undefined)
      }
    }
    return result
  }
}
