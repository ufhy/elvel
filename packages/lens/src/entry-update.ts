import type { EntryContent } from './entry.ts'
import type { EntryTypeName } from './entry-type.ts'

/**
 * A patch against an entry that is already stored — or is not stored yet.
 *
 * The second case is why this exists as its own channel rather than being an
 * `update` call. A job entry is written when the job is picked up and patched
 * when it finishes; a fast job finishes before its own batch has been flushed,
 * so the patch arrives before the row. That is normal, not an error, and the
 * repository reports such patches back rather than failing.
 */
export class EntryUpdate {
  changes: EntryContent = {}

  readonly tagsAdded: string[] = []

  readonly tagsRemoved: string[] = []

  constructor(
    readonly uuid: string,
    readonly type: EntryTypeName
  ) {}

  change(changes: EntryContent): this {
    this.changes = { ...this.changes, ...changes }

    return this
  }

  addTags(tags: string[]): this {
    this.tagsAdded.push(...tags)

    return this
  }

  removeTags(tags: string[]): this {
    this.tagsRemoved.push(...tags)

    return this
  }
}
