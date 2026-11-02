import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The SDK resolves a run on idle even when the model turn failed; inspect the durable log. */
export const turnFailure = (events: readonly SessionEvent[]): string | undefined => {
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    const reason = (event.data as { reason?: unknown }).reason as
      | { kind?: string; error?: { message?: string }; reason?: unknown }
      | undefined
    if (!reason) continue
    if (reason.kind === 'error') return reason.error?.message ?? 'model turn failed'
    if (reason.kind === 'blocked') return 'model turn blocked'
    if (reason.kind === 'max-tokens') return 'model turn reached its output token ceiling'
    if (reason.kind === 'aborted') return 'model turn aborted'
  }
  return undefined
}
