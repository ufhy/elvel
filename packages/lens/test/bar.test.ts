import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { Elysia } from 'elysia'
import { BAR_SCRIPT, BAR_STYLE } from '../src/bar/asset.ts'
import { Baselines } from '../src/bar/baseline.ts'
import { barAllows, barState } from '../src/bar/enabled.ts'
import { RequestProfiler } from '../src/bar/profiler.ts'
import { type BarEntry, BatchRing, snapshot } from '../src/bar/ring.ts'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { EntryUpdate } from '../src/entry-update.ts'
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
    .use(
      lensBar(app, {
        state,
        ring,
        path: 'lens',
        editor: '',
        root: '/app',
        stored: false,
        baselines: new Baselines(),
        profiler: new RequestProfiler(),
        watchers: {}
      })
    )
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
      .use(
        lensBar(app, {
          state: barState(app),
          ring,
          path: 'lens',
          editor: '',
          root: '',
          stored: false,
          baselines: new Baselines(),
          profiler: new RequestProfiler(),
          watchers: {}
        })
      )
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

  test('the list is its own endpoint, newest first', async () => {
    const { router, recorder } = harness()

    await router.handle(new Request('http://localhost/page'))
    await router.handle(new Request('http://localhost/json'))
    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 3)

    const answer = await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    const payload = (await answer.json()) as {
      cursor: number
      crossProcess: boolean
      batches: Array<{ path: string; seq: number }>
    }

    expect(payload.batches.map((item) => item.path)).toEqual(['/page', '/json', '/page'])
    expect(payload.cursor).toBe(3)
    expect(payload.crossProcess).toBe(false)
  })

  /**
   * The whole point of the cursor: a live bar asks repeatedly and must be told
   * only what it has not seen, or it redraws the world every second.
   */
  test('since returns only what is newer', async () => {
    const { router, recorder } = harness()

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    const first = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as { cursor: number }

    await router.handle(new Request('http://localhost/json'))
    await drained(recorder, 2)

    const next = (await (
      await router.handle(new Request(`http://localhost/lens-api/bar?since=${first.cursor}`))
    ).json()) as { batches: Array<{ path: string }> }

    expect(next.batches.map((item) => item.path)).toEqual(['/json'])
  })

  /**
   * A page with a 64 KB response used to cost the bar 64 KB before anybody had
   * clicked anything. The list carries the one-line form and nothing else.
   */
  test('a batch carries summaries, never content', async () => {
    const { router, recorder } = harness()
    const page = await (await router.handle(new Request('http://localhost/page'))).text()
    const id = /data-batch="([^"]+)"/.exec(page)?.[1]

    await drained(recorder, 1)

    const payload = (await (
      await router.handle(new Request(`http://localhost/lens-api/bar/${id}`))
    ).json()) as { batch: { entries: Array<Record<string, unknown>> } }

    for (const entry of payload.batch.entries) {
      expect(entry).not.toHaveProperty('content')
      expect(entry.summary).toBeDefined()
    }
  })

  test('one entry answers with the panels the dashboard would draw', async () => {
    const { router, recorder } = harness()
    const page = await (await router.handle(new Request('http://localhost/page'))).text()
    const id = /data-batch="([^"]+)"/.exec(page)?.[1]

    await drained(recorder, 1)

    const batch = (await (
      await router.handle(new Request(`http://localhost/lens-api/bar/${id}`))
    ).json()) as { batch: { entries: Array<{ uuid: string; type: string }> } }

    const request = batch.batch.entries.find((entry) => entry.type === 'request')

    expect(request).toBeDefined()

    const answer = await router.handle(
      new Request(`http://localhost/lens-api/bar/entry/${request?.uuid}`)
    )
    const detail = (await answer.json()) as { panels: Array<{ kind: string }> }

    expect(answer.status).toBe(200)
    expect(detail.panels.some((panel) => panel.kind === 'facts')).toBe(true)
  })

  test('an entry the ring no longer holds is a 404', async () => {
    const { router } = harness()
    const answer = await router.handle(
      new Request('http://localhost/lens-api/bar/entry/00000000-0000-0000-0000-000000000000')
    )

    expect(answer.status).toBe(404)
  })

  test('the gate refuses all three endpoints', async () => {
    const { router } = harness({ debug: false, enabled: true, gate: false })

    for (const path of ['/lens-api/bar?since=0', '/lens-api/bar/x', '/lens-api/bar/entry/x']) {
      expect((await router.handle(new Request(`http://localhost${path}`))).status).toBe(403)
    }
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
        entries: [],
        marks: [],
        kind: 'page' as const
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
      ]),
      marks: [],
      kind: 'page'
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

  /**
   * Three rules the client has to keep, asserted against its source.
   *
   * The script runs in a browser and nothing here provides one, so these read
   * the decision rather than drive it — which is weaker than a click, and still
   * enough to stop each one being undone by an edit that looks harmless. All
   * three were found by driving the bar by hand.
   */
  describe('the rules the panel keeps', () => {
    test('a repeat click on the open view does not close the panel', () => {
      expect(BAR_SCRIPT).toContain('view = next === null ? null : next')
      expect(BAR_SCRIPT).not.toContain('view === next ? null : next')
    })

    test('following a new request is held while an entry is open', () => {
      expect(BAR_SCRIPT).toContain("kept.get('follow', '1') === '1' && entry === null")
    })

    test('the profiler flag is written only after the server agrees', () => {
      const armed = BAR_SCRIPT.indexOf("kept.set('reopen', 'profile')")
      const refused = BAR_SCRIPT.indexOf("button.textContent = 'The profiler refused'")

      expect(armed).toBeGreaterThan(refused)
    })
  })

  test('the stylesheet is scoped to the shadow host', () => {
    expect(BAR_STYLE).toContain(':host')
    expect(BAR_SCRIPT).toContain('attachShadow')
  })

  /**
   * The script ships inside a template literal. One backtick anywhere in it ends
   * that literal in the middle of a function, and the error lands on whatever
   * line happens to follow — which is how an afternoon goes. Hence
   * `event.code === 'Backquote'` for the shortcut rather than comparing a key.
   */
  test('no backtick can close the literal either string ships in', () => {
    expect(BAR_SCRIPT).not.toContain('`')
    // The stylesheet too: a backtick in a CSS comment ends the literal just as
    // surely, and the error lands on the next line of JavaScript.
    expect(BAR_STYLE).not.toContain('`')
    expect(BAR_SCRIPT).toContain('Backquote')
  })

  /**
   * Without wrapping these the bar is a snapshot of page load: every call the
   * page makes afterwards is recorded on the server and invisible until reload.
   */
  test('the client watches the page own requests', () => {
    expect(BAR_SCRIPT).toContain('window.fetch =')
    expect(BAR_SCRIPT).toContain('XMLHttpRequest.prototype.send')
  })

  /**
   * `localStorage` throws outright in a private window with site data blocked,
   * and the bar is running inside somebody else's page.
   */
  test('nothing touches storage outside a try', () => {
    // Accesses, not mentions: a comment naming localStorage is not a read.
    const reads = BAR_SCRIPT.split('localStorage.getItem').length - 1
    const writes = BAR_SCRIPT.split('localStorage.setItem').length - 1
    const guarded = BAR_SCRIPT.slice(
      BAR_SCRIPT.indexOf('const kept ='),
      BAR_SCRIPT.indexOf('const host =')
    )

    expect(reads).toBe(1)
    expect(writes).toBe(1)
    expect(guarded.split('localStorage.')).toHaveLength(3)
    expect(guarded.split('try {')).toHaveLength(3)
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

describe('the ring holds a bounded amount', () => {
  const batch = (id: string, entries: BarEntry[] = []) => ({
    batchId: id,
    at: 1,
    method: 'GET',
    path: `/${id}`,
    status: 200,
    durationMs: 1,
    entries,
    marks: [],
    kind: 'page' as const
  })

  test('a sequence is handed out per push and never reused', () => {
    const ring = new BatchRing(3)

    expect(ring.push(batch('a'))).toBe(1)
    expect(ring.push(batch('b'))).toBe(2)
    expect(ring.cursor()).toBe(2)
    expect(ring.since(1).map((held) => held.batchId)).toEqual(['b'])
    expect(ring.since(2)).toEqual([])
  })

  /**
   * A count is no bound when one batch can be a megabyte, which is what a
   * recorded response body plus a hundred rendered components comes to.
   */
  test('the byte budget evicts before the count does', () => {
    const fat = () =>
      snapshot([IncomingEntry.make({ response: 'x'.repeat(20_000) }).withType(EntryType.REQUEST)])

    const ring = new BatchRing(50, 30_000)

    ring.push(batch('a', fat()))
    ring.push(batch('b', fat()))
    ring.push(batch('c', fat()))

    expect(ring.size).toBe(1)
    expect(ring.get('c')).toBeDefined()
    expect(ring.get('a')).toBeUndefined()
  })

  /**
   * The last batch is never evicted for size. A page that records more than the
   * whole budget should still be inspectable — it is the most interesting page
   * there is.
   */
  test('one oversized batch is kept anyway', () => {
    const ring = new BatchRing(50, 100)

    ring.push(
      batch(
        'huge',
        snapshot([IncomingEntry.make({ response: 'x'.repeat(5_000) }).withType(EntryType.REQUEST)])
      )
    )

    expect(ring.size).toBe(1)
    expect(ring.bytes).toBeGreaterThan(100)
  })
})

describe('patches reach entries the ring is still holding', () => {
  test('a job that finishes after its batch was flushed stops reading pending', () => {
    const ring = new BatchRing(3)
    const job = IncomingEntry.make({ name: 'SendInvoice', status: 'processing' }).withType(
      EntryType.JOB
    )

    ring.push({
      batchId: 'a',
      at: 1,
      method: '',
      path: '',
      status: 0,
      durationMs: 0,
      entries: snapshot([job]),
      marks: [],
      kind: 'page'
    })

    expect(ring.entry(job.uuid)?.summary.sub).toBe('processing')

    ring.apply([new EntryUpdate(job.uuid, EntryType.JOB).change({ status: 'failed' })])

    expect(ring.entry(job.uuid)?.content.status).toBe('failed')
    expect(ring.entry(job.uuid)?.summary.sub).toBe('failed')
  })

  test('a patch for an entry the ring never saw is ignored, not an error', () => {
    const ring = new BatchRing(3)

    expect(() =>
      ring.apply([new EntryUpdate('nobody', EntryType.JOB).change({ status: 'failed' })])
    ).not.toThrow()
  })
})

describe('work from other processes', () => {
  /**
   * A queue worker is a separate process with a ring of its own that nothing
   * serves. The database is the only thing both can see, so the list is the
   * union — and the ring wins where both know a batch, because only the ring has
   * the entries.
   */
  function withStorage(batches: Array<{ batchId: string; types: Record<string, number> }>) {
    const app = new Application(process.cwd())

    app.config.set('app.debug', true)

    const recorder = new Recorder()

    recorder.enable(true)

    app.instance('lens', recorder)
    app.instance('exception.handler', { report() {} } as never)
    app.instance('lens.entries', {
      async recentBatches() {
        return batches.map((batch) => ({
          ...batch,
          at: 1,
          count: Object.values(batch.types).reduce((sum, n) => sum + n, 0)
        }))
      }
    } as never)

    const ring = new BatchRing(5)

    const router = new Elysia()
      .use(
        lensPlugin(app, {
          onlyPaths: [],
          ignorePaths: ['lens-api*'],
          requestWatcher: new RequestWatcher({ sizeLimit: 64 }),
          ring
        })
      )
      .use(
        lensBar(app, {
          state: barState(app),
          ring,
          path: 'lens',
          editor: '',
          root: '',
          stored: true,
          baselines: new Baselines(),
          profiler: new RequestProfiler(),
          watchers: {}
        })
      )
      .get('/page', () => '<html><body>hi</body></html>')

    return { router, ring, recorder }
  }

  test('a batch only storage knows about appears in the list', async () => {
    const { router, recorder } = withStorage([{ batchId: 'worker', types: { job: 1, query: 4 } }])

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    const payload = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as {
      crossProcess: boolean
      batches: Array<{ batchId: string; source: string; path: string; count: number }>
    }

    expect(payload.crossProcess).toBe(true)

    const worker = payload.batches.find((batch) => batch.batchId === 'worker')

    expect(worker).toMatchObject({ source: 'storage', count: 5 })
    expect(worker?.path).toContain('job')
  })

  /**
   * The cursor belongs to this process's ring, and storage has no counterpart.
   * Gating storage on `since === 0` meant a job flushed by the worker after the
   * page opened could never appear: the page asks with `since=0` once, at load,
   * and every poll after that carries the cursor.
   */
  test('and it still appears on a poll that carries a cursor', async () => {
    const { router, recorder } = withStorage([{ batchId: 'worker', types: { job: 1 } }])

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    const first = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as { cursor: number }

    const later = (await (
      await router.handle(new Request(`http://localhost/lens-api/bar?since=${first.cursor}`))
    ).json()) as { batches: Array<{ batchId: string }> }

    expect(later.batches.map((batch) => batch.batchId)).toContain('worker')
  })

  /**
   * Found by running it, not by a test. A stored batch that has a request entry
   * came from an HTTP process; when the ring no longer holds it, it is this
   * process's own history, and listing it under "elsewhere" was both noise and
   * untrue. Only work with no request of its own — a job, a scheduled task, a
   * command — is worth surfacing here.
   */
  test('an old request of our own is not passed off as another process', async () => {
    const { router, recorder } = withStorage([
      { batchId: 'old-page', types: { request: 1, query: 2 } },
      { batchId: 'worker', types: { job: 1 } }
    ])

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    const payload = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as { batches: Array<{ batchId: string }> }

    const ids = payload.batches.map((batch) => batch.batchId)

    expect(ids).toContain('worker')
    expect(ids).not.toContain('old-page')
  })

  test('a batch both know about is listed once, from the ring', async () => {
    const seen: string[] = []
    const { router, ring, recorder } = withStorage([])

    ring.push({
      batchId: 'shared',
      at: 1,
      method: 'GET',
      path: '/shared',
      status: 200,
      durationMs: 1,
      entries: [],
      marks: [],
      kind: 'page'
    })

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    const payload = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as { batches: Array<{ batchId: string; source: string }> }

    for (const batch of payload.batches) seen.push(batch.batchId)

    expect(seen.filter((id) => id === 'shared')).toHaveLength(1)
    expect(payload.batches.find((batch) => batch.batchId === 'shared')?.source).toBe('ring')
  })

  /**
   * A bar that took the page down because a table was missing would be worse
   * than a bar showing only what it has.
   */
  test('storage that throws costs the list nothing', async () => {
    const app = new Application(process.cwd())

    app.config.set('app.debug', true)

    const recorder = new Recorder()

    recorder.enable(true)
    app.instance('lens', recorder)
    app.instance('exception.handler', { report() {} } as never)
    app.instance('lens.entries', {
      async recentBatches() {
        throw new Error('no such table: lens_entries')
      }
    } as never)

    const ring = new BatchRing(5)
    const router = new Elysia().use(
      lensBar(app, {
        state: barState(app),
        ring,
        path: 'lens',
        editor: '',
        root: '',
        stored: true,
        baselines: new Baselines(),
        profiler: new RequestProfiler(),
        watchers: {}
      })
    )

    const answer = await router.handle(new Request('http://localhost/lens-api/bar?since=0'))

    expect(answer.status).toBe(200)
    expect(((await answer.json()) as { batches: unknown[] }).batches).toEqual([])
  })
})

describe('what counts as work worth listing', () => {
  /**
   * Every console command opens a batch, and for one the command watcher ignores
   * the only thing in it is `command.starting`. Found by running a worker and
   * watching ten of those crowd out the job batch.
   */
  test('a batch of nothing but events is not listed', async () => {
    const app = new Application(process.cwd())

    app.config.set('app.debug', true)

    const recorder = new Recorder()

    recorder.enable(true)
    app.instance('lens', recorder)
    app.instance('exception.handler', { report() {} } as never)
    app.instance('lens.entries', {
      async recentBatches() {
        return [
          { batchId: 'bookkeeping', at: 1, types: { event: 1 }, count: 1 },
          { batchId: 'real-work', at: 2, types: { event: 1, query: 4 }, count: 5 }
        ]
      }
    } as never)

    const router = new Elysia().use(
      lensBar(app, {
        state: barState(app),
        ring: new BatchRing(5),
        path: 'lens',
        editor: '',
        root: '',
        stored: true,
        baselines: new Baselines(),
        profiler: new RequestProfiler(),
        watchers: {}
      })
    )

    const payload = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as { batches: Array<{ batchId: string }> }

    expect(payload.batches.map((batch) => batch.batchId)).toEqual(['real-work'])
  })
})

describe('the request has stages, not just entries', () => {
  /**
   * Watchers record what the application did; nothing recorded what the
   * framework was doing between those moments, so time spent in neither the
   * database nor rendering was a number with no shape.
   */
  test('a served request carries its own boundaries', async () => {
    const { router, recorder, ring } = harness()

    await router.handle(new Request('http://localhost/page'))
    await drained(recorder, 1)

    const first = ring.recent()[0]
    const marks = first === undefined ? [] : (ring.get(first.batchId)?.marks ?? [])

    expect(marks.map((at) => at.name)).toEqual(['middleware', 'handler', 'response'])

    for (const at of marks) expect(at.atMs).toBeGreaterThanOrEqual(0)

    // In order, and inside the request.
    expect(marks.map((at) => at.atMs)).toEqual(
      [...marks.map((at) => at.atMs)].sort((a, b) => a - b)
    )
  })

  /**
   * Elysia runs neither before- nor after-handle for a path it did not match, so
   * a 404 has fewer stages — which is itself the answer to why it was fast.
   */
  test('an unmatched path has fewer of them, and that is the answer', async () => {
    const { router, recorder, ring } = harness()

    await router.handle(new Request('http://localhost/nowhere'))
    await drained(recorder, 1)

    const first = ring.recent()[0]
    const marks = first === undefined ? [] : (ring.get(first.batchId)?.marks ?? [])

    expect(marks.map((at) => at.name)).not.toContain('handler')
  })
})

describe('a page carrying the bar is never cached', () => {
  /**
   * The bar is inlined in the markup, so a cached page is a cached tool: you
   * change the inspector, reload, and see the old build with nothing saying so.
   * Costly in production and free here — the bar only injects in development or
   * for one authorised person.
   */
  test('the response says no-store', async () => {
    const { app, ring } = harness()
    const router = new Elysia()
      .use(
        lensPlugin(app, {
          onlyPaths: [],
          ignorePaths: ['lens-api*'],
          requestWatcher: new RequestWatcher({ sizeLimit: 64 }),
          ring
        })
      )
      .use(
        lensBar(app, {
          state: barState(app),
          ring,
          path: 'lens',
          editor: '',
          root: '',
          stored: false,
          baselines: new Baselines(),
          profiler: new RequestProfiler(),
          watchers: {}
        })
      )
      .get(
        '/page',
        () =>
          new Response('<html><body>hi</body></html>', {
            headers: { 'content-type': 'text/html', 'cache-control': 'max-age=600' }
          })
      )

    const answer = await router.handle(new Request('http://localhost/page'))

    expect(await answer.text()).toContain('data-build=')
    expect(answer.headers.get('cache-control')).toBe('no-store')
  })

  /** The glance that settles which build a page is running. */
  test('the tag carries a build fingerprint', async () => {
    const { router } = harness()
    const body = await (await router.handle(new Request('http://localhost/page'))).text()
    const build = /data-build="([^"]+)"/.exec(body)?.[1]

    expect(build).toMatch(/^[0-9a-f]{6}$/)
  })
})

