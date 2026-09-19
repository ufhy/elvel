import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { configLines } from '../src/bar/config.ts'

function app(values: Record<string, unknown>): Application {
  const instance = new Application(process.cwd())

  for (const [key, value] of Object.entries(values)) instance.config.set(key, value)

  return instance
}

describe('the settings the bar may show', () => {
  test('are the ones named, in the order they were named', () => {
    const lines = configLines(app({ 'app.name': 'Playground', 'app.env': 'local' }), [
      'app.env',
      'app.name'
    ])

    expect(lines).toEqual([
      { key: 'app.env', value: 'local' },
      { key: 'app.name', value: 'Playground' }
    ])
  })

  /**
   * The rule that keeps an allowlist from becoming a dump by accident.
   * `database.connections` is one key and holds every password under it.
   */
  test('a key that names a whole section is described, never printed', () => {
    const lines = configLines(
      app({
        'database.connections': {
          pgsql: { password: 'sekrit' },
          sqlite: { database: 'x' }
        }
      }),
      ['database.connections']
    )

    expect(lines[0]?.value).toBe('2 keys')
    expect(JSON.stringify(lines)).not.toContain('sekrit')
  })

  test('a list of plain values is worth reading, so it is read out', () => {
    const lines = configLines(app({ 'app.locales': ['en', 'id'] }), ['app.locales'])

    expect(lines[0]?.value).toBe('en, id')
  })

  /** Saying it is not set answers the question; leaving it out does not. */
  test('a key with nothing behind it says so', () => {
    expect(configLines(app({}), ['app.nothing'])[0]).toEqual({
      key: 'app.nothing',
      value: 'not set'
    })
  })

  test('naming nothing produces nothing', () => {
    expect(configLines(app({ 'app.name': 'x' }), [])).toEqual([])
  })
})
