import type { Grammar } from '../query/grammar.ts'
import type { Connection, Row } from './connection.ts'
import type { TransactionManager } from './transactions.ts'

/**
 * One logical connection over a writer and a reader — Laravel's read/write
 * splitting.
 *
 * Reads go to the replica, writes to the primary. Three cases send a read to the
 * primary instead, and each is a correctness rule rather than a preference:
 *
 * 1. **Inside a transaction.** The replica cannot see uncommitted rows, so a read
 *    that crossed over would not see what this transaction just wrote.
 * 2. **After a write, when `sticky` is on.** Replication lags. Insert a row and
 *    immediately read it back and the replica may not have it yet — which reads as
 *    a bug in your code, not in the cluster.
 * 3. **When no reader is configured**, which makes the whole thing a no-op rather
 *    than an error.
 *
 * `sticky` is per connection object here, not per request, because this layer has
 * no idea what a request is. A long-lived process that writes once would then send
 * every later read to the primary, so `forgetRecordModifications()` exists and the
 * http package calls it when a response is finished.
 */
export class ReadWriteConnection implements Connection {
  /** Set by the first write; consulted by every read while `sticky` is on. */
  private recordsModified = false

  constructor(
    private readonly writer: Connection,
    private readonly reader: Connection,
    private readonly sticky = false
  ) {}

  get name(): string {
    return this.writer.name
  }

  get grammar(): Grammar {
    return this.writer.grammar
  }

  get transactions(): TransactionManager | undefined {
    return this.writer.transactions
  }

  /** Which connection a read should use, right now. */
  private readerFor(): Connection {
    if (this.writer.transactions?.inTransaction) return this.writer
    if (this.sticky && this.recordsModified) return this.writer

    return this.reader
  }

  /** Send later reads to the replica again — call this per request boundary. */
  forgetRecordModifications(): this {
    this.recordsModified = false

    return this
  }

  /** True when this connection has written since the last reset. */
  get hasModifiedRecords(): boolean {
    return this.recordsModified
  }

  async select<T = Row>(sql: string, bindings: unknown[] = []): Promise<T[]> {
    return this.readerFor().select<T>(sql, bindings)
  }

  async affectingStatement(sql: string, bindings: unknown[] = []): Promise<number> {
    this.recordsModified = true

    return this.writer.affectingStatement(sql, bindings)
  }

  async statement(sql: string, bindings: unknown[] = []): Promise<void> {
    this.recordsModified = true

    return this.writer.statement(sql, bindings)
  }

  async unprepared(sql: string): Promise<void> {
    this.recordsModified = true

    return this.writer.unprepared(sql)
  }

  /**
   * Always on the writer, and the callback gets the writer too.
   *
   * A transaction that handed out a reader would let a read inside it miss the
   * rows the same transaction wrote — the first rule above, in the one place it
   * is easiest to get wrong.
   */
  async transaction<T>(callback: (tx: Connection) => Promise<T>, attempts = 1): Promise<T> {
    this.recordsModified = true

    return this.writer.transaction(callback, attempts)
  }

  async afterCommit(callback: () => unknown): Promise<void> {
    return this.writer.afterCommit(callback)
  }

  afterRollback(callback: () => unknown): void {
    this.writer.afterRollback(callback)
  }

  async disconnect(): Promise<void> {
    await Promise.all([this.writer.disconnect(), this.reader.disconnect()])
  }
}
