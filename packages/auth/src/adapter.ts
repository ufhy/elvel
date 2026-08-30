import type { Connection, ConnectionManager, Row } from '@elvel/database'
import { Expression, QueryBuilder } from '@elvel/database'
import type {
  AdapterFactory,
  createAdapterFactory as AdapterFactoryBuilder,
  CleanedWhere,
  CustomAdapter,
  DBAdapterDebugLogOption
} from 'better-auth/adapters'
import type { BetterAuthOptions } from 'better-auth/types'

/**
 * The schema types are reached through `createSchema`'s own parameter rather
 * than imported: `better-auth/adapters` does not re-export them, and reaching
 * into `@better-auth/core` would couple us to a package better-auth treats as
 * internal.
 */
type AuthTables = Parameters<NonNullable<CustomAdapter['createSchema']>>[0]['tables']

type AuthField = AuthTables[string]['fields'][string]

export type Dialect = 'sqlite' | 'mysql' | 'mariadb' | 'postgres'

export type ElvelAdapterOptions = {
  /** Named connection to use. Defaults to the application's default. */
  connection?: string
  /** Dialect of that connection. Decides how booleans are stored. */
  dialect: Dialect
  debugLogs?: DBAdapterDebugLogOption
  /** Where `createSchema` writes the generated migration. */
  migrationPath?: string
  /** File name (without extension) for the generated migration. */
  migrationName?: string
}

/**
 * A better-auth adapter over our own query builder.
 *
 * `createAdapterFactory` does the heavy lifting — it normalises where clauses,
 * applies defaults, generates ids, and serialises values according to what we
 * declare the database supports. What is left for us is the operations below,
 * expressed in the same query builder the rest of the framework uses, so auth
 * reads and writes go through one connection pool, one event stream and one set
 * of grammars.
 *
 * Joins are deliberately not implemented: better-auth hands a `join` to an
 * adapter only when `experimental.joins` is on, and otherwise emulates it with
 * extra queries of its own.
 */
