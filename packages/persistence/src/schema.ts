import type {
  Actor,
  AssignmentState,
  Budget,
  ChannelAddress,
  DecisionKind,
  DomainPolicy,
  Evaluation,
  Mandate,
  OutboxStatus,
  ReportKind,
  RouterDecision,
  Strength,
  TaskState,
  TriggerDispositionKind,
  WorkerSessionState,
} from '@carina/contracts'
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const now = () => timestamp('created_at', { withTimezone: true }).defaultNow().notNull()

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: now(),
})

export const domains = pgTable('domains', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  name: text('name').notNull(),
  policy: jsonb('policy').$type<DomainPolicy>().notNull(),
  createdAt: now(),
})

export const sourceInstances = pgTable(
  'source_instances',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => tenants.id),
    domainId: text('domain_id').notNull().references(() => domains.id),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    createdAt: now(),
  },
  table => ({
    domainIdx: index('source_instances_domain_idx').on(table.domainId),
  }),
)

export const triggers = pgTable(
  'triggers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    domainId: text('domain_id').notNull(),
    sourceInstanceId: text('source_instance_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    objectVersion: text('object_version'),
    actor: jsonb('actor').$type<Actor>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    threadKeys: jsonb('thread_keys').$type<string[]>().notNull(),
    causationId: text('causation_id'),
    correlationId: text('correlation_id'),
    contentType: text('content_type').notNull(),
    summary: text('summary').notNull(),
    channel: jsonb('channel').$type<ChannelAddress>(),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    createdAt: now(),
  },
  table => ({
    dedupe: uniqueIndex('triggers_source_event_uidx').on(table.sourceInstanceId, table.sourceEventId),
    threadIdx: index('triggers_domain_thread_idx').on(table.domainId, table.occurredAt),
  }),
)

export const triggerDispositions = pgTable('trigger_dispositions', {
  triggerId: text('trigger_id').primaryKey().references(() => triggers.id),
  kind: text('kind').$type<TriggerDispositionKind>().notNull(),
  reason: text('reason'),
  evalId: text('eval_id'),
  createdAt: now(),
})

export const threads = pgTable(
  'threads',
  {
    key: text('key').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    domainId: text('domain_id').notNull(),
    sourceInstanceId: text('source_instance_id').notNull(),
    sourceKind: text('source_kind').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    lastTriggerAt: timestamp('last_trigger_at', { withTimezone: true }).notNull(),
    createdAt: now(),
  },
  table => ({
    domainIdx: index('threads_domain_idx').on(table.domainId),
  }),
)

export const threadSubscriptions = pgTable(
  'thread_subscriptions',
  {
    id: text('id').primaryKey(),
    threadKey: text('thread_key').notNull().references(() => threads.key),
    taskId: text('task_id').notNull(),
    purpose: text('purpose').$type<'origin' | 'context'>().notNull(),
    state: text('state').$type<'active' | 'dropped'>().notNull().default('active'),
    createdAt: now(),
  },
  table => ({
    uniq: uniqueIndex('thread_subscriptions_uidx').on(table.threadKey, table.taskId),
    taskIdx: index('thread_subscriptions_task_idx').on(table.taskId),
  }),
)

export const routerInbox = pgTable(
  'router_inbox',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    domainId: text('domain_id').notNull(),
    threadKey: text('thread_key').notNull(),
    triggerId: text('trigger_id').notNull(),
    state: text('state').$type<'pending' | 'processing' | 'done' | 'failed'>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    leaseToken: text('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    createdAt: now(),
  },
  table => ({
    claimIdx: index('router_inbox_claim_idx').on(table.domainId, table.state, table.availableAt),
    triggerUniq: uniqueIndex('router_inbox_trigger_uidx').on(table.triggerId),
  }),
)

export const evaluations = pgTable('evaluations', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  domainId: text('domain_id').notNull(),
  threadKey: text('thread_key').notNull(),
  triggerIds: jsonb('trigger_ids').$type<string[]>().notNull(),
  policyVersion: text('policy_version').notNull(),
  status: text('status').$type<Evaluation['status']>().notNull(),
  decision: jsonb('decision').$type<RouterDecision>(),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  createdAt: now(),
})

export const tasks = pgTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    domainId: text('domain_id').notNull(),
    title: text('title').notNull(),
    scope: text('scope').notNull(),
    acceptance: text('acceptance').notNull(),
    state: text('state').$type<TaskState>().notNull(),
    mandate: jsonb('mandate').$type<Mandate>().notNull(),
    originTriggerId: text('origin_trigger_id').notNull(),
    planVersion: integer('plan_version').notNull().default(1),
    budget: jsonb('budget').$type<Budget>().notNull(),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  table => ({
    domainStateIdx: index('tasks_domain_state_idx').on(table.domainId, table.state),
    originIdx: index('tasks_origin_trigger_idx').on(table.originTriggerId),
  }),
)