describe('a stale bar says so', () => {
  /**
   * The failure this closes: a page from the browser's cache carries an older
   * copy of the bar, everything looks fine, and nothing you change appears. The
   * client compares the build it was served with the one the server has.
   */
  test('the list endpoint reports the server build', async () => {
    const { router, recorder } = harness()
    const page = await (await router.handle(new Request('http://localhost/page'))).text()

    await drained(recorder, 1)

    const inPage = /data-build="([^"]+)"/.exec(page)?.[1]
    const payload = (await (
      await router.handle(new Request('http://localhost/lens-api/bar?since=0'))
    ).json()) as { build: string }

    expect(payload.build).toMatch(/^[0-9a-f]{6}$/)
    expect(inPage).toBe(payload.build)
  })

  test('the client only warns when the two differ', () => {
    expect(BAR_SCRIPT).toContain('payload.build !== mine')
    expect(BAR_SCRIPT).toContain('Stale')
  })
})

describe('the timeline says the same thing on every lane', () => {
  /**
   * Made twice: a description appended only when a kind happened once, so some
   * lanes carried a sentence and others a count. Removed, then carried back in
   * when the client was rewritten from the older copy. A test, because a comment
   * did not survive a rewrite.
   */
  test('no lane carries a description', () => {
    expect(BAR_SCRIPT).not.toContain("node('span', 'what'")
  })

  /**
   * The per-entry view is the type's own tab, reached by clicking a lane. A
   * toggle between a summary and a list already available elsewhere was a second
   * way to see one thing.
   */
  test('there is no toggle between folded and unfolded', () => {
    expect(BAR_SCRIPT).not.toContain('condensed')
    expect(BAR_SCRIPT).not.toContain('Every entry')
  })

  /**
   * The timeline header used to navigate to the route costs, and once there the
   * way back was to hunt for the Timeline tab. Headers describe; tabs navigate.
   */
  test('the timeline header navigates nowhere', () => {
    const start = BAR_SCRIPT.indexOf('function drawTimeline')
    // The header only. A lane below it does navigate, to that kind's own tab.
    const header = BAR_SCRIPT.slice(start, BAR_SCRIPT.indexOf('middle.appendChild(head)', start))

    expect(header).not.toContain('show(')
    expect(header).not.toContain("node('button'")
    expect(header).toContain('median ')
  })
})

