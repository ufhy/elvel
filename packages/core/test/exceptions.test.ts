import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Application } from '../src/application.ts'
import {
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
  root = await mkdtemp(join(tmpdir(), 'elyvel-exceptions-'))
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
    const response = handler.render(new NotFoundException('Gone fishing'), { request })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'Gone fishing' })
  })

  test('a numeric status field is honoured', () => {
    expect(handler.render({ status: 429 }, { request }).status).toBe(429)
  })

  test("Elysia's error codes map to statuses", () => {
    expect(handler.render({ code: 'NOT_FOUND' }, { request }).status).toBe(404)
    expect(handler.render({ code: 'VALIDATION' }, { request }).status).toBe(422)
    expect(handler.render({ code: 'PARSE' }, { request }).status).toBe(400)
  })

  test('anything else is a 500', () => {
    expect(handler.render(new Error('boom'), { request }).status).toBe(500)
    expect(handler.render('a bare string', { request }).status).toBe(500)
  })
})

describe('message rendering', () => {
  test('machine codes are humanised so they do not leak', async () => {
    // What @elysiajs/static actually throws: an Error carrying a code.
    const thrown = Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
    const response = handler.render(thrown, { request })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ message: 'Not Found' })
  })

  test('a bare Error is a 500 and reveals nothing, even if it looks like a code', async () => {
    const response = handler.render(new Error('NOT_FOUND'), { request })

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ message: 'Server Error' })
  })

  test('multi-word codes humanise too', async () => {
    const response = handler.render({ status: 400, message: 'INVALID_FILE_TYPE' }, { request })

    expect(await response.json()).toMatchObject({ message: 'Invalid File Type' })
  })

  test('ordinary non-500 messages pass through unchanged', async () => {
    const response = handler.render(new HttpException(409, 'Already exists'), { request })

    expect(await response.json()).toMatchObject({ message: 'Already exists' })
  })

  test('a 500 hides its message unless debug is on', async () => {
    const hidden = await handler.render(new Error('secret internals'), { request }).json()
    expect(hidden).toEqual({ message: 'Server Error' })

    app.config.set('app.debug', true)
    const shown = (await handler.render(new Error('secret internals'), { request }).json()) as {
      message: string
      exception: string
      stack: string[]
    }

    expect(shown.message).toBe('secret internals')
    expect(shown.exception).toBe('Error')
    expect(Array.isArray(shown.stack)).toBe(true)
  })

  test('no stack is exposed when debug is off', async () => {
    const payload = await handler.render(new Error('boom'), { request }).json()

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

describe('error pages for a browser', () => {
  const handler = () => new ExceptionHandler(new Application(process.cwd()))

  const at = (accept: string) => new Request('http://localhost/orders', { headers: { accept } })

  test('a browser gets HTML, an API client gets JSON', async () => {
    const html = handler().render(new NotFoundException('No such order.'), {
      request: at('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
    })

    expect<number>(html.status).toBe(404)
    expect<string | null>(html.headers.get('content-type')).toContain('text/html')
    expect<boolean>((await html.text()).includes('No such order.')).toBe(true)

    const json = handler().render(new NotFoundException('No such order.'), {
      request: at('application/json')
    })

    expect<string | null>(json.headers.get('content-type')).toContain('application/json')
  })

  test('a wildcard Accept still gets JSON', () => {
    // A fetch() sending */* must not be handed a page it cannot parse.
    const response = handler().render(new NotFoundException('gone'), { request: at('*/*') })

    expect<string | null>(response.headers.get('content-type')).toContain('application/json')
  })

  test('the message is escaped', async () => {
    const response = handler().render(new NotFoundException('<script>alert(1)</script>'), {
      request: at('text/html')
    })

    const body = await response.text()

    expect<boolean>(body.includes('<script>alert(1)</script>')).toBe(false)
    expect<boolean>(body.includes('&lt;script&gt;')).toBe(true)
  })
})
