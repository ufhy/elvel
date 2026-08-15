import { describe, expect, test } from 'bun:test'
import { MemoryDisk } from '../src/index.ts'

const disk = () => new MemoryDisk()

describe('directoryExists', () => {
  test('a directory exists when something lives under it', async () => {
    const store = disk()
    await store.put('photos/holiday/one.jpg', 'x')

    expect(await store.directoryExists('photos')).toBe(true)
    expect(await store.directoryExists('photos/holiday')).toBe(true)
    expect(await store.directoryExists('photos/work')).toBe(false)
  })

  test('and when it was made explicitly, even while empty', async () => {
    const store = disk()
    await store.makeDirectory('drafts')

    expect(await store.directoryExists('drafts')).toBe(true)
  })

  /**
   * A file is not a directory, and the two questions have different answers.
   *
   * `exists()` says yes for both, which is why this is a separate method rather
   * than a caller checking for a trailing slash.
   */
  test('a file is not a directory', async () => {
    const store = disk()
    await store.put('notes.txt', 'x')

    expect(await store.exists('notes.txt')).toBe(true)
    expect(await store.directoryExists('notes.txt')).toBe(false)
  })
})

describe('checksum', () => {
  test('the same bytes hash the same, and different bytes do not', async () => {
    const store = disk()
    await store.put('a.txt', 'hello')
    await store.put('b.txt', 'hello')
    await store.put('c.txt', 'goodbye')

    expect(await store.checksum('a.txt')).toBe(await store.checksum('b.txt'))
    expect(await store.checksum('a.txt')).not.toBe(await store.checksum('c.txt'))
  })

  test('md5 by default, because that is what an S3 ETag holds', async () => {
    const store = disk()
    await store.put('a.txt', 'hello')

    // The known md5 of "hello".
    expect(await store.checksum('a.txt')).toBe('5d41402abc4b2a76b9719d911017c592')
  })

  test('another algorithm may be named', async () => {
    const store = disk()
    await store.put('a.txt', 'hello')

    expect(await store.checksum('a.txt', 'sha256')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
  })

  test('a missing file fails rather than hashing nothing', async () => {
    await expect(disk().checksum('nowhere.txt')).rejects.toThrow()
  })
})

describe('assertions on the fake', () => {
  test('assertExists and assertMissing', async () => {
    const store = disk()
    await store.put('invoice.pdf', 'x')

    store.assertExists('invoice.pdf').assertMissing('receipt.pdf')

    // The failure names what is actually there, which is most of the debugging.
    expect(() => store.assertExists('receipt.pdf')).toThrow(/Present: invoice.pdf/)
    expect(() => store.assertMissing('invoice.pdf')).toThrow(/not to be on the disk/)
  })

  test('assertExists takes a list', async () => {
    const store = disk()
    await store.put('a', 'x')
    await store.put('b', 'x')

    store.assertExists(['a', 'b'])
    expect(() => store.assertExists(['a', 'c'])).toThrow(/\[c\]/)
  })

  /**
   * The assertion a fake most needs.
   *
   * "A file was stored" is rarely the question; "the right bytes were stored" is.
   * A test that only checks existence passes when the code writes an empty file.
   */
  test('assertContents checks the bytes', async () => {
    const store = disk()
    await store.put('greeting.txt', 'hello')

    store.assertContents('greeting.txt', 'hello')
    expect(() => store.assertContents('greeting.txt', 'goodbye')).toThrow(/to contain "goodbye"/)
  })

  test('assertCount and assertDirectoryEmpty', async () => {
    const store = disk()
    await store.put('exports/one.csv', 'x')
    await store.put('exports/two.csv', 'x')

    store.assertCount('exports', 2).assertDirectoryEmpty('archive')

    expect(() => store.assertCount('exports', 1)).toThrow(/saw 2/)
    expect(() => store.assertDirectoryEmpty('exports')).toThrow(/Expected 0 file/)
  })
})