export function elvelAdapter(db: ConnectionManager, options: ElvelAdapterOptions) {
  // Kept so a transaction can build a nested adapter with the same options,
  // exactly as better-auth's own memory adapter does.
  let lazyOptions: BetterAuthOptions = {}

  const build = (resolve: () => Promise<Connection>): AdapterFactory<BetterAuthOptions> => {
    // Lazy for the same reason as `betterAuth` itself — see the note in the
    // provider. `require`, because this is reached from a synchronous factory.
    const createAdapterFactory = require('better-auth/adapters')
      .createAdapterFactory as typeof AdapterFactoryBuilder

    return createAdapterFactory({
      config: {
        adapterId: 'elvel',
        adapterName: 'Elvel Adapter',
        usePlural: false,
        debugLogs: options.debugLogs ?? false,

        // Everything below is about what reaches the driver as a bound value.
        //
        // `false` means "hand us the primitive, and parse it back for us", which
        // is what we want in all three cases: our schema builder writes text
        // columns for json on sqlite, and a driver that already returns an
        // object or a Date simply skips the parse. Declaring `true` would send
        // objects and Dates straight to the driver, which rejects them.
        supportsJSON: false,
        supportsArrays: false,
        supportsDates: false,
        // Postgres has a real boolean column and its driver round-trips one; the
        // others store 0/1, so better-auth converts on both sides for us.
        supportsBooleans: options.dialect === 'postgres',
        supportsNumericIds: true,

        customTransformInput: ({ data, fieldAttributes }) =>
          normaliseDate(data, fieldAttributes, options.dialect),

        transaction: async (callback) => {
          const connection = await resolve()

          return connection.transaction(async (tx) => {
            // The nested adapter resolves to the transaction's connection, so
            // reads inside the callback see the transaction's own writes.
            const scoped: unknown = build(async () => tx)(lazyOptions)

            return callback(scoped as Parameters<typeof callback>[0])
          })
        }
      },

      adapter: ({ getFieldName }): CustomAdapter => {
        const query = async (model: string): Promise<QueryBuilder> =>
          new QueryBuilder(await resolve(), model)

        /** Apply a cleaned where clause to a builder. */
        const applyWhere = (builder: QueryBuilder, where: CleanedWhere[] = []): QueryBuilder => {
          for (const [index, clause] of where.entries()) {
            // The first clause opens the group; `connector` on the later ones
            // decides whether they narrow it or widen it.
            applyClause(builder, clause, index > 0 && clause.connector === 'OR', options.dialect)
          }

          return builder
        }

        /** Narrow a row to the requested columns, when a select was given. */
        const project = (row: Row | undefined, select?: string[]): Row | null => {
          if (!row) return null
          if (!select?.length) return row

          const result: Row = {}
          for (const column of select) result[column] = row[column]

          return result
        }

        /**
         * The key of the first row matching `where`.
         *
         * Singular operations resolve the row first and then act on its key: it
         * keeps `update` and `delete` to exactly one row even when the predicate
         * matches several, which better-auth's contract requires.
         */
        const firstId = async (model: string, where: CleanedWhere[]): Promise<unknown> => {
          const row = await applyWhere(await query(model), where)
            .limit(1)
            .first()

          return row?.id
        }

        const byId = async (model: string, id: unknown): Promise<QueryBuilder> =>
          (await query(model)).where('id', '=', id as never)

        return {
          create: async ({ model, data, select }) => {
            const values = data as Record<string, unknown>

            // A serial primary key is filled in by the database, so read it back.
            if (values.id === undefined) {
              const id = await (await query(model)).insertGetId(values)

              return project({ ...values, id }, select) as never
            }

            await (await query(model)).insert(values)

            return project(values, select) as never
          },

          findOne: async ({ model, where, select }) => {
            const row = await applyWhere(await query(model), where)
              .limit(1)
              .first()

            return project(row, select) as never
          },

          findMany: async ({ model, where, limit, sortBy, offset, select }) => {
            const builder = applyWhere(await query(model), where)

            if (sortBy) {
              builder.orderBy(getFieldName({ model, field: sortBy.field }), sortBy.direction)
            }
            if (limit !== undefined) builder.limit(limit)
            if (offset !== undefined) builder.offset(offset)

            return (await builder.get()).all().map((row) => project(row, select) as Row) as never
          },

          update: async ({ model, where, update }) => {
            const id = await firstId(model, where)
            if (id === undefined) return null

            await (await byId(model, id)).update(update as Row)

            return (await (await byId(model, id)).first()) as never
          },

          updateMany: async ({ model, where, update }) =>
            applyWhere(await query(model), where).update(update),

          delete: async ({ model, where }) => {
            const id = await firstId(model, where)
            if (id === undefined) return

            await (await byId(model, id)).delete()
          },

          deleteMany: async ({ model, where }) => applyWhere(await query(model), where).delete(),

          count: async ({ model, where }) => applyWhere(await query(model), where).count(),

          /**
           * Read and delete in one transaction, so two callers racing for the
           * same single-use token cannot both consume it.
           */
          consumeOne: async ({ model, where }) => {
            const connection = await resolve()

            return connection.transaction(async (tx) => {
              const table = () => new QueryBuilder(tx, model)

              const row = await applyWhere(table(), where).limit(1).first()
              if (!row) return null

              const deleted = await table()
                .where('id', '=', row.id as never)
                .delete()

              return (deleted > 0 ? row : null) as never
            })
          },

          /**
           * `field = field + delta` in one statement, with the where clause
           * re-applied as the guard: a counter that has since been depleted no
           * longer matches, so nothing is written and null comes back.
           */
          incrementOne: async ({ model, where, increment, set }) => {
            const connection = await resolve()

            return connection.transaction(async (tx) => {
              const table = () => new QueryBuilder(tx, model)

              const row = await applyWhere(table(), where).limit(1).first()
              if (!row) return null

              const values: Row = { ...(set ?? {}) }

              for (const [field, delta] of Object.entries(increment)) {
                const sign = delta < 0 ? '-' : '+'

                values[field] = new Expression(
                  `${tx.grammar.wrap(field)} ${sign} ${Math.abs(Number(delta))}`
                )
              }

              const guarded = applyWhere(table(), where).where('id', '=', row.id as never)

              if ((await guarded.update(values)) === 0) return null

              return (await table()
                .where('id', '=', row.id as never)
                .first()) as never
            })
          },

          createSchema: async ({ tables, file }) => ({
            code: migrationFor(tables, options.dialect),
            path: file ?? defaultMigrationPath(options),
            overwrite: false,
            // Returned as well as rendered, so `auth:schema --diff` can compare
            // what is wanted against what the database has without asking
            // better-auth to compute the tables a second time.
            tables
          })
        }
      }
    })
  }

  const factory = build(async () => db.connection(options.connection))

  return (betterAuthOptions: BetterAuthOptions) => {
    lazyOptions = betterAuthOptions

    return factory(betterAuthOptions)
  }
}

