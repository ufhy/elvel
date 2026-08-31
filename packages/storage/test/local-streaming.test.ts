import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDisk } from '../src/disks/local.ts'

/**
 * Appending and hashing without holding the file.
 *
 * `append` used to read the whole file and write it back, which makes repeated
 * appends quadratic — 500 lines took 88ms and 4,000 took 1,583ms, sixteen times
 * the work for eight times the lines. `checksum` read the file whole to hash it,
 * which costs nothing worth measuring at 64MB and 0.8 seconds at 1.5GB.
 *
 * The tests that existed covered content and a known md5, both on files small
 * enough to arrive in one piece. What they could not see is a file that does not:
 * a streamed hash that mishandled its second chunk would have passed all of them.
 */
let root: string

const disk = () => new LocalDisk('local', { root } as never)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-local-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('append', () => {
  test('lands every line, in order', async () => {
    const store = disk()

    for (let line = 0; line < 200; line++) await store.append('log.txt', `line ${line}\n`)

    const written = ((await store.get('log.txt')) as string).trim().split('\n')

    expect<number>(written.length).toBe(200)
    expect<string>(written[0] as string).toBe('line 0')
    expect<string>(written[199] as string).toBe('line 199')
  })

  test('and creates the directory it was pointed at', async () => {
    const store = disk()

    await store.append('deep/inside/here/log.txt', 'first\n')
    await store.append('deep/inside/here/log.txt', 'second\n')

    expect<unknown>(await store.get('deep/inside/here/log.txt')).toBe('first\nsecond\n')
  })

  /**
   * `put` chmods on every write; appending settles the mode once. The file still
   * has to end up private, which is what stops a log written under a public disk
   * root being readable by anything that can reach it.
   */
  test('giving a new file the disk’s visibility', async () => {
    const store = new LocalDisk('local', { root, visibility: 'private' } as never)

    await store.append('private.log', 'secret\n')

    const mode = (await stat(join(root, 'private.log'))).mode & 0o777

    expect<boolean>((mode & 0o077) === 0).toBe(true)
  })

  test('and a public disk’s files stay readable', async () => {
    const store = new LocalDisk('local', { root, visibility: 'public' } as never)

    await store.append('public.log', 'open\n')

    const mode = (await stat(join(root, 'public.log'))).mode & 0o777

    expect<boolean>((mode & 0o044) !== 0).toBe(true)
  })

  /**
   * Reading before writing was not only slow, it could lose the file.
   *
   * `get()` answers `null` for anything it cannot read, `?? ''` turned that into
   * an empty string, and `put` wrote the empty string plus the new line over the
   * top — so appending a line to a file this process could write but not read
   * **deleted everything already in it**. Nothing reads it now.
   */
  test('does not need to read the file, and cannot lose it', async () => {
    const store = disk()

    await store.put('append-only.log', 'important\n')
    await chmod(join(root, 'append-only.log'), 0o222)

    try {
      await store.append('append-only.log', 'new\n')
    } finally {
      await chmod(join(root, 'append-only.log'), 0o644)
    }

    expect<string>(await readFile(join(root, 'append-only.log'), 'utf8')).toBe(
      'important\nnew\n'
    )
  })

  test('while prepend still puts things at the front', async () => {
    const store = disk()

    await store.append('order.txt', 'middle')
    await store.prepend('order.txt', 'start-')
    await store.append('order.txt', '-end')

    expect<unknown>(await store.get('order.txt')).toBe('start-middle-end')
  })
})

describe('checksum', () => {
  /** The case the small-file tests could not reach: more than one chunk. */
  test('hashes a file that arrives in several pieces', async () => {
    const store = disk()
    const bytes = new Uint8Array(5 * 1024 * 1024)

    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251

    await store.put('big.bin', bytes as never)

    const expected = new Bun.CryptoHasher('md5').update(bytes).digest('hex')

    expect<string>(await store.checksum('big.bin')).toBe(expected)
  })

  test('and answers the same for a file built by appending', async () => {
    const store = disk()
    const line = `${'x'.repeat(4096)}\n`

    for (let index = 0; index < 500; index++) await store.append('grown.txt', line)

    const expected = new Bun.CryptoHasher('sha256').update(line.repeat(500)).digest('hex')

    expect<string>(await store.checksum('grown.txt', 'sha256')).toBe(expected)
  })

  test('but still refuses a file that is not there', async () => {
    await expect(disk().checksum('nowhere.bin')).rejects.toThrow()
  })
})
