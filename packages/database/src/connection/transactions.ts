/**
 * Callbacks waiting for a transaction to commit —
 * `Illuminate\Database\DatabaseTransactionsManager`.
 *
 * The problem it solves is a real bug, not an abstraction. Queue a job inside a
 * transaction and a worker can reserve it before the transaction commits: the
 * worker then reads rows that do not exist yet, or reads nothing and fails a job
 * that should have succeeded. The same applies to a queued listener, a
 * notification, or anything else that leaves this process.
 *
 * So work marked `afterCommit` is held here and released when the **outermost**
 * transaction commits — and dropped if it rolls back, because the rows it was
 * about never existed.
 *
 * One manager per connection, because that is the scope a commit has.
 */
export class TransactionManager {
  /** How deep we are. Zero means no transaction is open. */
  private depth = 0

  /** Callbacks per depth, so a nested rollback only discards its own. */
  private pending: Array<Array<() => unknown>> = []

  /** The mirror: run only if this level rolls back. */
  private pendingRollback: Array<Array<() => unknown>> = []

  get level(): number {
    return this.depth
  }

  get inTransaction(): boolean {
    return this.depth > 0
  }

  /** How many callbacks are waiting. For tests and `db:show`-style reporting. */
  get pendingCount(): number {
    return this.pending.reduce((total, level) => total + level.length, 0)
  }

  begin(): void {
    this.depth += 1
    this.pending.push([])
    this.pendingRollback.push([])
  }

  /**
   * Run `callback` after the outermost commit, or **now** if nothing is open.
   *
   * Running immediately outside a transaction is what lets a caller mark work
   * `afterCommit` unconditionally: it does the right thing either way, so no
   * caller has to ask "am I in a transaction?" — which is a question code
   * usually cannot answer about itself.
   */
  async afterCommit(callback: () => unknown): Promise<void> {
    if (!this.inTransaction) {
      await callback()

      return
    }

    ;(this.pending[this.depth - 1] as Array<() => unknown>).push(callback)
  }

  /**
   * Run `callback` only if the enclosing transaction rolls back.
   *
   * The mirror of `afterCommit`, for compensation: releasing a hold, undoing a
   * side effect made against an external system that has no transaction to join.
   * Outside a transaction there is nothing that can roll back, so the callback is
   * simply dropped — running it now would compensate for a failure that did not
   * happen.
   */
  afterRollback(callback: () => unknown): void {
    if (!this.inTransaction) return

    ;(this.pendingRollback[this.depth - 1] as Array<() => unknown>).push(callback)
  }

  /**
   * Leave one level successfully.
   *
   * A nested commit hands its callbacks *up* rather than running them: an inner
   * `COMMIT` is a released savepoint, and the outer transaction can still roll
   * the whole thing back.
   */
  async commit(): Promise<void> {
    const { commits: callbacks, rollbacks } = this.leave()

    if (this.depth > 0) {
      ;(this.pending[this.depth - 1] as Array<() => unknown>).push(...callbacks)
      // A nested commit is a released savepoint: the outer level can still roll
      // everything back, so the compensation moves up with the celebration.
      ;(this.pendingRollback[this.depth - 1] as Array<() => unknown>).push(...rollbacks)

      return
    }

    // Sequential on purpose: these were registered in order, and one that throws
    // must not take the rest with it — the transaction is already committed, so
    // there is nothing left to undo.
    for (const callback of callbacks) await callback()
  }

  /** Leave one level after a failure: drop the commits, run the compensation. */
  async rollback(): Promise<void> {
    const { rollbacks } = this.leave()

    // Sequential, and one that throws must not take the rest with it — the
    // rollback already happened, and each compensation is independent.
    for (const callback of rollbacks) {
      try {
        await callback()
      } catch {
        // Reported nowhere on purpose: this runs inside an error path, and a
        // second throw here would mask the error the caller actually cares about.
      }
    }
  }

  private leave(): { commits: Array<() => unknown>; rollbacks: Array<() => unknown> } {
    if (this.depth === 0) return { commits: [], rollbacks: [] }

    this.depth -= 1

    return { commits: this.pending.pop() ?? [], rollbacks: this.pendingRollback.pop() ?? [] }
  }
}
