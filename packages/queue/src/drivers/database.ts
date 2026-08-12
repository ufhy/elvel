import type { Connection, ConnectionManager } from '@elysian/database'
import { QueryBuilder } from '@elysian/database'
import type { JobPayload, QueueDriver, QueuedJob } from '../contracts.ts'

export type DatabaseQueueOptions = {
  connection?: string
  table?: string
  queue?: string
  /**
   * Seconds a reservation is trusted for.
   *
   * This is what recovers work from a worker that died: once a reservation is
   * this old the job becomes available again. Set it above your longest job or a
   * slow job will be picked up twice.
   */
  retryAfter?: number
}

/**
 * Jobs in a table — `Illuminate\Queue\DatabaseQueue`.
 *
 * The reservation is the whole design. `pop()` runs in a transaction with the
 * row locked `for update`, and looks for a job that is either available or
 * reserved-but-expired; without the lock two workers would read the same row and
 * both run it, and without the second branch a crashed worker's job would sit
 * reserved forever.
 */
export class DatabaseQueue implements QueueDriver {
  readonly defaultQueue: string

  private readonly table: string
  private readonly retryAfter: number

  constructor(
    readonly connectionName: string,
    private readonly db: ConnectionManager,
    private readonly options: DatabaseQueueOptions = {}
  ) {
    this.table = options.table ?? 'jobs'
    this.defaultQueue = options.queue ?? 'default'
    this.retryAfter = options.retryAfter ?? 90
  }

  async push(payload: JobPayload, queue?: string): Promise<string> {
    return this.pushToDatabase(payload, 0, queue)
  }

  async later(delay: number, payload: JobPayload, queue?: string): Promise<string> {
    return this.pushToDatabase(payload, delay, queue)
  }

  async pop(queue?: string): Promise<QueuedJob | null> {
    const name = queue ?? this.defaultQueue
    const connection = await this.db.connection(this.options.connection)

    return connection.transaction(async (tx) => {
      const now = Math.floor(Date.now() / 1000)
      const expiredAt = now - this.retryAfter

      const row = await this.on(tx)
        .where('queue', '=', name)
        .where((nested) => {
          nested
            .where((available) => {
              available.whereNull('reserved_at').where('available_at', '<=', now)
            })
            .orWhere((expired) => {
              // A worker that died mid-job left its reservation behind.
              expired.whereNotNull('reserved_at').where('reserved_at', '<=', expiredAt)
            })
        })
        .orderBy('id')
        .lockForUpdate()
        .first()

      if (!row) return null

      const attempts = Number(row.attempts) + 1

      await this.on(tx)
        .where('id', '=', row.id as never)
        .update({ reserved_at: now, attempts })

      const payload = JSON.parse(String(row.payload)) as JobPayload

      return new DatabaseJob({ ...payload, attempts }, name, this.connectionName, row.id, this)
    })
  }

  async size(queue?: string): Promise<number> {
    return (await this.query()).where('queue', '=', queue ?? this.defaultQueue).count()
  }

  async clear(queue?: string): Promise<number> {
    return (await this.query()).where('queue', '=', queue ?? this.defaultQueue).delete()
  }

  /** Called by a job releasing itself. */
  async releaseJob(id: unknown, payload: JobPayload, queue: string, delay: number): Promise<void> {
    // Deleting and re-inserting rather than clearing `reserved_at`: the row gets
    // a fresh id, so it goes to the back of the queue instead of being retried
    // ahead of work that arrived while it was failing.
    await (await this.query()).where('id', '=', id as never).delete()
    await this.pushToDatabase(payload, delay, queue, payload.attempts)
  }

  /** Called by a job that finished or failed. */
  async deleteJob(id: unknown): Promise<void> {
    await (await this.query()).where('id', '=', id as never).delete()
  }

  private async pushToDatabase(
    payload: JobPayload,
    delay: number,
    queue?: string,
    attempts = 0
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000)

    const id = await (await this.query()).insertGetId({
      queue: queue ?? this.defaultQueue,
      payload: JSON.stringify({ ...payload, attempts }),
      attempts,
      reserved_at: null,
      available_at: now + Math.max(0, Math.trunc(delay)),
      created_at: now
    })

    return String(id)
  }

  private async query(): Promise<QueryBuilder> {
    return this.db.table(this.table, this.options.connection)
  }

  private on(connection: Connection): QueryBuilder {
    return new QueryBuilder(connection, this.table)
  }
}

class DatabaseJob implements QueuedJob {
  private deleted = false
  private released = false
  private failed = false

  constructor(
    readonly payload: JobPayload,
    readonly queue: string,
    readonly connectionName: string,
    private readonly id: unknown,
    private readonly driver: DatabaseQueue
  ) {}

  attempts(): number {
    return this.payload.attempts
  }

  async delete(): Promise<void> {
    this.deleted = true

    await this.driver.deleteJob(this.id)
  }

  async release(delay = 0): Promise<void> {
    this.released = true

    await this.driver.releaseJob(this.id, this.payload, this.queue, delay)
  }

  async fail(_error: unknown): Promise<void> {
    this.failed = true

    // The row goes away; recording it belongs to the failed-job store, which the
    // worker owns — a driver has no business knowing where failures are kept.
    await this.driver.deleteJob(this.id)
  }

  isDeleted(): boolean {
    return this.deleted
  }

  isReleased(): boolean {
    return this.released
  }

  hasFailed(): boolean {
    return this.failed
  }
}
