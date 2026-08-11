import type { Connection } from '../connection/connection.ts'
import { QueryBuilder } from '../query/builder.ts'
import { SchemaBuilder } from '../schema/builder.ts'

export type MigrationRecord = {
  id: number
  migration: string
  batch: number
}

/**
 * Tracks which migrations have run, in a table shaped exactly as Laravel's
 * `DatabaseMigrationRepository` creates it: `increments('id')`,
 * `string('migration')`, `integer('batch')`.
 */
export class MigrationRepository {
  constructor(
    private readonly connection: Connection,
    readonly table = 'migrations'
  ) {}

  private query(): QueryBuilder<MigrationRecord> {
    return new QueryBuilder<MigrationRecord>(this.connection, this.table)
  }

  async repositoryExists(): Promise<boolean> {
    return new SchemaBuilder(this.connection).hasTable(this.table)
  }

  async createRepository(): Promise<void> {
    await new SchemaBuilder(this.connection).create(this.table, (table) => {
      table.increments('id')
      table.string('migration')
      table.integer('batch')
    })
  }

  /** Every migration that has run, ordered by batch then name. */
  async getRan(): Promise<string[]> {
    const rows = await this.query().orderBy('batch').orderBy('migration').get()

    return rows.pluck('migration').all()
  }

  /** The migrations in the most recent batch, newest first. */
  async getLast(): Promise<MigrationRecord[]> {
    const batch = await this.getLastBatchNumber()
    if (batch === 0) return []

    return this.getMigrationsByBatch(batch)
  }

  async getMigrationsByBatch(batch: number): Promise<MigrationRecord[]> {
    const rows = await this.query().where('batch', batch).orderByDesc('migration').get()

    return rows.all()
  }

  /** The last `steps` batches worth of migrations, newest first. */
  async getMigrations(steps: number): Promise<MigrationRecord[]> {
    const last = await this.getLastBatchNumber()
    const floor = Math.max(1, last - steps + 1)

    const rows = await this.query()
      .where('batch', '>=', floor)
      .orderByDesc('batch')
      .orderByDesc('migration')
      .get()

    return rows.all()
  }

  async log(migration: string, batch: number): Promise<void> {
    await this.query().insert({ migration, batch })
  }

  async delete(migration: string): Promise<void> {
    await this.query().where('migration', migration).delete()
  }

  async getNextBatchNumber(): Promise<number> {
    return (await this.getLastBatchNumber()) + 1
  }

  async getLastBatchNumber(): Promise<number> {
    return Number((await this.query().max<number>('batch')) ?? 0)
  }
}
