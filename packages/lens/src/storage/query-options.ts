/**
 * What the dashboard may ask for when listing entries.
 *
 * Every field is optional and every one narrows. `beforeSequence` is the cursor:
 * paging is keyset rather than offset because entries arrive while somebody is
 * reading, and an offset would show them page two's first row twice.
 */
export class EntryQueryOptions {
  batchId: string | undefined

  /** One or more tags, comma-separated in the query string. Matching is OR. */
  tag: string | undefined

  familyHash: string | undefined

  beforeSequence: number | undefined

  /**
   * Rows per page, clamped.
   *
   * Clamped because the dashboard is a URL and this arrives from it: an
   * unbounded limit is a request that reads the whole table into memory, which
   * the spike's security review caught.
   */
  limit = 50

  static readonly maxLimit = 200

  /**
   * Everything in one batch — what a detail page shows beside the entry.
   *
   * Telescope asks for this with `limit(-1)`, meaning unbounded, and gets away
   * with it because a batch is one request's worth of activity. This caps it
   * instead: the cap is not reachable from the URL, so it is not the unbounded
   * URL parameter the spike's security review objected to, but a request that
   * ran fifty thousand queries should still not be assembled into one JSON
   * response.
   */
  static forBatch(batchId: string): EntryQueryOptions {
    const options = new EntryQueryOptions()

    options.batchId = batchId
    options.limit = EntryQueryOptions.batchLimit

    return options
  }

  static readonly batchLimit = 1000

  static fromRequest(query: Record<string, string | undefined>): EntryQueryOptions {
    const options = new EntryQueryOptions()

    options.batchId = query.batchId ?? undefined
    options.tag = query.tag ?? undefined
    options.familyHash = query.familyHash ?? undefined

    const before = Number(query.beforeSequence)
    options.beforeSequence = Number.isSafeInteger(before) && before > 0 ? before : undefined

    const limit = Number(query.limit)
    options.limit =
      Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, EntryQueryOptions.maxLimit) : 50

    return options
  }

  /** The tags, split and trimmed. */
  tags(): string[] {
    if (this.tag === undefined) return []

    return this.tag
      .split(',')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '')
  }

  /**
   * Whether the index's own filter applies.
   *
   * Asking for a family, a tag or a batch is asking for everything in it — that
   * is how one exception row on the list opens into all five hundred of its
   * occurrences. Only the unfiltered list hides the collapsed ones.
   */
  showsCollapsed(): boolean {
    return this.familyHash !== undefined || this.tag !== undefined || this.batchId !== undefined
  }
}
