import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Kernel } from '@elvel/console'
import { Application } from '@elvel/core'
import { Elysia } from 'elysia'
import { SessionGcCommand } from '../src/console/session-gc.ts'
import { HttpServiceProvider } from '../src/index.ts'
import { currentScope } from '../src/scope.ts'
import { FileSessionDriver, MemorySessionDriver, Session } from '../src/session.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-session-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('a session can be given a new id', () => {
  /**
   * Session fixation, concretely.
   *
   * An attacker gets a victim's browser to hold an id they already know, the
   * victim signs in, and the id they know is now an authenticated session. Nothing
   * about the sign-in is broken; the id simply never changed. This is the call a
   * login makes, and Laravel makes it in the same place.
   */
  test('the data survives and the id does not', async () => {
    const driver = new MemorySessionDriver()
    const session = await new Session('the-known-id', driver).start()

    session.put('cart', ['a', 'b'])
    await session.save()

    const before = session.token()

    await session.regenerate()

    expect<boolean>(session.id === 'the-known-id').toBe(false)
    expect<string[]>(session.get('cart')).toEqual(['a', 'b'])

    /**
     * And the CSRF token with it.
     *
     * A token is bound to a session, so keeping the old one across a privilege
     * change means the value a page picked up while signed out still authorises
     * writes while signed in.
     */
    expect<boolean>(session.token() === before).toBe(false)
  })

  /**
   * The old record is destroyed, which is where this differs from Laravel.
   *
   * What an attacker holds *is* that record. Leaving it to expire leaves it usable
   * until it does.
   */
  test('the record an attacker holds is gone', async () => {
    const driver = new MemorySessionDriver()
    const session = await new Session('the-known-id', driver).start()

    await session.save()
    expect<boolean>((await driver.read('the-known-id')) !== undefined).toBe(true)

    await session.regenerate()

    expect(await driver.read('the-known-id')).toBeUndefined()
  })

  test('unless something else still reads it', async () => {
    const driver = new MemorySessionDriver()
    const session = await new Session('the-known-id', driver).start()

    await session.save()
    await session.regenerate(false)

    expect<boolean>((await driver.read('the-known-id')) !== undefined).toBe(true)
  })

  test('and the new id is what the next save writes', async () => {
    const driver = new MemorySessionDriver()
    const session = await new Session('first', driver).start()

    await session.regenerate()
    session.put('who', 'ada')
    await session.save()

    expect<unknown>((await driver.read(session.id))?.who).toBe('ada')
  })
})

describe('the cookie flags an application can decide', () => {
  async function cookieWith(session: Record<string, unknown>): Promise<string> {
    const app = new Application(root)

    app.config.set('app', { key: 'a'.repeat(40), url: 'http://localhost', name: 'Test' })
    app.config.set('app.env', 'testing')
    app.config.set('session', { driver: 'memory', ...session })

    await app.register(HttpServiceProvider)
    await app.boot()
    app.handleExceptions()

    /**
     * The page writes something, because a page that writes nothing gets no cookie.
     *
     * That is the point of the flags being on this response at all: a session with
     * nothing in it is not written and not named, which is what keeps an anonymous
     * visit free and its document cacheable. Reading `session.id` is not touching
     * the session — asking for a CSRF token, or putting a value, is.
     */
    app.useRoutes(
      new Elysia().get('/page', () => {
        currentScope()?.session.put('seen', true)

        return currentScope()?.session.id ?? ''
      })
    )

    const response = await app.handle(new Request('http://localhost/page'))

    return response.headers.get('set-cookie') ?? ''
  }

  test('lax by default, because a link from an email should land signed in', async () => {
    const cookie = await cookieWith({})

    expect<boolean>(cookie.includes('SameSite=Lax')).toBe(true)
    expect<boolean>(cookie.includes('HttpOnly')).toBe(true)
  })

  test('strict when asked, which refuses even a top-level navigation', async () => {
    expect<boolean>((await cookieWith({ sameSite: 'strict' })).includes('SameSite=Strict')).toBe(
      true
    )
  })

  /**
   * `Secure` is off in a testing environment and can be asked for anyway.
   *
   * A development setup can be HTTPS, and a production one can sit behind a proxy
   * that terminates it — so this is configurable in both directions, with the safe
   * half as the default.
   */
  test('secure can be asked for outside production', async () => {
    expect<boolean>((await cookieWith({})).includes('Secure')).toBe(false)
    expect<boolean>((await cookieWith({ secure: true })).includes('Secure')).toBe(true)
  })
})

describe('session:gc, which nothing used to call', () => {
  /** Run the command, capturing terminal output with colours stripped. */
  async function run(app: Application, argv: string[]): Promise<string> {
    const kernel = new Kernel(app)

    kernel.register(SessionGcCommand)

    const originalLog = console.log
    const originalError = console.error
    const lines: string[] = []
    const collect = (...args: unknown[]) => lines.push(args.map(String).join(' '))

    console.log = collect
    console.error = collect

    try {
      await kernel.run(argv)

      return lines
        .join('\n')
        .replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    } finally {
      console.log = originalLog
      console.error = originalError
    }
  }

  function application(driver: FileSessionDriver): Application {
    const app = new Application(root)

    app.config.set('session', { lifetime: 100 })
    app.instance('session.driver', driver)

    return app
  }

  /**
   * The file driver keeps a record until something removes it.
   *
   * Measured in a demo left running for a few days: over 130 files in
   * `storage/framework/sessions`, every one of them still a usable session.
   * `gc()` was implemented on all four drivers and called by nothing.
   */
  test('an idle session is removed and a fresh one is not', async () => {
    const driver = new FileSessionDriver(root)

    await driver.write('fresh', { who: 'ada' })
    await driver.write('idle', { who: 'grace' })

    // Idle for an hour, against a lifetime of a hundred seconds.
    const hourAgo = new Date(Number(new Date('2020-01-01T00:00:00Z')))
    await utimes(join(root, 'idle.json'), hourAgo, hourAgo)

    const output = await run(application(driver), ['session:gc'])

    expect<boolean>(output.includes('Removed 1 session')).toBe(true)
    expect<boolean>((await driver.read('fresh')) !== undefined).toBe(true)
    expect(await driver.read('idle')).toBeUndefined()
  })

  /**
   * The lifetime is in the message, not only the count.
   *
   * A bare `0` reads as "nothing to do" and as "the wrong lifetime" equally well,
   * and those need different fixes.
   */
  test('it says what it swept against', async () => {
    const output = await run(application(new FileSessionDriver(root)), ['session:gc'])

    expect<boolean>(output.includes('Removed 0 sessions')).toBe(true)
    expect<boolean>(output.includes('100s')).toBe(true)
  })

  test('an override has to be a number of seconds', async () => {
    const output = await run(application(new FileSessionDriver(root)), [
      'session:gc',
      '--lifetime',
      'soon'
    ])

    expect<boolean>(output.includes('is not a number of seconds')).toBe(true)
  })

  /** A file the driver did not write is not the command's business. */
  test('it leaves what it does not recognise', async () => {
    const driver = new FileSessionDriver(root)
    const stranger = join(root, 'notes.txt')

    await writeFile(stranger, 'not a session')

    const then = new Date(Number(new Date('2020-01-01T00:00:00Z')))
    await utimes(stranger, then, then)

    await run(application(driver), ['session:gc'])

    expect<boolean>(await Bun.file(stranger).exists()).toBe(true)
  })
})
