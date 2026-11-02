import type { Logger } from '@carina/contracts'

const levelValue = (level: string): number => ({ debug: 10, info: 20, warn: 30, error: 40 })[level] ?? 20

export class JsonLogger implements Logger {
  constructor(
    private readonly bindings: Record<string, unknown> = {},
    private readonly minLevel: string = process.env.LOG_LEVEL ?? 'info',
  ) {}

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.bindings, ...bindings }, this.minLevel)
  }

  private write(level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void {
    if (levelValue(level) < levelValue(this.minLevel)) return
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      ...this.bindings,
      ...fields,
    })
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields)
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields)
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields)
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields)
  }
}

export const rootLogger = (bindings: Record<string, unknown> = {}): Logger => new JsonLogger(bindings)
