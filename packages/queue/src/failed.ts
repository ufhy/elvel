import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConnectionManager } from '@elvel/database'
import { Clock } from '@elvel/support'
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

/**
 * Failures written to a JSON file, one per line.
 *
 * For a service with a queue and no database — a worker that only calls APIs, a
 * scheduled process on a box with nothing else on it. `array` loses them when
 * the process ends, which is the one thing a failure record must not do.
 *
 * A line per record rather than one JSON document, because appending is the hot
 * path and rewriting a growing array on every failure is how the file becomes
 * the outage. Reading parses the lines back and skips any that will not parse:
 * a half-written line from a killed process must not make every earlier failure
 * unreadable.
 */
export class FileFailedJobStore implements FailedJobStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  async log(
    connection: string,
    queue: string,
    payload: JobPayload,
    error: unknown
  ): Promise<string | number> {
    const record: FailedJobRecord = {
      id: crypto.randomUUID(),
      uuid: payload.uuid,
      connection,
      queue,
      payload,
      exception: describeError(error),
      failedAt: new Date()
    }

    // Serialised through a promise chain: two appends racing to the same file
    // can interleave mid-line, and a torn line is a lost failure.
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await appendFile(this.path, `${JSON.stringify(record)}\n`)
    })

    await this.queue

    return record.id
  }

  async all(): Promise<FailedJobRecord[]> {
    let contents: string

    try {
      contents = await readFile(this.path, 'utf8')
    } catch {
      return []
    }

    const records: FailedJobRecord[] = []

    for (const line of contents.split('\n')) {
      if (line.trim() === '') continue

      try {
        const parsed = JSON.parse(line) as FailedJobRecord

        records.push({ ...parsed, failedAt: new Date(parsed.failedAt) })
      } catch {
        // A half-written line from a killed process. Skipped rather than fatal:
        // every other failure in the file is still readable.
      }
    }

    return records
  }

  async find(id: string | number): Promise<FailedJobRecord | null> {
    return (await this.all()).find((record) => String(record.id) === String(id)) ?? null
  }

  async forget(id: string | number): Promise<boolean> {
    const records = await this.all()
    const kept = records.filter((record) => String(record.id) !== String(id))

    if (kept.length === records.length) return false

    await this.rewrite(kept)

    return true
  }

  async flush(hours?: number): Promise<number> {
    const records = await this.all()

    if (hours === undefined) {
      await this.rewrite([])

      return records.length
    }

    const cutoff = Clock.now() - hours * 3_600_000
    const kept = records.filter((record) => record.failedAt.getTime() > cutoff)

    await this.rewrite(kept)

    return records.length - kept.length
  }

  private async rewrite(records: FailedJobRecord[]): Promise<void> {
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(this.path, records.map((record) => `${JSON.stringify(record)}\n`).join(''))
    })

    await this.queue
  }
}

/**
 * Failures nobody records.
 *
 * The honest counterpart to the `null` queue: an environment that must not run
 * background work has no failures to keep either. Deliberate, and never a
 * fallback — `array` is what an unconfigured application gets, because a failure
 * that vanishes at process exit still beats one that was never written.
 */
export class NullFailedJobStore implements FailedJobStore {
  async log(
    _connection: string,
    _queue: string,
    payload: JobPayload,
    _error: unknown
  ): Promise<string | number> {
    return payload.uuid
  }

  async all(): Promise<FailedJobRecord[]> {
    return []
  }

  async find(_id: string | number): Promise<FailedJobRecord | null> {
    return null
  }

  async forget(_id: string | number): Promise<boolean> {
    return false
  }

  async flush(_hours?: number): Promise<number> {
    return 0
  }
}
