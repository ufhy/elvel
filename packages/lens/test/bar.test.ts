import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { Elysia } from 'elysia'
import { BAR_SCRIPT, BAR_STYLE } from '../src/bar/asset.ts'
import { barAllows, barState } from '../src/bar/enabled.ts'
import { BatchRing, snapshot } from '../src/bar/ring.ts'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { lensBar } from '../src/http/bar.ts'
import { lensPlugin } from '../src/http/plugin.ts'
import { Recorder } from '../src/recorder.ts'
import { NullEntriesRepository } from '../src/storage/null-repository.ts'
import { RequestWatcher } from '../src/watchers/request.ts'

/**
 * A router with the bar mounted and nothing else — no tables, no driver.
 *
 * That absence is the point: `LENS_BAR=true` with no migration is a supported
 * installation, so the tests run in exactly that shape.
 */
function harness(options: { debug?: boolean; enabled?: boolean | null; gate?: boolean } = {}) {
  const app = new Application(process.cwd())

  app.config.set('app.debug', options.debug ?? true)
  app.config.set('lens.bar.enabled', options.enabled ?? null)

  const recorder = new Recorder()

  recorder.enable(true)
  recorder.auth(() => options.gate ?? false)

  app.instance('lens', recorder)
  app.instance('lens.entries', new NullEntriesRepository())
  app.instance('exception.handler', { report() {} } as never)

  const ring = new BatchRing(3)
  const state = barState(app)

  const router = new Elysia()
    .use(
      lensPlugin(app, {
        onlyPaths: [],
        ignorePaths: ['lens-api*'],
        requestWatcher: new RequestWatcher({ sizeLimit: 64 }),
        ring
      })
    )
    .use(lensBar(app, { state, ring, path: 'lens', editor: '', root: '/app' }))
    .get('/page', () => '<html><body><h1>hi</h1></body></html>')
    .get('/json', () => ({ ok: true }))
    .get('/fragment', () => '<p>no body tag</p>')

  return { app, router, ring, recorder, state }
}

/**
 * Wait for the flush, counted rather than slept through.
 *
 * `router.handle()` resolves when the response is ready; `onAfterResponse` — and
 * so the ring — runs after that. The recorder's own flush counter is the exact
 * signal, which is why this is not a sleep of a guessed length.
 */
async function drained(recorder: Recorder, count: number): Promise<void> {
  const deadline = Date.now() + 2000

  while (recorder.flushes() < count) {
    if (Date.now() > deadline) throw new Error(`only ${recorder.flushes()} of ${count} flushed`)

    await Bun.sleep(1)
  }
}

describe('when the bar runs', () => {
  test('unset follows APP_DEBUG, both ways', () => {
    const on = new Application(process.cwd())

    on.config.set('app.debug', true)

    const off = new Application(process.cwd())

    off.config.set('app.debug', false)

    expect(barState(on).on).toBe(true)
    expect(barState(off).on).toBe(false)
    expect(barState(off).reason).toContain('APP_DEBUG')
  })

  test('false wins over debug mode', () => {
    const app = new Application(process.cwd())

    app.config.set('app.debug', true)
    app.config.set('lens.bar.enabled', false)

    expect(barState(app).on).toBe(false)
  })

  /**
   * The Debugbar leak, and the one place this deliberately differs from it.
   * Forcing the bar on with debug off is allowed — staging is a real place —
   * but it stops being a page anybody can load.
   */
  test('forced on with debug off is gated by authorise()', async () => {
    const app = new Application(process.cwd())

    app.config.set('app.debug', false)
    app.config.set('lens.bar.enabled', true)

    const state = barState(app)

    expect(state).toMatchObject({ on: true, gated: true })

    const refuses = new Recorder()

    refuses.auth(() => false)

    const allows = new Recorder()

    allows.auth(() => true)

    const request = new Request('http://localhost/page')

    expect(await barAllows(state, refuses, request)).toBe(false)
    expect(await barAllows(state, allows, request)).toBe(true)
  })

  test('an ungated bar does not consult authorise(), which refuses by default', async () => {
    const app = new Application(process.cwd())

    app.config.set('app.debug', true)

    const closed = new Recorder()

    expect(await closed.check(new Request('http://localhost/'))).toBe(false)
    expect(await barAllows(barState(app), closed, new Request('http://localhost/'))).toBe(true)
  })
})

