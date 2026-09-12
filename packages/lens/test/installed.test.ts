import { describe, expect, test } from 'bun:test'
import { Application, enterWorkContext } from '@elvel/core'
import { ConnectionManager } from '@elvel/database'
import { JsxViewFactory } from '@elvel/view'
import { Elysia } from 'elysia'
import { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { lensDashboard } from '../src/http/dashboard.ts'
import { notInstalledError, tableIsMissing } from '../src/installed.ts'
import { Recorder } from '../src/recorder.ts'
import { DatabaseEntriesRepository } from '../src/storage/database-repository.ts'

/** Every driver phrases it differently, which is why this matches on message. */
describe('tableIsMissing', () => {
  test('recognises what each driver says', () => {
    expect(tableIsMissing(new Error('no such table: lens_entries'))).toBe(true)
    expect(tableIsMissing(new Error('relation "lens_entries" does not exist'))).toBe(true)
    expect(tableIsMissing(new Error("Table 'app.lens_entries' doesn't exist"))).toBe(true)
    expect(tableIsMissing(new Error('ER_NO_SUCH_TABLE'))).toBe(true)
  })

  test('and does not claim every failure', () => {
    expect(tableIsMissing(new Error('connection refused'))).toBe(false)
    expect(tableIsMissing(new Error('UNIQUE constraint failed'))).toBe(false)
  })
})

describe('the instruction', () => {
  /**
   * A stack is where a failure came from; this one came from a migration nobody
   * ran. Every frame points at the recorder, which is not the subject.
   */
  test('carries no trace, because the trace points at the wrong thing', () => {
    const error = notInstalledError()

    expect(error.stack?.split('\n')).toHaveLength(1)
    expect(error.message).toContain('elvel lens:table && elvel migrate')
  })
})

/** A repository whose tables were never created. */
async function bare() {
  const app = new Application(process.cwd())

  app.config.set('database.default', 'lens-bare')
  app.config.set('database.connections.lens-bare', { driver: 'sqlite', database: ':memory:' })

  const db = new ConnectionManager(app)

  return { app, entries: new DatabaseEntriesRepository(db, { table: 'lens_entries' }) }
}

describe('a recorder with no tables', () => {
  /**
   * The application must not notice. The whole point of a recorder is that it
   * is watching, not participating.
   */
  test('does not throw into the work it was watching', async () => {
    const { entries } = await bare()
    const lens = new Recorder(() => {})

    lens.enable(true)
    enterWorkContext()
    lens.start()
    lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))

    expect(lens.store(entries)).resolves.toBeUndefined()
  })

  /**
   * And it says so once. Reported every request, the instruction buries the log
   * it was meant to be read in — measured on the playground before this existed.
   */
  test('gives the instruction once, not once per flush', async () => {
    const { entries } = await bare()
    const said: string[] = []
    const lens = new Recorder((error) => said.push((error as Error).message))

    lens.enable(true)

    for (let flush = 0; flush < 5; flush++) {
      enterWorkContext()
      lens.start()
      lens.record(EntryType.QUERY, IncomingEntry.make({ sql: 'select 1' }))
      await lens.store(entries)
    }

    expect(said.filter((message) => message.includes('lens:table'))).toHaveLength(1)
  })
})

describe('the dashboard with no tables', () => {
  test('explains rather than answering a stack trace', async () => {
    const { app, entries } = await bare()
    const recorder = new Recorder()

    recorder.enable(true)
    recorder.auth(() => true)

    app.instance('lens', recorder)
    app.instance('lens.entries', entries)
    app.instance('view', new JsxViewFactory())

    const router = new Elysia().use(
      lensDashboard(app, { path: 'lens', enabled: true, watchers: {} as never })
    )

    const response = await router.handle(new Request('http://localhost/lens/request'))
    const body = await response.text()

    expect(response.status).toBe(503)
    expect(body).toContain('not installed yet')
    expect(body).toContain('elvel lens:table')
    expect(body).not.toContain('no such table')
  })

  /**
   * A refusal nobody can act on reads as a bug, so it names the file with the
   * answer in it.
   */
  test('a closed gate says whose decision it was', async () => {
    const { app, entries } = await bare()
    const recorder = new Recorder()

    recorder.enable(true)

    app.instance('lens', recorder)
    app.instance('lens.entries', entries)
    app.instance('view', new JsxViewFactory())

    const router = new Elysia().use(
      lensDashboard(app, { path: 'lens', enabled: true, watchers: {} as never })
    )

    const response = await router.handle(new Request('http://localhost/lens/request'))
    const body = await response.text()

    expect(response.status).toBe(403)
    expect(body).toContain('LensServiceProvider.ts')
    expect(body).toContain('authorise()')
  })
})
