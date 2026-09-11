import { describe, expect, test } from 'bun:test'
import { Application } from '../src/application.ts'
import { DumpException, dd, dump } from '../src/dump.ts'
import { CARRIES_RESPONSE } from '../src/exceptions.ts'

/** Run `body` with `console.log` captured. */
function quietly<T>(body: () => T): { result: T; printed: string } {
  const original = console.log
  const lines: string[] = []

  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))

  try {
    return { result: body(), printed: lines.join('\n') }
  } finally {
    console.log = original
  }
}

describe('dump', () => {
  /**
   * Symfony's, and what makes the helper usable without taking a statement
   * apart: `const user = dump(await find(id))`.
   */
  test('gives back the single value it was passed', () => {
    const { result } = quietly(() => dump({ id: 7 }))

    expect(result).toEqual({ id: 7 })
  })

  test('gives back the array when there were several', () => {
    const { result } = quietly(() => dump(1, 'two', { three: true }))

    expect(result).toEqual([1, 'two', { three: true }])
  })

  test('prints what it was given', () => {
    const { printed } = quietly(() => dump({ name: 'Ada' }))

    expect(printed).toContain('Ada')
  })

  /** Symfony labels multiple values from 1, not from 0. */
  test('labels several values from one', () => {
    const { printed } = quietly(() => dump('a', 'b'))

    expect(printed).toContain('dump 1')
    expect(printed).toContain('dump 2')
    expect(printed).not.toContain('dump 0')
  })

  test('a single value gets no label', () => {
    const { printed } = quietly(() => dump('only'))

    expect(printed).toContain('↓ dump')
    expect(printed).not.toContain('dump 1')
  })

  /** Symfony dumps a bug when nothing was passed, which answers "did this run". */
  test('nothing at all still says something', () => {
    const { printed, result } = quietly(() => dump())

    expect(printed).toContain('🐛')
    expect(result).toBeUndefined()
  })

  /**
   * A dump with no origin is `console.log` with extra steps — the difficulty
   * with scattered dumps is working out which one is talking.
   */
  test('says where it was called from, and not from inside itself', () => {
    const { printed } = quietly(() => dump('x'))

    expect(printed).toContain('dump.test.ts')
    expect(printed).not.toContain('src/dump.ts')
  })

  test('a cycle does not throw', () => {
    const loop: Record<string, unknown> = { name: 'root' }
    loop.self = loop

    expect(() => quietly(() => dump(loop))).not.toThrow()
  })
})

describe('dd', () => {
  /**
   * Symfony calls `exit(1)`, which is right under PHP-FPM because the process
   * *is* the request. Bun's process is the server: exiting would take down every
   * other request in flight. So it throws, and what it throws carries the page.
   */
  test('throws rather than exiting', () => {
    expect(() => quietly(() => dd('stop'))).toThrow(DumpException)
  })

  test('prints before it throws', () => {
    const lines: string[] = []
    const original = console.log

    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))

    try {
      dd({ why: 'because' })
    } catch {
      // expected
    } finally {
      console.log = original
    }

    expect(lines.join('\n')).toContain('because')
  })

  /** The 500 Symfony sets by hand before exiting, carried instead. */
  test('carries a page with the dump in it', () => {
    let thrown: unknown

    quietly(() => {
      try {
        dd({ secretless: 'payload' })
      } catch (error) {
        thrown = error
      }
    })

    expect(thrown).toBeInstanceOf(DumpException)

    const response = (thrown as DumpException)[CARRIES_RESPONSE]()

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toContain('text/html')
  })

  test('the page escapes what it shows', async () => {
    let thrown: unknown

    quietly(() => {
      try {
        dd('<script>alert(1)</script>')
      } catch (error) {
        thrown = error
      }
    })

    const body = await (thrown as DumpException)[CARRIES_RESPONSE]().text()

    expect(body).not.toContain('<script>alert(1)</script>')
    expect(body).toContain('&lt;script&gt;')
  })
})

describe('the dump event', () => {
  /**
   * Guarded, so an application with no recorder pays nothing — and wrapped, so
   * a dump is never the thing that breaks the code somebody is debugging.
   */
  test('is dispatched when something is listening', async () => {
    const app = new Application(process.cwd())
    const seen: unknown[] = []

    app.instance(
      'events' as never,
      {
        hasListeners: () => true,
        dispatch: (name: string, payload: unknown) => {
          seen.push({ name, payload })
        }
      } as never
    )

    quietly(() => dump({ watched: true }))

    expect(seen).toHaveLength(1)
    expect((seen[0] as { name: string }).name).toBe('dump.captured')
  })

  test('a dispatcher that throws does not break the dump', () => {
    const app = new Application(process.cwd())

    app.instance(
      'events' as never,
      {
        hasListeners: () => true,
        dispatch: () => {
          throw new Error('listener exploded')
        }
      } as never
    )

    const { printed } = quietly(() => dump('still printed'))

    expect(printed).toContain('still printed')
  })
})
