import { beforeEach, describe, expect, test } from 'bun:test'
import { errorBags, errors, hasOld, MessageBag, old } from '../src/errors.ts'
import { back, intended, previousUrl, redirect } from '../src/redirect.ts'
import { withRequestScope } from '../src/scope.ts'
import { MemorySessionDriver, Session } from '../src/session.ts'

let session: Session

const request = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/subscribe', { headers })

/** Run `body` as if it were inside a request. */
const inRequest = <T>(body: () => T, headers: Record<string, string> = {}): T =>
  withRequestScope({ request: request(headers), session }, body)

beforeEach(async () => {
  session = await new Session('probe', new MemorySessionDriver(), 'elysian_session').start()
})

describe('where back() goes', () => {
  test('the stored previous URL wins', () => {
    session.put('_previous.url', '/articles?page=2')

    expect(inRequest(() => previousUrl(), { referer: '/somewhere-else' })).toBe('/articles?page=2')
  })

  test('the Referer is the fallback', () => {
    // A proxy can strip it and a browser can withhold it, which is why Laravel
    // keeps its own copy and this prefers the stored one.
    expect(inRequest(() => previousUrl(), { referer: '/from-header' })).toBe('/from-header')
  })

  test('and the root is the last resort', () => {
    expect(inRequest(() => previousUrl())).toBe('/')
  })

  test('outside a request there is nothing to go back to', () => {
    expect(previousUrl()).toBe('/')
  })
})

describe('building a redirect', () => {
  test('a plain redirect is a 302 with a location', async () => {
    const response = await inRequest(() => redirect('/articles').toResponse())

    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/articles')
  })

  test('seeOther is a 303, which turns a POST into a GET', async () => {
    const response = await inRequest(() => redirect('/done').seeOther().toResponse())

    expect(response.status).toBe(303)
  })

  test('permanent is a 301', async () => {
    expect((await inRequest(() => redirect('/moved').permanent().toResponse())).status).toBe(301)
  })

  test('back() resolves at build time', async () => {
    session.put('_previous.url', '/form')

    const response = await inRequest(() => redirect().back().toResponse())

    expect(response.headers.get('location')).toBe('/form')
  })

  test('back() as a standalone helper', () => {
    session.put('_previous.url', '/form')

    expect(inRequest(() => back().location)).toBe('/form')
  })
})

describe('flashing errors', () => {
  test('a validator-shaped bag is read through messages()', async () => {
    const bag = { messages: () => ({ email: ['is invalid'] }) }

    await inRequest(async () => {
      await redirect('/back').withErrors(bag).toResponse()
    })

    // Flashed for the next request, so the *current* one sees nothing yet.
    await session.save()

    expect(inRequest(() => errors().first('email'))).toBe('is invalid')
  })

  test('a plain object works too, and a bare string becomes a list', async () => {
    await inRequest(async () => {
      await redirect('/back')
        .withErrors({ email: 'is invalid', name: ['too short'] })
        .toResponse()
    })
    await session.save()

    expect(inRequest(() => errors().get('email'))).toEqual(['is invalid'])
    expect(inRequest(() => errors().get('name'))).toEqual(['too short'])
  })

  test('two withErrors calls merge rather than replace', async () => {
    // Two validators can fail in one request; the second must not erase the first.
    await inRequest(async () => {
      await redirect('/back').withErrors({ email: 'first' }).toResponse(true)
    })

    await inRequest(async () => {
      await redirect('/back').withErrors({ name: 'second' }).toResponse()
    })
    await session.save()

    expect(inRequest(() => errors().keys().sort())).toEqual(['email', 'name'])
  })
})

describe('flashing input', () => {
  test('the values come back for the next request', async () => {
    await inRequest(async () => {
      await redirect('/back').withInput({ email: 'nope', name: 'A' }).toResponse()
    })
    await session.save()

    expect(inRequest(() => old('email'))).toBe('nope')
    expect(inRequest(() => hasOld('name'))).toBe(true)
  })

  test('a password is never flashed, whoever asks', async () => {
    await inRequest(async () => {
      await redirect('/back')
        .withInput({ email: 'a@b.test', password: 'hunter2', password_confirmation: 'hunter2' })
        .toResponse()
    })
    await session.save()

    // Relying on every caller to remember this is how a password ends up sitting
    // in a session store.
    expect(inRequest(() => old('password'))).toBe('')
    expect(inRequest(() => old('password_confirmation'))).toBe('')
    expect(inRequest(() => old('email'))).toBe('a@b.test')
  })

  test('an upload is dropped rather than half-serialised', async () => {
    await inRequest(async () => {
      await redirect('/back')
        .withInput({ avatar: new File(['x'], 'a.png'), caption: 'hi' })
        .toResponse()
    })
    await session.save()

    expect(inRequest(() => hasOld('avatar'))).toBe(false)
    expect(inRequest(() => old('caption'))).toBe('hi')
  })

  test('nested values are reachable by path', async () => {
    await inRequest(async () => {
      await redirect('/back')
        .withInput({ lines: [{ sku: 'A1' }] })
        .toResponse()
    })
    await session.save()

    expect(inRequest(() => old('lines.0.sku'))).toBe('A1')
  })

  test('withoutInput drops the fields it names', async () => {
    await inRequest(async () => {
      await redirect('/back').withInput({ a: '1', b: '2' }).toResponse()
    })
    await inRequest(async () => {
      await redirect('/back').withoutInput({ a: '1', b: '2' }, 'b').toResponse()
    })
    await session.save()

    expect(inRequest(() => old('a'))).toBe('1')
    expect(inRequest(() => old('b'))).toBe('')
  })

  test('old() falls back when nothing was flashed', () => {
    expect(inRequest(() => old('email'))).toBe('')
    expect(inRequest(() => old('email', 'default@test'))).toBe('default@test')
  })
})

