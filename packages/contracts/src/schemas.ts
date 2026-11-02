import { z } from 'zod'

export const actorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'bot', 'system']),
  display: z.string().optional(),
})

export const budgetSchema = z.object({
  maxTokens: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
  maxWallClockMs: z.number().int().positive(),
})

export const strengthSchema = z.enum(['explicit', 'inferred'])

/** Structured output required from the Router model. */
export const routerDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ignore'), reason: z.string().min(1) }),
  z.object({ kind: z.literal('reply'), text: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('link'), taskId: z.string().min(1), reason: z.string().min(1) }),
  z.object({
    kind: z.literal('create_task'),
    title: z.string().min(1).max(160),
    scope: z.string().min(1),
    acceptance: z.string().min(1),
    strength: strengthSchema,
    allowedActions: z.array(z.string().min(1)).max(32),
    reason: z.string().min(1),
  }),
  z.object({ kind: z.literal('cancel'), taskId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }),
])

/** Structured output required from a Worker at the end of a turn. */
export const workerReportSchema = z.object({
  outcome: z.enum(['succeeded', 'failed', 'needs_input', 'blocked']),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  unresolved: z.array(z.string()).default([]),
  reply: z.string().optional(),
})

export const normalizedTriggerSchema = z.object({
  sourceEventId: z.string().min(1),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  objectVersion: z.string().optional(),
  actor: actorSchema,
  occurredAt: z.string().datetime(),
  threadKeys: z.array(z.string().min(1)).min(1),
  contentType: z.string().min(1),
  summary: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
})

export const domainPolicySchema = z.object({
  version: z.string().min(1),
  paused: z.boolean().default(false),
  acceptMode: z.enum(['explicit', 'inferred']).default('explicit'),
  rules: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        instruction: z.string().min(1),
        enabled: z.boolean().default(true),
        inferred: z.boolean().default(false),
      }),
    )
    .default([]),
})

export const defaultBudget = (): z.infer<typeof budgetSchema> => ({
  maxTokens: 120_000,
  maxCostUsd: 2,
  maxWallClockMs: 30 * 60_000,
})
