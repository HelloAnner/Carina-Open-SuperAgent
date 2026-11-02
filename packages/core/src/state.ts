import type { AssignmentState, TaskState } from '@carina/contracts'

const taskEdges: Record<TaskState, readonly TaskState[]> = {
  open: ['running', 'cancelled', 'failed'],
  running: ['awaiting_input', 'awaiting_approval', 'blocked', 'succeeded', 'failed', 'cancelled'],
  awaiting_input: ['running', 'blocked', 'cancelled', 'failed'],
  awaiting_approval: ['running', 'blocked', 'cancelled', 'failed'],
  blocked: ['running', 'cancelled', 'failed'],
  succeeded: ['running', 'failed'],
  failed: ['running', 'cancelled'],
  cancelled: ['open'],
}

const assignmentEdges: Record<AssignmentState, readonly AssignmentState[]> = {
  pending: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'cancelled', 'uncertain'],
  uncertain: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
}

export const canTransitionTask = (from: TaskState, to: TaskState): boolean => taskEdges[from].includes(to)

export const canTransitionAssignment = (from: AssignmentState, to: AssignmentState): boolean =>
  assignmentEdges[from].includes(to)

export const assertTaskTransition = (from: TaskState, to: TaskState): void => {
  if (!canTransitionTask(from, to)) throw new Error(`invalid task transition ${from} -> ${to}`)
}

export const assertAssignmentTransition = (from: AssignmentState, to: AssignmentState): void => {
  if (!canTransitionAssignment(from, to)) throw new Error(`invalid assignment transition ${from} -> ${to}`)
}

export const isTerminalTaskState = (state: TaskState): boolean =>
  state === 'succeeded' || state === 'failed' || state === 'cancelled'
