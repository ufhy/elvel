import { afterEach, describe, expect, test } from 'bun:test'
import { AssertionError } from '../src/assert.ts'
import { TestResponse } from '../src/response.ts'
import { freezeTime, restoreTime, travel, withoutExceptionHandling } from '../src/time.ts'

const redirect = (location: string) => new Response(null, { status: 302, headers: { location } })

async function pressed(session: Record<string, unknown>, response = redirect('/form')) {
  return TestResponse.of(response, session)
}

/** The commonest flow in a server-rendered application. */
describe('session assertions', () => {
  test('has, hasAll and missing', async () => {
    const answer = await pressed({ status: 'saved', count: 2 })

    answer.assertSessionHas('status').assertSessionHas('status', 'saved')
    answer.assertSessionHasAll({ status: 'saved', count: 2 })
    answer.assertSessionHasAll(['status', 'count'])
    answer.assertSessionMissing('nope')

    expect(() => answer.assertSessionHas('nope')).toThrow(AssertionError)
    expect(() => answer.assertSessionHas('status', 'other')).toThrow(AssertionError)
  })

  test('errors, by field and by message', async () => {
    const answer = await pressed({ errors: { email: ['The email is invalid.'] } })

    answer.assertSessionHasErrors()
    answer.assertSessionHasErrors(['email'])
    answer.assertSessionHasErrors({ email: 'The email is invalid.' })

    expect(() => answer.assertSessionHasErrors(['name'])).toThrow(AssertionError)
    expect(() => answer.assertSessionHasErrors({ email: 'Other.' })).toThrow(AssertionError)
  })

  /** Two forms on one page each need their own, or a failed sign-up lights up sign-in. */
  test('a named bag', async () => {
    const answer = await pressed({
      errors: { __bags: { signup: { email: ['Taken.'] } } }
    })

    answer.assertSessionHasErrorsIn('signup', ['email'])

    expect(() => answer.assertSessionHasErrors(['email'])).toThrow(AssertionError)
  })

  test('no errors', async () => {
    const answer = await pressed({})

    answer.assertSessionHasNoErrors()
    answer.assertSessionDoesntHaveErrors(['email'])

    const failed = await pressed({ errors: { email: ['bad'] } })

    expect(() => failed.assertSessionHasNoErrors()).toThrow(AssertionError)
  })

  test('the old input, so the form can be redrawn', async () => {
    const answer = await pressed({ _old_input: { email: 'ada@example.com' } })

    answer.assertSessionHasInput('email').assertSessionHasInput('email', 'ada@example.com')
    answer.assertSessionMissingInput('password')

    expect(() => answer.assertSessionHasInput('password')).toThrow(AssertionError)
  })

  test('dot access reaches a nested value', async () => {
    const answer = await pressed({ cart: { total: 40 } })

    answer.assertSessionHas('cart.total', 40)
  })
})

describe('redirect assertions', () => {
  test('back, checked against where it came from', async () => {
    const answer = await pressed({ '_previous.url': '/form' })

    answer.assertRedirectBack()

    const elsewhere = await pressed({ '_previous.url': '/other' })

    expect(() => elsewhere.assertRedirectBack()).toThrow(AssertionError)
  })

  test('back with errors, which is the whole flow in one call', async () => {
    const answer = await pressed({
      '_previous.url': '/form',
      errors: { email: ['The email is invalid.'] }
    })

    answer.assertRedirectBackWithErrors({ email: 'The email is invalid.' })
  })

  /** A renamed route fails here rather than in the browser. */
  test('to a named route', async () => {
    const routes = { to: (name: string) => (name === 'articles.index' ? '/form' : '/nope') }
    const answer = await pressed({})

    answer.assertRedirectToRoute(routes, 'articles.index')

    expect(() => answer.assertRedirectToRoute(routes, 'articles.show')).toThrow(AssertionError)
  })
})

describe('body assertions', () => {
  test('a download', async () => {
    const answer = await TestResponse.of(
      new Response('bytes', {
        headers: { 'content-disposition': 'attachment; filename="report.csv"' }
      })
    )

    answer.assertDownload().assertDownload('report.csv')

    expect(() => answer.assertDownload('other.csv')).toThrow(AssertionError)
  })

  test('a streamed response has no content-length', async () => {
    const streamed = await TestResponse.of(new Response('chunked'))

    streamed.assertStreamed().assertStreamedContent('chunked')

    const sized = await TestResponse.of(
      new Response('sized', { headers: { 'content-length': '5' } })
    )

    expect(() => sized.assertStreamed()).toThrow(AssertionError)
  })
})

describe('time', () => {
  afterEach(restoreTime)

  /** A stand-in for `Clock`, which this package must not import. */
  function clock() {
    let frozen: number | undefined
    let offset = 0

    return {
      freeze: (at?: Date | number) => {
        frozen = at === undefined ? Date.now() : at instanceof Date ? at.getTime() : at
      },
      advance: (ms: number) => {
        if (frozen === undefined) offset += ms
        else frozen += ms
      },
      travelTo: (when: Date | number) => {
        offset = (when instanceof Date ? when.getTime() : when) - Date.now()
      },
      restore: () => {
        frozen = undefined
        offset = 0
      },
      now: () => frozen ?? Date.now() + offset
    }
  }

  test('freezeTime holds it still', () => {
    const time = clock()

    freezeTime(time, new Date('2026-08-11T09:00:00.000Z'))

    expect(new Date(time.now()).toISOString()).toBe('2026-08-11T09:00:00.000Z')
  })

  test('travel reads as the thing it describes', () => {
    const time = clock()

    freezeTime(time, new Date('2026-08-11T00:00:00.000Z'))
    travel(time).days(31)

    expect(new Date(time.now()).toISOString()).toBe('2026-09-11T00:00:00.000Z')
  })

  /** For something that should already have expired. */
  test('and back for the case a test usually wants', () => {
    const time = clock()

    freezeTime(time, new Date('2026-08-11T00:00:00.000Z'))
    travel(time).back().hours(2)

    expect(new Date(time.now()).toISOString()).toBe('2026-08-10T22:00:00.000Z')
  })

  /** A test that forgets poisons the ones after it, somewhere else entirely. */
  test('restoreTime puts every clock it moved back', () => {
    const time = clock()

    freezeTime(time, new Date('2020-01-01T00:00:00.000Z'))
    restoreTime()

    expect(time.now()).toBeGreaterThan(new Date('2025-01-01').getTime())
  })
})

describe('withoutExceptionHandling', () => {
  test('turns it on for the body and off again', async () => {
    const application = { rethrowExceptions: false }

    await withoutExceptionHandling(application, () => {
      expect(application.rethrowExceptions).toBe(true)
    })

    expect(application.rethrowExceptions).toBe(false)
  })

  /** A test that threw is exactly the one that would leave it on. */
  test('and off again after a throw', async () => {
    const application = { rethrowExceptions: false }

    await expect(
      withoutExceptionHandling(application, () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(application.rethrowExceptions).toBe(false)
  })
})
