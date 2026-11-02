import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { IngestService } from '@carina/application'
import type { RawRequest, SourceInstance } from '@carina/contracts'
import { rootLogger } from '@carina/observability'
import { createDb, Store } from '@carina/persistence'
import { createRedis, RedisEventBus, WakeupBus } from '@carina/queue'
import { defaultSourceRegistry } from '@carina/sources'
import { z } from 'zod'

const env = (key: string, fallback: string): string => process.env[key] ?? fallback

const bootstrapBody = z.object({
  domainId: z.string().min(1),
  text: z.string().min(1),
  objectId: z.string().optional(),
  actorId: z.string().optional(),
})

const sourceBody = z.object({
  domainId: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
})

const main = async (): Promise<void> => {
  const logger = rootLogger({ service: 'api' })
  const databaseUrl = env('DATABASE_URL', 'postgres://carina:carina@localhost:5432/carina')
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379')
  const apiKey = process.env.CARINA_API_KEY

  const db = createDb(databaseUrl)
  const store = new Store(db.db, db.sql)
  const redis = createRedis(redisUrl)
  const wakeSubscriber = createRedis(redisUrl)
  const wakes = new WakeupBus(redis, wakeSubscriber)
  const sources = defaultSourceRegistry()
  const workerRuntime = process.env.WORKER_RUNTIME ?? (process.env.DSH_RUNTIME === 'dsh' ? 'dsh' : 'stub')
  const ingest = new IngestService(store, sources, new RedisEventBus(redis, createRedis(redisUrl)), wakes, workerRuntime)

  if (env('BOOTSTRAP', 'true') === 'true') {
    const tenantId = env('BOOTSTRAP_TENANT_ID', 'demo')
    const domainId = env('BOOTSTRAP_DOMAIN_ID', 'demo')
    await store.createTenant({ id: tenantId, name: 'Demo tenant' })
    await store.createDomain({
      id: domainId,
      tenantId,
      name: 'Demo domain',
      policy: { version: 'v1', paused: false, acceptMode: 'explicit', rules: [] },
    })
    await store.createSourceInstance({
      id: `${domainId}-webhook`,
      tenantId,
      domainId,
      kind: 'webhook',
      name: 'Demo webhook',
      enabled: true,
      config: process.env.DEMO_WEBHOOK_SECRET ? { secret: process.env.DEMO_WEBHOOK_SECRET } : {},
    })
    if (process.env.GITHUB_REPOSITORY) {
      await store.createSourceInstance({
        id: `${domainId}-github`,
        tenantId,
        domainId,
        kind: 'github',
        name: `GitHub ${process.env.GITHUB_REPOSITORY}`,
        enabled: true,
        config: {
          repository: process.env.GITHUB_REPOSITORY,
          ...(process.env.GITHUB_WEBHOOK_SECRET ? { webhookSecret: process.env.GITHUB_WEBHOOK_SECRET } : {}),
          ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}),
        },
      })
    }
  }

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 })
  await app.register(cors, { origin: true })
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    ;(request as unknown as { rawBody?: string }).rawBody = body as string
    try {
      done(null, JSON.parse(body as string))
    } catch (error) {
      done(error as Error)
    }
  })

  app.addHook('preHandler', async (request, reply) => {
    if (!apiKey) return
    if (request.url.startsWith('/api/health') || request.url.startsWith('/api/webhooks/')) return
    const header = request.headers['x-carina-key']
    const authorization = request.headers.authorization
    const queryKey = (request.query as Record<string, string | undefined> | undefined)?.key
    const provided = Array.isArray(header) ? header[0] : header
    if (provided === apiKey || authorization === `Bearer ${apiKey}` || queryKey === apiKey) return
    await reply.code(401).send({ error: 'unauthorized' })
  })

  app.get('/api/health', async () => ({ ok: true, service: 'carina-api', at: new Date().toISOString() }))

  app.post('/api/webhooks/:sourceInstanceId', async (request, reply) => {
    const { sourceInstanceId } = request.params as { sourceInstanceId: string }
    const source = await store.getSourceInstance(sourceInstanceId)
    if (!source) return reply.code(404).send({ error: 'source instance not found' })
    if (!source.enabled) return reply.code(409).send({ error: 'source instance disabled' })
    try {
      const rawRequest: RawRequest = {
        headers: request.headers,
        query: request.query as Record<string, string | undefined>,
        body: request.body,
        ...(typeof (request as unknown as { rawBody?: string }).rawBody === 'string'
          ? { rawBody: (request as unknown as { rawBody?: string }).rawBody }
          : {}),
      }
      return await ingest.ingest(source, rawRequest)
    } catch (error) {
      request.log.error(error)
      return reply.code(400).send({ error: String(error) })
    }
  })

  app.get('/api/domains', async () => {
    const domains = await store.listDomains()
    return domains.map(domain => ({ id: domain.id, tenantId: domain.tenantId, name: domain.name, policy: domain.policy }))
  })

  app.get('/api/sources', async request => {
    const query = request.query as { domainId?: string }
    return store.listSourceInstances(query.domainId)
  })

  app.post('/api/sources', async (request, reply) => {
    const parsed = sourceBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() })
    const domain = await store.getDomain(parsed.data.domainId)
    if (!domain) return reply.code(404).send({ error: 'domain not found' })
    let config: Record<string, unknown>
    try {
      config = sources.get(parsed.data.kind).configSchema.parse(parsed.data.config)
    } catch (error) {
      return reply.code(400).send({ error: `invalid source config: ${String(error)}` })
    }
    const source: SourceInstance = {
      id: randomUUID(),
      tenantId: domain.tenantId,
      domainId: domain.id,
      kind: parsed.data.kind,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      config,
    }
    await store.createSourceInstance(source)
    return reply.code(201).send(source)
  })

  app.get('/api/domains/:domainId/tasks', async request => {
    const { domainId } = request.params as { domainId: string }
    return store.listTasks(domainId)
  })

  app.get('/api/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    const task = await store.getTask(taskId)
    if (!task) return reply.code(404).send({ error: 'task not found' })
    return { task, reports: await store.listReports(taskId) }
  })

  app.post('/api/tasks/:taskId/cancel', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    const task = await store.getTask(taskId)
    if (!task) return reply.code(404).send({ error: 'task not found' })
    await store.cancelTask(taskId, 'cancelled by user')
    await wakes.notify({ queue: 'executor', domainId: task.domainId }).catch(() => undefined)
    return { ok: true }
  })

  app.get('/api/domains/:domainId/triggers', async request => {
    const { domainId } = request.params as { domainId: string }
    return store.listTriggers(domainId)
  })

  app.get('/api/domains/:domainId/evaluations', async request => {
    const { domainId } = request.params as { domainId: string }
    return store.listEvaluations(domainId)
  })

  app.get('/api/domains/:domainId/outbox', async request => {
    const { domainId } = request.params as { domainId: string }
    return store.listOutbox(domainId)
  })

  app.post('/api/dev/simulate', async (request, reply) => {
    const parsed = bootstrapBody.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.format() })
    const instances = await store.listSourceInstances(parsed.data.domainId)
    const source = instances.find(item => item.kind === 'webhook')
    if (!source) return reply.code(404).send({ error: 'no webhook source for this domain' })
    const event = {
      eventId: randomUUID(),
      objectType: 'demo',
      objectId: parsed.data.objectId ?? randomUUID(),
      text: parsed.data.text,
      actor: { id: parsed.data.actorId ?? 'demo-user', kind: 'human', display: parsed.data.actorId ?? 'demo-user' },
      occurredAt: new Date().toISOString(),
    }
    return ingest.ingest(source, {
      headers: {},
      query: {},
      body: event,
    })
  })

  app.get('/api/events', async (request, reply) => {
    const query = request.query as { domainId?: string }
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    reply.raw.write(': connected\n\n')
    const subscriber = createRedis(redisUrl)
    const bus = new RedisEventBus(redis, subscriber)
    const off = await bus.subscribe(event => {
      if (query.domainId && event.domainId !== query.domainId) return
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    })
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      off()
      void subscriber.quit()
    })
  })

  const port = Number(env('PORT', '8080'))
  await app.listen({ port, host: '0.0.0.0' })
  logger.info('api ready', { port })

  const shutdown = async (): Promise<void> => {
    await app.close()
    await Promise.allSettled([redis.quit(), wakeSubscriber.quit(), db.close()])
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
