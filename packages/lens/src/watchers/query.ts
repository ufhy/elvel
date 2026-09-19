import type { ApplicationContract } from '@elvel/contracts'
import { inlineBindings, QueryExecuted } from '@elvel/database'
import { callerFrom } from '../caller.ts'
import { IncomingEntry } from '../entry.ts'
import { EntryType } from '../entry-type.ts'
import { EntryUpdate } from '../entry-update.ts'
import { explainFor, readPlan } from '../explain.ts'
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
  private app: ApplicationContract | undefined

  register(app: ApplicationContract): void {
    const events = app.make('events')

    this.app = app

    events.listen(QueryExecuted, (event: QueryExecuted) => {
      this.record(app.make('lens'), event)
    })
  }

  private record(lens: Recorder, event: QueryExecuted): void {
    if (!lens.recording()) return

    /**
     * Never its own instrument.
     *
     * `explain` is a statement like any other, so the connection dispatches it
     * and this listener would record it — and then explain *that*. The guard is
     * on the SQL rather than on a flag because the recursion has to be
     * impossible, not merely unlikely.
     */
    if (/^\s*explain\b/i.test(event.sql)) return

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
       * Interpolating them into the SQL lets a query be copied into a client,
       * and the entry then holds every value the statement carried — email
       * addresses, tokens, whatever was in the where clause. A recorder whose
       * rows are readable by anyone who can reach the dashboard should not make
       * that trade by default, so the shape is recorded and the values are not.
       * Reproducing a query needs the parameters; understanding one does not.
       */
      bindings: event.bindings.length,
      /**
       * The same statement with its values written in — only when asked for.
       *
       * The deliberate exception to the line above, and the whole of it: turning
       * `bindings` on stores the values, and nothing else changes. Absent by
       * default, so a dashboard that was never configured for it holds no
       * parameter anywhere.
       */
      ...(this.option<boolean>('bindings', false) === true
        ? { raw: inlineBindings(event.sql, event.bindings) }
        : {}),
      time: Number(event.time.toFixed(2)),
      slow,
      file: caller.file,
      line: caller.line
    })
      .withFamilyHash(QueryWatcher.familyHash(event.sql))
      .withTags(slow ? ['slow'] : [])

    lens.record(EntryType.QUERY, entry)

    if (slow) this.explain(lens, entry.uuid, event)
  }

  /**
   * Ask the database how it answered, and attach what it said.
   *
   * Off unless `explain` is set, and only for a statement already slow enough
   * to have earned a second round trip. It is the one thing in this package
   * that issues a statement of its own, which is why it is opt-in.
   *
   * Not awaited: the request is not made to wait for an inspection of itself.
   * The answer arrives as an update, and an update that arrives after the batch
   * was flushed is dropped — the entry simply carries no plan, which is the
   * honest outcome of asking a question too late.
   */
  private explain(lens: Recorder, uuid: string, event: QueryExecuted): void {
    if (this.option<boolean>('explain', false) !== true || this.app === undefined) return
    if (!this.app.bound('db')) return

    const app = this.app

    void (async () => {
      try {
        const connection = await app.make('db').connection(event.connectionName)
        const statement = explainFor(connection.grammar.dialect, event.sql)

        if (statement === undefined) return

        const rows = await connection.select<Record<string, unknown>>(statement, event.bindings)
        const plan = readPlan(connection.grammar.dialect, rows)

        if (plan.scans.length === 0) return

        lens.recordUpdate(
          new EntryUpdate(uuid, EntryType.QUERY)
            .change({ scans: plan.scans, plan: plan.detail })
            .addTags(['full scan'])
        )
      } catch {
        // A plan is a nicety. A recorder that fails a request it was only
        // watching is worse than a recorder that says nothing.
      }
    })()
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
