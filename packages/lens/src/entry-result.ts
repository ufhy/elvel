import type { EntryContent } from './entry.ts'
import type { EntryTypeName } from './entry-type.ts'

/**
 * A stored entry on its way out.
 *
 * Separate from {@link IncomingEntry} because the two are genuinely different
 * shapes and not two directions of one: this has a `sequence` (the row exists,
 * and the dashboard pages by it) and no predicates (a filter has already run;
 * nothing downstream asks a stored row what kind of thing it is).
 */
export class EntryResult {
  constructor(
    readonly uuid: string,
    /** The keyset cursor. Absent when the row was fetched by uuid. */
    readonly sequence: number | undefined,
    readonly batchId: string,
    readonly type: EntryTypeName,
    readonly familyHash: string | undefined,
    readonly content: EntryContent,
    readonly createdAt: string | undefined,
    readonly tags: string[] = []
  ) {}

  toJSON(): Record<string, unknown> {
    return {
      id: this.uuid,
      sequence: this.sequence,
      batchId: this.batchId,
      type: this.type,
      familyHash: this.familyHash,
      content: this.content,
      createdAt: this.createdAt,
      tags: this.tags
    }
  }
}
