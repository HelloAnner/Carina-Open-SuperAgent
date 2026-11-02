import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  HarnessNotification,
  DeepSeekHarnessOptions,
} from '@deepseek-ai/dsh-sdk-client'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type {
  Logger,
  ReportInput,
  RuntimeContext,
  WorkerEvent,
  WorkerHandle,
  WorkerInput,
  WorkerRuntime,
  WorkerSpec,
} from '@carina/contracts'
import { workerReportSchema } from '@carina/contracts'
import type { AgentConfig } from './config.js'
import { AsyncQueue } from './async-queue.js'
import { turnFailure } from './dsh-errors.js'
import { writeWorkerPolicyPatch } from './dsh-policy.js'

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('')
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if (record.content !== undefined) return textOf(record.content)
    if (record.message !== undefined) return textOf(record.message)
  }
  return ''
}

const createdAt = (): string => new Date().toISOString()

const harnessOptions = (
  config: AgentConfig,
  cwd: string,
  model: string,
  patchPath: string,
  permissionMode: 'read-only' | 'workspace-write',
): DeepSeekHarnessOptions => ({
  cwd,
  provider: config.provider,
  model,
  maxTokens: config.maxTokens,
  requestTimeoutMs: config.requestTimeoutMs,
  env: { ...process.env, DSH_PERMISSION_MODE: permissionMode } as NodeJS.ProcessEnv,
  ...(config.dshBin ? { dshBin: config.dshBin } : {}),
  ...(config.dshHome ? { dshHome: config.dshHome } : {}),
  patches: [...config.patches, patchPath],
})

type TurnOutcome = 'succeeded' | 'failed' | 'blocked' | 'awaiting_input'

const parseReport = (text: string): { report: ReportInput; outcome: TurnOutcome } => {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  try {
    const parsed = workerReportSchema.parse(JSON.parse(fenced?.[1] ?? trimmed))
    const outcome =
      parsed.outcome === 'succeeded'
        ? 'succeeded'
        : parsed.outcome === 'failed'
          ? 'failed'
          : parsed.outcome === 'blocked'
            ? 'blocked'
            : 'awaiting_input'
    return {
      report: {
        kind:
          parsed.outcome === 'succeeded'
            ? 'ready'
            : parsed.outcome === 'failed'
              ? 'failed'
              : parsed.outcome === 'blocked'
                ? 'blocked'
                : 'waiting',
        body: parsed.summary,
        evidence: parsed.evidence,
        unresolved: parsed.unresolved,
      },
      outcome,
    }
  } catch {
    return { report: { kind: 'ready', body: text.slice(0, 8_000) }, outcome: 'succeeded' }
  }
}

class DshWorkerHandle implements WorkerHandle {
  readonly sessionId: string
  private readonly queue = new AsyncQueue<WorkerEvent>()
  private readonly controller = new AbortController()
  private readonly harness: DeepSeekHarness
  private readonly pending: string[] = []
  private finished = false
  private disposed = false
  private readonly loopPromise: Promise<void>

  constructor(
    private readonly config: AgentConfig,
    private readonly spec: WorkerSpec,
    private readonly context: RuntimeContext,
    patchPath: string,
  ) {
    this.sessionId = `worker-${spec.taskId}-${spec.assignmentId}`
    const canWrite = spec.allowedActions.includes('write_workspace') || spec.allowedActions.includes('run_command')
    this.harness = new DeepSeekHarness(
      harnessOptions(config, context.workspaceDir, config.workerModel, patchPath, canWrite ? 'workspace-write' : 'read-only'),
    )
    this.loopPromise = this.loop()
  }

  private log(): Logger {
    return this.context.log.child({ taskId: this.spec.taskId, sessionId: this.sessionId })
  }

