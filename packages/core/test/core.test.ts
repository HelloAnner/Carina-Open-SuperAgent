import { describe, expect, it } from 'vitest'
import type { DomainPolicy } from '@carina/contracts'
import {
  admitDecision,
  canTransitionAssignment,
  canTransitionTask,
  DecisionRejected,
  parseRouterDecision,
  planBatch,
  threadKey,
} from '../src/index.js'

const policy = (overrides: Partial<DomainPolicy> = {}): DomainPolicy => ({
  version: 'v1',
  paused: false,
  acceptMode: 'explicit',
  rules: [],
  ...overrides,
})

describe('threadKey', () => {
  it('is stable and includes source, object type, and object id', () => {
    expect(threadKey('github', 'pull_request', 'org/repo#12')).toBe('github:pull_request:org/repo#12')
  })
})

describe('state machines', () => {
  it('allows recovery and rejects impossible task transitions', () => {
    expect(canTransitionTask('open', 'running')).toBe(true)
    expect(canTransitionTask('running', 'blocked')).toBe(true)
    expect(canTransitionTask('cancelled', 'open')).toBe(true)
    expect(canTransitionTask('succeeded', 'cancelled')).toBe(false)
  })

  it('keeps assignments terminal', () => {
    expect(canTransitionAssignment('pending', 'running')).toBe(true)
    expect(canTransitionAssignment('running', 'uncertain')).toBe(true)
    expect(canTransitionAssignment('succeeded', 'running')).toBe(false)
  })
})

describe('planBatch', () => {
  const limits = { maxWaitMs: 1_000, maxEvents: 3, maxInputChars: 100 }

  it('waits until the oldest item is old enough', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const items = [{ id: 'a', createdAt: '2026-01-01T00:00:00.500Z', chars: 10 }]
    expect(planBatch(items, limits, now)).toEqual([])
  })

  it('flushes when aged or full and respects the event cap', () => {
    const now = new Date('2026-01-01T00:00:02.000Z')
    const items = ['a', 'b', 'c', 'd'].map((id, index) => ({
      id,
      createdAt: `2026-01-01T00:00:0${index}.000Z`,
      chars: 10,
    }))
    expect(planBatch(items, limits, now).map(item => item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('admitDecision', () => {
  it('rejects inferred work when the domain only accepts explicit work', () => {
    expect(() =>
      admitDecision(
        {
          kind: 'create_task',
          title: 't',
          scope: 's',
          acceptance: 'a',
          strength: 'inferred',
          allowedActions: ['read'],
          reason: 'r',
        },
        policy(),
        new Set(),
      ),
    ).toThrow(DecisionRejected)
  })

  it('rejects actions outside the first-phase allowlist', () => {
    expect(() =>
      admitDecision(
        {
          kind: 'create_task',
          title: 't',
          scope: 's',
          acceptance: 'a',
          strength: 'explicit',
          allowedActions: ['merge'],
          reason: 'r',
        },
        policy(),
        new Set(),
      ),
    ).toThrow(/actions not allowed/)
  })

  it('rejects links to unknown tasks', () => {
    expect(() =>
      admitDecision({ kind: 'link', taskId: 'missing', reason: 'r' }, policy(), new Set()),
    ).toThrow(/unknown task/)
  })
})

describe('parseRouterDecision', () => {
  it('accepts fenced JSON', () => {
    const decision = parseRouterDecision('```json\n{"kind":"ignore","reason":"noise"}\n```')
    expect(decision).toEqual({ kind: 'ignore', reason: 'noise' })
  })

  it('rejects prose', () => {
    expect(() => parseRouterDecision('I will ignore this')).toThrow()
  })
})
