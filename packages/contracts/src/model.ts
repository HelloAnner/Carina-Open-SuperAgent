/** Core domain types. This package has no I/O and no runtime dependencies beyond zod. */

export type Id = string
export type Timestamp = string

export interface Actor {
  id: string
  kind: 'human' | 'bot' | 'system'
  display?: string
}

export interface Budget {
  maxTokens: number
  maxCostUsd: number
  maxWallClockMs: number
}

export interface Trigger {
  id: Id
  tenantId: Id
  domainId: Id
  sourceInstanceId: Id
  sourceKind: string
  sourceEventId: string
  objectType: string
  objectId: string
  objectVersion?: string
  actor: Actor
  occurredAt: Timestamp
  receivedAt: Timestamp
  threadKeys: string[]
  causationId?: string
  correlationId?: string
  contentType: string
  summary: string
  /** Where a reply to this Trigger's Thread should go. */
  channel?: ChannelAddress
  payloadRef?: string
  raw?: Record<string, unknown>
}

export type TriggerDispositionKind = 'fanned_out' | 'queued_for_router' | 'duplicate' | 'rejected' | 'ignored'

export interface Thread {
  key: string
  tenantId: Id
  domainId: Id
  sourceInstanceId: Id
  sourceKind: string
  objectType: string
  objectId: string
  lastTriggerAt: Timestamp
}

export interface ThreadSubscription {
  threadKey: string
  taskId: Id
  purpose: 'origin' | 'context'
  state: 'active' | 'dropped'
}

export type TaskState =
  | 'open'
  | 'running'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'blocked'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type Strength = 'explicit' | 'inferred'

export interface Mandate {
  policyVersion: string
  strength: Strength
  scope: string
  allowedActions: string[]
  grantedBy: Actor
  grantedAt: Timestamp
}

export interface Task {
  id: Id
  tenantId: Id
  domainId: Id
  title: string
  scope: string
  acceptance: string
  state: TaskState
  mandate: Mandate
  originTriggerId: Id
  planVersion: number
  budget: Budget
  createdAt: Timestamp
  updatedAt: Timestamp
}

export type AssignmentState = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain'

export interface Assignment {
  id: Id
  taskId: Id
  attempt: number
  runtimeType: string
  state: AssignmentState
  fencingToken: number
  startedAt?: Timestamp
  endedAt?: Timestamp
  result?: string
}

export type WorkerSessionState = 'starting' | 'running' | 'waiting' | 'ended'

export interface WorkerSession {
  id: Id
  taskId: Id
  assignmentId: Id
  runtimeType: string
  state: WorkerSessionState
  workspaceRef?: string
  resumeToken?: string
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface WorkerInput {
  id: Id
  taskId: Id
  assignmentId?: Id
  kind: 'trigger' | 'text' | 'policy' | 'resume'
  triggerId?: Id
  text?: string
  state: 'pending' | 'delivered' | 'consumed'
  createdAt: Timestamp
}

export interface WorkerSpec {
  taskId: Id
  assignmentId: Id
  domainId: Id
  tenantId: Id
  title: string
  goal: string
  acceptance: string
  scope: string
  strength: Strength
  allowedActions: string[]
  budget: Budget
  planVersion: number
  workspaceRef: string
  originTriggerId: Id
  /** Full first-turn assignment prompt, assembled by the application layer. */
  prompt: string
  context: {
    confirmedRules: string[]
    relatedTaskIds: Id[]
    threadKeys: string[]
  }
}

export type WorkerEvent =
  | { type: 'started'; at: Timestamp }
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; ok: boolean; outputRef?: string }
  | { type: 'report'; report: ReportInput }
  | { type: 'awaiting_input'; question: string }
  | { type: 'awaiting_approval'; approvalId: Id }
  | {
      type: 'finished'
      outcome: 'succeeded' | 'failed' | 'cancelled' | 'blocked' | 'awaiting_input'
      summary: string
    }

export type ReportKind = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export interface ReportInput {
  kind: ReportKind
  body: string
  evidence?: string[]
  unresolved?: string[]
}

export interface Report extends ReportInput {
  id: Id
  taskId: Id
  assignmentId: Id
  createdAt: Timestamp
}

export type DecisionKind = 'ignore' | 'reply' | 'link' | 'create_task' | 'cancel' | 'unavailable'

export type RouterDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'reply'; text: string; reason: string }
  | { kind: 'link'; taskId: Id; reason: string }
  | {
      kind: 'create_task'
      title: string
      scope: string
      acceptance: string
      strength: Strength
      allowedActions: string[]
      reason: string
    }
  | { kind: 'cancel'; taskId: Id; reason: string }
  | { kind: 'unavailable'; reason: string }

export interface Evaluation {
  id: Id
  tenantId: Id
  domainId: Id
  threadKey: string
  triggerIds: Id[]
  policyVersion: string
  status: 'running' | 'decided' | 'failed'
  decision?: RouterDecision
  model?: string
  tokensIn?: number
  tokensOut?: number
  startedAt: Timestamp
  endedAt?: Timestamp
}

export interface ChannelAddress {
  sourceKind: string
  sourceInstanceId: Id
  address: Record<string, string>
}

export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead'

export interface OutboxMessage {
  id: Id
  tenantId: Id
  domainId: Id
  channel: ChannelAddress
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  idemKey: string
  status: OutboxStatus
  attempts: number
  nextAttemptAt: Timestamp
  createdAt: Timestamp
  sentAt?: Timestamp
}

export interface SourceInstance {
  id: Id
  tenantId: Id
  domainId: Id
  kind: string
  name: string
  enabled: boolean
  config: Record<string, unknown>
}

export interface DomainPolicy {
  version: string
  paused: boolean
  acceptMode: 'explicit' | 'inferred'
  rules: PolicyRule[]
}

export interface PolicyRule {
  id: string
  name: string
  instruction: string
  enabled: boolean
  inferred?: boolean
}

export interface RawRequest {
  headers: Record<string, string | string[] | undefined>
  query: Record<string, string | undefined>
  body: unknown
  rawBody?: string
}

export interface RawEvent {
  eventId: string
  receivedAt: Timestamp
  payload: unknown
  headers: Record<string, string | string[] | undefined>
}

export interface NormalizedTrigger {
  sourceEventId: string
  objectType: string
  objectId: string
  objectVersion?: string
  actor: Actor
  occurredAt: Timestamp
  threadKeys: string[]
  contentType: string
  summary: string
  /** Source-specific reply address, completed with source instance by ingest. */
  channelAddress?: Record<string, string>
  payload?: Record<string, unknown>
}
