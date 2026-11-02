import type { ChannelAdapter, Logger, OutboxMessage } from '@carina/contracts'

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** Local fallback: acknowledgement is visible in logs and the platform UI. */
export const echoChannel: ChannelAdapter = {
  async send(message) {
    return message.text ? 'sent' : 'gone'
  },
}

const githubChannel: ChannelAdapter = {
  async send(message, config, signal) {
    const token = typeof config.token === 'string' ? config.token : ''
    if (!token) throw new Error('github token is not configured')
    const [repository, number] = message.channel.address.repository
      ? [message.channel.address.repository, message.channel.address.number]
      : message.channel.address.objectId?.split('#') ?? []
    if (!repository || !number) throw new Error('github channel address is incomplete')
    const response = await fetch(`https://api.github.com/repos/${repository}/issues/${number}/comments`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify({ body: message.text }),
      signal,
    })
    if (response.status === 404 || response.status === 410) return 'gone'
    if (!response.ok) throw new Error(`github comment failed: ${response.status} ${await response.text()}`)
    return 'sent'
  },
  link(address) {
    const repository = address.address.repository ?? ''
    const number = address.address.number ?? ''
    return { url: repository && number ? `https://github.com/${repository}/issues/${number}` : '', label: `${repository}#${number}` }
  },
}

const webhookChannel: ChannelAdapter = {
  async send(message, config, signal) {
    const replyUrl =
      message.channel.address.replyUrl ?? (typeof config.replyUrl === 'string' ? config.replyUrl : undefined)
    // With no external endpoint the platform itself is the channel; the message stays visible there.
    if (!replyUrl) return 'sent'
    const response = await fetch(replyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message.text, id: message.idemKey, kind: message.kind }),
      signal,
    })
    if (!response.ok) throw new Error(`webhook reply failed: ${response.status}`)
    return 'sent'
  },
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>()

  constructor(private readonly logger: Logger = noopLogger) {}

  register(sourceKind: string, adapter: ChannelAdapter): this {
    this.adapters.set(sourceKind, adapter)
    return this
  }

  resolve(sourceKind: string): ChannelAdapter {
    return this.adapters.get(sourceKind) ?? echoChannel
  }

  async send(message: OutboxMessage, sourceConfig: Record<string, unknown>, signal?: AbortSignal): Promise<'sent' | 'gone'> {
    const adapter = this.resolve(message.channel.sourceKind)
    const result = await adapter.send(message, sourceConfig, signal)
    this.logger.info('channel send', {
      id: message.id,
      sourceKind: message.channel.sourceKind,
      result,
    })
    return result
  }
}

export const defaultChannelRegistry = (logger?: Logger): ChannelRegistry =>
  new ChannelRegistry(logger).register('github', githubChannel).register('webhook', webhookChannel)