describe('injection', () => {
  test('a script tag goes into an HTML page, once', async () => {
    const { router } = harness()
    const body = await (await router.handle(new Request('http://localhost/page'))).text()

    expect(body.match(/data-batch="/g)).toHaveLength(1)
    expect(body).toContain('</body>')
    expect(body.indexOf('data-batch')).toBeLessThan(body.indexOf('</body>'))
  })

  test('nothing is injected into JSON or into a fragment with no body tag', async () => {
    const { router } = harness()

    const json = await (await router.handle(new Request('http://localhost/json'))).text()
    const fragment = await (await router.handle(new Request('http://localhost/fragment'))).text()

    expect(json).not.toContain('data-batch')
    expect(fragment).toBe('<p>no body tag</p>')
  })

  test('nothing is injected when the bar is off', async () => {
    const { router } = harness({ debug: false })
    const body = await (await router.handle(new Request('http://localhost/page'))).text()

    expect(body).not.toContain('data-batch')
  })

  /**
   * The gate has to hold on the *page*, not only on the endpoint. Injecting the
   * tag and letting the fetch 403 would still tell an anonymous visitor that
   * Lens is installed, and hand them a batch id.
   */
  test('a gated bar injects nothing when authorise() refuses', async () => {
    const refused = harness({ debug: false, enabled: true, gate: false })
    const allowed = harness({ debug: false, enabled: true, gate: true })

    const a = await (await refused.router.handle(new Request('http://localhost/page'))).text()
    const b = await (await allowed.router.handle(new Request('http://localhost/page'))).text()

    expect(a).not.toContain('data-batch')
    expect(b).toContain('data-batch')
  })

  /**
   * An HTML parser closes a script at the first `</script`, whatever the
   * JavaScript means. The page belongs to the application, so truncating it
   * would be this package breaking somebody else's site.
   */
  test('the payload cannot close its own script tag', async () => {
    const { router } = harness()
    const body = await (await router.handle(new Request('http://localhost/page'))).text()
    const script = body.slice(body.indexOf('<script '), body.indexOf('</script>'))

    expect(script).not.toContain('</')
    expect(body.match(/<\/script>/g)).toHaveLength(1)
  })

  test('the bar never injects into the dashboard or its own endpoint', async () => {
    const { app, ring } = harness()
    const router = new Elysia()
      .use(lensBar(app, { state: barState(app), ring, path: 'lens', editor: '', root: '' }))
      .get('/lens/requests', () => '<html><body>dashboard</body></html>')

    const body = await (await router.handle(new Request('http://localhost/lens/requests'))).text()

    expect(body).not.toContain('data-batch')
  })
})

describe('the endpoint', () => {
  test('answers with the batch the page carried', async () => {
    const { router, recorder } = harness()
    const page = await (await router.handle(new Request('http://localhost/page'))).text()
    const id = /data-batch="([^"]+)"/.exec(page)?.[1]

    expect(id).toBeString()

    await drained(recorder, 1)

    const answer = await router.handle(new Request(`http://localhost/lens-api/bar/${id}`))
    const payload = (await answer.json()) as { batch: { path: string; entries: unknown[] } }

    expect(answer.status).toBe(200)
    expect(payload.batch.path).toBe('/page')
    expect(payload.batch.entries.length).toBeGreaterThan(0)
  })

  /**
   * A 404 here is a race, not a mistake: the ring is filled after the response
   * has been sent. The client retries on exactly this status, so it must not be
   * a 500 and must not be a 200 with an empty batch.
   */
  test('a batch that has not arrived is a 404', async () => {
    const { router } = harness()
    const answer = await router.handle(
      new Request('http://localhost/lens-api/bar/00000000-0000-0000-0000-000000000000')
    )

    expect(answer.status).toBe(404)
  })

  test('a gated bar refuses the endpoint too', async () => {
    const { router } = harness({ debug: false, enabled: true, gate: false })
    const answer = await router.handle(new Request('http://localhost/lens-api/bar/anything'))

    expect(answer.status).toBe(403)
  })

  test('the bar reads its own requests back out of the ring, newest first', async () => {
    const { router, recorder } = harness()

    await router.handle(new Request('http://localhost/page'))
    await router.handle(new Request('http://localhost/json'))

    const page = await (await router.handle(new Request('http://localhost/page'))).text()
    const id = /data-batch="([^"]+)"/.exec(page)?.[1]

    await drained(recorder, 3)

    const answer = await router.handle(new Request(`http://localhost/lens-api/bar/${id}`))
    const payload = (await answer.json()) as { recent: Array<{ path: string }> }

    expect(payload.recent.map((item) => item.path)).toEqual(['/page', '/json', '/page'])
  })
})

