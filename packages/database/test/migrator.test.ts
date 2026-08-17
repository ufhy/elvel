import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BunSqlConnection } from '../src/connection/bun-sql.ts'
import { Migrator } from '../src/migrations/migrator.ts'
import { MigrationRepository } from '../src/migrations/repository.ts'
import { QueryBuilder } from '../src/query/builder.ts'
import { SchemaBuilder } from '../src/schema/builder.ts'

let connection: BunSqlConnection
let repository: MigrationRepository
let directory: string
let notes: string[]

/**
 * A `file://` URL, not a path — these are written into generated source.
 *
 * A Windows path is `E:\SourceCode\...`, and interpolating it into a quoted
 * string makes `\S` and `\e` escape sequences that collapse to bare letters. The
 * import specifier arrived as `E:SourceCodeelvel…` and every migration test
 * failed with "cannot find package", on Windows only.
 */
const MIGRATION_ROOT = pathToFileURL(join(import.meta.dir, '..', 'src')).href

/** Write a migration file that creates `table` with a single id column. */
async function writeMigration(name: string, table: string): Promise<void> {
  await Bun.write(
    join(directory, `${name}.ts`),
    `import { Migration } from '${MIGRATION_ROOT}/migrations/migration.ts'

     export default class extends Migration {
       async up({ schema }) {
         await schema.create('${table}', (t) => {
           t.id()
           t.string('name').nullable()
         })
       }

       async down({ schema }) {
         await schema.dropIfExists('${table}')
       }
     }
    `
  )
}

function migrator(): Migrator {
  return new Migrator(connection, repository, [directory], { onNote: (note) => notes.push(note) })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'elvel-migrations-'))
  connection = await BunSqlConnection.make('testing', { driver: 'sqlite', database: ':memory:' })
  repository = new MigrationRepository(connection)
  notes = []
})

afterEach(async () => {
  await connection.disconnect()
  await rm(directory, { recursive: true, force: true })
})

describe('install', () => {
  test('creates the tracking table with the shape Laravel uses', async () => {
    expect(await repository.repositoryExists()).toBe(false)

    await migrator().install()

    const schema = new SchemaBuilder(connection)
    expect(await schema.hasTable('migrations')).toBe(true)
    expect(await schema.getColumnListing('migrations')).toEqual(['id', 'migration', 'batch'])
  })

  test('is idempotent', async () => {
    await migrator().install()
    await migrator().install()

    expect(notes.filter((note) => note.includes('Created'))).toHaveLength(1)
  })
})

describe('running migrations', () => {
  test('runs pending files in name order and records them in one batch', async () => {
    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')
    await writeMigration('2026_01_01_000000_create_users_table', 'users')

    const applied = await migrator().run()

    expect(applied).toEqual([
      '2026_01_01_000000_create_users_table',
      '2026_01_02_000000_create_posts_table'
    ])

    const schema = new SchemaBuilder(connection)
    expect(await schema.hasTable('users')).toBe(true)
    expect(await schema.hasTable('posts')).toBe(true)

    const records = await new QueryBuilder(connection, 'migrations').orderBy('id').get()
    expect(records.pluck('batch').all()).toEqual([1, 1])
  })

  test('running twice applies nothing new', async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')

    await migrator().run()
    expect(await migrator().run()).toEqual([])
    expect(notes).toContain('Nothing to migrate.')
  })

  test('a second run picks up only the new file, in the next batch', async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')
    await migrator().run()

    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')
    expect(await migrator().run()).toEqual(['2026_01_02_000000_create_posts_table'])

    expect(await repository.getLastBatchNumber()).toBe(2)
  })

  test('--step gives each migration its own batch', async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')
    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')

    await migrator().run({ step: true })

    const records = await new QueryBuilder(connection, 'migrations').orderBy('id').get()
    expect(records.pluck('batch').all()).toEqual([1, 2])
  })

  test('--pretend reports without touching the database', async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')

    const applied = await migrator().run({ pretend: true })

    expect(applied).toEqual(['2026_01_01_000000_create_users_table'])
    expect(await new SchemaBuilder(connection).hasTable('users')).toBe(false)
    expect(await repository.getRan()).toEqual([])
    expect(notes.some((note) => note.startsWith('Would run'))).toBe(true)
  })

  test('shouldRun false skips the migration without recording it', async () => {
    await Bun.write(
      join(directory, '2026_01_01_000000_skipped.ts'),
      `import { Migration } from '${MIGRATION_ROOT}/migrations/migration.ts'
       export default class extends Migration {
         shouldRun() { return false }
         async up({ schema }) { await schema.create('never', (t) => t.id()) }
         async down() {}
       }
      `
    )

    expect(await migrator().run()).toEqual([])
    expect(await new SchemaBuilder(connection).hasTable('never')).toBe(false)
    expect(notes.some((note) => note.includes('shouldRun'))).toBe(true)
  })

  test('a file without a Migration export fails loudly', async () => {
    await Bun.write(join(directory, '2026_01_01_000000_broken.ts'), 'export const nope = 1')

    await expect(migrator().run()).rejects.toThrow(/no default export extending Migration/)
  })

  test('a failing migration leaves the table absent thanks to the transaction', async () => {
    await Bun.write(
      join(directory, '2026_01_01_000000_explodes.ts'),
      `import { Migration } from '${MIGRATION_ROOT}/migrations/migration.ts'
       export default class extends Migration {
         async up({ schema }) {
           await schema.create('half_done', (t) => t.id())
           throw new Error('migration failed midway')
         }
         async down() {}
       }
      `
    )

    await expect(migrator().run()).rejects.toThrow('migration failed midway')
    expect(await new SchemaBuilder(connection).hasTable('half_done')).toBe(false)
    expect(await repository.getRan()).toEqual([])
  })
})

