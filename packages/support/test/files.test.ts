import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Files } from '../src/files.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-files-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const at = (...parts: string[]) => join(root, ...parts)

describe('reading and writing', () => {
  /** The whole reason this exists: every caller re-decided what this means. */
  test('put makes the directory it needs', async () => {
    await Files.put(at('deep', 'nested', 'file.txt'), 'hello')

    expect(await Files.get(at('deep', 'nested', 'file.txt'))).toBe('hello')
  })

  test('get answers null for a file that is not there', async () => {
    expect(await Files.get(at('nope.txt'))).toBeNull()
    expect(await Files.exists(at('nope.txt'))).toBe(false)
    expect(await Files.missing(at('nope.txt'))).toBe(true)
  })

  test('getOrFail names the path', async () => {
    await expect(Files.getOrFail(at('nope.txt'))).rejects.toThrow('nope.txt')
  })

  test('append and prepend', async () => {
    await Files.put(at('a.txt'), 'b')
    await Files.append(at('a.txt'), 'c')
    await Files.prepend(at('a.txt'), 'a')

    expect(await Files.get(at('a.txt'))).toBe('abc')
  })

  test('lines drops the empty one a final newline makes', async () => {
    await Files.put(at('a.txt'), 'one\ntwo\n')

    expect(await Files.lines(at('a.txt'))).toEqual(['one', 'two'])
  })

  test('json, and null for something that is not', async () => {
    await Files.put(at('a.json'), '{"a":1}')
    await Files.put(at('bad.json'), 'not json')

    expect(await Files.json<{ a: number }>(at('a.json'))).toEqual({ a: 1 })
    expect(await Files.json(at('bad.json'))).toBeNull()
  })
})

describe('replaceInFile', () => {
  test('swaps text and says whether it changed anything', async () => {
    await Files.put(at('a.txt'), 'hello world')

    expect(await Files.replaceInFile(at('a.txt'), 'world', 'there')).toBe(true)
    expect(await Files.get(at('a.txt'))).toBe('hello there')
    expect(await Files.replaceInFile(at('a.txt'), 'world', 'there')).toBe(false)
  })

  /** Creating it would leave a file holding nothing but the replacement. */
  test('and leaves a missing file alone', async () => {
    expect(await Files.replaceInFile(at('nope.txt'), 'a', 'b')).toBe(false)
    expect(await Files.exists(at('nope.txt'))).toBe(false)
  })
})

describe('directories', () => {
  test('ensureDirectoryExists is idempotent', async () => {
    await Files.ensureDirectoryExists(at('a', 'b'))
    await Files.ensureDirectoryExists(at('a', 'b'))

    expect(await Files.isDirectory(at('a', 'b'))).toBe(true)
  })

  test('cleanDirectory empties it and keeps it', async () => {
    await Files.put(at('cache', 'one.txt'), 'x')
    await Files.put(at('cache', 'deep', 'two.txt'), 'x')

    await Files.cleanDirectory(at('cache'))

    expect(await Files.isDirectory(at('cache'))).toBe(true)
    expect(await Files.allFiles(at('cache'))).toEqual([])
  })

  test('copyDirectory copies the tree', async () => {
    await Files.put(at('from', 'a.txt'), 'a')
    await Files.put(at('from', 'deep', 'b.txt'), 'b')

    await Files.copyDirectory(at('from'), at('to'))

    expect(await Files.allFiles(at('to'))).toEqual(['a.txt', join('deep', 'b.txt')])
  })

  test('deleteDirectory removes it whole', async () => {
    await Files.put(at('gone', 'a.txt'), 'a')
    await Files.deleteDirectory(at('gone'))

    expect(await Files.isDirectory(at('gone'))).toBe(false)
  })

  test('glob matches, sorted', async () => {
    await Files.put(at('b.ts'), '')
    await Files.put(at('a.ts'), '')
    await Files.put(at('c.txt'), '')

    expect(await Files.glob('*.ts', root)).toEqual(['a.ts', 'b.ts'])
  })
})

describe('facts about a file', () => {
  test('size, lastModified, isFile', async () => {
    await Files.put(at('a.txt'), 'hello')

    expect(await Files.size(at('a.txt'))).toBe(5)
    expect(await Files.lastModified(at('a.txt'))).toBeInstanceOf(Date)
    expect(await Files.isFile(at('a.txt'))).toBe(true)
    expect(await Files.size(at('nope.txt'))).toBeNull()
  })

  test('hash', async () => {
    await Files.put(at('a.txt'), 'hello')

    expect(await Files.hash(at('a.txt'))).toBe('5d41402abc4b2a76b9719d911017c592')
    expect(await Files.hash(at('nope.txt'))).toBeNull()
  })

  test('isWritable asks about the directory when the file is not there yet', async () => {
    expect(await Files.isWritable(at('not-yet.txt'))).toBe(true)
  })

  test('guessExtension normalises the spelling', () => {
    expect(Files.guessExtension('/a/b/photo.JPEG')).toBe('jpg')
    expect(Files.guessExtension('page.htm')).toBe('html')
    expect(Files.guessExtension('noextension')).toBeUndefined()
  })
})

describe('moving and copying', () => {
  test('copy and move make the directory they need', async () => {
    await Files.put(at('a.txt'), 'x')

    await Files.copy(at('a.txt'), at('deep', 'b.txt'))
    await Files.move(at('a.txt'), at('deeper', 'c.txt'))

    expect(await Files.get(at('deep', 'b.txt'))).toBe('x')
    expect(await Files.get(at('deeper', 'c.txt'))).toBe('x')
    expect(await Files.exists(at('a.txt'))).toBe(false)
  })

  test('delete takes several, and a missing one is not an error', async () => {
    await Files.put(at('a.txt'), 'x')
    await Files.delete(at('a.txt'), at('nope.txt'))

    expect(await Files.exists(at('a.txt'))).toBe(false)
  })
})
