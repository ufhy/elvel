import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../src/config.ts'

describe('Config', () => {
  test('reads with dot notation', () => {
    const config = new Config({ app: { name: 'Elysian', nested: { debug: false } } })

    expect(config.get<string>('app.name')).toBe('Elysian')
    expect(config.get<boolean>('app.nested.debug')).toBe(false)
    expect(config.get('app.missing', 'fallback')).toBe('fallback')
  })

  test('a key present but undefined falls back', () => {
    const config = new Config({ view: { path: undefined } })

    expect(config.get('view.path', '/default')).toBe('/default')
  })

  test('set creates intermediate objects', () => {
    const config = new Config()
    config.set('view.cache.enabled', true)

    expect(config.get<boolean>('view.cache.enabled')).toBe(true)
    expect(config.all()).toEqual({ view: { cache: { enabled: true } } })
  })

  test('has distinguishes missing from falsy', () => {
    const config = new Config({ app: { debug: false } })

    expect(config.has('app.debug')).toBe(true)
    expect(config.has('app.nope')).toBe(false)
  })
})

describe('Config.loadFrom', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elysian-config-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  test('each file becomes a namespace named after it', async () => {
    await Bun.write(join(directory, 'app.ts'), "export default { name: 'FromFile', port: 3000 }")
    await Bun.write(join(directory, 'view.ts'), 'export default { doctype: true }')

    const config = await Config.loadFrom(directory)

    expect(config.get<string>('app.name')).toBe('FromFile')
    expect(config.get<number>('app.port')).toBe(3000)
    expect(config.get<boolean>('view.doctype')).toBe(true)
  })

  test('a missing directory yields an empty repository', async () => {
    const config = await Config.loadFrom(join(directory, 'nope'))

    expect(config.all()).toEqual({})
  })

  test('a file without a default export is a clear error, not a silent gap', async () => {
    await Bun.write(join(directory, 'broken.ts'), "export const name = 'no default'")

    await expect(Config.loadFrom(directory)).rejects.toThrow(/no default export/)
  })

  test('ignores files that are not modules', async () => {
    await Bun.write(join(directory, 'app.ts'), "export default { name: 'ok' }")
    await Bun.write(join(directory, 'notes.md'), '# not config')
    await Bun.write(join(directory, 'types.d.ts'), 'export type Nope = string')

    const config = await Config.loadFrom(directory)

    expect(Object.keys(config.all())).toEqual(['app'])
  })
})