/** Apply one clause, mapping better-auth's operators onto ours. */
function applyClause(
  builder: QueryBuilder,
  clause: CleanedWhere,
  or: boolean,
  dialect: Dialect
): void {
  const { field, value, operator, mode } = clause
  const insensitive = mode === 'insensitive' && typeof value === 'string'

  // Postgres is the only dialect we target that compares strings case
  // sensitively by default, so it is the only one that needs `ilike`.
  const like = insensitive && dialect === 'postgres' ? 'ilike' : 'like'
  const where = (column: string, op: string, bound: unknown) =>
    or ? builder.orWhere(column, op, bound as never) : builder.where(column, op, bound as never)

  switch (operator) {
    case 'in':
      if (or) builder.orWhere((nested) => nested.whereIn(field, value as never[]))
      else builder.whereIn(field, value as never[])
      return
    case 'not_in':
      if (or) builder.orWhere((nested) => nested.whereNotIn(field, value as never[]))
      else builder.whereNotIn(field, value as never[])
      return
    case 'contains':
      where(field, like, `%${value}%`)
      return
    case 'starts_with':
      where(field, like, `${value}%`)
      return
    case 'ends_with':
      where(field, like, `%${value}`)
      return
    case 'ne':
      if (value === null) where(field, 'is not', null)
      else if (insensitive && dialect === 'postgres') where(field, 'not ilike', value)
      else where(field, '!=', value)
      return
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      where(field, { lt: '<', lte: '<=', gt: '>', gte: '>=' }[operator], value)
      return
    default:
      // `eq null` has to compile to `is null`: no value ever equals null.
      if (value === null) where(field, 'is', null)
      else if (insensitive) where(field, like, value)
      else where(field, '=', value)
  }
}

/**
 * MySQL and MariaDB reject the `T` separator and trailing `Z` of an ISO string
 * in a `timestamp` column. Postgres and sqlite take it as it stands.
 */
function normaliseDate(value: unknown, field: AuthField, dialect: Dialect): unknown {
  if (dialect !== 'mysql' && dialect !== 'mariadb') return value
  if (field?.type !== 'date' || typeof value !== 'string') return value

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value

  return parsed.toISOString().slice(0, 19).replace('T', ' ')
}

function defaultMigrationPath(options: ElvelAdapterOptions): string {
  const name = options.migrationName ?? 'create_auth_tables'

  return `${options.migrationPath ?? 'database/migrations'}/${name}.ts`
}

/**
 * Render better-auth's schema as one of our migrations.
 *
 * This is what makes the generated file something `migrate` understands: the
 * column types come out of our own blueprint, so each dialect is handled by our
 * schema grammars rather than by better-auth's own type maps.
 */
