import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Connection } from '../connection/connection.ts'
import { SchemaBuilder } from '../schema/builder.ts'
import { Migration, type MigrationFile } from './migration.ts'
import type { MigrationRepository } from './repository.ts'

export type MigratorEvents = {
  onNote?: (message: string) => void
}

export type RunOptions = {
  /** Record each migration in its own batch, so they roll back one at a time. */
  step?: boolean
  /** Compile the SQL and report it without touching the database. */
  pretend?: boolean
}

export type RollbackOptions = {
  /** Roll back this many batches. Defaults to one. */
  step?: number
  /** Roll back one specific batch. */
  batch?: number
  pretend?: boolean
}

/**
 * Runs and reverses migrations.
 *
 * Batching follows Laravel: `migrate` records one batch per run (or one per
 * migration with `--step`), and `migrate:rollback` reverses the newest batch,
 * newest migration first.
 */
export class Migrator {
  constructor(
    private readonly connection: Connection,
    private readonly repository: MigrationRepository,
    private readonly paths: string[],
    private readonly events: MigratorEvents = {}
  ) {}

  private note(message: string): void {
    this.events.onNote?.(message)
  }

  get schema(): SchemaBuilder {
    return new SchemaBuilder(this.connection)
  }

  /** Ensure the tracking table exists, as `migrate:install` does. */
  async install(): Promise<void> {
    if (await this.repository.repositoryExists()) return

    await this.repository.createRepository()
    this.note(`Created the ${this.repository.table} table.`)
  }

  /** Load every migration file from the configured paths, ordered by name. */
  async files(): Promise<MigrationFile[]> {
    const found: MigrationFile[] = []

    for (const path of this.paths) {
      let entries: string[]
      try {
        entries = await readdir(path)
      } catch {
        continue
      }

      for (const entry of entries.sort()) {
        if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

        const file = join(path, entry)
        const module = (await import(file)) as Record<string, unknown>
        const loaded = this.instantiate(module)

        if (!loaded) {
          throw new Error(
            `Migration [${entry}] has no default export extending Migration. Export it as default.`
          )
        }

        found.push({
          name: entry.replace(/\.(ts|js|mts|mjs)$/, ''),
          path: file,
          migration: loaded.migration,
          withinTransaction: loaded.withinTransaction,
          connection: loaded.connection
        })
      }
    }

    // Names start with a timestamp, so lexical order is chronological order.
    return found.sort((left, right) => left.name.localeCompare(right.name))
  }

  private instantiate(
    module: Record<string, unknown>
  ): { migration: Migration; withinTransaction: boolean; connection?: string } | undefined {
    for (const exported of [module.default, ...Object.values(module)]) {
      if (typeof exported !== 'function') continue

      const candidate = exported as unknown as {
        prototype?: { up?: unknown; down?: unknown }
        withinTransaction?: boolean
        connection?: string
      }

      if (
        typeof candidate.prototype?.up !== 'function' ||
        typeof candidate.prototype?.down !== 'function'
      ) {
        continue
      }

      return {
        migration: new (exported as new () => Migration)(),
        withinTransaction: candidate.withinTransaction ?? Migration.withinTransaction,
        connection: candidate.connection
      }
    }

    return undefined
  }

  /** Migrations present on disk but not yet recorded as run. */
  async pending(): Promise<MigrationFile[]> {
    const ran = new Set(await this.repository.getRan())

    return (await this.files()).filter((file) => !ran.has(file.name))
  }

  async status(): Promise<Array<{ name: string; ran: boolean; batch?: number }>> {
    const records = new Map<string, number>()
    for (const batch of await this.allRecords()) records.set(batch.migration, batch.batch)

    return (await this.files()).map((file) => ({
      name: file.name,
      ran: records.has(file.name),
      batch: records.get(file.name)
    }))
  }

  private async allRecords() {
    // Status must work before `migrate` has ever run, so a missing tracking
    // table means "nothing has run" rather than an error.
    if (!(await this.repository.repositoryExists())) return []

    const last = await this.repository.getLastBatchNumber()

    return last === 0 ? [] : this.repository.getMigrations(last)
  }

  // --------------------------------------------------------------------- run

