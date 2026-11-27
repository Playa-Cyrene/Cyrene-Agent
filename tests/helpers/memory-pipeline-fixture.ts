/** Test-only lifecycle: never leave an intentionally paused judge holding teardown open. */
export class PipelineFixture {
  private stopping = false
  private releases = new Set<() => void>()
  private work: Promise<unknown>[] = []
  private active = new Map<number, { name: string; start: number }>()
  private history: string[] = []
  private nextId = 0

  run(work: () => Promise<void>): Promise<void> {
    const result = Promise.resolve().then(work)
    // Observe failures immediately; the original promise still rejects to the test runner.
    this.work.push(result.catch(() => {}))
    return result
  }

  async step<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (this.stopping) throw new Error(`PIPELINE_FIXTURE_STOPPING:${name}`)
    const id = ++this.nextId
    const start = performance.now()
    this.active.set(id, { name, start })
    try {
      const value = await work()
      if (this.stopping) throw new Error(`PIPELINE_FIXTURE_STOPPING:${name}`)
      return value
    } finally {
      this.active.delete(id)
      this.history.push(`${name}: ${Math.round(performance.now() - start)}ms`)
      this.history = this.history.slice(-12)
    }
  }

  /** Release also wakes a waiter for entry, so failures before judge invocation can unwind. */
  gate<T>(fallback: T) {
    let enter!: () => void
    let resolve!: (value: T) => void
    const entered = new Promise<void>(done => { enter = done })
    const pending = new Promise<T>(done => { resolve = done })
    const release = (value = fallback) => { enter(); resolve(value); this.releases.delete(dispose) }
    const dispose = () => release()
    this.releases.add(dispose)
    return { entered, wait: () => { enter(); return pending }, release }
  }

  diagnostic(): string {
    const active = [...this.active.values()].map(({ name, start }) => `${name}: ${Math.round(performance.now() - start)}ms pending`)
    return `[memory-pipeline] ${[...this.history, ...active].join("; ") || "before first stage"}`
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const release of this.releases) release()
    await Promise.all(this.work)
  }
}

/** A timed-out hook keeps running. Do not reset shared module mocks underneath it. */
export class PipelineCleanupGuard {
  private pending = false
  assertReady(): void {
    if (this.pending) throw new Error("PREVIOUS_PIPELINE_CLEANUP_INCOMPLETE")
  }
  async finish(cleanup: () => Promise<void>): Promise<void> {
    this.pending = true
    await cleanup()
    this.pending = false // Failed cleanup intentionally blocks subsequent cases too.
  }
}
