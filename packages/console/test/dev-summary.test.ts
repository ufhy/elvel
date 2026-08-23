import { describe, expect, test } from 'bun:test'
import { devSummary } from '../src/commands/dev.ts'

/**
 * `dev` used to say `Running: server, assets, schedule` and nothing else.
 *
 * Everything a developer asks first — what port, which environment, where the
 * assets are — it already knew and did not say. `serve` does print a banner, but
 * it prints it as a child into a terminal three processes share: measured inside
 * this repository, that banner arrived after 229 lines of `warn: … will not be
 * watched` from `bun --hot`, so the answer was in the scrollback.
 */

/**
 * Colour is a terminal's business, not this test's.
 *
 * The pattern is built rather than written as a literal: an escape character
 * inside a regex literal is what `noControlCharactersInRegex` exists to catch,
 * and it is right to — one arriving by accident is invisible in a diff. Here it
 * is the whole point, so it is spelled out by code point instead.
 */
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

const plain = (line: string) => line.replaceAll(ansi, '')

describe('what `dev` says before the processes start talking', () => {
  test('the port and the environment are both there', () => {
    const lines = devSummary({
      name: 'shop',
      environment: 'local',
      port: '3000',
      assets: 'starting, its port is reported below'
    }).map(plain)

    expect(lines.join('\n')).toContain('shop (local)')
    expect(lines.join('\n')).toContain('http://localhost:3000')
  })

  test('the port asked for is the port printed', () => {
    const lines = devSummary({
      name: 'shop',
      environment: 'production',
      port: '8080',
      assets: 'off'
    })
      .map(plain)
      .join('\n')

    expect(lines).toContain('http://localhost:8080')
    expect(lines).not.toContain('3000')
    expect(lines).toContain('(production)')
  })

  /**
   * Three labelled lines whose values share a column.
   *
   * The colons do not line up and are not meant to — `Application` is longer than
   * `Server`, so it is the padding after each colon that makes the three values
   * readable as a column rather than as prose.
   */
  test('every line is labelled and the values share a column', () => {
    const lines = devSummary({
      name: 'shop',
      environment: 'local',
      port: '3000',
      assets: 'vite is not installed, so there is no browser reload'
    }).map(plain)

    expect(lines).toHaveLength(3)

    expect(lines.map((line) => line.trim().split(':')[0])).toEqual([
      'Application',
      'Server',
      'Assets'
    ])

    const valueStarts = lines.map((line) => {
      const colon = line.indexOf(':')

      return colon + 1 + line.slice(colon + 1).search(/\S/)
    })

    expect(new Set(valueStarts).size).toBe(1)
  })
})
