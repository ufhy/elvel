import { describe, expect, test as it } from 'bun:test'
import { channels } from '@elvel/broadcasting'
import { Arr, collect, Str } from '@elvel/support'
import { test } from '@elvel/testing'
import { __, trans } from '@elvel/translation'
import app from '../bootstrap/app.ts'
import './database.ts'

/**
 * The parts of the framework a route does not obviously reach.
 *
 * The scheduler, the translator, the channel registry and the support helpers
 * are all used *by* an application rather than served by one, so nothing in the
 * playground's routes exercised them. Their own packages have tests; what these
 * add is that they are wired into a booted application — a translator with no
 * lang directory loaded, or a schedule that registered nothing, looks identical
 * to a working one until somebody asks.
 */
describe('the schedule', () => {
  it('has the entries the provider registered', () => {
    const entries = app.make('schedule').events()

    expect(entries.length).toBeGreaterThan(0)

    // Named, because an unnamed entry is unreadable in `schedule:list` and its
    // mutex key is derived from the same string.
    for (const entry of entries) {
      expect(entry.mutexName()).toBeTruthy()
    }
  })

  /**
   * Every entry has a cron expression that parses.
   *
   * An entry whose expression never matches simply never runs, and there is no
   * error anywhere — the most silent failure in the framework.
   */
  it('and every entry is due at some point in the next week', () => {
    const entries = app.make('schedule').events()
    const start = new Date('2026-01-01T00:00:00Z')

    for (const entry of entries) {
      let due = false

      // Eight days, not one: a weekly entry fires on one day of seven, and a
      // 24-hour window would report the schedule broken every time somebody
      // added one.
      for (let minute = 0; minute < 60 * 24 * 8 && !due; minute += 1) {
        due = entry.isDue(new Date(start.getTime() + minute * 60_000))
      }

      expect({ entry: entry.describedAs ?? entry.mutexName(), due }).toEqual({
        entry: entry.describedAs ?? entry.mutexName(),
        due: true
      })
    }
  })
})

describe('translation', () => {
  it('reads a key out of the lang directory', () => {
    expect(__('orders.title')).toBe('Orders')
  })

  it('replaces placeholders, and matches the case of the placeholder', () => {
    // `:Name` capitalised in the key means the value is capitalised too, which is
    // what lets one string serve a sentence start and a mid-sentence use.
    expect(__('orders.greeting', { name: 'ada' })).toBe('Hello Ada, welcome back')
  })

  /**
   * Pluralisation by range, not by an `=== 1`.
   *
   * The three branches are what a real language needs; a boolean would already
   * be wrong for "no orders" and wrong again for languages with more forms.
   */
  it('chooses a plural form by count', () => {
    expect(trans().choice('orders.count', 0)).toBe('You have no orders')
    expect(trans().choice('orders.count', 1)).toBe('You have one order')
    expect(trans().choice('orders.count', 5, { count: 5 })).toBe('You have 5 orders')
  })

  it('and another locale is a different answer', () => {
    expect(__('orders.title', {}, 'id')).not.toBe(__('orders.title', {}, 'en'))
  })

  it('a key that does not exist comes back as itself, not as empty', () => {
    // Returning '' would put a blank where a label should be, and look like a
    // styling bug rather than a missing translation.
    expect(__('orders.nothing-here')).toBe('orders.nothing-here')
  })
})

describe('broadcast channels', () => {
  it('the registry holds what the provider declared', () => {
    expect(channels().patterns().length).toBeGreaterThan(0)
  })

  it('a pattern matches the channel it was written for', () => {
    expect(channels().has('orders.7')).toBe(true)
    expect(channels().has('nothing.7')).toBe(false)
  })

  /**
   * An authorizer that throws refuses.
   *
   * The wrong way round would be letting the socket in because the check broke,
   * which turns a bug in one channel into a data leak on all of them.
   */
  it('and authorization is a decision, not an exception', async () => {
    // This application's authorizer admits any signed-in user to order 7 only.
    expect(await channels().authorize('orders.7', { id: '1' })).toBe(true)
    expect(await channels().authorize('orders.8', { id: '1' })).toBe(false)

    // A guest arrives as null and is refused, which is what `channel()` means
    // as opposed to `public()`.
    expect(await channels().authorize('orders.7', null)).toBe(false)

    // A channel nobody declared is refused rather than allowed — failing open
    // here would make every typo in a channel name a public feed.
    expect(await channels().authorize('nothing.7', { id: '1' })).toBe(false)

    // And the public one lets anybody in, including a guest.
    expect(await channels().authorize('status', null)).toBe(true)
  })
})

describe('the HTTP client', () => {
  /**
   * Faked, which is the half that works without a socket.
   *
   * The client's other routes call this application back over the network on
   * purpose — a retry, a timeout and a connection refusal only exist once there
   * is a socket between the two halves — so they are exercised by `bun run
   * smoke` against a listening server rather than here. Pressing them through
   * `test()` would fetch a port nothing is on and prove nothing about the
   * client.
   */
  it('answers from the fake, and refuses a stray request', async () => {
    const response = await test(app).getJson('/check/client/fake')

    response
      .assertOk()
      .assertJsonPath('body.faked', true)
      // `preventStrayRequests` is what makes a faked client a test double rather
      // than a convenience: a URL nobody faked is a mistake, not a real call.
      .assertJsonPath('strayRefused', true)
  })
})

describe('the support helpers', () => {
  it('Str keeps its promises about code points, not bytes', () => {
    expect(Str.take('🔐🔑🗝', 2)).toBe('🔐🔑')
    expect(Str.slug('Hello, World!')).toBe('hello-world')
    // The last four digits survive: a negative length stops from the end, as
    // PHP's substr does, which is the whole point of masking a card.
    expect(Str.mask('4111111111111111', '*', 4, -4)).toBe('4111********1111')
  })

  it('Arr reaches into nested data by path', () => {
    const data = { user: { roles: ['admin', 'editor'] } }

    expect(Arr.get<string>(data, 'user.roles.0')).toBe('admin')
    expect(Arr.get<string>(data, 'user.missing', 'fallback')).toBe('fallback')
    expect(Arr.has(data, 'user.roles')).toBe(true)
  })

  it('and a Collection is what every query answers with', () => {
    const people = collect([
      { name: 'Ada', age: 36 },
      { name: 'Grace', age: 45 }
    ])

    expect(people.pluck('name').all()).toEqual(['Ada', 'Grace'])
    expect(people.sum((one) => one.age)).toBe(81)
    expect(people.firstWhere('name', 'Grace')?.age).toBe(45)
  })
})
