/** Minimal async push queue used to turn DSH notifications into a WorkerEvent stream. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
  private ended = false

  push(value: T): void {
    if (this.ended) return
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) return Promise.resolve({ value: this.values.shift()!, done: false })
        if (this.ended) return Promise.resolve({ value: undefined as T, done: true })
        return new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve))
      },
    }
  }
}
