import { and, desc, eq, inArray, lt, ne, sql as raw } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type {
  Assignment,
  AssignmentState,
  Budget,
  ChannelAddress,
  DomainPolicy,
  Evaluation,
  Mandate,
  OutboxMessage,
  ReportKind,
  RouterDecision,
  SourceInstance,
  TaskState,
  Trigger,
  TriggerDispositionKind,
  WorkerEvent,
} from '@carina/contracts'
import type { Database } from './db.js'
import type postgres from 'postgres'
import {
  assignments,
  auditLogs,
  domains,
  evaluations,
  outbox,
  reports,
  routerInbox,
  sessionEvents,
  sourceInstances,
  tasks,
  threadSubscriptions,
  threads,
  triggerDispositions,
  triggers,
  usageRecords,
  watchAlerts,
  workerInputs,
  workerSessions,
} from './schema.js'

const isoRequired = (value: Date | string): string => (value instanceof Date ? value.toISOString() : value)

const mapTrigger = (row: typeof triggers.$inferSelect): Trigger => ({
  id: row.id,
  tenantId: row.tenantId,
  domainId: row.domainId,
  sourceInstanceId: row.sourceInstanceId,
  sourceKind: row.sourceKind,
  sourceEventId: row.sourceEventId,
  objectType: row.objectType,
  objectId: row.objectId,
  ...(row.objectVersion ? { objectVersion: row.objectVersion } : {}),
  actor: row.actor,
  occurredAt: isoRequired(row.occurredAt),
  receivedAt: isoRequired(row.receivedAt),
  threadKeys: row.threadKeys,
  ...(row.causationId ? { causationId: row.causationId } : {}),
  ...(row.correlationId ? { correlationId: row.correlationId } : {}),
  contentType: row.contentType,
  summary: row.summary,
  ...(row.channel ? { channel: row.channel } : {}),
  ...(row.payload ? { raw: row.payload } : {}),
})

const mapTask = (row: typeof tasks.$inferSelect) => ({
  id: row.id,
  tenantId: row.tenantId,
  domainId: row.domainId,
  title: row.title,
  scope: row.scope,
  acceptance: row.acceptance,
  state: row.state,
  mandate: row.mandate,
  originTriggerId: row.originTriggerId,
  planVersion: row.planVersion,
  budget: row.budget,
  createdAt: isoRequired(row.createdAt),
  updatedAt: isoRequired(row.updatedAt),
})

const mapAssignment = (row: typeof assignments.$inferSelect): Assignment => ({
  id: row.id,
  taskId: row.taskId,
  attempt: row.attempt,
  runtimeType: row.runtimeType,
  state: row.state,
  fencingToken: row.fencingToken,
  ...(row.startedAt ? { startedAt: isoRequired(row.startedAt) } : {}),
  ...(row.endedAt ? { endedAt: isoRequired(row.endedAt) } : {}),
  ...(row.result ? { result: row.result } : {}),
})

const mapOutbox = (row: typeof outbox.$inferSelect): OutboxMessage => ({
  id: row.id,
  tenantId: row.tenantId,
  domainId: row.domainId,
  channel: row.channel,
  text: row.text,
  kind: row.kind,
  idemKey: row.idemKey,
  status: row.status,
  attempts: row.attempts,
  nextAttemptAt: isoRequired(row.nextAttemptAt),
  createdAt: isoRequired(row.createdAt),
  ...(row.sentAt ? { sentAt: isoRequired(row.sentAt) } : {}),
})

export interface TriggerInsertResult {
  inserted: boolean
  taskIds: string[]
}

export interface TaskCreateInput {
  id: string
  tenantId: string
  domainId: string
  title: string
  scope: string
  acceptance: string
  mandate: Mandate
  originTriggerId: string
  budget: Budget
  threadKey: string
  assignmentId: string
  runtimeType: string
}

