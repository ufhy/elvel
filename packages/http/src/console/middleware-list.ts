import { Command } from '@elyvel/console'
import pc from 'picocolors'
import { middlewareNamesOf, middlewares } from '../middleware.ts'

/**
 * `middleware:list`
 *
 * Laravel has no equivalent — it shows middleware inside `route:list` and leaves
 * the alias map to whoever reads `bootstrap/app.php`. That is workable when the
 * aliases live in one file you wrote. Here they are registered by whichever
 * packages happen to be installed: `throttle` and `signed` come from this one,
 * five more from `@elyvel/auth`, and an application adds its own. Asking "what
 * can I write on a route?" had no answer at all, which is why this exists.
 *
 * Also reports how many routes use each, so an alias nobody reaches for shows up
 * as the dead code it is.
 */
export class MiddlewareListCommand extends Command {
  static override signature = 'middleware:list {--unused : Only aliases and groups no route uses}'

  static override description = 'List the registered middleware aliases and groups'

  handle(): number {
    const registry = middlewares()
    const names = registry.names()

    if (names.length === 0) {
      this.warn('No middleware is registered.')

      return 0
    }

    /**
     * Counted by bare name, so `throttle:6,1` counts towards `throttle`.
     *
     * A group counts when a route names the group, not when a route names one of
     * its members — the two are different questions and conflating them would
     * report every group as used the moment its first member was.
     */
    const used = new Map<string, number>()

    for (const route of this.app.router.routes) {
      for (const name of middlewareNamesOf(route)) {
        const bare = name.split(':')[0] as string
        used.set(bare, (used.get(bare) ?? 0) + 1)
      }
    }

    const rows = names
      .map((name) => ({
        name,
        kind: registry.expands(name) ? 'group' : 'alias',
        count: used.get(name) ?? 0
      }))
      .filter((row) => !this.flag('unused') || row.count === 0)

    if (rows.length === 0) {
      this.info('Every registered middleware is used by at least one route.')

      return 0
    }

    this.line()
    this.table(
      ['NAME', 'KIND', 'ROUTES', 'EXPANDS TO'],
      rows.map((row) => [
        row.kind === 'group' ? pc.magenta(row.name) : pc.cyan(row.name),
        pc.dim(row.kind),
        row.count === 0 ? pc.yellow('0') : String(row.count),
        pc.dim(registry.expands(row.name)?.join(', ') ?? '')
      ])
    )
    this.line()
    this.comment(`  ${rows.length} registered. Use one with: middleware('${rows[0]?.name}')`)
    this.line()

    return 0
  }
}
