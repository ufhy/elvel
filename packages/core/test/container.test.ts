import { describe, expect, test } from 'bun:test'
import type { ContainerBindings } from '@elvel/contracts'
import { Application } from '../src/application.ts'
import { enterWorkContext, withoutRequestContext } from '../src/request-context.ts'

function container(): Application {
  return new Application(process.cwd())
}

/**
 * The keys this file binds, declared the way an application declares its own.
 *
 * A cast at every call site would have hidden exactly what these tests are for —
 * that a key resolves to what was bound to it.
 */
declare module '@elvel/contracts' {
  interface ContainerBindings {
    'per-request': number
    mine: string
    greeting: string
    driver: string
    'channel.mail': string
    'channel.sms': string
    'health.db': string
    transport: string
    'reports.mailer': string
    'site.mailer': string
    client: { timeout: number }
    a: string
    b: string
    lazy: string
    'each-time': object
    once: number
    gone: string
    zebra: number
    apple: number
  }
}

const key = <K extends keyof ContainerBindings>(name: K): K => name

describe('scoped bindings', () => {
  test('resolve once inside a request', () => {
    const app = container()
    let built = 0

    app.scoped(key('per-request'), () => ++built)

    withoutRequestContext(() => {
      enterWorkContext()

      expect(app.make(key('per-request'))).toBe(1)
      expect(app.make(key('per-request'))).toBe(1)
    })

    expect(built).toBe(1)
  })

  test('and the next request gets its own', () => {
    const app = container()
    let built = 0

    app.scoped(key('per-request'), () => ++built)

    const once = () =>
      withoutRequestContext(() => {
        enterWorkContext()

        return app.make(key('per-request'))
      })

    expect(once()).toBe(1)
    expect(once()).toBe(2)
  })

  /** A worker or a command: shared until something says the unit of work ended. */
  test('outside a request it is shared until forgotten', () => {
    const app = container()
    let built = 0

    app.scoped(key('per-request'), () => ++built)

    withoutRequestContext(() => {
      expect(app.make(key('per-request'))).toBe(1)
      expect(app.make(key('per-request'))).toBe(1)

      app.forgetScopedInstances()

      expect(app.make(key('per-request'))).toBe(2)
    })
  })
})

describe('defaults and decoration', () => {
  test('bindIf leaves an existing binding alone', () => {
    const app = container()

    app.bind(key('mine'), () => 'application')
    app.bindIf(key('mine'), () => 'package default')

    expect(app.make(key('mine'))).toBe('application')
  })

  test('and binds when nothing is there', () => {
    const app = container()

    app.bindIf(key('mine'), () => 'package default')

    expect(app.make(key('mine'))).toBe('package default')
  })

  test('extend wraps what is bound, keeping whoever bound it', () => {
    const app = container()

    app.bind(key('greeting'), () => 'hello')
    app.extend(key('greeting'), (value) => `${value as string}, world`)
    app.extend(key('greeting'), (value) => `${value as string}!`)

    expect(app.make(key('greeting'))).toBe('hello, world!')
  })

  /** An instance is already built, so there is no next resolution to wrap. */
  test('and an instance already built is wrapped in place', () => {
    const app = container()

    app.instance(key('greeting'), 'hello')
    app.extend(key('greeting'), (value) => `${value as string}!`)

    expect(app.make(key('greeting'))).toBe('hello!')
  })

  test('rebinding hears about a replacement', () => {
    const app = container()
    const seen: unknown[] = []

    app.bind(key('driver'), () => 'file')
    app.rebinding(key('driver'), (value) => seen.push(value))
    app.bind(key('driver'), () => 'redis')

    expect(seen).toEqual(['redis'])
  })

  test('refresh hands the value over now and again later', () => {
    const app = container()
    const holder = {
      driver: '',
      set(value: string) {
        this.driver = value
      }
    }

    app.bind(key('driver'), () => 'file')
    app.refresh(key('driver'), holder, 'set')

    expect(holder.driver).toBe('file')

    app.bind(key('driver'), () => 'redis')

    expect(holder.driver).toBe('redis')
  })
})

describe('tags', () => {
  test('collect a set nobody enumerated', () => {
    const app = container()

    app.bind(key('channel.mail'), () => 'mail')
    app.bind(key('channel.sms'), () => 'sms')
    app.tag([key('channel.mail'), key('channel.sms')], 'channels')

    expect(app.tagged('channels')).toEqual(['mail', 'sms'])
  })

  test('a tag nothing was added to is empty, not an error', () => {
    expect(container().tagged('nothing')).toEqual([])
  })

  test('and a key can carry more than one', () => {
    const app = container()

    app.bind(key('health.db'), () => 'db')
    app.tag(key('health.db'), 'health', 'startup')

    expect(app.tagged('startup')).toEqual(['db'])
  })
})

