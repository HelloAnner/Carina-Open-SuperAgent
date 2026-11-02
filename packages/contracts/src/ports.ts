import type {
  ChannelAddress,
  OutboxMessage,
  RawEvent,
  RawRequest,
  NormalizedTrigger,
  WorkerEvent,
  WorkerInput,
  WorkerSpec,
} from './model.js'

/** A source adapter: verification, normalization, optional polling and outbound channel. */
export interface SourceKind {
  kind: string
  title: string
  configSchema: { parse(value: unknown): Record<string, unknown> }
  webhook?: {
    verify(request: RawRequest, config: Record<string, unknown>): Promise<void> | void
    parse(request: RawRequest, config: Record<string, unknown>): Promise<RawEvent[]> | RawEvent[]
  }
  /** Reserved for pull-based sources; the first phase uses webhooks. */
  poll?: {
    intervalMs(config: Record<string, unknown>): number
    fetch(cursor: string | null, config: Record<string, unknown>): Promise<{ events: RawEvent[]; next: string }>
  }
  normalize(raw: RawEvent, config: Record<string, unknown>): NormalizedTrigger
  channel?: ChannelAdapter
}

export interface ChannelAdapter {
  /** Must be idempotent by message.idemKey where the target supports it. */
  send(message: OutboxMessage, config: Record<string, unknown>, signal?: AbortSignal): Promise<'sent' | 'gone'>
  link?(address: ChannelAddress, config: Record<string, unknown>): { url: string; label: string }
}

/**
 * Runs a Router judgement turn. The implementation owns the process/model;
 * the prompt and the structured output contract are application concerns.
 */
export interface RouterAgent {
  evaluate(input: {
    tenantId: string
    domainId: string
    prompt: string
    signal?: AbortSignal
  }): Promise<{ text: string; sessionId: string }>
}

export interface WorkerRuntime {
  type: string
  start(spec: WorkerSpec, context: RuntimeContext): Promise<WorkerHandle>
}

export interface WorkerHandle {
  sessionId: string
  send(input: WorkerInput): Promise<void>
  cancel(reason: string): Promise<void>
  events(): AsyncIterable<WorkerEvent>
  dispose(): Promise<void>
}

export interface RuntimeContext {
  tenantId: string
  domainId: string
  workspaceDir: string
  artifacts: ArtifactStore
  signal: AbortSignal
  log: Logger
  /** Receives runtime-side progress that is not a WorkerEvent (tool traces, usage). */
  usage?(usage: { model: string; tokensIn: number; tokensOut: number; costUsd?: number }): void
}

export interface ArtifactStore {
  put(input: { tenantId: string; domainId: string; taskId: string; kind: string; body: string | Uint8Array; mime?: string }): Promise<{
    id: string
    storageKey: string
    sha256: string
    size: number
  }>
  get(storageKey: string): Promise<Uint8Array>
}

export interface DomainEventMessage {
  type: string
  tenantId: string
  domainId: string
  data: Record<string, unknown>
  at: string
}

export interface EventPublisher {
  publish(event: DomainEventMessage): Promise<void>
}

export type Unsubscribe = () => void

export interface EventSubscriber {
  subscribe(handler: (event: DomainEventMessage) => void): Promise<Unsubscribe>
}

export interface Logger {
  child(bindings: Record<string, unknown>): Logger
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}