  private onNotification = (notification: HarnessNotification): void => {
    if (notification.method !== 'session.event') return
    const params = notification.params as { sessionId?: string; event?: Record<string, unknown> }
    if (params.sessionId !== this.sessionId || !params.event) return
    const event = params.event
    const data = (event.data ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'assistant/message': {
        const text = textOf(data.message)
        if (text) this.queue.push({ type: 'assistant_delta', text })
        const usage = data.usage as Record<string, unknown> | undefined
        if (usage) {
          const tokensIn = Number(usage.input_tokens ?? usage.inputTokens ?? 0)
          const tokensOut = Number(usage.output_tokens ?? usage.outputTokens ?? 0)
          if (tokensIn || tokensOut) {
            this.context.usage?.({
              model: this.config.workerModel,
              tokensIn: Number.isFinite(tokensIn) ? tokensIn : 0,
              tokensOut: Number.isFinite(tokensOut) ? tokensOut : 0,
            })
          }
        }
        return
      }
      case 'tool/call':
        this.queue.push({
          type: 'tool_call',
          callId: String(data.callId ?? ''),
          name: String(data.name ?? 'unknown'),
          input: data.arguments ?? {},
        })
        return
      case 'tool/result':
        this.queue.push({
          type: 'tool_result',
          callId: String((data.message as Record<string, unknown> | undefined)?.callId ?? ''),
          ok: data.error === undefined,
        })
        return
      default:
        return
    }
  }

  private async loop(): Promise<void> {
    this.queue.push({ type: 'started', at: createdAt() })
    let prompt: string | undefined = this.spec.prompt
    try {
      while (prompt && !this.disposed) {
        const result = await this.harness.session(this.sessionId).run(prompt, {
          onNotification: this.onNotification,
        })
        const failure = turnFailure(result.events)
        if (failure) {
          this.queue.push({ type: 'report', report: { kind: 'failed', body: failure, unresolved: [] } })
          this.finish('failed', failure)
          return
        }
        const parsed = parseReport(result.finalResponse)
        this.queue.push({ type: 'report', report: parsed.report })
        prompt = this.pending.shift()
        if (!prompt) {
          // Give late fast-path inputs one event-loop turn to arrive before closing the turn.
          await new Promise(resolve => setTimeout(resolve, 0))
          prompt = this.pending.shift()
        }
        if (!prompt && !this.disposed) {
          this.finish(parsed.outcome, parsed.report.body)
          return
        }
      }
      if (!this.finished) this.finish('cancelled', 'worker disposed')
    } catch (error) {
      this.log().error('dsh worker turn failed', { error: String(error) })
      if (!this.finished) this.finish(this.disposed ? 'cancelled' : 'failed', String(error))
    }
  }

  private finish(outcome: 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'awaiting_input', summary: string): void {
    if (this.finished) return
    this.finished = true
    this.queue.push({ type: 'finished', outcome, summary })
    this.queue.end()
    void this.harness.close().catch(() => undefined)
  }

  async send(input: WorkerInput): Promise<void> {
    if (this.finished || this.disposed) throw new Error('worker session already finished')
    if (input.text) this.pending.push(input.text)
  }

  async cancel(reason: string): Promise<void> {
    if (this.finished) return
    this.disposed = true
    this.controller.abort()
    await this.harness.close().catch(() => undefined)
    this.finish('cancelled', reason)
  }

  events(): AsyncIterable<WorkerEvent> {
    return this.queue
  }

  async dispose(): Promise<void> {
    if (!this.finished) {
      this.disposed = true
      await this.cancel('disposed')
    }
    await this.loopPromise.catch(() => undefined)
  }
}

/** WorkerRuntime backed by `dsh --profile sdk`; one DSH runtime process per assignment. */
export class DshWorkerRuntime implements WorkerRuntime {
  readonly type = 'dsh'

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger = noopLogger,
  ) {}

  async start(spec: WorkerSpec, context: RuntimeContext): Promise<WorkerHandle> {
    await mkdir(join(context.workspaceDir), { recursive: true })
    const patchPath = await writeWorkerPolicyPatch(context.workspaceDir, spec.allowedActions)
    this.logger.info('starting dsh worker', {
      taskId: spec.taskId,
      workspace: context.workspaceDir,
      allowedActions: spec.allowedActions,
    })
    return new DshWorkerHandle(this.config, spec, context, patchPath)
  }
}