describe('the bar can get out of the way', () => {
  /**
   * php-debugbar has three states — open, minimised, closed — and the third is
   * the one that matters: closing only the panel leaves a strip of somebody
   * else's application occupied by a dev tool.
   */
  test('minimise and close are different controls', () => {
    expect(BAR_SCRIPT).toContain('function closeBar')
    expect(BAR_SCRIPT).toContain('function openBar')
    expect(BAR_SCRIPT).toContain("kept.set('open', '0')")
    // Closed leaves a handle rather than nothing to click.
    expect(BAR_SCRIPT).toContain("node('button', 'handle'")
  })

  test('closed survives a reload', () => {
    expect(BAR_SCRIPT).toContain("kept.get('open', '1') === '0'")
  })
})

describe('the panel keeps its own state straight', () => {
  /**
   * A filter typed on the query list made the cache list read "Nothing matches"
   * with two entries in it.
   */
  test('a filter does not follow you to another kind', () => {
    const show = BAR_SCRIPT.slice(BAR_SCRIPT.indexOf('function show(next)'))

    expect(show.slice(0, 200)).toContain("find = ''")
  })

  /** The queue and the scheduler are invisible without storage; say so. */
  test('the blind spot is named in the menu', () => {
    expect(BAR_SCRIPT).toContain('Queue and scheduler run in other processes')
    expect(BAR_SCRIPT).toContain('if (!crossProcess)')
  })
})

