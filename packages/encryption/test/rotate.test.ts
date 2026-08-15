import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Kernel } from '@elysian/console'
import { Application } from '@elysian/core'
import { ConnectionManager } from '@elysian/database'
import { EncryptionRotateCommand } from '../src/console/encryption-rotate.ts'
import { Encrypter } from '../src/encrypter.ts'

/**
 * `encryption:rotate` against a real table.
 *
 * The command rewrites rows in place, which is the one thing in this package
 * that cannot be tested by inspection: everything else here is pure, and this
 * walks a cursor, decrypts with whichever key works, and issues UPDATEs. The
 * ways it can go wrong are all shaped like data loss — overwriting a row it
 * could not read, skipping one it could, or losing the tail of a table because
 * the cursor stopped moving.
 */

const CURRENT = 'the-current-application-key-32-ch!!'
const PREVIOUS = 'the-previous-application-key-32-ch!'

const COLUMN = 'users.ssn'

let app: Application
let kernel: Kernel
let db: ConnectionManager

/** Every row, as a plain array — `get()` answers a collection. */
const rows = async (): Promise<Array<{ id: number; ssn: string; name: string }>> => [
  ...((await (await db.table('users')).orderBy('id').get()) as unknown as Iterable<{
    id: number
    ssn: string
    name: string
  }>)
]

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** Run the command through the kernel, capturing its terminal output. */
async function rotate(...argv: string[]): Promise<{ status: number; output: string }> {
  const originalLog = console.log
  const originalError = console.error
  const lines: string[] = []
  const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))

  console.log = collect
  console.error = collect

  try {
    const status = await kernel.run(['encryption:rotate', 'users', 'ssn', ...argv])

    return { status, output: lines.join('\n').replace(ANSI, '') }
  } finally {
    console.log = originalLog
    console.error = originalError
  }
}

beforeEach(async () => {
  app = new Application(process.cwd())
  app.config.set('database.default', 'rotate-test')
  app.config.set('database.connections.rotate-test', { driver: 'sqlite', database: ':memory:' })

  db = new ConnectionManager(app)
  app.instance('db', db)
  app.instance('encrypter', new Encrypter(CURRENT, { previousKeys: [PREVIOUS] }))

  kernel = new Kernel(app)
  kernel.register(EncryptionRotateCommand)

  const schema = await db.schema()

  await schema.create('users', (table) => {
    table.increments('id')
    table.string('name')
    table.text('ssn')
  })
})

afterEach(async () => {
  await db.disconnectAll()
})

/** Seed a row, encrypted under whichever key is named. */
async function seed(name: string, secret: string, key: string): Promise<void> {
  await (await db.table('users')).insert({
    name,
    ssn: new Encrypter(key).encryptString(secret, COLUMN)
  })
}

describe('encryption:rotate', () => {
  test('it rewrites old payloads and leaves current ones alone', async () => {
    await seed('old', 'aaa-11-1111', PREVIOUS)
    await seed('current', 'bbb-22-2222', CURRENT)

    const { status, output } = await rotate()

    expect(status).toBe(0)
    expect(output).toContain('1 row(s) re-encrypted')
    expect(output).toContain('1 row(s) were already on the current key')

    // Both are now readable by the current key *alone* — which is the whole
    // point: it is what makes the previous key retirable.
    const only = new Encrypter(CURRENT)

    for (const row of await rows()) {
      expect(only.decryptString(row.ssn, COLUMN)).toBe(
        row.name === 'old' ? 'aaa-11-1111' : 'bbb-22-2222'
      )
    }
  })

  test('--force rewrites a row that is already current', async () => {
    await seed('current', 'bbb-22-2222', CURRENT)

    const [before] = await rows()
    const { output } = await rotate('--force')

    expect(output).toContain('1 row(s) re-encrypted')

    const [after] = await rows()

    // A fresh IV every time, so the ciphertext must differ even though the key
    // and the plaintext did not.
    expect(after?.ssn).not.toBe(before?.ssn)
    expect(new Encrypter(CURRENT).decryptString(after?.ssn as string, COLUMN)).toBe('bbb-22-2222')
  })

  test('a row no key can read is reported and left exactly as it was', async () => {
    await seed('stranger', 'ccc-33-3333', 'never-configured-key-of-32-chars!!!')

    const [before] = await rows()
    const { status, output } = await rotate()

    expect(status).toBe(0)
    expect(output).toContain('could not be decrypted with any configured key')

    const [after] = await rows()
    expect(after?.ssn).toBe(before?.ssn as string)
  })

  test('--pretend reports the work without doing any of it', async () => {
    await seed('old', 'aaa-11-1111', PREVIOUS)

    const [before] = await rows()
    const { output } = await rotate('--pretend')

    expect(output).toContain('1 row(s) would be re-encrypted')
    expect((await rows())[0]?.ssn).toBe(before?.ssn as string)
  })

  test('an empty column is counted, not treated as ciphertext', async () => {
    await (await db.table('users')).insert({ name: 'blank', ssn: '' })

    const { status, output } = await rotate()

    expect(status).toBe(0)
    expect(output).toContain('nothing in that column')
    expect((await rows())[0]?.ssn).toBe('')
  })

  test('it walks past the end of a chunk', async () => {
    // The loop pages by primary key. A cursor that failed to advance would
    // either spin for ever or stop after one batch, and one batch is all a
    // small fixture ever has — so the chunk is made smaller than the table.
    for (let index = 0; index < 7; index += 1) {
      await seed(`row-${index}`, `secret-${index}`, PREVIOUS)
    }

    const { output } = await rotate('--chunk=2')

    expect(output).toContain('7 row(s) re-encrypted')

    const only = new Encrypter(CURRENT)
    const all = await rows()

    expect(all).toHaveLength(7)

    for (const [index, row] of all.entries()) {
      expect(only.decryptString(row.ssn, COLUMN)).toBe(`secret-${index}`)
    }
  })

  test('it refuses to run without a database', async () => {
    const bare = new Application(process.cwd())
    const bareKernel = new Kernel(bare)

    bareKernel.register(EncryptionRotateCommand)

    const originalError = console.error
    const lines: string[] = []
    console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '))

    try {
      expect(await bareKernel.run(['encryption:rotate', 'users', 'ssn'])).toBe(1)
      expect(lines.join('\n')).toContain('DatabaseServiceProvider')
    } finally {
      console.error = originalError
    }
  })
})
