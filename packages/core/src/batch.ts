export interface BatchLimits {
  maxWaitMs: number
  maxEvents: number
  maxInputChars: number
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxWaitMs: 1_500,
  maxEvents: 20,
  maxInputChars: 120_000,
}

export interface BatchItem {
  id: string
  createdAt: Date | string
  chars?: number
}

/**
 * Selects a bounded batch in arrival order. `now` is injected so the rule is testable.
 * Returns an empty array until the oldest pending item is old enough to flush,
 * unless the batch is already full or one item alone exceeds the character budget.
 */
export const planBatch = <T extends BatchItem>(
  items: readonly T[],
  limits: BatchLimits,
  now: Date,
): T[] => {
  const ordered = [...items].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt))
  const batch: T[] = []
  let chars = 0
  for (const item of ordered) {
    if (batch.length >= limits.maxEvents) break
    const nextChars = chars + (item.chars ?? 0)
    if (batch.length > 0 && nextChars > limits.maxInputChars) break
    batch.push(item)
    chars = nextChars
  }
  if (batch.length === 0) return batch
  const oldest = +new Date(batch[0]!.createdAt)
  const full = batch.length >= limits.maxEvents
  const aged = now.getTime() - oldest >= limits.maxWaitMs
  const oversized = batch.length === 1 && chars > limits.maxInputChars
  return full || aged || oversized ? batch : []
}
