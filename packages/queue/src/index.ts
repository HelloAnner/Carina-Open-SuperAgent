import { Redis } from 'ioredis'
import type { DomainEventMessage, EventPublisher, EventSubscriber } from '@carina/contracts'

export const createRedis = (url: string): Redis =>
  new Redis(url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
  })

const releaseScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

const renewScript = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

/** Short-lived distributed leases. Postgres remains the authority for durable state. */
export class LeaseManager {
  constructor(private readonly redis: Redis) {}

  async acquire(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.redis.set(key, token, 'PX', ttlMs, 'NX')
    return result === 'OK'
  }

  async renew(key: string, token: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(renewScript, 1, key, token, String(ttlMs))) === 1
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(releaseScript, 1, key, token)
  }

  async held(key: string, token: string): Promise<boolean> {
    return (await this.redis.get(key)) === token
  }
}

export interface WakeSignal {
  queue: string
  domainId: string
}

/** Low-latency notification only; losing a signal never loses work. */
export class WakeupBus {
  private readonly channel = 'carina:wake'

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {}

  async notify(signal: WakeSignal): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(signal))
  }

  async subscribe(handler: (signal: WakeSignal) => void): Promise<() => Promise<void>> {
    await this.subscriber.subscribe(this.channel)
    const listener = (channel: string, message: string): void => {
      if (channel !== this.channel) return
      try {
        const signal = JSON.parse(message) as WakeSignal
        if (typeof signal.queue === 'string' && typeof signal.domainId === 'string') handler(signal)
      } catch {
        // Ignore malformed notifications.
      }
    }
    this.subscriber.on('message', listener)
    return async () => {
      this.subscriber.off('message', listener)
      await this.subscriber.unsubscribe(this.channel)
    }
  }
}

/** Process-wide domain event fan-out for SSE. Postgres remains the durable record. */
export class RedisEventBus implements EventPublisher, EventSubscriber {
  private readonly channel = 'carina:events'

  constructor(
    private readonly publisher: Redis,
    private readonly subscriber: Redis,
  ) {}

  async publish(event: DomainEventMessage): Promise<void> {
    await this.publisher.publish(this.channel, JSON.stringify(event))
  }

  async subscribe(handler: (event: DomainEventMessage) => void): Promise<() => void> {
    await this.subscriber.subscribe(this.channel)
    const listener = (channel: string, message: string): void => {
      if (channel !== this.channel) return
      try {
        handler(JSON.parse(message) as DomainEventMessage)
      } catch {
        // Ignore malformed events.
      }
    }
    this.subscriber.on('message', listener)
    return () => {
      this.subscriber.off('message', listener)
      void this.subscriber.unsubscribe(this.channel)
    }
  }
}