export function migrationFor(
  tables: AuthTables,
  dialect: Dialect,
  /**
   * Where references are resolved from, when it is not `tables` itself.
   *
   * `diffMigrationFor` renders a *subset* — only the tables that do not exist
   * yet — and a foreign key in that subset still points at a schema key outside
   * it. Resolved against the subset, `userId → user` found nothing and fell back
   * to the raw key, so a diff for a plugin emitted
   * `.references(['id']).on('user')` against an application whose table is
   * called something else. Postgres answers `relation "user" does not exist`.
   */
  all: AuthTables = tables
): string {
  const ordered = Object.entries(tables)
    .filter(([, table]) => table.disableMigrations !== true)
    .sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99))

  // A reference names a *schema key*; the foreign key has to target the table
  // that key resolves to, which a custom `modelName` may have renamed. Looked up
  // in `all` rather than `tables`, so a rendered subset still resolves outward.
  const tableOf = (key: string): string => all[key]?.modelName ?? tables[key]?.modelName ?? key

  const up: string[] = []
  const down: string[] = []

  for (const [, table] of ordered) {
    const lines: string[] = [`      table.string('id').primary()`]
    const keys: string[] = []
    const compound = compoundIndexes(table)
    const keyed = new Set(compound.flatMap((entry) => entry.columns))

    for (const [name, field] of Object.entries(table.fields)) {
      const column = field.fieldName ?? name

      lines.push(`      ${columnFor(column, field, keyed)}`)

      if (field.references) {
        keys.push(
          `      table` +
            `.foreign(['${column}'])` +
            `.references(['${field.references.field}'])` +
            `.on('${tableOf(field.references.model)}')` +
            `.onDelete('${field.references.onDelete ?? 'cascade'}')`
        )
      }
    }

    /**
     * The compound indexes, which no single field can declare.
     *
     * better-auth 1.7 keys an account on `(issuer, accountId)` and says so with
     * a table-level `indexes: [{ fields: [...], unique: true }]`. This generator
     * only ever walked `table.fields`, so that entry was dropped on the floor:
     * every application generated a schema that let the same `accountId` from two
     * issuers collide, and the migration ran clean while doing it. Plugins in 1.7
     * declare compound indexes the same way, so this is not one table's problem.
     */
    for (const entry of compound) {
      const columns = entry.columns.map((column) => `'${column}'`).join(', ')

      keys.push(`      table.${entry.unique ? 'unique' : 'index'}([${columns}])`)
    }

    up.push(
      `    await schema.create('${table.modelName}', (table) => {\n${[...lines, ...keys].join('\n')}\n    })`
    )
    down.unshift(`    await schema.dropIfExists('${table.modelName}')`)
  }

  return `import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Auth tables, generated from better-auth's schema by \`elvel auth:schema\`.
 *
 * The column names are better-auth's own (\`emailVerified\`, \`userId\`): every
 * plugin declares its fields that way, so renaming them here would break the
 * first plugin added. Application tables keep their own convention.
 *
 * Regenerate after adding a better-auth plugin; generated for ${dialect}.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
${up.join('\n\n')}
  }

  async down({ schema }: MigrationContext): Promise<void> {
${down.join('\n')}
  }
}
`
}

/**
 * A table's compound indexes, normalised.
 *
 * The shape is better-auth's: `{ fields: string[], unique?: boolean }`, with the
 * field *names* rather than column names, so a `fieldName` override has to be
 * resolved before the index can be written. It is typed loosely here because the
 * adapter's own `AuthTables` type is derived from `createSchema`'s parameter and
 * does not carry `indexes` in every version this package supports.
 */
function compoundIndexes(table: AuthTables[string]): Array<{
  columns: string[]
  unique: boolean
}> {
  const declared = (table as { indexes?: Array<{ fields?: string[]; unique?: boolean }> }).indexes

  if (!Array.isArray(declared)) return []

  return declared
    .filter((entry) => Array.isArray(entry.fields) && entry.fields.length > 0)
    .map((entry) => ({
      columns: (entry.fields ?? []).map((field) => table.fields[field]?.fieldName ?? field),
      unique: entry.unique === true
    }))
}

/**
 * One blueprint line for a better-auth field.
 *
 * `keyed` names the columns this table indexes *compoundly*, which the field
 * itself has no way to say — see `compoundKeys` and the note in `migrationFor`.
 */
