import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '../src/application.ts'
import {
  CARRIES_RESPONSE,
  ExceptionHandler,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException
} from '../src/exceptions.ts'

let app: Application
let handler: ExceptionHandler
let root: string

const request = new Request('http://localhost/somewhere')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elvel-exceptions-'))
  app = new Application(root)
  // Keep report() quiet: the handler skips logging in the testing environment.
  app.config.set('app.env', 'testing')
  handler = new ExceptionHandler(app)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('exception classes', () => {
  test('carry their status and a default message', () => {
    expect(new NotFoundException().status).toBe(404)
    expect(new NotFoundException().message).toBe('Not Found')
    expect(new ForbiddenException().status).toBe(403)
    expect(new UnauthorizedException().status).toBe(401)
    expect(new HttpException(418).message).toBe('HTTP 418')
  })

  test('report their own class name', () => {
    expect(new NotFoundException().name).toBe('NotFoundException')
    expect(new ForbiddenException().name).toBe('ForbiddenException')
  })

  test('accept a custom message', () => {
    expect(new ForbiddenException('Not your post').message).toBe('Not your post')
  })
})

describe('status mapping', () => {
  test('HttpException wins', async () => {
    const response = await handler.render(new NotFoundException('Gone fishing'), { request })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'Gone fishing' })
  })

  test('a numeric status field is honoured', async () => {
    expect((await handler.render({ status: 429 }, { request })).status).toBe(429)
  })

  test("Elysia's error codes map to statuses", async () => {
    expect((await handler.render({ code: 'NOT_FOUND' }, { request })).status).toBe(404)
    expect((await handler.render({ code: 'VALIDATION' }, { request })).status).toBe(422)
    expect((await handler.render({ code: 'PARSE' }, { request })).status).toBe(400)
  })

  test('anything else is a 500', async () => {
    expect((await handler.render(new Error('boom'), { request })).status).toBe(500)
    expect((await handler.render('a bare string', { request })).status).toBe(500)
  })
})

describe('message rendering', () => {
  test('machine codes are humanised so they do not leak', async () => {
    // What @elysiajs/static actually throws: an Error carrying a code.
    const thrown = Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
    const response = await handler.render(thrown, { request })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'Not Found' })
  })

  test('a bare Error is a 500 and reveals nothing, even if it looks like a code', async () => {
    const response = await handler.render(new Error('NOT_FOUND'), { request })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: 'Server Error' })
  })

  test('multi-word codes humanise too', async () => {
    const response = await handler.render(
      { status: 400, message: 'INVALID_FILE_TYPE' },
      { request }
    )

    expect(await response.json()).toMatchObject({ message: 'Invalid File Type' })
  })

  test('ordinary non-500 messages pass through unchanged', async () => {
    const response = await handler.render(new HttpException(409, 'Already exists'), { request })

    expect(await response.json()).toMatchObject({ message: 'Already exists' })
  })

  test('a 500 hides its message unless debug is on', async () => {
    const hidden = await (await handler.render(new Error('secret internals'), { request })).json()
    expect(hidden).toEqual({ message: 'Server Error' })

    app.config.set('app.debug', true)
    const shown = (await (
      await handler.render(new Error('secret internals'), { request })
    ).json()) as {
      message: string
      exception: string
      stack: string[]
    }

    expect(shown.message).toBe('secret internals')
    expect(shown.exception).toBe('Error')
    expect(Array.isArray(shown.stack)).toBe(true)
  })

  test('no stack is exposed when debug is off', async () => {
    const payload = (await handler.render(new Error('boom'), { request })).json()

    expect(payload).not.toHaveProperty('stack')
    expect(payload).not.toHaveProperty('exception')
  })
})

describe('reporting', () => {
  test('stays silent in the testing environment', () => {
    const original = console.error
    let calls = 0
    console.error = () => {
      calls += 1
    }

    try {
      handler.report(new Error('quiet please'))
      expect(calls).toBe(0)

      app.config.set('app.env', 'local')
      handler.report(new Error('now log it'))
      expect(calls).toBe(1)
    } finally {
      console.error = original
    }
  })
})

/**
 * A log is for what this application got wrong.
 *
 * Every error used to be reported, so a browser asking for a `/favicon.ico` the
 * application does not ship wrote `ERROR [stack] NOT_FOUND` with a stack trace
 * through `@elysiajs/static` — an application error, in the log, for a request
 * that was answered correctly. Laravel keeps the same four-hundreds out of its
 * log for the same reason.
 */
