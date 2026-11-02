import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export interface AgentConfig {
  runtime: 'dsh' | 'stub'
  provider: string
  model: string
  routerModel: string
  workerModel: string
  maxTokens: number
  dshBin?: string
  dshHome?: string
  patches: string[]
  workspaceRoot: string
  requestTimeoutMs: number
}

const env = (key: string): string | undefined => {
  const value = process.env[key]
  return value && value.trim() !== '' ? value : undefined
}

const int = (key: string, fallback: number): number => {
  const raw = env(key)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Resolve the same-version dsh CLI explicitly. The SDK's own fallback uses
 * import.meta.resolve, which is not available when our worker is transpiled
 * by tsx; resolving through Node's module resolver keeps both paths working.
 */
const resolveDshBin = (): string | undefined => {
  const configured = env('DSH_BIN')
  if (configured) return configured
  try {
    const require = createRequire(import.meta.url)
    const manifest = require.resolve('@deepseek-ai/dsh/package.json')
    return join(dirname(manifest), 'lib', 'bin.js')
  } catch {
    return undefined
  }
}

export const agentConfigFromEnv = (): AgentConfig => {
  const model = env('DSH_MODEL') ?? 'deepseek-v4-flash'
  return {
    runtime: env('DSH_RUNTIME') === 'dsh' ? 'dsh' : 'stub',
    provider: env('DSH_PROVIDER') ?? 'deepseek-official',
    model,
    routerModel: env('DSH_ROUTER_MODEL') ?? model,
    workerModel: env('DSH_WORKER_MODEL') ?? model,
    maxTokens: int('DSH_MAX_TOKENS', 49_152),
    dshBin: resolveDshBin(),
    dshHome: env('DSH_HOME'),
    patches: (env('DSH_PATCHES') ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
    workspaceRoot: env('WORKSPACE_ROOT') ?? '/data/workspaces',
    requestTimeoutMs: int('DSH_REQUEST_TIMEOUT_MS', 20 * 60_000),
  }
}
