import { describe, expect, test } from 'bun:test'
import { Config, ConfigTypeError } from '../src/config.ts'

const config = () =>
  new Config({
    queue: {
      retryAfter: '90',
      tries: 3,
      ratio: '1.5',
      name: 'default',
      after: 'soon',
      middleware: ['throttle']
    },
    features: { beta: 'true', legacy: 'off', broken: 'maybe', live: false }
  })

describe('the checked readers', () => {
  /** The bug they exist for: a cast types as `number` and hands back a string. */
  test('a cast lets an env string through, and the reader does not', () => {
    expect(config().get<number>('queue.retryAfter')).toBe('90' as unknown as number)
    expect(config().integer('queue.retryAfter')).toBe(90)
  })

  test('a numeric string converts, because that is what an env var is', () => {
    expect(config().float('queue.ratio')).toBe(1.5)
    expect(config().integer('queue.tries')).toBe(3)
  })

  test('a non-numeric one is an error naming the key and what was there', () => {
    expect(() => config().integer('queue.after')).toThrow(ConfigTypeError)
    expect(() => config().integer('queue.after')).toThrow("config('queue.after')")
    expect(() => config().integer('queue.after')).toThrow('the string "soon"')
  })

  test('a float is not an integer', () => {
    expect(() => config().integer('queue.ratio')).toThrow('an integer')
    expect(config().float('queue.ratio')).toBe(1.5)
  })

  test('string refuses a number rather than stringifying it', () => {
    expect(config().string('queue.name')).toBe('default')
    expect(() => config().string('queue.tries')).toThrow('should be a string')
  })

  /** `Boolean('false')` is `true`, which is the whole reason this exists. */
  test('boolean reads the env spellings', () => {
    expect(config().boolean('features.beta')).toBe(true)
    expect(config().boolean('features.legacy')).toBe(false)
    expect(config().boolean('features.live')).toBe(false)
  })

  test('and refuses a word that is neither', () => {
    expect(() => config().boolean('features.broken')).toThrow('should be a boolean')
  })

  test('array', () => {
    expect(config().array<string>('queue.middleware')).toEqual(['throttle'])
    expect(() => config().array('queue.name')).toThrow('an array')
  })

  test('a fallback is read through the same check', () => {
    expect(config().integer('queue.missing', 5)).toBe(5)
    expect(() => config().integer('queue.missing')).toThrow('not set')
  })
})

describe('getMany', () => {
  test('the defaults decide the shape of the answer', () => {
    const read = config().getMany({ 'queue.name': '', 'queue.tries': 0, 'queue.absent': 'x' })

    expect(read).toEqual({ 'queue.name': 'default', 'queue.tries': 3, 'queue.absent': 'x' })
  })
})

describe('push and prepend', () => {
  test('append to a declared list', () => {
    const held = config()

    held.push('queue.middleware', 'audit')

    expect(held.array('queue.middleware')).toEqual(['throttle', 'audit'])
  })

  test('prepend puts it first', () => {
    const held = config()

    held.prepend('queue.middleware', 'first')

    expect(held.array('queue.middleware')).toEqual(['first', 'throttle'])
  })

  /** Safe before anybody has declared the list, which is when a package runs. */
  test('a missing key becomes the array', () => {
    const held = config()

    held.push('queue.nothing.here', 'a', 'b')

    expect(held.array('queue.nothing.here')).toEqual(['a', 'b'])
  })

  test('and pushing onto something that is not an array is an error', () => {
    expect(() => config().push('queue.name', 'x')).toThrow('an array')
  })
})