/**
 * The cURL builder, evaluated out of the script that ships.
 *
 * Not a copy of the logic: the two functions are sliced from `BAR_SCRIPT` and
 * run, so a change to the shipped string is a change to what is asserted here.
 * They are pure apart from `location.origin`, which is passed in.
 */
describe('copying a request as cURL', () => {
  const build = (content: Record<string, unknown>, origin = 'http://localhost:3000') => {
    const from = BAR_SCRIPT.indexOf('function shellQuote')
    const to = BAR_SCRIPT.indexOf('function drawDetail')

    expect(from).toBeGreaterThan(-1)
    expect(to).toBeGreaterThan(from)

    const source = BAR_SCRIPT.slice(from, to)
    const make = new Function('location', 'content', source + '\nreturn curlFor(content)')

    return make({ origin }, content) as string
  }

  test('method, absolute URL and headers', () => {
    const command = build({
      method: 'GET',
      uri: '/articles?page=2',
      headers: { accept: 'text/html', 'x-trace': 'abc' }
    })

    expect(command).toContain("curl -i -X GET 'http://localhost:3000/articles?page=2'")
    expect(command).toContain("-H 'accept: text/html'")
    expect(command).toContain("-H 'x-trace: abc'")
  })

  /** The query is already in the URL; sending it again is a different request. */
  test('a GET carries no body', () => {
    const command = build({ method: 'GET', uri: '/articles?page=2', payload: { page: '2' } })

    expect(command).not.toContain('--data')
  })

  test('a POST sends its payload as JSON, and says so', () => {
    const command = build({
      method: 'POST',
      uri: '/articles',
      headers: {},
      payload: { title: 'Hi' }
    })

    expect(command).toContain('--data \'{"title":"Hi"}\'')
    expect(command).toContain("-H 'content-type: application/json'")
  })

  test('and does not add a content type the request already had', () => {
    const command = build({
      method: 'POST',
      uri: '/x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1'
    })

    expect(command).toContain("--data 'a=1'")
    expect(command.match(/content-type/g)).toHaveLength(1)
  })

  /**
   * A hidden header keeps its mask rather than being dropped: the command then
   * carries a visible blank to fill in, instead of quietly being a different
   * request from the one recorded.
   */
  test('a masked header stays masked, visibly', () => {
    const command = build({ method: 'GET', uri: '/', headers: { cookie: '********' } })

    expect(command).toContain("-H 'cookie: ********'")
  })

  test("a quote in a value cannot end the shell's quoting", () => {
    const command = build({ method: 'GET', uri: "/search?q=it's", headers: {} })

    // The apostrophe closes the quoting, escapes itself, and reopens it.
    expect(command).toContain("it'\\''s")
    expect(command.endsWith("'")).toBe(true)
  })
})
