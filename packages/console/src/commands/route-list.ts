import { existsSync } from 'node:fs'
import { join } from 'node:path'
import pc from 'picocolors'
import { Command } from '../command.ts'

const METHOD_COLORS: Record<string, (value: string) => string> = {
  GET: pc.blue,
  POST: pc.green,
  PUT: pc.yellow,
  PATCH: pc.yellow,
  DELETE: pc.red
}

/**
 * Where `middleware()` leaves the names it was given.
 *
 * Read through `Symbol.for` rather than imported, so this package keeps its four
 * dependencies: the console has no business depending on the HTTP package to
 * print a column. A global symbol is the contract between them.
 */
const MIDDLEWARE_NAMES = Symbol.for('elvel.middleware.names')

/**
 * The middleware guarding one route, in declaration order.
 *
 * Elysia wraps each hook as `{ fn }` and leaves the function's own properties
 * alone. That is not a public contract, so this is written to come back empty
 * rather than throw if the shape ever changes — an empty column is a smaller
 * problem than a `route:list` that cannot run.
 */
function middlewareOf(route: unknown): string[] {
  const hooks = (route as { hooks?: { beforeHandle?: unknown } }).hooks?.beforeHandle
  const list = Array.isArray(hooks) ? hooks : hooks === undefined ? [] : [hooks]

  return list.flatMap((entry) => {
    const fn = (entry as { fn?: unknown })?.fn ?? entry
    const names = (fn as Record<symbol, unknown> | undefined)?.[MIDDLEWARE_NAMES]

    return Array.isArray(names) ? (names as string[]) : []
  })
}

export class RouteListCommand extends Command {
  static override signature =
    'route:list {--method= : Filter by HTTP method} {--path= : Filter by path substring} {--middleware= : Only routes guarded by this middleware} {--assets : Include the static files under public/}'

  static override description = 'List all registered routes'

  handle(): number {
    const methodFilter = this.stringOption('method').toUpperCase()
    const pathFilter = this.stringOption('path')
    const middlewareFilter = this.stringOption('middleware')

    /**
     * A file in `public/` is a route, and listing it is noise.
     *
     * The static plugin is mounted with `alwaysStatic: true` so that a path with
     * no file falls through to the router — which means it registers one route per
     * file that exists, and they all land in Elysia's table. Measured on a
     * scaffolded application: `route:list` printed seven rows for two routes,
     * five of them `favicon.svg`, `robots.txt` and the build output.
     *
     * Decided by asking the filesystem rather than by matching path prefixes: the
     * build directory is configurable and `public/` can hold anything, so a
     * prefix list would be wrong in both directions. `--assets` prints them.
     */
    const publicPath = this.app.config.get<string>('view.publicPath', this.app.publicPath())
    const servesFile = (route: { path: string }) =>
      route.path !== '/' &&
      !route.path.includes(':') &&
      !route.path.includes('*') &&
      existsSync(join(publicPath, decodeURIComponent(route.path)))

    // Elysia exposes its compiled route table directly — no registry of our own.
    const routes = this.app.router.routes
      .filter((route) => this.flag('assets') || !servesFile(route))
      .filter((route) => methodFilter === '' || route.method.toUpperCase() === methodFilter)
      .filter((route) => pathFilter === '' || route.path.includes(pathFilter))
      .filter(
        (route) =>
          middlewareFilter === '' ||
          // Matched on the bare name, so `--middleware=throttle` finds
          // `throttle:6,1` as well.
          middlewareOf(route).some(
            (name) => name === middlewareFilter || name.startsWith(`${middlewareFilter}:`)
          )
      )
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.method.localeCompare(right.method)
      )

    if (routes.length === 0) {
      this.warn('No routes matched.')
      return 0
    }

    const guarded = routes.map((route) => middlewareOf(route))
    // The column is dropped entirely when nothing is guarded, rather than printed
    // empty for every row.
    const anyMiddleware = guarded.some((names) => names.length > 0)

    /**
     * The route's name, which is what `route()` is called with.
     *
     * Read back from the name table by comparing paths: Elysia's route table has
     * no idea a name exists, and the registry is keyed the other way round. The
     * comparison ignores what a parameter is *called* — the registry stores
     * `/users/{id}` and Elysia has `/users/:id` — because a rename of the
     * parameter is not a different route.
     *
     * Worth the lookup: thirty-one named routes in the auth kit alone, and a
     * listing that cannot show them makes `route('settings.twoFactor.confirm')`
     * something to be guessed at.
     */
    const registered = this.app.bound('routes') ? this.app.make('routes').registered() : []
    const named = new Map<string, string>()

    for (const entry of registered) {
      const shape = shapeOf(entry.path)

      /**
       * Keyed by shape *and* verb, because a path is not one route.
       *
       * `/settings/profile` is three of them — a page, an update and a delete —
       * under three names. Keyed by path alone the last one registered won, and
       * the listing labelled the GET row `settings.profile.destroy`.
       *
       * A name registered without verbs still gets a path-only key, so an older
       * registration keeps showing up rather than vanishing from the listing.
       */
      if (entry.methods.length === 0) named.set(shape, entry.name)

      for (const method of entry.methods) named.set(`${method.toUpperCase()} ${shape}`, entry.name)
    }

    const names = routes.map((route) => {
      const shape = shapeOf(route.path)

      return named.get(`${route.method.toUpperCase()} ${shape}`) ?? named.get(shape) ?? ''
    })
    const anyNames = names.some((name) => name !== '')

    const headers = ['METHOD', 'PATH']

    if (anyNames) headers.push('NAME')
    if (anyMiddleware) headers.push('MIDDLEWARE')

    this.line()
    this.table(
      headers,
      routes.map((route, index) => {
        const paint = METHOD_COLORS[route.method.toUpperCase()] ?? pc.white
        const row = [paint(route.method), route.path]

        if (anyNames) row.push(pc.cyan(names[index] ?? ''))
        if (anyMiddleware) row.push(pc.dim((guarded[index] ?? []).join(', ')))

        return row
      })
    )
    this.line()
    this.comment(`  ${routes.length} route${routes.length === 1 ? '' : 's'}`)
    this.line()

    return 0
  }
}

/**
 * A path by its shape, so the two spellings of a parameter compare equal.
 *
 * The name table stores what a developer wrote — `/users/{id}` — and Elysia's
 * table holds what it matches on — `/users/:id`. Comparing the strings finds
 * nothing; comparing their shapes finds the route.
 */
function shapeOf(path: string): string {
  return path
    .replace(/\{[^}]+\}/g, ':param')
    .replace(/:[A-Za-z0-9_]+\??/g, ':param')
    .replace(/\/+$/, '')
}
