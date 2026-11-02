import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RouterAgent, Logger } from '@carina/contracts'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { DeepSeekHarnessOptions } from '@deepseek-ai/dsh-sdk-client'
import type { AgentConfig } from './config.js'
import { turnFailure } from './dsh-errors.js'
import { writeRouterPolicyPatch } from './dsh-policy.js'

const noopLogger: Logger = {
  child: () => noopLogger,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

const harnessOptions = (config: AgentConfig, cwd: string, patchPath: string): DeepSeekHarnessOptions => ({
  cwd,
  provider: config.provider,
  model: config.routerModel,
  maxTokens: config.maxTokens,
  requestTimeoutMs: config.requestTimeoutMs,
  env: { ...process.env, DSH_PERMISSION_MODE: 'read-only' } as NodeJS.ProcessEnv,
  ...(config.dshBin ? { dshBin: config.dshBin } : {}),
  ...(config.dshHome ? { dshHome: config.dshHome } : {}),
  patches: [...config.patches, patchPath],
})

/**
 * Router judgement over a persistent DSH session per domain.
 * The session keeps recent coordination context; the caller supplies the
 * bounded batch prompt and parses the structured decision.
 */
export class DshRouterAgent implements RouterAgent {
  private harness: DeepSeekHarness | undefined
  /** DSH persists sessions; a fresh process cannot recreate a stored id. Continuity comes from the Router prompt. */
  private readonly processTag = randomUUID().slice(0, 8)

  constructor(
    private readonly config: AgentConfig,
    private readonly logger: Logger = noopLogger,
  ) {}

  private async ensure(): Promise<DeepSeekHarness> {
    if (!this.harness) {
      const cwd = join(this.config.workspaceRoot, '_router')
      await mkdir(cwd, { recursive: true })
      const patchPath = await writeRouterPolicyPatch(cwd)
      this.harness = new DeepSeekHarness(harnessOptions(this.config, cwd, patchPath))
    }
    return this.harness
  }

  async evaluate(input: {
    tenantId: string
    domainId: string
    prompt: string
    signal?: AbortSignal
  }): Promise<{ text: string; sessionId: string }> {
    if (input.signal?.aborted) throw new Error('router evaluation aborted')
    const harness = await this.ensure()
    const sessionId = `router-${input.domainId}-${this.processTag}`
    try {
      const result = await harness.session(sessionId).run(input.prompt)
      if (input.signal?.aborted) throw new Error('router evaluation aborted')
      const failure = turnFailure(result.events)
      if (failure) throw new Error(`router turn failed: ${failure}`)
      if (!result.finalResponse.trim()) throw new Error('router returned an empty response')
      return { text: result.finalResponse, sessionId }
    } catch (error) {
      this.logger.error('dsh router turn failed', { domainId: input.domainId, error: String(error) })
      // The SDK has no mid-turn cancel; a failed/timed-out runtime must be reaped before retry.
      await harness.close().catch(() => undefined)
      this.harness = undefined
      throw error
    }
  }

  async close(): Promise<void> {
    const harness = this.harness
    this.harness = undefined
    await harness?.close().catch(() => undefined)
  }
}
