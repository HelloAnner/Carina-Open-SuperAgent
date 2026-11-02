import type { ChannelRegistry } from '@carina/channels'
import type { EventPublisher, Logger } from '@carina/contracts'
import type { Store } from '@carina/persistence'

export class OutboxService {
  constructor(
    private readonly store: Store,
    private readonly channels: ChannelRegistry,
    private readonly events: EventPublisher,
    private readonly logger: Logger,
  ) {}

  /** Claim and send due outbox messages. Returns how many were attempted. */
  async runOnce(limit = 20): Promise<number> {
    const messages = await this.store.claimOutbox(limit)
    for (const message of messages) {
      try {
        const source = await this.store.getSourceInstance(message.channel.sourceInstanceId)
        if (!source) {
          await this.store.markOutboxFailed(message.id, message.attempts, 'source instance not found', true)
          continue
        }
        if (!source.enabled) {
          await this.store.markOutboxFailed(message.id, message.attempts, 'source instance disabled', true)
          continue
        }
        const result = await this.channels.send(message, source.config)
        if (result === 'gone') {
          await this.store.markOutboxFailed(message.id, message.attempts, 'channel gone', true)
        } else {
          await this.store.markOutboxSent(message.id)
          await this.events
            .publish({
              type: 'outbox.sent',
              tenantId: message.tenantId,
              domainId: message.domainId,
              at: new Date().toISOString(),
              data: { outboxId: message.id, kind: message.kind },
            })
            .catch(() => undefined)
        }
      } catch (error) {
        const dead = message.attempts >= 5
        this.logger.warn('outbox send failed', { id: message.id, attempts: message.attempts, error: String(error) })
        await this.store.markOutboxFailed(message.id, message.attempts, String(error), dead)
      }
    }
    return messages.length
  }
}
