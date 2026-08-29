import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PendingRequest } from '../src/pending.ts'

/**
 * The methods added to reach Laravel's `PendingRequest`, against a real server.
 *
 * A fake would prove nothing about most of these. `attach` is about the bytes and
 * the boundary the runtime writes; `sink` is about the body going to a file
 * instead of into memory; `maxRedirects` is about a chain this client walks
 * itself, because `fetch` takes "follow all" or "follow none" and no count. Only
 * a server on the other end can answer any of that.
 */
let server: ReturnType<typeof Bun.serve>
let origin = ''
const scratch = join(tmpdir(), `elvel-http-${Date.now().toString(36)}`)

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url)

      if (pathname === '/echo') {
        return Response.json({
          method: request.method,
          contentType: request.headers.get('content-type'),
          cookie: request.headers.get('cookie'),
          accept: request.headers.get('accept'),
          marker: request.headers.get('x-marker')
        })
      }

      if (pathname === '/upload') {
        const form = await request.formData()
        const file = form.get('report')

        return Response.json({
          fields: [...form.keys()].sort(),
          note: form.get('note'),
          filename: file instanceof File ? file.name : null,
          contents: file instanceof File ? await file.text() : null,
          boundary: (request.headers.get('content-type') ?? '').includes('boundary=')
        })
      }

      if (pathname === '/download') {
        return new Response('a report, streamed', {
          headers: { 'content-type': 'text/plain' }
        })
      }

      // /hop/3 → /hop/2 → /hop/1 → /landed
      const hop = /^\/hop\/(\d+)$/.exec(pathname)

      if (hop) {
        const left = Number(hop[1]) - 1

        return new Response(null, {
          status: 302,
          headers: { location: left > 0 ? `/hop/${left}` : '/landed' }
        })
      }

      if (pathname === '/landed') return new Response('landed')

      if (pathname === '/see-other') {
        return new Response(null, { status: 303, headers: { location: '/echo' } })
      }

      return new Response('not found', { status: 404 })
    }
  })

  origin = `http://localhost:${server.port}`
})

afterAll(async () => {
  server.stop(true)
  await rm(scratch, { recursive: true, force: true })
})

const client = () => new PendingRequest()

describe('attach', () => {
  test('sends a multipart body, and the runtime writes the boundary', async () => {
    const answer = await client()
      .attach('report', new Blob(['line one']), 'report.txt')
      .attach('note', 'from the tests')
      .post(`${origin}/upload`)

    const body = answer.json() as {
      fields: string[]
      note: string
      filename: string
      contents: string
      boundary: boolean
    }

    expect<string[]>(body.fields).toEqual(['note', 'report'])
    expect<string>(body.filename).toBe('report.txt')
    expect<string>(body.contents).toBe('line one')
    expect<string>(body.note).toBe('from the tests')

    /**
     * The boundary is the reason `content-type` is deleted before sending.
     *
     * Only the runtime knows it, and it knows it only once it has the form. A
     * hand-set `multipart/form-data` header survives and the far end then cannot
     * parse the body — with nothing failing on this side.
     */
    expect<boolean>(body.boundary).toBe(true)
  })

  test('a hand-set content type does not survive to break the boundary', async () => {
    const answer = await client()
      .contentType('multipart/form-data')
      .attach('note', 'x')
      .post(`${origin}/upload`)

    expect<boolean>((answer.json() as { boundary: boolean }).boundary).toBe(true)
  })
})

describe('sink', () => {
  test('writes the body to a file', async () => {
    const target = join(scratch, 'report.txt')
    const answer = await client().sink(target).get(`${origin}/download`)

    expect<number>(answer.status).toBe(200)
    expect<string>(await Bun.file(target).text()).toBe('a report, streamed')
  })
})

