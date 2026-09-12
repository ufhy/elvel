import type { ConnectionManager, QueryBuilder } from '@elvel/database'
import type { EntriesDriver } from '../contracts.ts'
import { EntryResult } from '../entry-result.ts'
import type { EntryUpdate } from '../entry-update.ts'
import type { IncomingEntry } from '../entry.ts'
import { EntryType, type EntryTypeName } from '../entry-type.ts'
import { EntryQueryOptions } from './query-options.ts'

export type DatabaseRepositoryOptions = {
  connection?: string
  table?: string
  chunk?: number
}

/** `YYYY-MM-DD HH:MM:SS`, which every dialect accepts as a datetime literal. */
function formatDateTime(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Entries in our own tables.
 *
 * Implements all four contracts, which is the ordinary case — the point of
 * splitting them is that a driver *need not*, not that this one does not.
 */
export class DatabaseEntriesRepository implements EntriesDriver {
  private readonly table: string

  private readonly chunk: number

  /**
   * The monitored tags, memoised for the life of the process.
   *
   * Every recorded entry would otherwise ask the database whether any of its
   * tags is monitored, which is a query per entry to answer a question whose
   * answer changes by hand. `terminate()` drops it — under Bun the process
   * outlives the request, so without that the list would go stale for as long
   * as the server runs.
   */
  private monitoredTags: string[] | undefined

  constructor(
    private readonly db: ConnectionManager,
    private readonly options: DatabaseRepositoryOptions = {}
  ) {
    this.table = options.table ?? 'lens_entries'
    this.chunk = options.chunk ?? 1000
  }

  async find(uuid: string): Promise<EntryResult | undefined> {
    const row = await (await this.entries()).where('uuid', uuid).first()

    if (row === undefined) return undefined

    const tags = await (await this.tags()).where('entry_uuid', uuid).pluck<string>('tag')

    return this.hydrate(row as Record<string, unknown>, tags.all())
  }

  async get(
    type: EntryTypeName | undefined,
    options: EntryQueryOptions
  ): Promise<EntryResult[]> {
    let query = await this.entries()

    if (type !== undefined) query = query.where('type', type)
    if (options.batchId !== undefined) query = query.where('batch_id', options.batchId)
    if (options.familyHash !== undefined) {
      query = query.where('family_hash', options.familyHash)
    }
    if (options.beforeSequence !== undefined) {
      query = query.where('sequence', '<', options.beforeSequence)
    }

    const tags = options.tags()

    if (tags.length > 0) {
      const uuids = await (await this.tags()).whereIn('tag', tags).pluck<string>('entry_uuid')

      if (uuids.all().length === 0) return []

      query = query.whereIn('uuid', uuids.all())
    }

    /**
     * The collapsed rows stay hidden on the unfiltered list and appear once you
     * ask for a family, a tag or a batch. One boolean column serving both views.
     */
    if (!options.showsCollapsed()) query = query.where('should_display_on_index', true)

    const rows = await query.orderByDesc('sequence').take(options.limit).get()

    return rows
      .all()
      .map((row) => this.hydrate(row as Record<string, unknown>, []))
      .filter((entry): entry is EntryResult => entry !== undefined)
  }

  async count(type?: EntryTypeName): Promise<number> {
    const query = await this.entries()

    return type === undefined ? query.count() : query.where('type', type).count()
  }

  async store(entries: IncomingEntry[]): Promise<void> {
    if (entries.length === 0) return

    const exceptions = entries.filter((entry) => entry.isException())
    const rest = entries.filter((entry) => !entry.isException())

    if (exceptions.length > 0) await this.storeExceptions(exceptions)

    for (const slice of this.chunked(rest)) {
      await (await this.entries()).insert(slice.map((entry) => this.row(entry)))
    }

    await this.storeTags(entries)
  }

  /**
   * Store exceptions, folding earlier occurrences of the same family off the
   * index and carrying the running count on the new row.
   *
   * Telescope does this with three statements per exception — a count, a bulk
   * flag update, then the insert. The count and the update are one statement
   * here because the flag update can report how many rows it touched, which is
   * the same number the count was after.
   */
  private async storeExceptions(exceptions: IncomingEntry[]): Promise<void> {
    for (const exception of exceptions) {
      const family = exception.familyHash()

      let occurrences = 0

      if (family !== undefined) {
        occurrences = await (await this.entries())
          .where('type', EntryType.EXCEPTION)
          .where('family_hash', family)
          .count()

        await (await this.entries())
          .where('type', EntryType.EXCEPTION)
          .where('family_hash', family)
          .where('should_display_on_index', true)
          .update({ should_display_on_index: false })
      }

      exception.content = { ...exception.content, occurrences: occurrences + 1 }

      await (await this.entries()).insert(this.row(exception))
    }
  }

  /**
   * Insert the tag rows, tolerating ones that are already there.
   *
   * `insertOrIgnore` rather than catching a unique violation: the composite
   * primary key makes a duplicate harmless, and swallowing an error class to
   * express that would also swallow errors that are not that.
   */
  private async storeTags(entries: IncomingEntry[]): Promise<void> {
    const rows = entries.flatMap((entry) =>
      entry.tags.map((tag) => ({ entry_uuid: entry.uuid, tag }))
    )

    for (const slice of this.chunked(rows)) {
      await (await this.tags()).insertOrIgnore(slice)
    }
  }

  async update(updates: EntryUpdate[]): Promise<EntryUpdate[]> {
    const pending: EntryUpdate[] = []

    for (const update of updates) {
      const row = (await (await this.entries())
        .where('uuid', update.uuid)
        .where('type', update.type)
        .first()) as Record<string, unknown> | undefined

      if (row === undefined) {
        pending.push(update)

        continue
      }

      const content = { ...this.decode(row.content), ...update.changes }

      await (await this.entries())
        .where('uuid', update.uuid)
        .where('type', update.type)
        .update({ content: JSON.stringify(content) })

      if (update.tagsAdded.length > 0) {
        await (await this.tags()).insertOrIgnore(
          update.tagsAdded.map((tag) => ({ entry_uuid: update.uuid, tag }))
        )
      }

      if (update.tagsRemoved.length > 0) {
        await (await this.tags())
          .where('entry_uuid', update.uuid)
          .whereIn('tag', update.tagsRemoved)
          .delete()
      }
    }

    return pending
  }

  async monitoring(): Promise<string[]> {
    if (this.monitoredTags !== undefined) return this.monitoredTags

    try {
      this.monitoredTags = (await (await this.monitored()).pluck<string>('tag')).all()
    } catch {
      // Before the migration runs there is no table. Recording still works.
      this.monitoredTags = []
    }

    return this.monitoredTags
  }

  async isMonitoring(tags: string[]): Promise<boolean> {
    if (tags.length === 0) return false

    const monitored = await this.monitoring()

    return tags.some((tag) => monitored.includes(tag))
  }

  async monitor(tags: string[]): Promise<void> {
    const existing = await this.monitoring()
    const missing = tags.filter((tag) => !existing.includes(tag))

    if (missing.length === 0) return

    await (await this.monitored()).insertOrIgnore(missing.map((tag) => ({ tag })))

    this.monitoredTags = undefined
  }

  async stopMonitoring(tags: string[]): Promise<void> {
    if (tags.length === 0) return

    await (await this.monitored()).whereIn('tag', tags).delete()

    this.monitoredTags = undefined
  }

  /**
   * Delete entries older than `before`, in passes.
   *
   * In passes because a single `delete` covering a week of entries is one long
   * lock. Ordered by `sequence` so each pass takes the oldest rows and the loop
   * is guaranteed to make progress.
   */
  async prune(before: Date, keepExceptions: boolean): Promise<number> {
    let total = 0

    for (;;) {
      let query = (await this.entries()).where('created_at', '<', formatDateTime(before))

      if (keepExceptions) query = query.where('type', '!=', EntryType.EXCEPTION)

      const uuids = (
        await query.orderBy('sequence').take(this.chunk).select('uuid').pluck<string>('uuid')
      ).all()

      if (uuids.length === 0) break

      await (await this.tags()).whereIn('entry_uuid', uuids).delete()

      total += await (await this.entries()).whereIn('uuid', uuids).delete()
    }

    return total
  }

  async clear(): Promise<void> {
    await (await this.tags()).delete()
    await (await this.entries()).delete()
    await (await this.monitored()).delete()

    this.monitoredTags = undefined
  }

  /** Drop what was memoised for the life of the process. */
  async terminate(): Promise<void> {
    this.monitoredTags = undefined
  }

  private row(entry: IncomingEntry): Record<string, unknown> {
    return {
      uuid: entry.uuid,
      batch_id: entry.batchId,
      family_hash: entry.familyHash() ?? null,
      type: entry.type,
      content: JSON.stringify(entry.content),
      created_at: formatDateTime(entry.recordedAt)
    }
  }

  private hydrate(row: Record<string, unknown>, tags: string[]): EntryResult {
    return new EntryResult(
      String(row.uuid),
      row.sequence === undefined || row.sequence === null ? undefined : Number(row.sequence),
      String(row.batch_id),
      String(row.type) as EntryTypeName,
      row.family_hash === null || row.family_hash === undefined
        ? undefined
        : String(row.family_hash),
      this.decode(row.content),
      row.created_at === null || row.created_at === undefined
        ? undefined
        : String(row.created_at),
      tags
    )
  }

  /**
   * The column is text on every dialect, but a driver may hand it back already
   * parsed. Both shapes have to be accepted, and neither may throw: a row whose
   * content is somehow not JSON should show as an empty entry, not break the
   * page listing it.
   */
  private decode(value: unknown): Record<string, unknown> {
    if (value !== null && typeof value === 'object') return value as Record<string, unknown>

    try {
      const parsed = JSON.parse(String(value))

      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }

  private *chunked<T>(items: T[]): Generator<T[]> {
    for (let index = 0; index < items.length; index += this.chunk) {
      yield items.slice(index, index + this.chunk)
    }
  }

  /**
   * `table()` resolves a connection, which may still have to open, so these are
   * awaited at every call site rather than held as fields.
   */
  private entries(): Promise<QueryBuilder> {
    return this.db.table(this.table, this.options.connection)
  }

  private tags(): Promise<QueryBuilder> {
    return this.db.table(`${this.table}_tags`, this.options.connection)
  }

  private monitored(): Promise<QueryBuilder> {
    return this.db.table(`${this.table}_monitoring`, this.options.connection)
  }
}
