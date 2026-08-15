import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Model } from '../model/model.ts'
import { SchemaBuilder } from '../schema/builder.ts'
import { MigrationCommand } from './base.ts'

/**
 * What a model is, without opening the file — Laravel's `model:show`.
 *
 * The useful part is that it reads both sides: the class says what it casts and
 * hides, the database says what columns are actually there. A property declared
 * on the model with no column behind it is the bug this finds, and it is
 * invisible from either side alone.
 */
export class ModelShowCommand extends MigrationCommand {
  static override signature =
    'model:show {model : The model class name, e.g. Article} {--database= : The connection to inspect} {--json : Output as JSON}'

  static override description = 'Show a model, its table and its columns'

  async handle(): Promise<number> {
    const name = this.argument('model')
    const found = await loadModel(this.app.appPath('Models'), name)

    if (!found) {
      this.error(`No model named [${name}] under app/Models.`)
      return 1
    }

    const manager = this.app.make('db')
    const database = this.stringOption('database')
    const connection = await manager.connection(database === '' ? undefined : database)
    const schema = new SchemaBuilder(connection)
    const table = found.getTable()

    const columns = (await schema.hasTable(table)) ? await schema.getColumnListing(table) : []

    const summary = {
      model: found.name,
      table,
      connection: connection.name,
      primaryKey: found.primaryKey,
      timestamps: found.timestamps,
      softDeletes: found.softDeletes,
      fillable: found.fillable,
      hidden: found.hidden,
      casts: Object.keys(found.casts),
      globalScopes: Object.keys(found.globalScopes),
      prunable: typeof found.prunable === 'function',
      columns
    }

    if (this.flag('json')) {
      this.line(JSON.stringify(summary, null, 2))
      return 0
    }

    this.line()
    this.output.pairs([
      ['Model', summary.model],
      ['Table', summary.table],
      ['Connection', summary.connection],
      ['Primary key', summary.primaryKey],
      ['Timestamps', String(summary.timestamps)],
      ['Soft deletes', String(summary.softDeletes)],
      ['Prunable', String(summary.prunable)]
    ])
    this.line()

    if (columns.length === 0) {
      this.warn(`Table [${table}] does not exist. Run migrate.`)
      this.line()

      return 0
    }

    /**
     * Marked rather than filtered.
     *
     * A hidden column is still there and a cast column is still a column; showing
     * one list with notes says more than three lists that have to be read
     * together.
     */
    this.table(
      ['COLUMN', 'NOTES'],
      columns.map((column) => [
        column,
        [
          summary.casts.includes(column) ? `cast:${String(found.casts[column])}` : '',
          summary.hidden.includes(column) ? 'hidden' : '',
          summary.fillable.includes(column) ? 'fillable' : '',
          column === summary.primaryKey ? 'key' : ''
        ]
          .filter(Boolean)
          .join(' ')
      ])
    )
    this.line()

    // Declared on the class but not in the table — the mismatch worth naming.
    const missing = [...summary.fillable, ...summary.hidden].filter(
      (column) => !columns.includes(column)
    )

    if (missing.length > 0) {
      this.warn(`Declared but not a column: ${[...new Set(missing)].join(', ')}`)
      this.line()
    }

    return 0
  }
}

/** Every model class exported under a directory, keyed by class name. */
export async function loadModels(directory: string): Promise<Array<typeof Model>> {
  let entries: string[]

  try {
    entries = await readdir(directory)
  } catch {
    return []
  }

  const models: Array<typeof Model> = []

  for (const entry of entries.sort()) {
    if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

    const module = (await import(join(directory, entry))) as Record<string, unknown>

    for (const exported of Object.values(module)) {
      // `Model` itself is exported by the package and would be picked up by a
      // check that only asked "is this a subclass".
      if (
        typeof exported === 'function' &&
        exported !== Model &&
        exported.prototype instanceof Model
      ) {
        models.push(exported as typeof Model)
      }
    }
  }

  return models
}

async function loadModel(directory: string, name: string): Promise<typeof Model | undefined> {
  const models = await loadModels(directory)

  return models.find((model) => model.name.toLowerCase() === name.toLowerCase())
}
