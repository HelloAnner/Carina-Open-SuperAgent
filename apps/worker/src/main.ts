import { mkdir } from 'node:fs/promises'
import { DshRouterAgent, DshWorkerRuntime, agentConfigFromEnv } from '@carina/agent'
import {
  ExecutorService,
  OutboxService,
  RouterService,
  WatchdogService,
} from '@carina/application'
import { defaultChannelRegistry } from '@carina/channels'
import type { RouterAgent } from '@carina/contracts'
import { rootLogger } from '@carina/observability'
import { createDb, LocalArtifactStore, Store } from '@carina/persistence'
import { createRedis, LeaseManager, RedisEventBus, WakeupBus } from '@carina/queue'
import { StubRouterAgent, StubWorkerRuntime, WorkerRuntimeRegistry } from '@carina/runtime'

const env = (key: string, fallback: string): string => process.env[key] ?? fallback

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const main = async (): Promise<void> => {
  const logger = rootLogger({ service: 'worker' })
  const databaseUrl = env('DATABASE_URL', 'postgres://carina:carina@localhost:5432/carina')
  const redisUrl = env('REDIS_URL', 'redis://localhost:6379')
  const role = env('WORKER_ROLE', 'all')
  const workspaceRoot = env('WORKSPACE_ROOT', '/data/workspaces')
  const artifactRoot = env('ARTIFACT_DIR', '/data/artifacts')

  await mkdir(workspaceRoot, { recursive: true })
  await mkdir(artifactRoot, { recursive: true })

  const db = createDb(databaseUrl)
  const store = new Store(db.db, db.sql)
  const redis = createRedis(redisUrl)
  const redisSubscriber = createRedis(redisUrl)
  const wakeSubscriber = createRedis(redisUrl)
  const leases = new LeaseManager(redis)
  const wakes = new WakeupBus(redis, wakeSubscriber)
  const events = new RedisEventBus(redis, redisSubscriber)
  const artifacts = new LocalArtifactStore(db.db, artifactRoot)
  const channels = defaultChannelRegistry(logger)

  const agentConfig = agentConfigFromEnv()
  const runtimes = new WorkerRuntimeRegistry()
  let routerAgent: RouterAgent
  if (agentConfig.runtime === 'dsh') {
    runtimes.register(new DshWorkerRuntime(agentConfig, logger))
    routerAgent = new DshRouterAgent(agentConfig, logger)
    logger.info('agent runtime', { runtime: 'dsh', provider: agentConfig.provider, workerModel: agentConfig.workerModel })
  } else {
    runtimes.register(new StubWorkerRuntime())
    routerAgent = new StubRouterAgent()
    logger.warn('agent runtime is stub; set DSH_RUNTIME=dsh, DSH_PROVIDER and model credentials for real runs')
  }

  const router = new RouterService(store, routerAgent, leases, events, wakes, logger, {
    batch: {
      maxWaitMs: Number(env('ROUTER_BATCH_WAIT_MS', '1500')),
      maxEvents: Number(env('ROUTER_BATCH_MAX_EVENTS', '20')),
      maxInputChars: Number(env('ROUTER_BATCH_MAX_CHARS', '120000')),
    },
    leaseMs: Number(env('ROUTER_LEASE_MS', '60000')),
    workerRuntime: agentConfig.runtime,
  })
  const executor = new ExecutorService(store, runtimes, artifacts, events, wakes, logger, { workspaceRoot })
  const outbox = new OutboxService(store, channels, events, logger)
  const watchdog = new WatchdogService(store, wakes, logger)

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    logger.info('worker stopping')
    await Promise.allSettled([
      routerAgent instanceof DshRouterAgent ? routerAgent.close() : Promise.resolve(),
      redis.quit(),
      redisSubscriber.quit(),
      wakeSubscriber.quit(),
      db.close(),
    ])
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())

  await wakes.subscribe(signal => {
    logger.debug('wakeup', { queue: signal.queue, domainId: signal.domainId })
  })

  logger.info('worker ready', { role, runtime: agentConfig.runtime })

  const loops: Array<Promise<void>> = []

  if (role === 'all' || role === 'router') {
    loops.push(
      (async () => {
        while (!stopping) {
          try {
            const domains = await store.listDomains()
            for (const domain of domains) await router.runDomain(domain.id)
          } catch (error) {
            logger.error('router loop failed', { error: String(error) })
          }
          await sleep(Number(env('ROUTER_POLL_MS', '500')))
        }
      })(),
    )
  }

  if (role === 'all' || role === 'executor') {
    loops.push(
      (async () => {
        while (!stopping) {
          try {
            const ran = await executor.runOnce(1)
            if (ran === 0) await sleep(Number(env('EXECUTOR_POLL_MS', '500')))
          } catch (error) {
            logger.error('executor loop failed', { error: String(error) })
            await sleep(1_000)
          }
        }
      })(),
    )
  }

  if (role === 'all' || role === 'outbox') {
    loops.push(
      (async () => {
        while (!stopping) {
          try {
            const sent = await outbox.runOnce(20)
            if (sent === 0) await sleep(Number(env('OUTBOX_POLL_MS', '1000')))
          } catch (error) {
            logger.error('outbox loop failed', { error: String(error) })
            await sleep(1_000)
          }
        }
      })(),
    )
  }

  if (role === 'all' || role === 'watchdog') {
    loops.push(
      (async () => {
        while (!stopping) {
          try {
            await watchdog.tick()
          } catch (error) {
            logger.error('watchdog tick failed', { error: String(error) })
          }
          await sleep(Number(env('WATCHDOG_INTERVAL_MS', '30000')))
        }
      })(),
    )
  }

  await Promise.all(loops)
  await stop()
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
