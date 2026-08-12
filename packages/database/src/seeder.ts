import type { Connection, Row } from './connection/connection.ts'
import { QueryBuilder } from './query/builder.ts'

export type SeederContext = {
  connection: Connection
  /** Run another seeder from inside this one — Laravel's `$this->call()`. */
  call(...seeders: Array<new () => Seeder>): Promise<void>
  /** A query builder for a table, for bulk inserts that skip the model layer. */
  table(name: string): QueryBuilder<Row>
  note(message: string): void
}

/**
 * Base seeder.
 *
 * Seeders are plain classes with a `run()`; there is no auto-discovery, because
 * seed order matters and a directory listing is a bad way to express it. Compose
 * them explicitly with `call()`.
 */
export abstract class Seeder {
  abstract run(context: SeederContext): Promise<void> | void
}

export type SeederEvents = { onNote?: (message: string) => void }

/** Run a seeder graph against a connection, keeping each class to one run. */
export class SeederRunner {
  private readonly ran = new Set<string>()

  constructor(
    private readonly connection: Connection,
    private readonly events: SeederEvents = {}
  ) {}

  async run(seeder: new () => Seeder): Promise<void> {
    // A shared seeder pulled in by two others must not run twice.
    if (this.ran.has(seeder.name)) return
    this.ran.add(seeder.name)

    const instance = new seeder()

    await instance.run(this.context())
    this.events.onNote?.(`Seeded ${seeder.name}.`)
  }

  private context(): SeederContext {
    return {
      connection: this.connection,
      call: async (...seeders) => {
        for (const seeder of seeders) await this.run(seeder)
      },
      table: (name: string) => new QueryBuilder<Row>(this.connection, name),
      note: (message: string) => this.events.onNote?.(message)
    }
  }
}