export interface OutboxInsert {
  id: string
  tenantId: string
  domainId: string
  channel: ChannelAddress
  text: string
  kind: OutboxMessage['kind']
  idemKey: string
}

export class Store {
  constructor(
    private readonly db: Database,
    private readonly sql: postgres.Sql,
  ) {}

  /* ---------------------------------------------------------------- tenant */

  async createTenant(input: { id: string; name: string }): Promise<void> {
    await this.sql`INSERT INTO tenants (id, name) VALUES (${input.id}, ${input.name}) ON CONFLICT (id) DO NOTHING`
  }

  async createDomain(input: { id: string; tenantId: string; name: string; policy: DomainPolicy }): Promise<void> {
    await this.sql`INSERT INTO domains (id, tenant_id, name, policy) VALUES (${input.id}, ${input.tenantId}, ${input.name}, ${JSON.stringify(input.policy)}::jsonb) ON CONFLICT (id) DO NOTHING`
  }

  async getDomain(domainId: string): Promise<{ id: string; tenantId: string; name: string; policy: DomainPolicy } | undefined> {
    const [row] = await this.db.select().from(domains).where(eq(domains.id, domainId)).limit(1)
    return row ? { id: row.id, tenantId: row.tenantId, name: row.name, policy: row.policy } : undefined
  }

  async listDomains(): Promise<Array<{ id: string; tenantId: string; name: string; policy: DomainPolicy }>> {
    const rows = await this.db.select().from(domains).orderBy(domains.name)
    return rows.map(row => ({ id: row.id, tenantId: row.tenantId, name: row.name, policy: row.policy }))
  }

  async listSourceInstances(domainId?: string): Promise<SourceInstance[]> {
    const rows = domainId
      ? await this.db.select().from(sourceInstances).where(eq(sourceInstances.domainId, domainId))
      : await this.db.select().from(sourceInstances)
    return rows.map(row => ({
      id: row.id,
      tenantId: row.tenantId,
      domainId: row.domainId,
      kind: row.kind,
      name: row.name,
      enabled: row.enabled,
      config: row.config,
    }))
  }

  async getSourceInstance(id: string): Promise<SourceInstance | undefined> {
    const [row] = await this.db.select().from(sourceInstances).where(eq(sourceInstances.id, id)).limit(1)
    return row
      ? {
          id: row.id,
          tenantId: row.tenantId,
          domainId: row.domainId,
          kind: row.kind,
          name: row.name,
          enabled: row.enabled,
          config: row.config,
        }
      : undefined
  }

  async createSourceInstance(input: SourceInstance): Promise<void> {
    await this.sql`
      INSERT INTO source_instances (id, tenant_id, domain_id, kind, name, enabled, config)
      VALUES (${input.id}, ${input.tenantId}, ${input.domainId}, ${input.kind}, ${input.name}, ${input.enabled}, ${JSON.stringify(input.config)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `
  }

  /* --------------------------------------------------------------- triggers */