  async run(options: RunOptions = {}): Promise<string[]> {
    await this.install()

    const pending = await this.pending()
    if (pending.length === 0) {
      this.note('Nothing to migrate.')
      return []
    }

    let batch = await this.repository.getNextBatchNumber()
    const applied: string[] = []

    for (const file of pending) {
      if (!file.migration.shouldRun()) {
        this.note(`Skipped ${file.name} (shouldRun returned false).`)
        continue
      }

      await this.runOne(file, 'up', options.pretend === true)

      if (options.pretend !== true) {
        await this.repository.log(file.name, batch)
        // --step gives each migration its own batch so it rolls back alone.
        if (options.step) batch += 1
      }

      applied.push(file.name)
    }

    return applied
  }

  // ---------------------------------------------------------------- rollback

  async rollback(options: RollbackOptions = {}): Promise<string[]> {
    if (!(await this.repository.repositoryExists())) {
      this.note('Migration table not found. Nothing to roll back.')
      return []
    }

    const records =
      options.batch !== undefined
        ? await this.repository.getMigrationsByBatch(options.batch)
        : options.step !== undefined && options.step > 1
          ? await this.repository.getMigrations(options.step)
          : await this.repository.getLast()

    if (records.length === 0) {
      this.note('Nothing to roll back.')
      return []
    }

    return this.rollbackRecords(records, options.pretend === true)
  }

  /** Roll everything back, oldest batch last — `migrate:reset`. */
  async reset(pretend = false): Promise<string[]> {
    if (!(await this.repository.repositoryExists())) return []

    const last = await this.repository.getLastBatchNumber()
    if (last === 0) return []

    return this.rollbackRecords(await this.repository.getMigrations(last), pretend)
  }

  private async rollbackRecords(
    records: Array<{ migration: string }>,
    pretend: boolean
  ): Promise<string[]> {
    const files = new Map((await this.files()).map((file) => [file.name, file]))
    const reverted: string[] = []

    for (const record of records) {
      const file = files.get(record.migration)

      if (!file) {
        this.note(`Migration ${record.migration} is recorded but its file is missing; skipped.`)
        continue
      }

      await this.runOne(file, 'down', pretend)

      if (!pretend) await this.repository.delete(record.migration)
      reverted.push(record.migration)
    }

    return reverted
  }

  /** Drop every table and migrate from scratch — `migrate:fresh`. */
  async fresh(): Promise<string[]> {
    const schema = this.schema

    await schema.withoutForeignKeyConstraints(async () => {
      for (const table of await this.tables()) {
        await schema.dropIfExists(table)
      }
    })

    this.note('Dropped all tables.')

    return this.run()
  }

  /** Table names in the current database, used only by `fresh`. */
  private async tables(): Promise<string[]> {
    const dialect = this.connection.grammar.dialect

    const sql =
      dialect === 'sqlite'
        ? "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        : dialect === 'postgres'
          ? 'select tablename as name from pg_catalog.pg_tables where schemaname = current_schema()'
          : 'select table_name as name from information_schema.tables where table_schema = database()'

    const rows = await this.connection.select<{ name: string }>(sql)

    return rows.map((row) => row.name)
  }

  private async runOne(
    file: MigrationFile,
    direction: 'up' | 'down',
    pretend: boolean
  ): Promise<void> {
    const context = { schema: this.schema, connection: this.connection }

    if (pretend) {
      this.note(`${direction === 'up' ? 'Would run' : 'Would reverse'} ${file.name}.`)
      return
    }

    const execute = async (connection: Connection) => {
      const scoped = { schema: new SchemaBuilder(connection), connection }
      await file.migration[direction](scoped)
    }

    // SQLite and Postgres run DDL inside transactions; MySQL implicitly commits,
    // so wrapping there would only give a false sense of atomicity.
    const transactional =
      file.withinTransaction && ['sqlite', 'postgres'].includes(this.connection.grammar.dialect)

    if (transactional) {
      await this.connection.transaction(execute)
    } else {
      await execute(context.connection)
    }

    this.note(`${direction === 'up' ? 'Migrated' : 'Rolled back'} ${file.name}.`)
  }
}