describe('what is worth reporting', () => {
  /** Counts what `report()` would have written, whatever it reaches for. */
  const counting = () => {
    const original = console.error
    let calls = 0

    console.error = () => {
      calls += 1
    }

    return {
      calls: () => calls,
      restore: () => {
        console.error = original
      }
    }
  }

  test('a missing page is not an application error', () => {
    app.config.set('app.env', 'local')

    const log = counting()

    try {
      // Every shape a 404 arrives in: the framework's, Elysia's, and a status.
      handler.report(new NotFoundException())
      handler.report(Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' }))
      handler.report(Object.assign(new Error('missing'), { status: 404 }))

      expect(log.calls()).toBe(0)
    } finally {
      log.restore()
    }
  })

  test('the rest of the four-hundreds are just as quiet', () => {
    app.config.set('app.env', 'local')

    const log = counting()

    try {
      handler.report(new ForbiddenException())
      handler.report(new UnauthorizedException())
      handler.report(new HttpException(419, 'CSRF token mismatch.'))
      handler.report(Object.assign(new Error('invalid'), { code: 'VALIDATION' }))

      expect(log.calls()).toBe(0)
    } finally {
      log.restore()
    }
  })

  /**
   * The positive control, and the reason the tests above mean anything.
   *
   * A count of zero proves nothing unless the same counter can reach a number,
   * so this asserts the loud half of the rule: what this application got wrong
   * still gets written down.
   */
  test('a failure of this application is still reported', () => {
    app.config.set('app.env', 'local')

    const log = counting()

    try {
      handler.report(new Error('the database is gone'))
      handler.report(new HttpException(500, 'Server Error'))
      handler.report(new HttpException(503, 'Down for maintenance'))

      expect(log.calls()).toBe(3)
    } finally {
      log.restore()
    }
  })
})

describe('an exception that carries its own response', () => {
  /**
   * A redirect thrown by validation is control flow, not a failure.
   *
   * It has no `status` of its own — it holds a built `Response` — so it fell
   * through to the 500 at the bottom of `statusFor`. The log then called every
   * failed form submission an application error: `ERROR [stack] Redirecting to
   * /subscribe`, with a stack trace through `failedValidation`, for a browser on
   * its way back to the form it came from.
   */
  const thrown = (status: number) => {
    const carried = new Response('', { status, headers: { location: '/subscribe' } })

    return Object.assign(new Error('Redirecting to /subscribe'), {
      [CARRIES_RESPONSE]: () => carried
    })
  }

  test('its status is the response it carries', () => {
    const handler = new (class extends ExceptionHandler {
      status(error: unknown): number {
        return this.statusFor(error)
      }
    })(app)

    expect<number>(handler.status(thrown(302))).toBe(302)
  })

  test('and a redirect is not worth a log line', () => {
    const reported: string[] = []

    const handler = new (class extends ExceptionHandler {
      worth(error: unknown): boolean {
        return this.shouldReport(error)
      }
    })(app)

    expect<boolean>(handler.worth(thrown(302))).toBe(false)

    // The rule is 5xx, so a carried 500 — an application answering its own
    // failure with a page — is still reported.
    expect<boolean>(handler.worth(thrown(500))).toBe(true)
    expect<string[]>(reported).toEqual([])
  })
})

describe('error pages for a browser', () => {
  const handler = () => new ExceptionHandler(new Application(process.cwd()))

  const at = (accept: string) => new Request('http://localhost/orders', { headers: { accept } })

  test('a browser gets HTML, an API client gets JSON', async () => {
    const html = await handler().render(new NotFoundException('No such order.'), {
      request: at('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    })

    expect<number>(html.status).toBe(404)
    expect<string | null>(html.headers.get('content-type')).toContain('text/html')
    expect<boolean>((await html.text()).includes('No such order.')).toBe(true)

    const json = await handler().render(new NotFoundException('No such order.'), {
      request: at('application/json')
    })

    expect<string | null>(json.headers.get('content-type')).toContain('application/json')
  })

  test('a wildcard Accept still gets JSON', async () => {
    // A fetch() sending */* must not be handed a page it cannot parse.
    const response = await handler().render(new NotFoundException('gone'), { request: at('*/*') })

    expect<string | null>(response.headers.get('content-type')).toContain('application/json')
  })

  test('the message is escaped', async () => {
    /**
     * Awaited, because `render` may answer asynchronously.
     *
     * The contract has always allowed `Promise<Response>`; the class narrowed it
     * to `Response` until an application needed to render a document — which
     * means reading from a database — from its own handler.
     */
    const response = await handler().render(new NotFoundException('<script>alert(1)</script>'), {
      request: at('text/html')
    })

    const body = await response.text()

    expect<boolean>(body.includes('<script>alert(1)</script>')).toBe(false)
    expect<boolean>(body.includes('&lt;script&gt;')).toBe(true)
  })
})

/**
 * A schema failure, as a form can render it.
 *
 * Elysia's `ValidationError` carries a pretty-printed JSON dump in `message` — the
 * schema, the value it was given, and the violation. Before this it *was* the
 * answer: measured against a running application, a sign-up form with one field
 * missing showed the person
 *
 * ```
 * {\n  "type": "validation",\n  "on": "body",\n  "property": "/password",…
 * ```
 *
 * and marked no field at all, because there was no bag to mark one from.
 *
 * Duck-typed here the way the handler reads it — `code` and `all` — rather than by
 * constructing a real `ValidationError`: core does not depend on Elysia, and the
 * shape is the contract.
 */
describe('an Elysia validation failure', () => {
  const handler = () => new ExceptionHandler(new Application(process.cwd()))

  const asked = new Request('http://localhost/sign-up', {
    method: 'POST',
    headers: { accept: 'application/json' }
  })

  const failure = (all: Array<Record<string, unknown>>) => ({
    code: 'VALIDATION',
    status: 422,
    message: '{\n  "type": "validation",\n  "on": "body"\n}',
    all
  })

  test('answers a sentence, not the schema dump', async () => {
    const response = await handler().render(
      failure([{ path: '/password', message: 'Expected required property' }]),
      { request: asked }
    )
    const body = (await response.json()) as { message: string }

    expect<number>(response.status).toBe(422)
    expect<string>(body.message).toBe('The given data was invalid.')
    // The dump is what this exists to keep out of the answer.
    expect<boolean>(body.message.includes('"type"')).toBe(false)
  })

  test('and a bag keyed by field, so the right input is marked', async () => {
    const response = await handler().render(
      failure([
        { path: '/password', message: 'Expected required property' },
        { path: '/email', message: 'Expected string to match format "email"', value: 'nope' }
      ]),
      { request: asked }
    )
    const body = (await response.json()) as { errors: Record<string, string[]> }

    expect<string[]>(Object.keys(body.errors).sort()).toEqual(['email', 'password'])
    expect<string[]>(body.errors.password as string[]).toEqual(['The password field is required.'])
    expect<string[]>(body.errors.email as string[]).toEqual(['The email field is not valid.'])
  })

  /**
   * A bound of one is a blank field, and reads as one.
   *
   * `t.String({ minLength: 1 })` is how a route refuses an empty input, and "too
   * short" there reads as though somebody had tried and fallen short.
   */
  test('a minimum of one reads as required, a larger one as too short', async () => {
    const response = await handler().render(
      failure([
        {
          path: '/name',
          message: 'Expected string length greater or equal to 1',
          schema: { minLength: 1 },
          value: ''
        },
        {
          // Not blank — short. Blank is read off the value and is always "required".
          path: '/password',
          message: 'Expected string length greater or equal to 8',
          schema: { minLength: 8 },
          value: 'ab'
        }
      ]),
      { request: asked }
    )
    const body = (await response.json()) as { errors: Record<string, string[]> }

    expect<string[]>(body.errors.name as string[]).toEqual(['The name field is required.'])
    expect<string[]>(body.errors.password as string[]).toEqual(['The password field is too short.'])
  })

  test('a nested path becomes a dotted field name', async () => {
    const response = await handler().render(
      failure([{ path: '/address/city', message: 'Expected required property' }]),
      { request: asked }
    )
    const body = (await response.json()) as { errors: Record<string, string[]> }

    // What a bag is keyed by everywhere else, so one renderer handles both.
    expect<string[]>(Object.keys(body.errors)).toEqual(['address.city'])
    expect<string[]>(body.errors['address.city'] as string[]).toEqual([
      'The city field is required.'
    ])
  })

  test('a violation about the whole body is filed under form', async () => {
    const response = await handler().render(
      failure([{ path: '', message: 'Expected object', value: 'not an object' }]),
      {
        request: asked
      }
    )
    const body = (await response.json()) as { errors: Record<string, string[]> }

    // Keyed by the empty string it would mark no field and render nowhere.
    expect<string[]>(Object.keys(body.errors)).toEqual(['form'])
  })
})
