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
const MIDDLEWARE_NAMES = Symbol.for('elyvel.middleware.names')

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
    'route:list {--method= : Filter by HTTP method} {--path= : Filter by path substring} {--middleware= : Only routes guarded by this middleware}'

  static override description = 'List all registered routes'

  handle(): number {
    const methodFilter = this.stringOption('method').toUpperCase()
    const pathFilter = this.stringOption('path')
    const middlewareFilter = this.stringOption('middleware')

    // Elysia exposes its compiled route table directly — no registry of our own.
    const routes = this.app.router.routes
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

    this.line()
    this.table(
      anyMiddleware ? ['METHOD', 'PATH', 'MIDDLEWARE'] : ['METHOD', 'PATH'],
      routes.map((route, index) => {
        const paint = METHOD_COLORS[route.method.toUpperCase()] ?? pc.white
        const names = guarded[index] ?? []

        return anyMiddleware
          ? [paint(route.method), route.path, pc.dim(names.join(', '))]
          : [paint(route.method), route.path]
      })
    )
    this.line()
    this.comment(`  ${routes.length} route${routes.length === 1 ? '' : 's'}`)
    this.line()

    return 0
  }
}
