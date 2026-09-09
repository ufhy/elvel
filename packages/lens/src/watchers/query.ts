import type { ApplicationContract } from '@elvel/contracts'
import { QueryExecuted } from '@elvel/database'
import { callerFrom } from '../caller.ts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import type { Recorder } from '../recorder.ts'
import { Watcher } from './watcher.ts'

/**
 * Records every statement the application runs.
 *
 * The one watcher worth having first: it needs no new framework event —
 * `QueryExecuted` is dispatched from the connection already — and it exercises
 * the whole path, from the slot-scoped batch through the family hash to keyset
 * paging in the dashboard.
 */
export class QueryWatcher extends Watcher {
  register(app: ApplicationContract): void {
    const events = app.make('events')

    events.listen(QueryExecuted, (event: QueryExecuted) => {
      this.record(app.make('lens'), event)
    })
  }

  private record(lens: Recorder, event: QueryExecuted): void {
    if (!lens.recording()) return

    const caller = callerFrom(new Error().stack, this.option<string[]>('ignorePaths', []))

    // No application frame means the query came from inside a package.
    if (caller === undefined) return

    const slow = event.time >= this.option('slow', Number.POSITIVE_INFINITY)

    const entry = IncomingEntry.make({
      connection: event.connectionName,
      sql: event.sql,
      /**
       * The number of bindings, not the bindings.
       *
       * Telescope interpolates them into the SQL so a query can be copied into
       * a client, and accepts that the entry then holds every value the
       * statement carried — email addresses, tokens, whatever was in the where
       * clause. A recorder whose rows are readable by anyone who can reach the
       * dashboard should not make that trade by default, so the shape is
       * recorded and the values are not. Reproducing a query needs the
       * parameters; understanding one does not.
       */
      bindings: event.bindings.length,
      time: Number(event.time.toFixed(2)),
      slow,
      file: caller.file,
      line: caller.line
    })
      .withFamilyHash(QueryWatcher.familyHash(event.sql))
      .withTags(slow ? ['slow'] : [])

    lens.record(EntryType.QUERY, entry)
  }

  /**
   * Group statements that are the same query.
   *
   * The SQL with its placeholders still in it, so the thousand reads of one row
   * by differing id collapse into one row on the list. Bindings are excluded
   * for the same reason they are not stored.
   */
  static familyHash(sql: string): string {
    return new Bun.CryptoHasher('md5').update(sql).digest('hex')
  }
}