  /**
   * Persist a Trigger, upsert its Threads, and route it in one transaction.
   * Subscribed Tasks receive a worker input; otherwise the Thread enters the Router inbox.
   */
  async ingestTrigger(trigger: Trigger): Promise<TriggerInsertResult> {
    return this.db.transaction(async tx => {
      const inserted = await tx
        .insert(triggers)
        .values({
          id: trigger.id,
          tenantId: trigger.tenantId,
          domainId: trigger.domainId,
          sourceInstanceId: trigger.sourceInstanceId,
          sourceKind: trigger.sourceKind,
          sourceEventId: trigger.sourceEventId,
          objectType: trigger.objectType,
          objectId: trigger.objectId,
          objectVersion: trigger.objectVersion ?? null,
          actor: trigger.actor,
          occurredAt: new Date(trigger.occurredAt),
          receivedAt: new Date(trigger.receivedAt),
          threadKeys: trigger.threadKeys,
          causationId: trigger.causationId ?? null,
          correlationId: trigger.correlationId ?? null,
          contentType: trigger.contentType,
          summary: trigger.summary,
          channel: trigger.channel ?? null,
          payload: trigger.raw ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: triggers.id })
      if (inserted.length === 0) return { inserted: false, taskIds: [] }

      const taskIds = new Set<string>()
      for (const key of trigger.threadKeys) {
        await tx
          .insert(threads)
          .values({
            key,
            tenantId: trigger.tenantId,
            domainId: trigger.domainId,
            sourceInstanceId: trigger.sourceInstanceId,
            sourceKind: trigger.sourceKind,
            objectType: trigger.objectType,
            objectId: trigger.objectId,
            lastTriggerAt: new Date(trigger.occurredAt),
          })
          .onConflictDoUpdate({
            target: threads.key,
            set: { lastTriggerAt: new Date(trigger.occurredAt) },
          })
        const subscriptions = await tx
          .select({ taskId: threadSubscriptions.taskId })
          .from(threadSubscriptions)
          .innerJoin(tasks, eq(tasks.id, threadSubscriptions.taskId))
          .where(
            and(
              eq(threadSubscriptions.threadKey, key),
              eq(threadSubscriptions.state, 'active'),
              ne(tasks.state, 'cancelled'),
            ),
          )
        for (const subscription of subscriptions) {
          taskIds.add(subscription.taskId)
          await tx
            .insert(workerInputs)
            .values({
              id: randomUUID(),
              taskId: subscription.taskId,
              kind: 'trigger',
              triggerId: trigger.id,
              state: 'pending',
            })
            .onConflictDoNothing()
        }
      }

      if (taskIds.size > 0) {
        await tx.insert(triggerDispositions).values({
          triggerId: trigger.id,
          kind: 'fanned_out',
          reason: `${taskIds.size} subscription(s)`,
        })
      } else {
        const threadKey = trigger.threadKeys[0]
        if (threadKey) {
          await tx
            .insert(routerInbox)
            .values({
              id: randomUUID(),
              tenantId: trigger.tenantId,
              domainId: trigger.domainId,
              threadKey,
              triggerId: trigger.id,
              state: 'pending',
            })
            .onConflictDoNothing()
        }
        await tx.insert(triggerDispositions).values({
          triggerId: trigger.id,
          kind: 'queued_for_router',
          reason: 'no active subscription',
        })
      }
      return { inserted: true, taskIds: [...taskIds] }
    })
  }

  async getTrigger(id: string): Promise<Trigger | undefined> {
    const [row] = await this.db.select().from(triggers).where(eq(triggers.id, id)).limit(1)
    return row ? mapTrigger(row) : undefined
  }

  async listTriggers(domainId: string, limit = 100): Promise<Trigger[]> {
    const rows = await this.db
      .select()
      .from(triggers)
      .where(eq(triggers.domainId, domainId))
      .orderBy(desc(triggers.receivedAt))
      .limit(limit)
    return rows.map(mapTrigger)
  }

  async recordDisposition(triggerId: string, kind: TriggerDispositionKind, reason?: string): Promise<void> {
    await this.sql`
      UPDATE trigger_dispositions SET kind = ${kind}, reason = ${reason ?? null} WHERE trigger_id = ${triggerId}
    `
  }

  /* ----------------------------------------------------------------- router */

  async claimRouterBatch(domainId: string, limit: number): Promise<Array<{ id: string; triggerId: string; threadKey: string; createdAt: string }>> {
    return this.sql.begin(async tx => {
      const rows = await tx<
        Array<{ id: string; trigger_id: string; thread_key: string; created_at: Date }>
      >`SELECT id, trigger_id, thread_key, created_at FROM router_inbox
         WHERE domain_id = ${domainId} AND state = 'pending' AND available_at <= now()
         ORDER BY created_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED`
      for (const row of rows) {
        await tx`UPDATE router_inbox SET state = 'processing', attempts = attempts + 1 WHERE id = ${row.id}`
      }
      return rows.map(row => ({
        id: row.id,
        triggerId: row.trigger_id,
        threadKey: row.thread_key,
        createdAt: isoRequired(row.created_at),
      }))
    })
  }