export const assignments = pgTable(
  'assignments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => tasks.id),
    attempt: integer('attempt').notNull(),
    runtimeType: text('runtime_type').notNull(),
    state: text('state').$type<AssignmentState>().notNull(),
    fencingToken: integer('fencing_token').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    result: text('result'),
    createdAt: now(),
  },
  table => ({
    taskIdx: index('assignments_task_idx').on(table.taskId),
    claimIdx: index('assignments_claim_idx').on(table.state, table.createdAt),
    attemptUniq: uniqueIndex('assignments_task_attempt_uidx').on(table.taskId, table.attempt),
  }),
)

export const workerSessions = pgTable('worker_sessions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  assignmentId: text('assignment_id').notNull().references(() => assignments.id),
  runtimeType: text('runtime_type').notNull(),
  state: text('state').$type<WorkerSessionState>().notNull(),
  workspaceRef: text('workspace_ref'),
  resumeToken: text('resume_token'),
  createdAt: now(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const workerInputs = pgTable(
  'worker_inputs',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id').notNull().references(() => tasks.id),
    assignmentId: text('assignment_id'),
    kind: text('kind').$type<'trigger' | 'text' | 'policy' | 'resume'>().notNull(),
    triggerId: text('trigger_id'),
    text: text('text'),
    state: text('state').$type<'pending' | 'delivered' | 'consumed'>().notNull().default('pending'),
    createdAt: now(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  table => ({
    taskIdx: index('worker_inputs_task_idx').on(table.taskId, table.state),
  }),
)

export const sessionEvents = pgTable(
  'session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: text('session_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: now(),
  },
  table => ({
    sessionIdx: index('session_events_session_idx').on(table.sessionId, table.id),
  }),
)

export const reports = pgTable('reports', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().references(() => tasks.id),
  assignmentId: text('assignment_id').notNull(),
  kind: text('kind').$type<ReportKind>().notNull(),
  body: text('body').notNull(),
  evidence: jsonb('evidence').$type<string[]>(),
  unresolved: jsonb('unresolved').$type<string[]>(),
  createdAt: now(),
})

export const outbox = pgTable(
  'outbox',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    domainId: text('domain_id').notNull(),
    channel: jsonb('channel').$type<ChannelAddress>().notNull(),
    text: text('text').notNull(),
    kind: text('kind').$type<'acknowledgement' | 'reply' | 'notice'>().notNull(),
    idemKey: text('idem_key').notNull(),
    status: text('status').$type<OutboxStatus>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: now(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  table => ({
    idemUniq: uniqueIndex('outbox_idem_uidx').on(table.idemKey),
    claimIdx: index('outbox_claim_idx').on(table.status, table.nextAttemptAt),
  }),
)

export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  domainId: text('domain_id').notNull(),
  taskId: text('task_id'),
  kind: text('kind').notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: now(),
})

export const usageRecords = pgTable('usage_records', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  domainId: text('domain_id').notNull(),
  taskId: text('task_id'),
  model: text('model').notNull(),
  tokensIn: integer('tokens_in').notNull(),
  tokensOut: integer('tokens_out').notNull(),
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
  createdAt: now(),
})

export const auditLogs = pgTable('audit_logs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  domainId: text('domain_id'),
  actor: jsonb('actor').$type<Actor>().notNull(),
  action: text('action').notNull(),
  objectType: text('object_type').notNull(),
  objectId: text('object_id').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: now(),
})

export const domainRouterState = pgTable('domain_router_state', {
  domainId: text('domain_id').primaryKey(),
  fencingToken: integer('fencing_token').notNull().default(0),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
})

export const watchAlerts = pgTable('watch_alerts', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  domainId: text('domain_id').notNull(),
  taskId: text('task_id'),
  kind: text('kind').notNull(),
  severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull(),
  state: text('state').$type<'open' | 'acknowledged' | 'resolved'>().notNull(),
  detail: text('detail').notNull(),
  createdAt: now(),
})

export type TriggerRow = typeof triggers.$inferSelect
export type ThreadRow = typeof threads.$inferSelect
export type TaskRow = typeof tasks.$inferSelect
export type AssignmentRow = typeof assignments.$inferSelect
export type WorkerSessionRow = typeof workerSessions.$inferSelect
export type OutboxRow = typeof outbox.$inferSelect
export type EvaluationRow = typeof evaluations.$inferSelect
export type SourceInstanceRow = typeof sourceInstances.$inferSelect
export type DomainRow = typeof domains.$inferSelect
export type WorkerInputRow = typeof workerInputs.$inferSelect
