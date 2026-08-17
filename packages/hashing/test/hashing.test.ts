import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import {
  Argon2idHasher,
  BcryptHasher,
  HashManager,
  HashServiceProvider,
  isHashed,
  parseHash
} from '../src/index.ts'

/**
 * Cheap parameters throughout.
 *
 * The defaults are cost 12 and 64 MiB of argon memory, which is right in
 * production and would make this file take minutes. The parameters are what is
 * varied deliberately in the rehash tests, so they are explicit everywhere.
 */
const bcrypt = new BcryptHasher({ cost: 4 })
const argon = new Argon2idHasher({ memoryCost: 8192, timeCost: 2 })

describe('bcrypt', () => {
  test('hashes and verifies', async () => {
    const hashed = await bcrypt.make('correct horse')

    expect(hashed).toStartWith('$2')
    expect(await bcrypt.check('correct horse', hashed)).toBe(true)
    expect(await bcrypt.check('wrong horse', hashed)).toBe(false)
  })

  test('the same value hashes differently every time', async () => {
    const [first, second] = await Promise.all([bcrypt.make('same'), bcrypt.make('same')])

    // A per-hash salt, so a repeated password is not visible in the column.
    expect(first).not.toBe(second)
    expect(await bcrypt.check('same', second)).toBe(true)
  })

  test('a hash it cannot read is a mismatch, not a throw', async () => {
    // Bun's verify throws UnsupportedAlgorithm here; a corrupt column is a "no".
    expect(await bcrypt.check('anything', 'not-a-hash')).toBe(false)
    expect(await bcrypt.check('anything', '')).toBe(false)
  })

  test('refuses a value past the 72-byte bcrypt ceiling', async () => {
    const long = 'a'.repeat(80)

    await expect(bcrypt.make(long)).rejects.toThrow(/80 bytes and bcrypt accepts 72/)
    // The escape hatch is explicit, and says what it costs.
    expect(await bcrypt.check(long, await bcrypt.make(long, { limit: 0 }))).toBe(true)
  })

  test('counts bytes, not characters', async () => {
    // 40 emoji is 40 characters and 160 bytes; a length check would let it past.
    await expect(bcrypt.make('🔐'.repeat(40))).rejects.toThrow(/160 bytes/)
  })

  test('the synchronous form produces a usable hash', async () => {
    const hashed = bcrypt.makeSync('blocking')

    expect(await bcrypt.check('blocking', hashed)).toBe(true)
  })
})

describe('argon2id', () => {
  test('hashes and verifies', async () => {
    const hashed = await argon.make('correct horse')

    expect(hashed).toStartWith('$argon2id$')
    expect(await argon.check('correct horse', hashed)).toBe(true)
    expect(await argon.check('wrong horse', hashed)).toBe(false)
  })

  test('has no length ceiling, which is the reason to choose it', async () => {
    const long = 'a'.repeat(500)
    const hashed = await argon.make(long)

    expect(await argon.check(long, hashed)).toBe(true)
    expect(await argon.check(`${'a'.repeat(499)}b`, hashed)).toBe(false)
  })

  test('verifies a bcrypt hash too, since the format says which it is', async () => {
    const hashed = await bcrypt.make('shared')

    // Useful during a migration between drivers: check() keeps working while
    // needsRehash() reports that the row should be replaced.
    expect(await argon.check('shared', hashed)).toBe(true)
    expect(argon.needsRehash(hashed)).toBe(true)
  })
})

describe('reading a hash', () => {
  test('reports bcrypt and its cost', async () => {
    const info = parseHash(await bcrypt.make('x'))

    expect(info.algorithm).toBe('bcrypt')
    expect(info.options.cost).toBe(4)
  })

  test('reports argon and its parameters', async () => {
    const info = parseHash(await argon.make('x'))

    expect(info.algorithm).toBe('argon2id')
    expect(info.options).toMatchObject({ memoryCost: 8192, timeCost: 2, threads: 1, version: 19 })
  })

  test('recognises what it made, and nothing else', async () => {
    expect(isHashed(await bcrypt.make('x'))).toBe(true)
    expect(isHashed(await argon.make('x'))).toBe(true)
    expect(isHashed('plain text')).toBe(false)
    expect(isHashed('')).toBe(false)
    expect(isHashed(undefined)).toBe(false)
    // A md5 hex digest is not a password hash, and saying so is the point.
    expect(isHashed('5d41402abc4b2a76b9719d911017c592')).toBe(false)
  })
})