describe('the ring', () => {
  test('drops the oldest rather than growing', () => {
    const ring = new BatchRing(2)

    for (const n of [1, 2, 3]) {
      ring.push({
        batchId: String(n),
        at: n,
        method: 'GET',
        path: `/${n}`,
        status: 200,
        durationMs: 1,
        entries: []
      })
    }

    expect(ring.size).toBe(2)
    expect(ring.get('1')).toBeUndefined()
    expect(ring.recent().map((item) => item.batchId)).toEqual(['3', '2'])
  })

  test('the list carries counts, not entries', () => {
    const ring = new BatchRing(2)

    ring.push({
      batchId: 'a',
      at: 1,
      method: 'GET',
      path: '/',
      status: 200,
      durationMs: 1,
      entries: snapshot([
        IncomingEntry.make({ sql: 'select 1' }).withType(EntryType.QUERY),
        IncomingEntry.make({ sql: 'select 2' }).withType(EntryType.QUERY)
      ])
    })

    const [first] = ring.recent()

    expect(first).toMatchObject({ count: 2 })
    expect(first).not.toHaveProperty('entries')
  })

  /**
   * Filled before the write, so a batch is on the bar even when storage failed.
   * That is the case the bar is most wanted in, and an `afterStoring` hook —
   * the first attempt — never runs for it.
   */
  test('a request is on the bar even when storage throws', async () => {
    const { app, ring, recorder } = harness()

    app.instance('lens.entries', {
      async store() {
        throw new Error('no such table: lens_entries')
      },
      async update() {
        return []
      },
      async monitoring() {
        return []
      }
    } as never)

    const router = new Elysia()
      .use(
        lensPlugin(app, {
          onlyPaths: [],
          ignorePaths: [],
          requestWatcher: new RequestWatcher({ sizeLimit: 64 }),
          ring
        })
      )
      .get('/page', () => '<html><body>hi</body></html>')

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    expect(ring.size).toBe(1)
  })
})

describe('the asset', () => {
  test('the injected script is valid JavaScript', () => {
    expect(() => new Function(BAR_SCRIPT)).not.toThrow()
  })

  /**
   * Everything recorded reaches the DOM through `textContent`. A single
   * `innerHTML` with an entry's content in it would make a recorded SQL string
   * or a request path into markup on the application's own page.
   */
  test('nothing in the client writes markup', () => {
    expect(BAR_SCRIPT).not.toContain('innerHTML')
    expect(BAR_SCRIPT).not.toContain('outerHTML')
    expect(BAR_SCRIPT).not.toContain('insertAdjacentHTML')
    expect(BAR_SCRIPT).not.toContain('document.write')
  })

  test('the stylesheet is scoped to the shadow host', () => {
    expect(BAR_STYLE).toContain(':host')
    expect(BAR_SCRIPT).toContain('attachShadow')
  })
})

describe('the N+1 badge', () => {
  /**
   * Counted on the server so it can be tested here rather than in a page. The
   * key is the recorder's own family hash — the SQL with its placeholders still
   * in it — which is exactly "is this the same query asked again".
   */
  test('identical statements are counted across the whole batch', () => {
    const query = (sql: string) =>
      IncomingEntry.make({ sql }).withType(EntryType.QUERY).withFamilyHash(sql)

    const counted = snapshot([
      query('select * from users where id = ?'),
      query('select * from articles'),
      query('select * from users where id = ?'),
      query('select * from users where id = ?')
    ])

    expect(counted.map((entry) => entry.repeats)).toEqual([3, 1, 3, 3])
  })

  test('separated repeats still count, which is the case worth warning about', () => {
    const query = (sql: string) =>
      IncomingEntry.make({ sql }).withType(EntryType.QUERY).withFamilyHash(sql)
    const view = IncomingEntry.make({ view: 'Row' }).withType(EntryType.VIEW)

    const counted = snapshot([query('select 1'), view, query('select 1')])

    expect(counted.map((entry) => entry.repeats)).toEqual([2, 1, 2])
  })

  test('an entry with no family hash is never a repeat', () => {
    const counted = snapshot([
      IncomingEntry.make({ view: 'Row' }).withType(EntryType.VIEW),
      IncomingEntry.make({ view: 'Row' }).withType(EntryType.VIEW)
    ])

    expect(counted.map((entry) => entry.repeats)).toEqual([1, 1])
  })
})
