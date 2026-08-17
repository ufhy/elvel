import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Env, env, parseEnvFile } from '../src/env.ts'

describe('parseEnvFile', () => {
  test('parses plain assignments', () => {
    expect(parseEnvFile('APP_NAME=Elyvel\nPORT=3000')).toEqual({
      APP_NAME: 'Elyvel',
      PORT: '3000'
    })
  })

  test('ignores blank lines and comments', () => {
    const contents = ['# a comment', '', '   ', 'APP_ENV=local', '# APP_DEBUG=true'].join('\n')

    expect(parseEnvFile(contents)).toEqual({ APP_ENV: 'local' })
  })

  test('strips surrounding quotes', () => {
    expect(parseEnvFile('A="quoted value"\nB=\'single\'')).toEqual({
      A: 'quoted value',
      B: 'single'
    })
  })

  test('expands escapes only inside double quotes', () => {
    expect(parseEnvFile('A="line\\nbreak"').A).toBe('line\nbreak')
    expect(parseEnvFile("B='line\\nbreak'").B).toBe('line\\nbreak')
  })

  test('keeps # inside a quoted value but drops a trailing comment', () => {
    expect(parseEnvFile('A="value # not a comment"').A).toBe('value # not a comment')
    expect(parseEnvFile('B=value # a comment').B).toBe('value')
  })

  test('accepts the export prefix', () => {
    expect(parseEnvFile('export APP_KEY=abc')).toEqual({ APP_KEY: 'abc' })
  })

  test('keeps = inside values', () => {
    expect(parseEnvFile('DSN=postgres://u:p@host/db?a=b').DSN).toBe('postgres://u:p@host/db?a=b')
  })

  test('skips lines without an assignment and empty keys', () => {
    expect(parseEnvFile('JUST_A_WORD\n=novalue\nOK=1')).toEqual({ OK: '1' })
  })

  test('preserves an empty value', () => {
    expect(parseEnvFile('HOST=')).toEqual({ HOST: '' })
  })
})

describe('Env casting', () => {
  const keys = ['PROBE_A', 'PROBE_B', 'PROBE_C', 'PROBE_D']

  afterEach(() => {
    for (const key of keys) delete process.env[key]
  })

  test('casts booleans', () => {
    process.env.PROBE_A = 'true'
    process.env.PROBE_B = '(false)'
    process.env.PROBE_C = 'yes'
    process.env.PROBE_D = 'off'

    expect(Env.get<boolean>('PROBE_A')).toBe(true)
    expect(Env.get<boolean>('PROBE_B')).toBe(false)
    expect(Env.get<boolean>('PROBE_C')).toBe(true)
    expect(Env.get<boolean>('PROBE_D')).toBe(false)
  })

  test('casts null', () => {
    process.env.PROBE_A = 'null'
    expect(Env.get<null>('PROBE_A')).toBeNull()
  })

  test('returns the fallback when unset', () => {
    expect(Env.get('PROBE_A', 'fallback')).toBe('fallback')
    expect(env('PROBE_A', 'fallback')).toBe('fallback')
  })

  test('an empty value falls back rather than reading as an empty string', () => {
    process.env.PROBE_A = ''
    expect(Env.get('PROBE_A', 'fallback')).toBe('fallback')
  })

  test('string() coerces', () => {
    process.env.PROBE_A = 'true'
    expect(Env.string('PROBE_A')).toBe('true')
    expect(Env.string('PROBE_B', 'default')).toBe('default')
  })

  test('number() rejects non-numeric values', () => {
    process.env.PROBE_A = '8080'
    process.env.PROBE_B = 'nope'

    expect(Env.number('PROBE_A', 3000)).toBe(8080)
    expect(Env.number('PROBE_B', 3000)).toBe(3000)
    expect(Env.number('PROBE_C', 3000)).toBe(3000)
  })

  test('boolean() only accepts recognised boolean forms', () => {
    process.env.PROBE_A = 'true'
    process.env.PROBE_B = 'banana'

    expect(Env.boolean('PROBE_A', false)).toBe(true)
    expect(Env.boolean('PROBE_B', false)).toBe(false)
  })
})

describe('Env.load', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'elyvel-env-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    for (const key of ['LOAD_A', 'LOAD_B', 'LOAD_C']) delete process.env[key]
  })

  test('loads .env into process.env', async () => {
    await Bun.write(join(directory, '.env'), 'LOAD_A=from-file')
    await Env.load(directory)

    expect(process.env.LOAD_A).toBe('from-file')
  })

  test('a real environment variable always wins', async () => {
    process.env.LOAD_A = 'from-environment'
    await Bun.write(join(directory, '.env'), 'LOAD_A=from-file')
    await Env.load(directory)

    expect(process.env.LOAD_A).toBe('from-environment')
  })

  test('an environment-specific file overrides .env', async () => {
    await Bun.write(join(directory, '.env'), 'LOAD_B=base\nLOAD_C=base')
    await Bun.write(join(directory, '.env.testing'), 'LOAD_C=override')
    await Env.load(directory, 'testing')

    // Keys only in .env still load...
    expect(process.env.LOAD_B).toBe('base')
    // ...but the more specific file wins where both define a key.
    expect(process.env.LOAD_C).toBe('override')
  })

  test('a missing file is not an error', async () => {
    await Env.load(join(directory, 'does-not-exist'))
    expect(true).toBe(true)
  })
})
