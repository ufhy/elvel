import type { EntryTypeName } from './entry-type.ts'
import { EntryType } from './entry-type.ts'

/** What an entry carries. Anything JSON-encodable; the storage layer encodes it. */
export type EntryContent = Record<string, unknown>

/**
 * An entry on its way to storage.
 *
 * This is the write-side shape, and it is deliberately not the read-side shape
 * ({@link EntryResult}). The two differ in more than direction: a pending entry
 * has no `sequence` because the row does not exist yet, and it carries the
 * predicates below, which a stored row has no use for.
 *
 * Those predicates are the reason this is a class and not an object literal.
 * An application's filter is written against them:
 *
 * ```ts
 * Lens.filter((entry) => local || entry.isSlowQuery() || entry.isFailedRequest())
 * ```
 *
 * Without them every filter would be reaching into `content` by key and
 * guessing at its shape, and a renamed key would silently stop filtering
 * instead of failing to compile.
 */
export class IncomingEntry {
  readonly uuid: string

  type: EntryTypeName | undefined

  batchId: string | undefined

  content: EntryContent

  tags: string[] = []

  readonly recordedAt: Date

  private family: string | undefined

  /**
   * The monitored tags, as they stood when this entry was recorded.
   *
   * Set by the recorder rather than looked up, which is what keeps
   * {@link hasMonitoredTag} taking no arguments — the filter an application
   * writes is `entry.hasMonitoredTag()`, exactly as it is in Telescope, and it
   * must not need a repository handed to it.
   */
  private monitored: string[] = []

  constructor(content: EntryContent, uuid?: string, recordedAt?: Date) {
    this.content = content
    this.uuid = uuid ?? crypto.randomUUID()
    this.recordedAt = recordedAt ?? new Date()
  }

  static make(content: EntryContent): IncomingEntry {
    return new IncomingEntry(content)
  }

  withType(type: EntryTypeName): this {
    this.type = type

    return this
  }

  withBatch(batchId: string): this {
    this.batchId = batchId

    return this
  }

  /**
   * Group this entry with others that are "the same problem".
   *
   * Exceptions hash file and line, queries hash the SQL with its bindings still
   * as placeholders. It is what lets the list collapse repeats.
   */
  withFamilyHash(hash: string | undefined): this {
    this.family = hash

    return this
  }

  familyHash(): string | undefined {
    return this.family
  }

  /** Merge tags in, keeping them unique and in insertion order. */
  withTags(tags: string[]): this {
    this.tags = [...new Set([...this.tags, ...tags])]

    return this
  }

  /**
   * Attach the acting user.
   *
   * Only the three fields the dashboard shows, never the whole record — a user
   * row holds a password hash and whatever else the application put there.
   */
  withUser(user: { id: unknown; name?: unknown; email?: unknown }): this {
    this.content = {
      ...this.content,
      user: { id: user.id, name: user.name ?? null, email: user.email ?? null }
    }

    return this.withTags([`auth:${String(user.id)}`])
  }

  /** Called by the recorder before the filters run. */
  withMonitored(tags: string[]): this {
    this.monitored = tags

    return this
  }

  /**
   * Is any of this entry's tags being monitored?
   *
   * The escape hatch in a production filter: everything else in that filter
   * names a *kind* of entry worth keeping, and this names a *subject* — "keep
   * everything tagged `auth:41` while I work out what is happening to that
   * account", set from the dashboard and switched off again afterwards, with no
   * deploy in between.
   */
  hasMonitoredTag(): boolean {
    if (this.monitored.length === 0 || this.tags.length === 0) return false

    return this.tags.some((tag) => this.monitored.includes(tag))
  }

  isRequest(): boolean {
    return this.type === EntryType.REQUEST
  }

  /** A request the server itself failed, not one the client got wrong. */
  isFailedRequest(): boolean {
    return this.isRequest() && Number(this.content.responseStatus ?? 200) >= 500
  }

  isQuery(): boolean {
    return this.type === EntryType.QUERY
  }

  isSlowQuery(): boolean {
    return this.isQuery() && this.content.slow === true
  }

  isEvent(): boolean {
    return this.type === EntryType.EVENT
  }

  isCache(): boolean {
    return this.type === EntryType.CACHE
  }

  isGate(): boolean {
    return this.type === EntryType.GATE
  }

  isJob(): boolean {
    return this.type === EntryType.JOB
  }

  isFailedJob(): boolean {
    return this.isJob() && this.content.status === 'failed'
  }

  isException(): boolean {
    return this.type === EntryType.EXCEPTION
  }

  isLog(): boolean {
    return this.type === EntryType.LOG
  }

  isScheduledTask(): boolean {
    return this.type === EntryType.SCHEDULED_TASK
  }

  isClientRequest(): boolean {
    return this.type === EntryType.CLIENT_REQUEST
  }

  isModel(): boolean {
    return this.type === EntryType.MODEL
  }
}