describe('contextual bindings', () => {
  test('one consumer gets a different implementation', () => {
    const app = container()

    app.bind(key('transport'), () => 'smtp')
    app.bind(key('reports.mailer'), (c) => `reports:${c.make(key('transport')) as string}`)
    app.bind(key('site.mailer'), (c) => `site:${c.make(key('transport')) as string}`)

    app
      .when(key('reports.mailer'))
      .needs(key('transport'))
      .give(() => 'ses')

    expect(app.make(key('reports.mailer'))).toBe('reports:ses')
    expect(app.make(key('site.mailer'))).toBe('site:smtp')
  })

  test('a value may be given instead of a factory', () => {
    const app = container()

    app.bind(key('transport'), () => 'smtp')
    app.bind(key('reports.mailer'), (c) => c.make(key('transport')))
    app.when(key('reports.mailer')).needs(key('transport')).give('ses')

    expect(app.make(key('reports.mailer'))).toBe('ses')
  })
})

describe('resolution hooks', () => {
  test('run before and after a key resolves', () => {
    const app = container()
    const order: string[] = []

    app.bind(key('client'), () => ({ timeout: 0 }))
    app.beforeResolving(key('client'), (name) => order.push(`before:${name}`))
    app.resolving(key('client'), () => order.push('resolving'))
    app.afterResolving(key('client'), () => order.push('after'))

    app.make(key('client'))

    expect(order).toEqual(['before:client', 'resolving', 'after'])
  })

  test('and configure an instance of a type the hook does not own', () => {
    const app = container()

    app.bind(key('client'), () => ({ timeout: 0 }))
    app.resolving(key('client'), (value) => {
      ;(value as { timeout: number }).timeout = 30
    })

    expect(app.make(key('client'))).toEqual({ timeout: 30 })
  })

  /** An `instance()` is a resolution too, or a hook configures some and not others. */
  test('and see a value handed straight to instance()', () => {
    const app = container()
    const seen: unknown[] = []

    app.resolving(key('client'), (value) => seen.push(value))
    app.instance(key('client'), { timeout: 5 })

    expect(seen).toEqual([{ timeout: 5 }])
  })

  test('a wildcard sees every key', () => {
    const app = container()
    const seen: string[] = []

    app.bind(key('a'), () => 'a')
    app.bind(key('b'), () => 'b')
    app.beforeResolving('*', (name) => seen.push(name))

    app.make(key('a'))
    app.make(key('b'))

    expect(seen).toEqual(['a', 'b'])
  })
})

describe('inspection and reset', () => {
  test('resolved says what has been built', () => {
    const app = container()

    app.bind(key('lazy'), () => 'built')

    expect(app.resolved(key('lazy'))).toBe(false)

    app.make(key('lazy'))

    expect(app.resolved(key('lazy'))).toBe(true)
  })

  test('isShared separates a singleton from a factory', () => {
    const app = container()

    app.bind(key('each-time'), () => ({}))
    app.singleton(key('once'), () => 1)

    expect(app.isShared(key('each-time'))).toBe(false)
    expect(app.isShared(key('once'))).toBe(true)
  })

  test('getBindings lists what is bound', () => {
    const app = container()

    app.singleton(key('zebra'), () => 1)
    app.bind(key('apple'), () => 2)

    const listed = app.getBindings().filter((row) => row.key === 'apple' || row.key === 'zebra')

    expect(listed).toEqual([
      { key: 'apple', shared: false, scoped: false, resolved: false },
      { key: 'zebra', shared: true, scoped: false, resolved: false }
    ])
  })

  test('forgetInstance keeps the binding and rebuilds', () => {
    const app = container()
    let built = 0

    app.singleton(key('once'), () => ++built)

    expect(app.make(key('once'))).toBe(1)

    app.forgetInstance(key('once'))

    expect(app.make(key('once'))).toBe(2)
  })

  test('flush empties it', () => {
    const app = container()

    app.bind(key('gone'), () => 'gone')
    app.flush()

    expect(app.bound(key('gone'))).toBe(false)
    expect(() => app.make(key('gone'))).toThrow('is not bound')
  })
})