describe('needsRehash', () => {
  test('true when the stored cost is weaker than the current one', async () => {
    const weak = await new BcryptHasher({ cost: 4 }).make('x')

    expect(new BcryptHasher({ cost: 6 }).needsRehash(weak)).toBe(true)
    expect(new BcryptHasher({ cost: 4 }).needsRehash(weak)).toBe(false)
  })

  /**
   * The case a bare inequality gets wrong.
   *
   * Someone lowers the cost to speed up a test suite; every existing hash then
   * "needs" rehashing, and rehashing would make each one weaker.
   */
  test('false when the stored cost is stronger', async () => {
    const strong = await new BcryptHasher({ cost: 6 }).make('x')

    expect(new BcryptHasher({ cost: 4 }).needsRehash(strong)).toBe(false)
  })

  test('true across algorithms', async () => {
    expect(new BcryptHasher({ cost: 4 }).needsRehash(await argon.make('x'))).toBe(true)
    expect(argon.needsRehash(await bcrypt.make('x'))).toBe(true)
  })

  test('argon compares memory and time', async () => {
    const weak = await new Argon2idHasher({ memoryCost: 8192, timeCost: 2 }).make('x')

    expect(new Argon2idHasher({ memoryCost: 16_384, timeCost: 2 }).needsRehash(weak)).toBe(true)
    expect(new Argon2idHasher({ memoryCost: 8192, timeCost: 3 }).needsRehash(weak)).toBe(true)
    expect(new Argon2idHasher({ memoryCost: 8192, timeCost: 2 }).needsRehash(weak)).toBe(false)
  })

  test('nonsense needs rehashing rather than passing silently', () => {
    expect(bcrypt.needsRehash('not-a-hash')).toBe(true)
  })
})

describe('the manager', () => {
  function managed(config: Record<string, unknown> = {}): HashManager {
    const app = new Application(process.cwd())
    app.config.set('hashing', { driver: 'bcrypt', bcrypt: { cost: 4 }, ...config })

    return new HashManager(app)
  }

  test('uses the configured driver', async () => {
    const manager = managed()
    const hashed = await manager.make('x')

    expect(manager.info(hashed).algorithm).toBe('bcrypt')
    expect(manager.info(hashed).options.cost).toBe(4)
    expect(await manager.check('x', hashed)).toBe(true)
  })

  test('switches driver from config', async () => {
    const manager = managed({ driver: 'argon2id', argon: { memory: 8192, time: 2 } })

    expect(manager.info(await manager.make('x')).algorithm).toBe('argon2id')
  })

  test('reaches a named driver without changing the default', async () => {
    const manager = managed({ argon: { memory: 8192, time: 2 } })

    expect(manager.info(await manager.driver('argon2id').make('x')).algorithm).toBe('argon2id')
    expect(manager.info(await manager.make('x')).algorithm).toBe('bcrypt')
  })

  test('memoises drivers', () => {
    const manager = managed()

    expect(manager.driver()).toBe(manager.driver('bcrypt'))
  })

  test('a custom driver can be registered', async () => {
    const manager = managed()
    manager.extend('argon-cheap', () => new Argon2idHasher({ memoryCost: 8192, timeCost: 2 }))

    expect(manager.info(await manager.driver('argon-cheap').make('x')).algorithm).toBe('argon2id')
  })

  test('an unknown driver says how to add one', () => {
    expect(() => managed({ driver: 'md5' }).make('x')).toThrow(/is not supported.*extend/s)
  })

  test('works without an application, on defaults', async () => {
    // A seeder or a script may have no container; hashing should still work.
    const manager = new HashManager()

    expect(manager.info(await manager.make('x', { cost: 4 })).algorithm).toBe('bcrypt')
  })
})

describe('the provider', () => {
  test('binds one manager for the application', async () => {
    const app = new Application(process.cwd())
    app.config.set('hashing', { driver: 'bcrypt', bcrypt: { cost: 4 } })
    await app.register(HashServiceProvider)
    await app.boot()

    expect(app.make('hash')).toBe(app.make('hash'))
    expect(await app.make('hash').check('x', await app.make('hash').make('x'))).toBe(true)
  })
})
