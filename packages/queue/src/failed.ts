import type { ConnectionManager } from '@elvel/database'
import type { FailedJobRecord, FailedJobStore, JobPayload } from './contracts.ts'

export type DatabaseFailedJobStoreOptions = {
  connection?: string
  table?: string
}

/** The message and stack of anything throwable, as text for the record. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}\n${error.stack ?? ''}`.trim()

  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }

  return String(error)
}

/**
 * Failed jobs in a table — `DatabaseFailedJobProvider`.
 *
 * The payload is kept whole rather than summarised, because that is what
 * `queue:retry` needs: the point of recording a failure is being able to run it
 * again once the cause is fixed.
 */
export class DatabaseFailedJobStore implements FailedJobStore {
  private readonly table: string

  constructor(
    private readonly db: ConnectionManager,
    private readonly options: DatabaseFailedJobStoreOptions = {}
  ) {
    this.table = options.table ?? 'failed_jobs'
  }

  async log(
    connection: string,
    queue: string,
    payload: JobPayload,
    error: unknown
  ): Promise<string | number> {
    const id = await (await this.query()).insertGetId({
      uuid: payload.uuid,
      connection,
      queue,
      payload: JSON.stringify(payload),
      exception: describeError(error),
      failed_at: new Date().toISOString().slice(0, 19).replace('T', ' ')
    })

    return id as string | number
  }

  async all(): Promise<FailedJobRecord[]> {
    const rows = await (await this.query()).orderBy('id', 'desc').get()

    return rows.all().map((row) => this.hydrate(row))
  }

  async find(id: string | number): Promise<FailedJobRecord | null> {
    const row = await (await this.query()).where('id', '=', id as never).first()

    return row ? this.hydrate(row) : null
  }

  async forget(id: string | number): Promise<boolean> {
    return (await (await this.query()).where('id', '=', id as never).delete()) > 0
  }

  /** Delete everything, or everything older than `hours`. */
  async flush(hours?: number): Promise<number> {
    const query = await this.query()

    if (hours !== undefined) {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ')

      return query.where('failed_at', '<=', cutoff).delete()
    }

    return query.delete()
  }

  private hydrate(row: Record<string, unknown>): FailedJobRecord {
    return {
      id: row.id as string | number,
      uuid: String(row.uuid),
      connection: String(row.connection),
      queue: String(row.queue),
      payload: JSON.parse(String(row.payload)) as JobPayload,
      exception: String(row.exception),
      failedAt: row.failed_at instanceof Date ? row.failed_at : new Date(String(row.failed_at))
    }
  }

  private async query() {
    return this.db.table(this.table, this.options.connection)
  }
}

/**
 * Failures in memory.
 *
 * The default when no database is configured, and what tests use: a failure that
 * vanishes is still better than a failure nobody records, and it keeps the queue
 * usable in an application with no `failed_jobs` table.
 */
export class ArrayFailedJobStore implements FailedJobStore {
  private readonly records: FailedJobRecord[] = []
  private nextId = 1

  async log(
    connection: string,
    queue: string,
    payload: JobPayload,
    error: unknown
  ): Promise<string | number> {
    const id = this.nextId++

    this.records.push({
      id,
      uuid: payload.uuid,
      connection,
      queue,
      payload,
      exception: describeError(error),
      failedAt: new Date()
    })

    return id
  }

  async all(): Promise<FailedJobRecord[]> {
    return [...this.records].reverse()
  }

  async find(id: string | number): Promise<FailedJobRecord | null> {
    return this.records.find((record) => String(record.id) === String(id)) ?? null
  }

  async forget(id: string | number): Promise<boolean> {
    const index = this.records.findIndex((record) => String(record.id) === String(id))
    if (index === -1) return false

    this.records.splice(index, 1)

    return true
  }

  async flush(hours?: number): Promise<number> {
    if (hours === undefined) {
      const count = this.records.length
      this.records.length = 0

      return count
    }

    const cutoff = Date.now() - hours * 3600 * 1000
    const keep = this.records.filter((record) => record.failedAt.getTime() > cutoff)
    const removed = this.records.length - keep.length

    this.records.length = 0
    this.records.push(...keep)

    return removed
  }
}