function columnFor(name: string, field: AuthField, keyed: ReadonlySet<string> = new Set()): string {
  const parts: string[] = []

  if (field.references) {
    // Ids are strings unless the app opts into serial keys, and the column has
    // to match the key it points at.
    parts.push(`table.string('${name}')`)
  } else {
    switch (field.type) {
      case 'number':
        parts.push(field.bigint ? `table.bigInteger('${name}')` : `table.integer('${name}')`)
        break
      case 'boolean':
        parts.push(`table.boolean('${name}')`)
        break
      case 'date':
        parts.push(`table.timestamp('${name}')`)
        break
      case 'json':
      case 'string[]':
      case 'number[]':
        parts.push(`table.text('${name}')`)
        break
      default: {
        /**
         * `varchar` whenever the column is part of a key, not only when
         * better-auth calls it `sortable`.
         *
         * MySQL refuses `BLOB/TEXT column 'token' used in key specification
         * without a key length`, so a `text` column carrying `.unique()` or
         * `.index()` makes the whole migration unrunnable there. `session.token`
         * is unique and not sortable, which meant `auth:schema` had been emitting
         * a migration MySQL rejects — for every application, core tables
         * included, not only for plugins.
         *
         * `sortable` is better-auth's hint that a column is compared rather than
         * merely stored, and being indexed is the same statement made a different
         * way; both want varchar.
         */
        const indexed =
          field.sortable === true ||
          field.unique === true ||
          field.index === true ||
          keyed.has(name)

        parts.push(indexed ? `table.string('${name}')` : `table.text('${name}')`)
        break
      }
    }
  }

  if (field.required === false) parts.push('.nullable()')
  if (field.unique) parts.push('.unique()')
  else if (field.index) parts.push('.index()')

  return parts.join('')
}

/** What a table wants, flattened — used to diff against a live database. */
export function schemaShape(tables: AuthTables): Array<{ table: string; columns: string[] }> {
  return Object.entries(tables)
    .filter(([, table]) => table.disableMigrations !== true)
    .map(([key, table]) => ({
      table: table.modelName ?? key,
      columns: [
        'id',
        ...Object.entries(table.fields).map(([name, field]) => field.fieldName ?? name)
      ]
    }))
}

/**
 * A migration for only what is missing — the `--diff` half of `auth:schema`.
 *
 * The reason it matters: adding a better-auth plugin mid-project asks for two
 * new columns on a table that already holds users. The full migration would
 * try to create that table again, so today the answer is "hand-edit it", and a
 * hand-edited auth migration is one nobody dares run twice.
 */
