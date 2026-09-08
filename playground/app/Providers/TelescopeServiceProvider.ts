import { gate } from '@elvel/auth'
import { ServiceProvider } from '@elvel/core'
import type { QueryExecuted } from '@elvel/database'
import { Elysia } from 'elysia'
import { Recorder, shapeOf, TABLE, trimSql } from '../Telescope/Recorder.ts'

declare module '@elvel/contracts' {
  interface ContainerBindings {
    telescope: Recorder
  }
}

/**
 * A spike: what a Telescope-shaped tool costs on this framework.
 *
 * The answer is "one wildcard listener and two hooks", and that is the finding —
 * ten of Telescope's watchers are already events the framework dispatches, so
 * there is nothing to instrument for them. What is written here is the recorder
 * and the classification, not the instrumentation.
 *
 * Deliberately **not** a package. A spike that has to be released is a spike
 * nobody dares change.
 */
export class TelescopeServiceProvider extends ServiceProvider {
  /**
   * Names whose suffix means "a model did something".
   *
   * Model events are dispatched as `<model_snake>.<lifecycle>`, built at runtime
   * from the class name — so there is no list of names to subscribe to, and the
   * wildcard is not a convenience here but the only way in.
   */
  /**
   * Payload keys that hold content rather than describe it.
   *
   * `cache.hit` and `cache.written` both carry `value`; a notification carries
   * its `notifiable`. Keeping the key and dropping the content is the difference
   * between "the cache was written" and "here is what was in it".
   */
  private static readonly CONTENT_KEYS = new Set([
    'value',
    'values',
    'body',
    'message',
    'payload',
    'token',
    'password',
    'secret',
    'notifiable',
    'user'
  ])

  private static readonly MODEL_EVENTS = new Set([
    'creating',
    'created',
    'updating',
    'updated',
    'deleting',
    'deleted',
    'saving',
    'saved',
    'restoring',
    'restored'
  ])

  register(): void {
    this.app.singleton('telescope', (app) => new Recorder(app))
  }

  override boot(): void {
    const telescope = this.app.make('telescope')

    this.watchQueries(telescope)
    this.watchEverythingElse(telescope)
    this.watchRequests(telescope)

    /**
     * Who may read it — closed by default, on purpose.
     *
     * The first version was `allowGuests: true` when `app.env === 'local'`, and
     * the security review was right to object: `HOST=` empty binds **every
     * interface**, so "local" means anybody on the network could read every
     * query, cached key and mail recipient the application had touched, with no
     * credential at all.
     *
     * So: a signed-in user, and never in production. An application wanting this
     * reachable in a shared environment must write a policy that says who —
     * which is the decision this refuses to make on its behalf.
     */
    gate().define(
      'viewTelescope',
      (user) => user !== null && this.app.config.get<string>('app.env') === 'local',
      { allowGuests: false }
    )
  }

  /**
   * Queries, through the sugar the framework already ships.
   *
   * The guard is the one thing a spike is for finding: recording a query is
   * itself a query, so without it the first `insert` dispatches `db.query`,
   * which records an entry, which... The table name is the check rather than a
   * flag, because the dispatch is fire-and-forget — `void dispatcher.dispatch(…)`
   * in `bun-sql.ts` — so a flag set around the write is not reliably still set
   * when the listener runs.
   */
  private watchQueries(telescope: Recorder): void {
    this.app.make('db').listen((query: QueryExecuted) => {
      if (query.sql.includes(TABLE)) return

      telescope.record('query', {
        sql: trimSql(query.sql),
        // Shapes, not values: these are the query's parameters, and on a sign-in
        // that is the email and the password hash.
        bindings: query.bindings.map(shapeOf),
        milliseconds: query.time,
        connection: query.connectionName
      })
    })
  }

  /**
   * Ten watchers, one listener.
   *
   * `'*'` compiles to `.*` and the match is cached per resolved name, and a
   * wildcard listener is handed the event's **name** as well as its payload —
   * which is what makes classification possible from outside.
   */
  private watchEverythingElse(telescope: Recorder): void {
    const events = this.app.make('events') as unknown as {
      listen(pattern: string, listener: (name: string, payload: unknown) => unknown): void
    }

    events.listen('*', (name, payload) => {
      // `db.query` has a watcher of its own, and it is the one with the guard
      // that keeps the recorder from recording itself. Catching it here as well
      // both double-counted every query and hung the boot.
      if (name === 'db.query') return
      if (name.startsWith('telescope.')) return

      telescope.record(TelescopeServiceProvider.classify(name), {
        event: name,
        payload: TelescopeServiceProvider.summarise(payload)
      })
    })
  }

  /**
   * The request itself, and the flush — on two hooks, because one is not enough.
   *
   * `onAfterResponse` is the normal path: it runs once the response is out, so
   * the write is off the path the caller waits on.
   *
   * `RequestLifecycle.finishing` covers the other one. It is **not** a
   * "every response" hook, which is what the first version of this assumed and
   * got zero request entries for: `application.ts:376` calls it only from
   * `onError`, as the substitute for the `onAfterHandle` that an unmatched or
   * throwing request never had. So it is where a 404 or a 500 gets recorded, and
   * `onAfterResponse` is where everything else does.
   */
  private watchRequests(telescope: Recorder): void {
    const complete = async (request: Request, status: number): Promise<void> => {
      const url = new URL(request.url)

      await telescope.complete({
        method: request.method,
        path: url.pathname,
        /**
         * The parameter **names**, not their values.
         *
         * `?token=…`, `?signature=…` and `?api_key=…` are all query strings, and
         * storing one verbatim puts a working credential in a table built to be
         * read later. Which keys were present is what a request entry is for.
         */
        queryKeys: [...url.searchParams.keys()],
        status
      })
    }

    this.use(
      new Elysia({ name: 'telescope:requests' }).onAfterResponse(
        { as: 'global' },
        async ({ request, set }) => {
          await complete(request, Number(set.status ?? 200))
        }
      )
    )

    this.app.make('request.lifecycle').finishing(async (request, response) => {
      await complete(request, response.status)
    })
  }

  /** What kind of thing this event is, from its name alone. */
  private static classify(name: string): string {
    const [head, ...rest] = name.split('.')
    const tail = rest.at(-1) ?? ''

    if (TelescopeServiceProvider.MODEL_EVENTS.has(tail)) return 'model'
    if (head === 'queue') return 'job'

    return head === undefined || head === '' ? 'event' : head
  }

  /**
   * A payload small enough to store, and safe to.
   *
   * A model event carries the whole model; a mail event carries the message. Both
   * would be stored in full by an eager version of this, which is how a debugging
   * tool becomes the thing that fills the disk — and how a password hash ends up
   * in a table somebody reads over a shoulder.
   */
  private static summarise(payload: unknown): Record<string, unknown> {
    if (payload === null || typeof payload !== 'object') return { value: shapeOf(payload) }

    const summary: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value === 'function') continue

      // A key naming the thing itself is the payload's content, not its
      // description — `cache.written` carries `value`, and a mail event carries
      // the message. Those are kept as shapes.
      summary[key] = TelescopeServiceProvider.CONTENT_KEYS.has(key) ? shapeOf(value) : value
    }

    return summary
  }
}