describe('maxRedirects', () => {
  test('follows the chain to the end when the limit allows', async () => {
    const answer = await client().maxRedirects(5).get(`${origin}/hop/3`)

    expect<number>(answer.status).toBe(200)
    expect<string>(answer.body).toBe('landed')
  })

  /**
   * The limit hands back the last hop rather than throwing.
   *
   * A caller that set a limit is asking to see where the chain went; "too many
   * redirects" hides exactly that.
   */
  test('and stops at the limit, answering the redirect itself', async () => {
    const answer = await client().maxRedirects(1).get(`${origin}/hop/3`)

    /**
     * One *follow*, not one request.
     *
     * `/hop/3` answers 302 to `/hop/2` — that is the reply to what was asked for,
     * not a redirect that was followed. The single hop the limit allows then
     * fetches `/hop/2`, whose 302 points at `/hop/1`, and that is where it stops.
     * Asserting `/hop/2` here would have been asserting that nothing was followed.
     */
    expect<number>(answer.status).toBe(302)
    expect<string | null>(answer.header('location')).toBe('/hop/1')
  })

  test('a 303 becomes a GET, which is what that status means', async () => {
    const answer = await client().maxRedirects(2).post(`${origin}/see-other`, { a: 1 })

    expect<string>((answer.json() as { method: string }).method).toBe('GET')
  })
})

describe('withoutVerifying', () => {
  /**
   * Measured before the method existed: Bun's `fetch` refuses a self-signed
   * certificate and accepts it with `tls: { rejectUnauthorized: false }`. This
   * asserts the option reaches that place, over TLS this machine does not trust.
   *
   * Thirty seconds rather than the default five, and the extra is for one line:
   * `openssl req -newkey rsa:2048` generates a key, which is CPU-bound and pays
   * Windows' much larger process-spawn cost on top. The whole file runs in 241ms
   * on this machine and went over 5,000ms once on `windows-latest` — a rerun of
   * the same commit passed, so it is contention on a shared runner rather than
   * anything about the platform.
   *
   * A timeout here is not a slow test tolerated. It is the cascade being stopped:
   * when the deadline cut this test, the `finally` never ran, the TLS server kept
   * the certificate files open, and `afterAll`'s `rm` failed too — so one slow
   * keygen reported as two failures, neither of them about TLS verification.
   */
  test('accepts a certificate nothing trusts', async () => {
    const key =
      await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${scratch}/k.pem -out ${scratch}/c.pem -days 1 -subj /CN=localhost`
        .quiet()
        .nothrow()

    if (key.exitCode !== 0) {
      // No openssl on this machine: the assertion below cannot be made honestly.
      return
    }

    const secure = Bun.serve({
      port: 0,
      tls: { cert: Bun.file(`${scratch}/c.pem`), key: Bun.file(`${scratch}/k.pem`) },
      fetch: () => new Response('secured')
    })

    try {
      const refused = await client()
        .get(`https://localhost:${secure.port}/`)
        .then(() => 'accepted')
        .catch(() => 'refused')

      expect<string>(refused).toBe('refused')

      const answer = await client().withoutVerifying().get(`https://localhost:${secure.port}/`)

      expect<string>(answer.body).toBe('secured')
    } finally {
      secure.stop(true)
    }
  }, 30_000)
})

describe('the smaller ones', () => {
  test('withCookies sends a Cookie header', async () => {
    const answer = await client()
      .withCookies({ session: 'abc', theme: 'dark' })
      .get(`${origin}/echo`)

    expect<string>((answer.json() as { cookie: string }).cookie).toBe('session=abc; theme=dark')
  })

  test('asJson says so on the way out and the way back', async () => {
    const answer = await client().asJson().post(`${origin}/echo`)
    const body = answer.json() as { contentType: string; accept: string }

    expect<string>(body.contentType).toBe('application/json')
    expect<string>(body.accept).toBe('application/json')
  })

  test('replaceHeaders drops what was there rather than adding', async () => {
    const answer = await client()
      .withHeader('x-marker', 'first')
      .replaceHeaders({ 'x-marker': 'second' })
      .get(`${origin}/echo`)

    expect<string>((answer.json() as { marker: string }).marker).toBe('second')
  })

  test('beforeSending and afterResponse both run', async () => {
    const seen: string[] = []

    const answer = await client()
      .beforeSending((attempt) => seen.push(`before ${attempt.method}`))
      .afterResponse((response) => seen.push(`after ${response.status}`))
      .get(`${origin}/echo`)

    expect<number>(answer.status).toBe(200)
    expect<string[]>(seen).toEqual(['before GET', 'after 200'])
  })
})