export function diffMigrationFor(
  tables: AuthTables,
  dialect: Dialect,
  existing: Map<string, string[]>,
  /**
   * The index names each existing table already carries, lowercased.
   *
   * Without this the diff could only compare columns, and a table-level index was
   * invisible to it: upgrading an application to better-auth 1.7 added the
   * `issuer` column and silently left out the `(issuer, accountId)` unique index
   * that the same release exists to enforce. A fresh install got it, an upgraded
   * one never did, and both migrations ran clean.
   *
   * Absent, the index half is skipped rather than guessed at: an empty map would
   * mean "this table has no indexes", and the diff would helpfully write one that
   * is already there.
   */
  indexes?: Map<string, string[]>
): { code: string; missing: Array<{ table: string; columns: string[] }> } | undefined {
  const wanted = schemaShape(tables)
  const missing: Array<{ table: string; columns: string[] }> = []
  const created: string[] = []

  for (const { table, columns } of wanted) {
    const present = existing.get(table.toLowerCase())

    if (present === undefined) {
      created.push(table)

      continue
    }

    const absent = columns.filter((column) => !present.includes(column.toLowerCase()))

    if (absent.length > 0) missing.push({ table, columns: absent })
  }

  /**
   * The compound indexes an existing table is still missing.
   *
   * Collected before the early return, because "every column is there" is not
   * the same as "nothing to do": upgrading to better-auth 1.7 with `issuer`
   * already added leaves exactly one thing outstanding, and it is an index.
   *
   * Created tables are not considered — they were written in full, indexes
   * included, by the generator that writes a fresh install.
   */
  const absentIndexes: Array<{ table: string; columns: string[]; unique: boolean; name: string }> =
    []

  for (const { table } of indexes === undefined ? [] : wanted) {
    if (existing.get(table.toLowerCase()) === undefined) continue

    const present = indexes?.get(table.toLowerCase()) ?? []

    for (const entry of compoundFor(tables, table)) {
      // The name the blueprint would give it, which is Laravel's and is what the
      // database reports back: `account_issuer_accountid_unique`.
      const name = `${table}_${entry.columns.join('_')}_${entry.unique ? 'unique' : 'index'}`
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')

      if (!present.includes(name)) absentIndexes.push({ table, ...entry, name })
    }
  }

  if (created.length === 0 && missing.length === 0 && absentIndexes.length === 0) return undefined

  const up: string[] = []
  const down: string[] = []

  // A table that does not exist at all is written in full, by the same generator
  // that writes a fresh install — there is no diff to take.
  if (created.length > 0) {
    const only = Object.fromEntries(
      Object.entries(tables).filter(([key, table]) => created.includes(table.modelName ?? key))
    ) as AuthTables

    const full = migrationFor(only, dialect, tables)
    const body =
      /async up\(\{ schema \}: MigrationContext\): Promise<void> \{([\s\S]*?)\n {2}\}/.exec(full)
    const undo =
      /async down\(\{ schema \}: MigrationContext\): Promise<void> \{([\s\S]*?)\n {2}\}/.exec(full)

    if (body?.[1]) up.push(body[1].trim())
    if (undo?.[1]) down.push(undo[1].trim())
  }

  for (const { table, columns } of missing) {
    // Part of a compound index means `varchar`, not `text`, exactly as it does on
    // a fresh install — MySQL will not key a `TEXT` column, and `issuer` arrived
    // as `text` here while the same column was `varchar` in a new database.
    const keyed = new Set(compoundFor(tables, table).flatMap((entry) => entry.columns))

    const adds = columns.map((column) => {
      const field = fieldFor(tables, table, column)

      return `      ${field ? columnFor(column, field, keyed) : `table.string('${column}').nullable()`}`
    })

    up.push(`await schema.table('${table}', (table) => {\n${adds.join('\n')}\n    })`)
    down.push(
      `await schema.table('${table}', (table) => {\n      table.dropColumn(${columns
        .map((column) => `'${column}'`)
        .join(', ')})\n    })`
    )
  }

  for (const entry of absentIndexes) {
    const kind = entry.unique ? 'unique' : 'index'
    const list = entry.columns.map((column) => `'${column}'`).join(', ')

    up.push(
      `await schema.table('${entry.table}', (table) => {\n      table.${kind}([${list}])\n    })`
    )
    down.push(
      `await schema.table('${entry.table}', (table) => {\n      table.dropIndex('${entry.name}')\n    })`
    )
  }

  const code = `import { Migration, type MigrationContext } from '@elvel/database'

/**
 * Brings the auth tables up to what the current configuration asks for.
 *
 * Generated by \`elvel auth:schema --diff\`, which compared the configuration
 * against the database as it stands. Review it: a column added here is a column
 * every existing row will hold as null.
 */
export default class extends Migration {
  async up({ schema }: MigrationContext): Promise<void> {
    ${up.join('\n\n    ')}
  }

  async down({ schema }: MigrationContext): Promise<void> {
    ${down.reverse().join('\n\n    ')}
  }
}
`

  return { code, missing: [...created.map((table) => ({ table, columns: ['*'] })), ...missing] }
}

/**
 * A table's compound indexes, found by the name it has in the database.
 *
 * `compoundIndexes` takes the declaration; this takes the `modelName`, which is
 * what the diff has to work from — the database reports tables, not schema keys,
 * and a `modelName` override means the two need not match.
 */
function compoundFor(
  tables: AuthTables,
  model: string
): Array<{ columns: string[]; unique: boolean }> {
  for (const [key, table] of Object.entries(tables)) {
    if ((table.modelName ?? key) === model) return compoundIndexes(table)
  }

  return []
}

/** The declared field behind a column name, so the diff keeps its type. */
function fieldFor(tables: AuthTables, table: string, column: string): AuthField | undefined {
  for (const [key, candidate] of Object.entries(tables)) {
    if ((candidate.modelName ?? key) !== table) continue

    for (const [name, field] of Object.entries(candidate.fields)) {
      if ((field.fieldName ?? name) === column) return field
    }
  }

  return undefined
}