  async pendingRouterCount(domainId: string): Promise<number> {
    const rows = await this.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM router_inbox
      WHERE domain_id = ${domainId} AND state = 'pending' AND available_at <= now()
    `
    return Number(rows[0]?.count ?? 0)
  }

  async finishRouterInbox(id: string, state: 'done' | 'failed'): Promise<void> {
    await this.sql`UPDATE router_inbox SET state = ${state} WHERE id = ${id}`
  }

  async listTasksForThread(threadKey: string): Promise<ReturnType<typeof mapTask>[]> {
    const rows = await this.db
      .select({ task: tasks })
      .from(tasks)
      .innerJoin(threadSubscriptions, eq(threadSubscriptions.taskId, tasks.id))
      .where(eq(threadSubscriptions.threadKey, threadKey))
    return rows.map(row => mapTask(row.task))
  }

  async createEvaluation(input: Omit<Evaluation, 'endedAt' | 'decision'>): Promise<void> {
    await this.db.insert(evaluations).values({
      id: input.id,
      tenantId: input.tenantId,
      domainId: input.domainId,
      threadKey: input.threadKey,
      triggerIds: input.triggerIds,
      policyVersion: input.policyVersion,
      status: input.status,
      startedAt: new Date(input.startedAt),
    })
  }

  async finishEvaluation(input: {
    id: string
    status: 'decided' | 'failed'
    decision?: RouterDecision
    model?: string
    tokensIn?: number
    tokensOut?: number
  }): Promise<void> {
    await this.db
      .update(evaluations)
      .set({
        status: input.status,
        decision: input.decision ?? null,
        model: input.model ?? null,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        endedAt: new Date(),
      })
      .where(eq(evaluations.id, input.id))
  }

  async listEvaluations(domainId: string, limit = 50): Promise<Array<typeof evaluations.$inferSelect>> {
    return this.db
      .select()
      .from(evaluations)
      .where(eq(evaluations.domainId, domainId))
      .orderBy(desc(evaluations.startedAt))
      .limit(limit)
  }

  /** Create a Task, its first Assignment, and the origin Thread Subscription atomically. */
  async createTask(input: TaskCreateInput): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.insert(tasks).values({
        id: input.id,
        tenantId: input.tenantId,
        domainId: input.domainId,
        title: input.title,
        scope: input.scope,
        acceptance: input.acceptance,
        state: 'open',
        mandate: input.mandate,
        originTriggerId: input.originTriggerId,
        planVersion: 1,
        budget: input.budget,
      })
      await tx.insert(assignments).values({
        id: input.assignmentId,
        taskId: input.id,
        attempt: 1,
        runtimeType: input.runtimeType,
        state: 'pending',
      })
      await tx
        .insert(threadSubscriptions)
        .values({
          id: randomUUID(),
          threadKey: input.threadKey,
          taskId: input.id,
          purpose: 'origin',
          state: 'active',
        })
        .onConflictDoNothing()
    })
  }

  async getTask(id: string): Promise<ReturnType<typeof mapTask> | undefined> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
    return row ? mapTask(row) : undefined
  }

  async listTasks(domainId: string, limit = 100): Promise<Array<ReturnType<typeof mapTask>>> {
    const rows = await this.db
      .select()
      .from(tasks)
      .where(eq(tasks.domainId, domainId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
    return rows.map(mapTask)
  }

  async updateTaskState(taskId: string, state: TaskState): Promise<void> {
    await this.db.update(tasks).set({ state, updatedAt: new Date() }).where(eq(tasks.id, taskId))
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    await this.db.transaction(async tx => {
      await tx.update(tasks).set({ state: 'cancelled', updatedAt: new Date() }).where(eq(tasks.id, taskId))
      await tx
        .update(assignments)
        .set({ state: 'cancelled', endedAt: new Date(), result: reason })
        .where(and(eq(assignments.taskId, taskId), inArray(assignments.state, ['pending', 'running'])))
    })
  }

  /**
   * A new event on a subscribed Thread resumes a task that is not running.
   * Cancelled tasks never resume; the caller still records the event.
   */
  async resumeTaskIfNeeded(taskId: string, runtimeType: string): Promise<boolean> {
    return this.db.transaction(async tx => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
      if (!task) return false
      if (!['blocked', 'awaiting_input', 'succeeded', 'failed'].includes(task.state)) return false
      const active = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.taskId, taskId), inArray(assignments.state, ['pending', 'running'])))
        .limit(1)
      if (active.length > 0) return false
      const [latest] = await tx
        .select({ attempt: assignments.attempt })
        .from(assignments)
        .where(eq(assignments.taskId, taskId))
        .orderBy(desc(assignments.attempt))
        .limit(1)
      await tx.insert(assignments).values({
        id: randomUUID(),
        taskId,
        attempt: (latest?.attempt ?? 0) + 1,
        runtimeType,
        state: 'pending',
      })
      await tx.update(tasks).set({ state: 'open', updatedAt: new Date() }).where(eq(tasks.id, taskId))
      return true
    })
  }

  /* -------------------------------------------------------------- execution */

  async claimAssignments(limit: number): Promise<Array<{ assignment: Assignment; task: ReturnType<typeof mapTask> }>> {
    const ids = await this.sql.begin(async tx => {
      const rows = await tx<Array<{ id: string }>>`
        SELECT id FROM assignments WHERE state = 'pending'
        ORDER BY created_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
      `
      for (const row of rows) {
        await tx`UPDATE assignments SET state = 'running', started_at = now() WHERE id = ${row.id}`
      }
      return rows.map(row => row.id)
    })
    const output: Array<{ assignment: Assignment; task: ReturnType<typeof mapTask> }> = []
    for (const id of ids) {
      const [row] = await this.db
        .select({ assignment: assignments, task: tasks })
        .from(assignments)
        .innerJoin(tasks, eq(assignments.taskId, tasks.id))
        .where(eq(assignments.id, id))
        .limit(1)
      if (row) output.push({ assignment: mapAssignment(row.assignment), task: mapTask(row.task) })
    }
    return output
  }

  async getAssignment(id: string): Promise<Assignment | undefined> {
    const [row] = await this.db.select().from(assignments).where(eq(assignments.id, id)).limit(1)
    return row ? mapAssignment(row) : undefined
  }

  async createWorkerSession(input: {
    id: string
    taskId: string
    assignmentId: string
    runtimeType: string
    workspaceRef: string
  }): Promise<void> {
    await this.db.insert(workerSessions).values({
      id: input.id,
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      runtimeType: input.runtimeType,
      state: 'running',
      workspaceRef: input.workspaceRef,
    })
  }

  async endWorkerSession(sessionId: string, state: 'ended' | 'waiting'): Promise<void> {
    await this.db
      .update(workerSessions)
      .set({ state, updatedAt: new Date() })
      .where(eq(workerSessions.id, sessionId))
  }

  async appendSessionEvent(sessionId: string, event: WorkerEvent): Promise<void> {
    await this.db.insert(sessionEvents).values({
      sessionId,
      type: event.type,
      payload: event as unknown as Record<string, unknown>,
    })
  }

  async listSessionEvents(sessionId: string, limit = 200): Promise<Array<{ type: string; payload: Record<string, unknown>; createdAt: string }>> {
    const rows = await this.db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, sessionId))
      .orderBy(sessionEvents.id)
      .limit(limit)
    return rows.map(row => ({ type: row.type, payload: row.payload, createdAt: isoRequired(row.createdAt) }))
  }

  async listPendingInputs(taskId: string): Promise<Array<{ id: string; triggerId?: string; text?: string; kind: string }>> {
    const rows = await this.db
      .select()
      .from(workerInputs)
      .where(and(eq(workerInputs.taskId, taskId), eq(workerInputs.state, 'pending')))
      .orderBy(workerInputs.createdAt)
    return rows.map(row => ({
      id: row.id,
      ...(row.triggerId ? { triggerId: row.triggerId } : {}),
      ...(row.text ? { text: row.text } : {}),
      kind: row.kind,
    }))
  }

  async markInputDelivered(id: string, assignmentId: string): Promise<void> {
    await this.db
      .update(workerInputs)
      .set({ state: 'delivered', assignmentId, deliveredAt: new Date() })
      .where(eq(workerInputs.id, id))
  }

  async markInputConsumed(id: string): Promise<void> {
    await this.db.update(workerInputs).set({ state: 'consumed', consumedAt: new Date() }).where(eq(workerInputs.id, id))
  }

  async insertReport(input: {
    id: string
    taskId: string
    assignmentId: string
    kind: ReportKind
    body: string
    evidence?: string[]
    unresolved?: string[]
  }): Promise<void> {
    await this.db.insert(reports).values({
      id: input.id,
      taskId: input.taskId,
      assignmentId: input.assignmentId,
      kind: input.kind,
      body: input.body,
      evidence: input.evidence ?? null,
      unresolved: input.unresolved ?? null,
    })
  }

  async listReports(taskId: string): Promise<Array<{ id: string; kind: ReportKind; body: string; createdAt: string }>> {
    const rows = await this.db
      .select()
      .from(reports)
      .where(eq(reports.taskId, taskId))
      .orderBy(desc(reports.createdAt))
      .limit(50)
    return rows.map(row => ({ id: row.id, kind: row.kind, body: row.body, createdAt: isoRequired(row.createdAt) }))
  }

  async finishAssignment(input: {
    assignmentId: string
    taskId: string
    assignmentState: Exclude<AssignmentState, 'pending' | 'running'>
    taskState?: TaskState
    result: string
  }): Promise<void> {
    await this.db.transaction(async tx => {
      await tx
        .update(assignments)
        .set({ state: input.assignmentState, endedAt: new Date(), result: input.result })
        .where(eq(assignments.id, input.assignmentId))
      if (input.taskState) {
        await tx.update(tasks).set({ state: input.taskState, updatedAt: new Date() }).where(eq(tasks.id, input.taskId))
      }
    })
  }

  async incrementPlanVersion(taskId: string): Promise<number> {
    const [row] = await this.db
      .update(tasks)
      .set({ planVersion: raw`${tasks.planVersion} + 1`, updatedAt: new Date() })
      .where(eq(tasks.id, taskId))
      .returning({ planVersion: tasks.planVersion })
    return row?.planVersion ?? 1
  }

  async insertUsage(input: {
    tenantId: string
    domainId: string
    taskId?: string
    model: string
    tokensIn: number
    tokensOut: number
    costUsd?: number
  }): Promise<void> {
    await this.db.insert(usageRecords).values({
      id: randomUUID(),
      tenantId: input.tenantId,
      domainId: input.domainId,
      taskId: input.taskId ?? null,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      costUsd: String(input.costUsd ?? 0),
    })
  }

  /* ----------------------------------------------------------------- outbox */

  async enqueueOutbox(input: OutboxInsert): Promise<void> {
    await this.db
      .insert(outbox)
      .values({
        id: input.id,
        tenantId: input.tenantId,
        domainId: input.domainId,
        channel: input.channel,
        text: input.text,
        kind: input.kind,
        idemKey: input.idemKey,
      })
      .onConflictDoNothing()
  }

  async claimOutbox(limit: number): Promise<OutboxMessage[]> {
    const ids = await this.sql.begin(async tx => {
      const claimed = await tx<Array<{ id: string; attempts: number }>>`
        SELECT id, attempts FROM outbox
        WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
        ORDER BY created_at ASC LIMIT ${limit} FOR UPDATE SKIP LOCKED
      `
      for (const row of claimed) {
        await tx`UPDATE outbox SET status = 'sending', attempts = ${row.attempts + 1} WHERE id = ${row.id}`
      }
      return claimed.map(row => row.id)
    })
    if (ids.length === 0) return []
    const rows = await this.db.select().from(outbox).where(inArray(outbox.id, ids))
    return rows.map(mapOutbox)
  }

  async markOutboxSent(id: string): Promise<void> {
    await this.db.update(outbox).set({ status: 'sent', sentAt: new Date() }).where(eq(outbox.id, id))
  }

  async markOutboxFailed(id: string, attempts: number, error: string, dead: boolean): Promise<void> {
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6))
    await this.db
      .update(outbox)
      .set({
        status: dead ? 'dead' : 'failed',
        nextAttemptAt: new Date(Date.now() + delayMs),
      })
      .where(eq(outbox.id, id))
    await this.audit({
      tenantId: 'system',
      actor: { id: 'outbox', kind: 'system' },
      action: 'outbox.failed',
      objectType: 'outbox',
      objectId: id,
      detail: { error, attempts, dead },
    })
  }

  async listOutbox(domainId: string, limit = 100): Promise<OutboxMessage[]> {
    const rows = await this.db
      .select()
      .from(outbox)
      .where(eq(outbox.domainId, domainId))
      .orderBy(desc(outbox.createdAt))
      .limit(limit)
    return rows.map(mapOutbox)
  }

  /* ---------------------------------------------------------------- support */

  async audit(input: {
    tenantId: string
    domainId?: string
    actor: { id: string; kind: 'human' | 'bot' | 'system'; display?: string }
    action: string
    objectType: string
    objectId: string
    detail?: Record<string, unknown>
  }): Promise<void> {
    await this.db.insert(auditLogs).values({
      id: randomUUID(),
      tenantId: input.tenantId,
      domainId: input.domainId ?? null,
      actor: input.actor,
      action: input.action,
      objectType: input.objectType,
      objectId: input.objectId,
      detail: input.detail ?? null,
    })
  }

  async insertWatchAlert(input: {
    tenantId: string
    domainId: string
    taskId?: string
    kind: string
    severity: 'info' | 'warning' | 'critical'
    detail: string
  }): Promise<void> {
    await this.db.insert(watchAlerts).values({
      id: randomUUID(),
      tenantId: input.tenantId,
      domainId: input.domainId,
      taskId: input.taskId ?? null,
      kind: input.kind,
      severity: input.severity,
      state: 'open',
      detail: input.detail,
    })
  }

  async listStuckRouterInbox(olderThanMs: number): Promise<Array<{ id: string; domainId: string }>> {
    const cutoff = new Date(Date.now() - olderThanMs)
    const rows = await this.db
      .select({ id: routerInbox.id, domainId: routerInbox.domainId })
      .from(routerInbox)
      .where(and(eq(routerInbox.state, 'processing'), lt(routerInbox.createdAt, cutoff)))
    return rows
  }

  async requeueRouterInbox(id: string): Promise<void> {
    await this.db.update(routerInbox).set({ state: 'pending', availableAt: new Date() }).where(eq(routerInbox.id, id))
  }

  async listStaleAssignments(olderThanMs: number): Promise<Array<{ id: string; taskId: string; tenantId: string; domainId: string }>> {
    const cutoff = new Date(Date.now() - olderThanMs)
    const rows = await this.db
      .select({
        id: assignments.id,
        taskId: assignments.taskId,
        tenantId: tasks.tenantId,
        domainId: tasks.domainId,
      })
      .from(assignments)
      .innerJoin(tasks, eq(assignments.taskId, tasks.id))
      .where(and(eq(assignments.state, 'running'), lt(assignments.startedAt, cutoff)))
    return rows
  }
}