describe('rollback', () => {
  beforeEach(async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')
    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')
  })

  test('reverses the last batch, newest migration first', async () => {
    await migrator().run()

    const reverted = await migrator().rollback()

    expect(reverted).toEqual([
      '2026_01_02_000000_create_posts_table',
      '2026_01_01_000000_create_users_table'
    ])

    const schema = new SchemaBuilder(connection)
    expect(await schema.hasTable('users')).toBe(false)
    expect(await schema.hasTable('posts')).toBe(false)
    expect(await repository.getRan()).toEqual([])
  })

  test('with --step batches, only the newest batch goes', async () => {
    await migrator().run({ step: true })

    expect(await migrator().rollback()).toEqual(['2026_01_02_000000_create_posts_table'])

    const schema = new SchemaBuilder(connection)
    expect(await schema.hasTable('posts')).toBe(false)
    expect(await schema.hasTable('users')).toBe(true)
  })

  test('--step=2 rolls back two batches', async () => {
    await migrator().run({ step: true })

    const reverted = await migrator().rollback({ step: 2 })

    expect(reverted).toHaveLength(2)
    expect(await repository.getRan()).toEqual([])
  })

  test('--batch targets one specific batch', async () => {
    await migrator().run({ step: true })

    expect(await migrator().rollback({ batch: 1 })).toEqual([
      '2026_01_01_000000_create_users_table'
    ])
    expect(await repository.getRan()).toEqual(['2026_01_02_000000_create_posts_table'])
  })

  test('rolling back with nothing recorded is a no-op', async () => {
    await migrator().install()

    expect(await migrator().rollback()).toEqual([])
    expect(notes).toContain('Nothing to roll back.')
  })

  test('without the tracking table it says so instead of throwing', async () => {
    expect(await migrator().rollback()).toEqual([])
    expect(notes.some((note) => note.includes('Migration table not found'))).toBe(true)
  })

  test('a recorded migration whose file vanished is skipped, not fatal', async () => {
    await migrator().run()
    await rm(join(directory, '2026_01_02_000000_create_posts_table.ts'))

    const reverted = await migrator().rollback()

    expect(reverted).toEqual(['2026_01_01_000000_create_users_table'])
    expect(notes.some((note) => note.includes('file is missing'))).toBe(true)
  })

  test('--pretend reverses nothing', async () => {
    await migrator().run()

    await migrator().rollback({ pretend: true })

    expect(await new SchemaBuilder(connection).hasTable('users')).toBe(true)
    expect(await repository.getRan()).toHaveLength(2)
  })
})

describe('reset and fresh', () => {
  beforeEach(async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')
    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')
  })

  test('reset reverses every batch', async () => {
    await migrator().run({ step: true })

    expect(await migrator().reset()).toHaveLength(2)
    expect(await repository.getRan()).toEqual([])
  })

  test('fresh drops every table, including ones no migration owns', async () => {
    await migrator().run()
    await new SchemaBuilder(connection).create('legacy', (table) => {
      table.id()
    })

    const applied = await migrator().fresh()

    const schema = new SchemaBuilder(connection)
    expect(await schema.hasTable('legacy')).toBe(false)
    expect(await schema.hasTable('users')).toBe(true)
    expect(applied).toHaveLength(2)
    expect(await repository.getLastBatchNumber()).toBe(1)
  })
})

describe('status', () => {
  test('reports each file with its batch, ran or not', async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')
    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')

    await migrator().install()
    await migrator().run({ step: true })
    await writeMigration('2026_01_03_000000_create_tags_table', 'tags')

    const status = await migrator().status()

    expect(status).toEqual([
      { name: '2026_01_01_000000_create_users_table', ran: true, batch: 1 },
      { name: '2026_01_02_000000_create_posts_table', ran: true, batch: 2 },
      { name: '2026_01_03_000000_create_tags_table', ran: false, batch: undefined }
    ])
  })

  test('pending lists only what has not run', async () => {
    await writeMigration('2026_01_01_000000_create_users_table', 'users')
    await migrator().run()
    await writeMigration('2026_01_02_000000_create_posts_table', 'posts')

    expect((await migrator().pending()).map((file) => file.name)).toEqual([
      '2026_01_02_000000_create_posts_table'
    ])
  })
})
