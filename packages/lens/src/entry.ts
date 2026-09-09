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
