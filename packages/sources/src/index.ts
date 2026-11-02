import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { NormalizedTrigger, RawEvent, RawRequest, SourceKind } from '@carina/contracts'
import { z } from 'zod'

const header = (headers: RawRequest['headers'], name: string): string => {
  const value = headers[name] ?? headers[name.toLowerCase()]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

const now = (): string => new Date().toISOString()

const hashEvent = (payload: unknown): string =>
  createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32)

/** Generic signed JSON webhook. The body is one event or an array of events. */
export const webhookSource: SourceKind = {
  kind: 'webhook',
  title: 'Webhook',
  configSchema: z.object({ secret: z.string().optional() }),
  webhook: {
    verify(request, config) {
      const secret = typeof config.secret === 'string' ? config.secret : undefined
      if (!secret) return
      const provided = header(request.headers, 'x-carina-secret')
      const expected = Buffer.from(secret)
      const actual = Buffer.from(provided)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('invalid webhook secret')
      }
    },
    parse(request) {
      const body = request.body
      const items = Array.isArray(body) ? body : [body]
      return items.map((payload, index): RawEvent => {
        const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
        return {
          eventId: typeof record.eventId === 'string' && record.eventId ? record.eventId : `${hashEvent(payload)}-${index}`,
          receivedAt: now(),
          payload,
          headers: request.headers,
        }
      })
    },
  },
  normalize(raw) {
    const record = typeof raw.payload === 'object' && raw.payload !== null ? (raw.payload as Record<string, unknown>) : {}
    const objectType = typeof record.objectType === 'string' ? record.objectType : 'event'
    const objectId = typeof record.objectId === 'string' ? record.objectId : raw.eventId
    const threadKey = typeof record.threadKey === 'string' ? record.threadKey : `webhook:${objectType}:${objectId}`
    const actorRecord = typeof record.actor === 'object' && record.actor !== null ? (record.actor as Record<string, unknown>) : {}
    const text = typeof record.text === 'string' ? record.text : JSON.stringify(record)
    const channelAddress: Record<string, string> =
      typeof record.replyUrl === 'string' ? { replyUrl: record.replyUrl } : { objectId }
    return {
      sourceEventId: raw.eventId,
      objectType,
      objectId,
      actor: {
        id: typeof actorRecord.id === 'string' ? actorRecord.id : 'unknown',
        kind: actorRecord.kind === 'bot' ? 'bot' : 'human',
        ...(typeof actorRecord.display === 'string' ? { display: actorRecord.display } : {}),
      },
      occurredAt: typeof record.occurredAt === 'string' ? record.occurredAt : raw.receivedAt,
      threadKeys: [threadKey],
      contentType: 'text/plain',
      summary: text,
      channelAddress,
      payload: record,
    }
  },
}

const githubEventTypes = new Set([
  'pull_request',
  'issue_comment',
  'pull_request_review_comment',
  'issues',
])

const githubConfig = z.object({
  webhookSecret: z.string().optional(),
  token: z.string().optional(),
  repository: z.string().optional(),
})

export const githubSource: SourceKind = {
  kind: 'github',
  title: 'GitHub',
  configSchema: githubConfig,
  webhook: {
    verify(request, config) {
      const secret = typeof config.webhookSecret === 'string' ? config.webhookSecret : undefined
      if (!secret) return
      const signature = header(request.headers, 'x-hub-signature-256')
      if (!signature || !request.rawBody) throw new Error('missing github signature or raw body')
      const expected = `sha256=${createHmac('sha256', secret).update(request.rawBody).digest('hex')}`
      const expectedBuffer = Buffer.from(expected)
      const actualBuffer = Buffer.from(signature)
      if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
        throw new Error('invalid github signature')
      }
    },
    parse(request) {
      const event = header(request.headers, 'x-github-event')
      const delivery = header(request.headers, 'x-github-delivery')
      if (!event || !delivery) return []
      if (!githubEventTypes.has(event)) return []
      return [{ eventId: delivery, receivedAt: now(), payload: request.body, headers: request.headers }]
    },
  },
  normalize(raw) {
    const body = (raw.payload ?? {}) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''
    const repository = (body.repository ?? {}) as Record<string, unknown>
    const repo = typeof repository.full_name === 'string' ? repository.full_name : 'unknown/repo'
    const issue = (body.issue ?? {}) as Record<string, unknown>
    const pull = (body.pull_request ?? {}) as Record<string, unknown>
    const comment = (body.comment ?? {}) as Record<string, unknown>
    const sender = (body.sender ?? {}) as Record<string, unknown>
    const number = Number(issue.number ?? pull.number ?? 0)
    const isPull = pull.url !== undefined || issue.pull_request !== undefined
    const objectType = isPull ? 'pull_request' : 'issue'
    const objectId = `${repo}#${number}`
    const title = String(pull.title ?? issue.title ?? '')
    const bodyText = String(comment.body ?? pull.body ?? issue.body ?? '')
    const summary = [action && `${action}`, title, bodyText].filter(Boolean).join(' ').trim() || `github ${objectType} event`
    const eventUrl = String(comment.html_url ?? pull.html_url ?? issue.html_url ?? '')
    const occurredAt = String(comment.created_at ?? pull.updated_at ?? issue.updated_at ?? raw.receivedAt)
    const actor: NormalizedTrigger['actor'] = {
      id: String(sender.login ?? 'unknown'),
      kind: sender.type === 'Bot' ? 'bot' : 'human',
      ...(typeof sender.login === 'string' ? { display: sender.login } : {}),
    }
    return {
      sourceEventId: raw.eventId,
      objectType,
      objectId,
      objectVersion: typeof pull.updated_at === 'string' ? pull.updated_at : undefined,
      actor,
      occurredAt,
      threadKeys: [`github:${objectType}:${objectId}`],
      contentType: 'text/plain',
      summary,
      channelAddress: { repository: repo, number: String(number), objectType },
      payload: {
        action,
        title,
        body: bodyText,
        url: eventUrl,
        number,
        repository: repo,
        event: header(raw.headers, 'x-github-event'),
      },
    }
  },
}

export class SourceRegistry {
  private readonly kinds = new Map<string, SourceKind>()

  register(kind: SourceKind): this {
    if (this.kinds.has(kind.kind)) throw new Error(`source kind already registered: ${kind.kind}`)
    this.kinds.set(kind.kind, kind)
    return this
  }

  get(kind: string): SourceKind {
    const source = this.kinds.get(kind)
    if (!source) throw new Error(`source kind not registered: ${kind}`)
    return source
  }

  has(kind: string): boolean {
    return this.kinds.has(kind)
  }

  list(): SourceKind[] {
    return [...this.kinds.values()]
  }
}

export const defaultSourceRegistry = (): SourceRegistry =>
  new SourceRegistry().register(webhookSource).register(githubSource)
