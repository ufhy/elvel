import pc from 'picocolors'
import { Command } from '../command.ts'

const METHOD_COLORS: Record<string, (value: string) => string> = {
  GET: pc.blue,
  POST: pc.green,
  PUT: pc.yellow,
  PATCH: pc.yellow,
  DELETE: pc.red
}

export class RouteListCommand extends Command {
  static override signature =
    'route:list {--method= : Filter by HTTP method} {--path= : Filter by path substring}'

  static override description = 'List all registered routes'

  handle(): number {
    const methodFilter = this.stringOption('method').toUpperCase()
    const pathFilter = this.stringOption('path')

    // Elysia exposes its compiled route table directly — no registry of our own.
    const routes = this.app.router.routes
      .filter((route) => methodFilter === '' || route.method.toUpperCase() === methodFilter)
      .filter((route) => pathFilter === '' || route.path.includes(pathFilter))
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) || left.method.localeCompare(right.method)
      )

    if (routes.length === 0) {
      this.warn('No routes matched.')
      return 0
    }

    this.line()
    this.table(
      ['METHOD', 'PATH'],
      routes.map((route) => {
        const paint = METHOD_COLORS[route.method.toUpperCase()] ?? pc.white
        return [paint(route.method), route.path]
      })
    )
    this.line()
    this.comment(`  ${routes.length} route${routes.length === 1 ? '' : 's'}`)
    this.line()

    return 0
  }
}
