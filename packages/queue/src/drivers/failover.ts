import type { JobPayload, QueueDriver, QueuedJob } from '../contracts.ts'

/**
 * Try the next connection when one is unreachable.
 *
 * A Redis that stops answering turns every `dispatch()` in every request into an
 * exception — and the dispatch usually happens *after* the work that mattered is
 * already done, so the user sees a 500 for an email that failed to queue.
 *
 * Only `push` and `later` fail over. Reading is not the same problem: a worker
 * polling a dead connection should say so and stop, not quietly start draining a
 * different queue and leave the first one's backlog unattended when it comes
 * back.
 */
export class FailoverQueue implements QueueDriver {
  constructor(
    readonly connectionName: string,
    private readonly connections: QueueDriver[],
    private readonly report?: (connection: string, error: unknown) => void
  ) {
    if (connections.length === 0) {
      throw new Error(`Failover connection [${connectionName}] has nothing to fail over to.`)
    }
  }

  get defaultQueue(): string {
    return (this.connections[0] as QueueDriver).defaultQueue
  }

  push(payload: JobPayload, queue?: string): Promise<string> {
    return this.attempt((driver) => driver.push(payload, queue))
  }

  later(delay: number, payload: JobPayload, queue?: string): Promise<string> {
    return this.attempt((driver) => driver.later(delay, payload, queue))
  }

  /**
   * Reads come from the first connection only.
   *
   * A worker that fell through to the second would drain it while the first
   * one's jobs sat unread, and nothing would say so.
   */
  pop(queue?: string): Promise<QueuedJob | null> {
    return (this.connections[0] as QueueDriver).pop(queue)
  }

  async size(queue?: string): Promise<number> {
    let total = 0

    for (const driver of this.connections) {
      total += await driver.size(queue).catch(() => 0)
    }

    return total
  }

  async clear(queue?: string): Promise<number> {
    let cleared = 0

    for (const driver of this.connections) {
      cleared += await driver.clear(queue).catch(() => 0)
    }

    return cleared
  }

  waitForJob(queue?: string): Promise<boolean> {
    const first = this.connections[0] as QueueDriver

    return first.waitForJob?.(queue) ?? Promise.resolve(false)
  }

  /**
   * Each connection in turn, and the **last** error if none of them took it.
   *
   * The last rather than the first: the first is usually "Redis is down", which
   * is the reason failover exists, and the one worth showing is why the fallback
   * did not work either.
   */
  private async attempt<T>(run: (driver: QueueDriver) => Promise<T>): Promise<T> {
    let last: unknown

    for (const driver of this.connections) {
      try {
        return await run(driver)
      } catch (error) {
        last = error
        this.report?.(driver.connectionName, error)
      }
    }

    throw last
  }
}
