import type { ApplicationContract } from '@elvel/contracts'
import { enterRequestContext } from '@elvel/core'
import { currentScope } from '@elvel/http'
import { Elysia } from 'elysia'
import type { Batch, Recorder } from '../recorder.ts'
import type { RequestWatcher } from '../watchers/request.ts'

/** Does `path` match one of these glob patterns? Only a trailing `*` is honoured. */
export function pathMatches(path: string, patterns: string[]): boolean {
  const subject = path.replace(/^\/+/, '')

  return patterns.some((pattern) => {
    const glob = pattern.replace(/^\/+/, '')

    return glob.endsWith('*') ? subject.startsWith(glob.slice(0, -1)) : subject === glob
  })
}

export type LensPluginOptions = {
  onlyPaths: string[]
  ignorePaths: string[]
  /** Absent when the request watcher is switched off in config. */
  requestWatcher?: RequestWatcher
}

/**
 * Opens a batch when a request arrives and flushes it after the response.
 *
 * Telescope gets these two moments from Laravel: `Telescope::start()` runs while
 * the framework boots a request, and `$app->terminating()` stores the batch. In
 * Elvel neither exists in a usable form — `RequestLifecycle.finish()` is called
 * only from the error path, its own docstring saying it exists for "a response
 * with no handler" — so the moments come from a plugin on `app.router`, which is
 * a public `Elysia` instance.
 *
 * Two things about the hooks chosen here were both learned the hard way.
 *
 * `onRequest` and not `onBeforeHandle`: every per-request hook Elysia offers
 * except `onRequest` belongs to a *handler*, so an unmatched path — every 404,
 * which is exactly the request somebody opens the dashboard to understand — runs
 * none of them. The spike this package came from recorded zero requests for
 * precisely that reason.
 *
 * And the batch is kept against the `Request` as well as in its slot, because
 * `onAfterResponse` may run outside the execution context the handler ran in.
 * `deferPlugin` in `@elvel/http` keeps its queue in a `WeakMap` for the same
 * reason. The slot is what watchers read during the request; the map is what the
 * flush reads after it.
 */
export function lensPlugin(app: ApplicationContract, options: LensPluginOptions) {
  const batches = new WeakMap<Request, Batch>()
  const started = new WeakMap<Request, number>()

  return (
    new Elysia({ name: 'elvel:lens' })
      /**
       * Synchronous, and it must stay that way: `enterWith` applies to the rest of
       * the current execution, so an `await` before the batch is opened would put
       * it somewhere the handler cannot see.
       */
      .onRequest(({ request }: { request: Request }) => {
        /**
         * Open a context of this request's own before anything is put in it.
         *
         * `@elvel/http` does this too, from its own `onRequest`, and doing it
         * again is harmless — `enterRequestContext` carries the unmarked
         * context outside the request forward, so a session established by
         * `AuthManager.runWith` survives either way.
         *
         * Doing it *unconditionally* is the part that matters. `enterWith`
         * inside `app.handle()` lands in the caller's frame, so two requests
         * driven from one frame have the second see the first's context.
         * Measured: without this, two concurrent `handle()` calls shared one
         * batch, the first flush closed it, and the second request recorded
         * nothing — the failure `request-context.ts` describes finding in the
         * spike this package came from, arriving again by another route.
         *
         * It does mean Lens must be registered *after* the HTTP provider, since
         * a plugin entering a context after this one would discard the batch.
         * The flush checks rather than trusting.
         */
        enterRequestContext()

        const path = new URL(request.url).pathname

        if (options.onlyPaths.length > 0 && !pathMatches(path, options.onlyPaths)) return
        if (pathMatches(path, options.ignorePaths)) return

        const batch = app.make('lens').start()

        if (batch === undefined) return

        batches.set(request, batch)
        started.set(request, performance.now())
      })
      .onAfterResponse({ as: 'global' }, async (context) => {
        const { request } = context
        const batch = batches.get(request)

        if (batch === undefined) return

        batches.delete(request)

        const lens: Recorder = app.make('lens')

        /**
         * The slot should still hold the batch this request opened. When it does
         * not, something entered a context after `onRequest`, and everything
         * recorded since went somewhere nobody flushes — a registration order
         * problem, and one worth saying out loud rather than leaving as a gap in
         * the dashboard.
         */
        if (lens.batchId() !== batch.batchId) {
          app
            .make('exception.handler')
            .report(
              new Error(
                '[lens] A request context was opened after Lens opened its batch. Register LensServiceProvider after HttpServiceProvider.'
              )
            )
        }

        const begun = started.get(request)

        started.delete(request)

        /**
         * The request entry is recorded here rather than by a subscription,
         * because this is the only moment the answer is known — see
         * `RequestWatcher`. Recorded before the flush, so it lands in the same
         * batch as the queries it ran.
         */
        if (options.requestWatcher !== undefined) {
          const bag = context as {
            response?: unknown
            responseValue?: unknown
            route?: unknown
            body?: unknown
            set?: { status?: unknown; headers?: Record<string, string> }
          }

          /**
           * A handler that built its own `Response` is the only case where one
           * exists here, and the only case where `set.status` is stale.
           * Measured on Elysia 1.4.30: a handler answering 503 with its own
           * `Response` left `set.status` at 200, while an unmatched path had
           * both agree on 404.
           */
          const own = bag.response instanceof Response ? bag.response : undefined

          options.requestWatcher.record(lens, {
            request,
            status: own?.status ?? (typeof bag.set?.status === 'number' ? bag.set.status : 200),
            responseHeaders: own?.headers,
            responseValue: own === undefined ? bag.responseValue : undefined,
            location: bag.set?.headers?.location,
            route: typeof bag.route === 'string' ? bag.route : undefined,
            body: bag.body,
            duration: begun === undefined ? 0 : performance.now() - begun,
            ip: clientAddress(context),
            session: sessionData()
          })
        }

        await lens.store(app.make('lens.entries'), batch)
      })
  )
}

/** The client's address, when the server can say who it is. */
function clientAddress(context: unknown): string | undefined {
  const server = (
    context as { server?: { requestIP?(request: Request): { address?: string } | null } }
  ).server
  const request = (context as { request: Request }).request

  const address = server?.requestIP?.(request)?.address

  return address === undefined ? undefined : address.replace(/^::ffff:/, '')
}

/**
 * The session, if one was started for this request.
 *
 * Telescope records `$request->session()->all()`, so this does too. Read from
 * the request scope, which is empty on a path with no session — a static asset,
 * an API route — and then the field is simply absent rather than `{}`.
 */
function sessionData(): Record<string, unknown> | undefined {
  const session = currentScope()?.session

  if (session === undefined) return undefined

  try {
    return session.all() as Record<string, unknown>
  } catch {
    return undefined
  }
}