describe('reading outside a request', () => {
  test('errors() is an empty bag rather than a crash', () => {
    // A component asking `errors().first('email')` must work whether or not
    // anything failed, and whether or not a request scope exists at all.
    expect(errors().isEmpty()).toBe(true)
    expect(errors().first('email')).toBeUndefined()
    expect(old('email')).toBe('')
  })
})

describe('MessageBag', () => {
  const bag = new MessageBag({ email: ['is invalid', 'is taken'], name: ['too short'] })

  test('it answers per field and overall', () => {
    expect(bag.has()).toBe(true)
    expect(bag.has('email')).toBe(true)
    expect(bag.has('missing')).toBe(false)
    expect(bag.first('email')).toBe('is invalid')
    expect(bag.get('email')).toEqual(['is invalid', 'is taken'])
    expect(bag.count()).toBe(3)
    expect(bag.keys()).toEqual(['email', 'name'])
  })

  test('an empty bag is answerable too', () => {
    const empty = new MessageBag()

    expect(empty.isEmpty()).toBe(true)
    expect(empty.all()).toEqual([])
    expect(empty.first()).toBeUndefined()
  })
})

describe('named error bags', () => {
  test('a named bag does not light up the other form', async () => {
    // Two forms on one page: the sign-up failure must not mark the sign-in
    // form's email field, which is the whole reason bags have names.
    await inRequest(async () => {
      await redirect('/back').withErrors({ email: 'is taken' }, 'register').toResponse()
    })
    await session.save()

    expect<string | undefined>(inRequest(() => errors('register').first('email'))).toBe('is taken')
    expect<boolean>(inRequest(() => errors('login').has('email'))).toBe(false)
    expect<boolean>(inRequest(() => errors().has('email'))).toBe(false)
  })

  test('two named bags live side by side', async () => {
    await inRequest(async () => {
      await redirect('/back').withErrors({ email: 'is taken' }, 'register').toResponse(true)
    })

    await inRequest(async () => {
      await redirect('/back').withErrors({ password: 'is wrong' }, 'login').toResponse()
    })
    await session.save()

    expect<string[]>(inRequest(() => errorBags().sort())).toEqual(['login', 'register'])
    expect<string | undefined>(inRequest(() => errors('login').first('password'))).toBe('is wrong')
    expect<string | undefined>(inRequest(() => errors('register').first('email'))).toBe('is taken')
  })

  test('unnamed errors are the default bag, readable both ways', async () => {
    await inRequest(async () => {
      await redirect('/back').withErrors({ email: 'is invalid' }).toResponse()
    })
    await session.save()

    expect<string | undefined>(inRequest(() => errors().first('email'))).toBe('is invalid')
    expect<string | undefined>(inRequest(() => errors('default').first('email'))).toBe('is invalid')
    expect<string[]>(inRequest(() => errorBags())).toEqual(['default'])
  })

  test('a field called `default` is not mistaken for a bag', async () => {
    await inRequest(async () => {
      await redirect('/back').withErrors({ default: 'is invalid' }).toResponse()
    })
    await session.save()

    // Without the sentinel, `errors('default')` would read the *field* as a bag
    // and hand back a list of characters.
    expect<string[]>(inRequest(() => errors().get('default'))).toEqual(['is invalid'])
  })

  test('nothing flashed means no bags', () => {
    expect<string[]>(inRequest(() => errorBags())).toEqual([])
    expect<string[]>(errorBags()).toEqual([])
  })
})

describe('guest() and intended()', () => {
  test('a guest sent to sign in comes back to where they were going', () => {
    inRequest(() => redirect('/login').guest(), {})

    expect<string>(inRequest(() => intended().location)).toBe('/subscribe')
  })

  test('the intended URL is used once', () => {
    inRequest(() => redirect('/login').guest())
    inRequest(() => intended())

    // Left behind, it would send the *next* sign-in somewhere the person had
    // long forgotten about.
    expect<string>(inRequest(() => intended('/dashboard').location)).toBe('/dashboard')
  })

  test('a POST is not remembered', () => {
    const posted = new Request('http://localhost/subscribe', { method: 'POST' })

    // Sending someone to a URL that only answers a form submission is a 405 at
    // best and a repeated charge at worst.
    withRequestScope({ request: posted, session }, () => redirect('/login').guest())

    expect<string>(inRequest(() => intended('/dashboard').location)).toBe('/dashboard')
  })
})
