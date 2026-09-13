import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { Dispatcher } from '@elvel/events'
import { basicAuth, parseBasic } from '../src/basic.ts'
import { announce, Failed, Login, Registered } from '../src/events.ts'
import { Gate } from '../src/gate.ts'
import { AuthorizationResponse } from '../src/response.ts'

const encode = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

describe('parsing the header', () => {
  test('reads a username and password', () => {
    expect(parseBasic(encode('ada', 'secret'))).toEqual(['ada', 'secret'])
  })

  /** A password may contain a colon and a username may not. */
  test('splits on the first colon, so a password may hold one', () => {
    expect(parseBasic(encode('ada', 'a:b:c'))).toEqual(['ada', 'a:b:c'])
  })

  test('anything else is not a credential', () => {
    expect(parseBasic(null)).toBeUndefined()
    expect(parseBasic('Bearer abc')).toBeUndefined()
    expect(parseBasic('Basic')).toBeUndefined()
    expect(parseBasic(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeUndefined()
  })
})

describe('the challenge', () => {
  /** Without the header a browser shows the body and never asks for a credential. */
  test('a missing credential is a 401 that makes the browser prompt', async () => {
    const answer = await basicAuth({ realm: 'Metrics' })({
      request: new Request('http://example.com/metrics')
    })

    expect(answer?.status).toBe(401)
    expect(answer?.headers.get('www-authenticate')).toBe('Basic realm="Metrics", charset="UTF-8"')
  })

  /** A realm closing the string early would inject a parameter of its own. */
  test('and a realm cannot inject a header parameter', async () => {
    const answer = await basicAuth({ realm: 'a", nonce="x' })({
      request: new Request('http://example.com/metrics')
    })

    expect(answer?.headers.get('www-authenticate')).toBe(
      'Basic realm="a, nonce=x", charset="UTF-8"'
    )
  })
})

describe('auth events', () => {
  function boot(): Dispatcher {
    const app = new Application(process.cwd())
    const events = new Dispatcher()

    app.instance('events' as never, events as never)

    return events
  }

  test('announce reaches a listener', async () => {
    const events = boot()
    const seen: string[] = []

    events.listen(Login, (event: Login) => seen.push(event.userId))

    announce(new Login('user-1'))

    // The dispatch is not awaited by `announce`: an audit listener must not put
    // itself between a user and their sign-in.
    await Bun.sleep(1)

    expect(seen).toEqual(['user-1'])
  })

  test('"log every failed sign-in" is a listener now', async () => {
    const events = boot()
    const seen: Array<[string, string | undefined]> = []

    events.listen(Failed, (event: Failed) => seen.push([event.identifier, event.reason]))

    announce(new Failed('ada@example.com', 'web', 'invalid credentials'))
    await Bun.sleep(1)

    expect(seen).toEqual([['ada@example.com', 'invalid credentials']])
  })

  test('and each event answers to a name a route file can listen for', () => {
    expect(Login.eventName).toBe('auth.login')
    expect(Failed.eventName).toBe('auth.failed')
    expect(Registered.eventName).toBe('auth.registered')
  })

  /** Auth has to work in an application with no events package. */
  test('nothing is dispatched when no dispatcher is registered', () => {
    const app = new Application(process.cwd())
    app.forgetInstance('events' as never)

    expect(() => announce(new Login('user-1'))).not.toThrow()
  })
})

describe('what the gate knows', () => {
  test('abilities and policies can be read back', () => {
    class Article {}
    class ArticlePolicy {}

    const gate = new Gate(async () => null)

    gate.define('touch', () => true)
    gate.define('browse', () => true, { allowGuests: true })
    gate.policy(Article, ArticlePolicy)

    expect(gate.registeredAbilities()).toEqual([
      { ability: 'touch', guests: false },
      { ability: 'browse', guests: true }
    ])
    expect(gate.registeredPolicies()).toEqual([{ subject: 'Article', policy: 'ArticlePolicy' }])
  })
})

/** So an API answers 404 everywhere without denyAsNotFound() in forty policies. */
describe('the default denial', () => {
  test('a bare false becomes whatever the default says', async () => {
    const gate = new Gate(async () => null)

    gate.define('touch', () => false, { allowGuests: true })
    gate.defaultDenialResponse(() => AuthorizationResponse.denyAsNotFound())

    const answer = await gate.inspect('touch')

    expect(answer.denied()).toBe(true)
    expect(answer.status()).toBe(404)
  })

  test('and an ability that answered for itself still wins', async () => {
    const gate = new Gate(async () => null)

    gate.define('touch', () => AuthorizationResponse.deny('Nope'), { allowGuests: true })
    gate.defaultDenialResponse(() => AuthorizationResponse.denyAsNotFound())

    const answer = await gate.inspect('touch')

    expect(answer.status()).toBe(403)
    expect(answer.message).toBe('Nope')
  })

  /** A shared instance would let the first caller's withStatus change everyone's. */
  test('each denial is its own response', async () => {
    const gate = new Gate(async () => null)

    gate.define('touch', () => false, { allowGuests: true })
    gate.defaultDenialResponse(() => AuthorizationResponse.deny())

    const first = await gate.inspect('touch')
    first.withStatus(418)

    expect((await gate.inspect('touch')).status()).toBe(403)
  })
})
