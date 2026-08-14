import { controller } from '@elysian/core'
import { ConnectionError, HttpResponse, http, RequestError } from '@elysian/http-client'

/**
 * Generated with `bun run playground make:controller HttpClientController`, then
 * extended.
 *
 * Outbound requests — the other half of the HTTP story. Every route here calls
 * *this same application* on a loopback address, so the exercise needs no third
 * party and no network: `/check/client/*` fetches `/check/client/upstream/*`,
 * which is served a few lines down.
 *
 * The one that matters is `/check/client/retry`. The upstream fails twice and
 * then succeeds, and the client is told to try three times — which is the whole
 * reason to have a client rather than call `fetch` and hope.
 */
export default controller('http-client')
  // ------------------------------------------------------------- the upstream

  .get('/check/client/upstream/ok', () => ({ hello: 'world' }))

  .get('/check/client/upstream/slow', async () => {
    await Bun.sleep(3000)

    return { late: true }
  })

  .get('/check/client/upstream/status', ({ query, status }) =>
    status(Number(query.code ?? 500), { refused: true })
  )

  /**
   * Fails twice per client, then succeeds.
   *
   * Keyed by a run id the caller supplies rather than a module counter, so two
   * exercises in flight do not consume each other's failures.
   */
  .get('/check/client/upstream/flaky', ({ query, status }) => {
    const run = String(query.run ?? 'default')
    const seen = (attempts.get(run) ?? 0) + 1
    attempts.set(run, seen)

    return seen < 3 ? status(503, { busy: true, attempt: seen }) : { attempts: seen }
  })

  // --------------------------------------------------------------- the client

  .get('/check/client/get', async ({ request }) => {
    const response = await http().acceptJson().get(upstream(request, '/ok'))

    return {
      status: response.status,
      ok: response.ok(),
      body: response.json(),
      contentType: response.header('content-type')
    }
  })

  /** A failure is a result until something asks it to throw. */
  .get('/check/client/failure', async ({ request }) => {
    const response = await http().get(upstream(request, '/status?code=422'))

    let thrown: string | null = null
    try {
      response.throw()
    } catch (error) {
      // The message carries the body, so a log line is enough to debug from.
      thrown = error instanceof RequestError ? (error.message.split('\n')[0] ?? null) : null
    }

    return {
      failed: response.failed(),
      clientError: response.clientError(),
      unprocessable: response.unprocessable(),
      thrown
    }
  })

  /** Two failures, then success — and the count proves it repeated. */
  .get('/check/client/retry', async ({ query, request }) => {
    const run = String(query.run ?? Date.now())
    const response = await http()
      .retry(4, 20)
      .get(upstream(request, `/flaky?run=${encodeURIComponent(run)}`))

    return { ok: response.ok(), body: response.json() }
  })

  /** The same upstream, given too few attempts. */
  .get('/check/client/retry-exhausted', async ({ query, request }) => {
    const run = String(query.run ?? Date.now())

    try {
      await http()
        .retry(2, 10)
        .get(upstream(request, `/flaky?run=${encodeURIComponent(run)}`))

      return { threw: false }
    } catch (error) {
      return { threw: true, status: error instanceof RequestError ? error.status : null }
    }
  })

  /** A timeout cancels rather than waiting for a slow upstream. */
  .get('/check/client/timeout', async ({ request }) => {
    const started = Date.now()

    try {
      await http().timeout(200).get(upstream(request, '/slow'))

      return { timedOut: false, elapsed: Date.now() - started }
    } catch (error) {
      return {
        timedOut: error instanceof ConnectionError,
        // Far below the upstream's three seconds, which is the point.
        elapsed: Date.now() - started
      }
    }
  })

  /** Several at once, keyed as declared and with failures reported in place. */
  .get('/check/client/pool', async ({ request }) => {
    const results = await http().pool({
      first: (client) => client.get(upstream(request, '/ok')),
      second: (client) => client.get(upstream(request, '/status?code=404')),
      broken: (client) => client.timeout(500).get('http://127.0.0.1:1/nothing')
    })

    return Object.fromEntries(
      Object.entries(results).map(([key, result]) => [
        key,
        result instanceof HttpResponse ? result.status : (result as Error).constructor.name
      ])
    )
  })

  /**
   * The fake, which is why a test of code that calls an API need not call it.
   *
   * Exercised over HTTP so the recording and the assertions are proven in a real
   * request rather than only in a unit test.
   */
  .get('/check/client/fake', async () => {
    const client = http()

    client.fake({ 'https://api.example.test/*': { body: { faked: true } } }).preventStrayRequests()

    try {
      const response = await client.get('https://api.example.test/users')

      let strayRefused = false
      try {
        await client.get('https://somewhere.else.test/x')
      } catch {
        strayRefused = true
      }

      client.assertSent('https://api.example.test/users').assertSentCount(1)

      return { body: response.json(), strayRefused, recorded: client.recorded().length }
    } finally {
      // Left faking would make every later request in this process a stub.
      client.stopFaking()
    }
  })

/** Attempts per run id, for the flaky upstream. */
const attempts = new Map<string, number>()

/**
 * The application's own address, taken from the request that arrived.
 *
 * Not from `PORT` or `app.url`: the smoke run binds an ephemeral port and sets
 * neither, so a guessed origin sent every exercise to a closed socket and every
 * check reported a connection failure. The request knows where it came in.
 */
function upstream(request: Request, path: string): string {
  return `${new URL(request.url).origin}/check/client/upstream${path}`
}
