import type { Connection, ConnectionManager, Row } from '@elysian/database'
import { Expression, QueryBuilder } from '@elysian/database'
import type {
  AdapterFactory,
  CleanedWhere,
  CustomAdapter,
  DBAdapterDebugLogOption
} from 'better-auth/adapters'
import { createAdapterFactory } from 'better-auth/adapters'
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

export type ElysianAdapterOptions = {
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
export function elysianAdapter(db: ConnectionManager, options: ElysianAdapterOptions) {
  // Kept so a transaction can build a nested adapter with the same options,
  // exactly as better-auth's own memory adapter does.
  let lazyOptions: BetterAuthOptions = {}

  const build = (resolve: () => Promise<Connection>): AdapterFactory<BetterAuthOptions> =>
    createAdapterFactory({
      config: {
        adapterId: 'elysian',
        adapterName: 'Elysian Adapter',
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
            overwrite: false
          })
        }
      }
    })

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

function defaultMigrationPath(options: ElysianAdapterOptions): string {
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
export function migrationFor(tables: AuthTables, dialect: Dialect): string {
  const ordered = Object.entries(tables)
    .filter(([, table]) => table.disableMigrations !== true)
    .sort(([, a], [, b]) => (a.order ?? 99) - (b.order ?? 99))

  // A reference names a *schema key*; the foreign key has to target the table
  // that key resolves to, which a custom `modelName` may have renamed.
  const tableOf = (key: string): string => tables[key]?.modelName ?? key

  const up: string[] = []
  const down: string[] = []

  for (const [, table] of ordered) {
    const lines: string[] = [`      table.string('id').primary()`]
    const keys: string[] = []

    for (const [name, field] of Object.entries(table.fields)) {
      const column = field.fieldName ?? name

      lines.push(`      ${columnFor(column, field)}`)

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

    up.push(
      `    await schema.create('${table.modelName}', (table) => {\n${[...lines, ...keys].join('\n')}\n    })`
    )
    down.unshift(`    await schema.dropIfExists('${table.modelName}')`)
  }

  return `import { Migration, type MigrationContext } from '@elysian/database'

/**
 * Auth tables, generated from better-auth's schema by \`artisan auth:schema\`.
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

/** One blueprint line for a better-auth field. */
function columnFor(name: string, field: AuthField): string {
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
      default:
        // `sortable` is better-auth's hint that the column is compared and
        // indexed rather than merely stored, which is what varchar is for.
        parts.push(field.sortable ? `table.string('${name}')` : `table.text('${name}')`)
    }
  }

  if (field.required === false) parts.push('.nullable()')
  if (field.unique) parts.push('.unique()')
  else if (field.index) parts.push('.index()')

  return parts.join('')
}
