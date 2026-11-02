import type {
  RouterAgent,
  RuntimeContext,
  WorkerEvent,
  WorkerHandle,
  WorkerInput,
  WorkerRuntime,
  WorkerSpec,
} from '@carina/contracts'

class StubWorkerHandle implements WorkerHandle {
  readonly sessionId: string
  private readonly buffer: WorkerEvent[] = []
  private finished = false

  constructor(private readonly spec: WorkerSpec) {
    this.sessionId = `stub-${spec.taskId}-${spec.assignmentId}`
    queueMicrotask(() => {
      if (this.finished) return
      this.buffer.push({ type: 'started', at: new Date().toISOString() })
      this.buffer.push({
        type: 'report',
        report: {
          kind: 'ready',
          body: `stub runtime completed: ${this.spec.title}`,
          evidence: ['stub'],
          unresolved: [],
        },
      })
      this.buffer.push({ type: 'finished', outcome: 'succeeded', summary: 'stub runtime completed' })
      this.finished = true
    })
  }

  async send(_input: WorkerInput): Promise<void> {
    // The stub performs one deterministic turn.
  }

  async cancel(_reason: string): Promise<void> {
    if (this.finished) return
    this.finished = true
    this.buffer.push({ type: 'finished', outcome: 'cancelled', summary: 'cancelled' })
  }

  async *events(): AsyncIterable<WorkerEvent> {
    while (true) {
      const next = this.buffer.shift()
      if (next) {
        yield next
        if (next.type === 'finished') return
      } else if (this.finished) {
        return
      } else {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
  }

  async dispose(): Promise<void> {
    this.finished = true
  }
}

export class StubWorkerRuntime implements WorkerRuntime {
  readonly type = 'stub'

  async start(spec: WorkerSpec, _context: RuntimeContext): Promise<WorkerHandle> {
    return new StubWorkerHandle(spec)
  }
}

/** Deterministic Router for local development without model credentials. */
export class StubRouterAgent implements RouterAgent {
  async evaluate(input: { prompt: string }): Promise<{ text: string; sessionId: string }> {
    const summary = input.prompt.match(/summary:\s*(.+)/)?.[1]?.trim()
    const title = (summary ?? input.prompt.split('\n').find(line => line.trim().length > 0) ?? 'new work').slice(0, 80)
    const decision = {
      kind: 'create_task',
      title,
      scope: 'stub scope',
      acceptance: 'stub acceptance',
      strength: 'explicit',
      allowedActions: ['read'],
      reason: 'stub runtime',
    }
    return { text: JSON.stringify(decision), sessionId: 'stub-router' }
  }
}

export class WorkerRuntimeRegistry {
  private readonly runtimes = new Map<string, WorkerRuntime>()

  register(runtime: WorkerRuntime): this {
    this.runtimes.set(runtime.type, runtime)
    return this
  }

  get(type: string): WorkerRuntime {
    const runtime = this.runtimes.get(type)
    if (!runtime) throw new Error(`worker runtime not registered: ${type}`)
    return runtime
  }

  types(): string[] {
    return [...this.runtimes.keys()]
  }
}
