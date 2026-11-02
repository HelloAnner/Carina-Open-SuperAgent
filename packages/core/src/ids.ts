/** Stable Thread key. Tenant and domain are stored as columns, never encoded in this key. */
export const threadKey = (sourceKind: string, objectType: string, objectId: string): string =>
  `${sourceKind}:${objectType}:${objectId}`

export const taskSessionId = (taskId: string, attempt: number): string => `worker-${taskId}-${attempt}`

export const idemKey = (...parts: Array<string | number>): string => parts.join(':')

export const nowIso = (): string => new Date().toISOString()

export const costFromTokens = (tokensIn: number, tokensOut: number, inPerMillion: number, outPerMillion: number): number =>
  (tokensIn / 1_000_000) * inPerMillion + (tokensOut / 1_000_000) * outPerMillion
