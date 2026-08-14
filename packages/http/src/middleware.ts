import { app } from '@elysian/core'

declare module '@elysian/contracts' {
  interface ContainerBindings {
    middleware: MiddlewareRegistry
  }
}

/**
 * What a middleware does.
 *
 * Returning nothing continues; returning a `Response` stops the chain and sends
 * it. Throwing works too, and is usually better for anything the exception
 * handler already knows how to render — `RedirectException` and `HttpException`
 * both travel that way.
 */
export type MiddlewareContext = { request: Request }

/**
 * Typed to accept the *minimum* an Elysia context provides, not `never`.
 *
 * A parameter of `never` reads as "accepts nothing" and makes the hook
 * unassignable to Elysia's own `beforeHandle` slot — the tests passed and the
 * types did not. Accepting a narrower shape than Elysia hands over is exactly
 * what a function parameter may do.
 */
export type MiddlewareHook = (context: MiddlewareContext) => unknown

/** Built from its parameters: `throttle:6,1` calls this with `['6', '1']`. */
export type MiddlewareFactory = (...parameters: string[]) => MiddlewareHook

/**
 * Named middleware — Laravel's aliases, groups and priority.
 *
 * Laravel's `Middleware` configurator has 38 methods; this has the four that
 * carry the behaviour. The rest are conveniences for editing a global stack that
 * does not exist here, because Elysia composes plugins instead of running a
 * global pipeline.
 */
export class MiddlewareRegistry {
  private readonly aliases = new Map<string, MiddlewareFactory>()
  private readonly groups = new Map<string, string[]>()
  private order: string[] = []

  /** `alias('auth', () => hook)` — then `middleware('auth')` on any route. */
  alias(name: string, factory: MiddlewareFactory): this {
    this.aliases.set(name, factory)

    return this
  }

  /** A name that expands to several: `group('dashboard', ['auth', 'verified'])`. */
  group(name: string, names: string[]): this {
    this.groups.set(name, [...names])

    return this
  }

  /**
   * The order middleware must run in when both are present.
   *
   * `auth` before `verified` is not a preference: `verified` reads the user that
   * `auth` guarantees, and reversed it reports "not verified" to a guest who
   * should have been sent to sign in. Laravel keeps a priority list for exactly
   * this, and route order alone does not solve it — a caller writing
   * `middleware('verified', 'auth')` should still get the working order.
   */
  priority(names: string[]): this {
    this.order = [...names]

    return this
  }

  has(name: string): boolean {
    return this.aliases.has(this.bare(name)) || this.groups.has(this.bare(name))
  }

  names(): string[] {
    return [...this.aliases.keys(), ...this.groups.keys()].sort()
  }

  /** What a group expands to, or `undefined` when the name is a plain alias. */
  expands(name: string): string[] | undefined {
    const group = this.groups.get(this.bare(name))

    return group ? [...group] : undefined
  }

  /** Expand groups, build each hook from its parameters, sort by priority. */
  resolve(names: string[]): MiddlewareHook[] {
    const flat = this.expand(names, new Set())

    return this.sort(flat).map((name) => this.build(name))
  }

  private bare(name: string): string {
    const colon = name.indexOf(':')

    return colon === -1 ? name : name.slice(0, colon)
  }

  private expand(names: string[], seen: Set<string>): string[] {
    const out: string[] = []

    for (const name of names) {
      const bare = this.bare(name)
      const group = this.groups.get(bare)

      if (!group) {
        out.push(name)
        continue
      }

      // A group naming itself would recurse until the stack gave out, and the
      // error would name a frame rather than the group.
      if (seen.has(bare)) {
        throw new Error(`Middleware group [${bare}] includes itself.`)
      }

      out.push(...this.expand(group, new Set([...seen, bare])))
    }

    return out
  }

  /**
   * Stable, and only for the names the priority list mentions.
   *
   * Anything unlisted keeps the position it was written in. Sorting everything
   * would mean a caller could not order two middleware of their own by writing
   * them in the order they want.
   */
  private sort(names: string[]): string[] {
    if (this.order.length === 0) return names

    const ranked = names
      .map((name, index) => ({ name, index, rank: this.order.indexOf(this.bare(name)) }))
      .sort((a, b) => {
        if (a.rank === -1 && b.rank === -1) return a.index - b.index
        if (a.rank === -1) return 1
        if (b.rank === -1) return -1
        if (a.rank !== b.rank) return a.rank - b.rank

        return a.index - b.index
      })

    return ranked.map((entry) => entry.name)
  }

  private build(name: string): MiddlewareHook {
    const colon = name.indexOf(':')
    const bare = colon === -1 ? name : name.slice(0, colon)

    /**
     * Split on commas after the first colon, like Laravel.
     *
     * `can:update,post` is one alias with two parameters, not two aliases — so
     * the colon is found once and everything after it belongs to the parameters.
     */
    const parameters = colon === -1 ? [] : name.slice(colon + 1).split(',')

    const factory = this.aliases.get(bare)
    if (!factory) {
      throw new Error(
        `Middleware [${bare}] is not registered. Known: ${this.names().join(', ') || '(none)'}. ` +
          `Register it with middlewares().alias('${bare}', …).`
      )
    }

    return factory(...parameters)
  }
}

/** The registry. */
export function middlewares(): MiddlewareRegistry {
  return app('middleware')
}

/**
 * Middleware for a route or a group — the equivalent of `->middleware([...])`.
 *
 * ```ts
 * controller('posts')
 *   .get('/mine', handler, middleware('auth', 'verified'))
 *   .post('/', handler, { ...middleware('auth', 'throttle:6,1'), body: schema })
 * ```
 *
 * It returns `{ beforeHandle }` because that is Elysia's own per-route slot: the
 * hooks run in order, and one that returns a `Response` stops the rest from
 * running at all. Nothing here reimplements a pipeline — `@elysian/support`'s
 * `Pipeline` exists for values, and a request already has a chain to join.
 *
 * For a whole group, hand the same object to `guard()`:
 *
 * ```ts
 * controller('admin').guard(middleware('auth', 'can:admin'), (routes) => routes.get(…))
 * ```
 *
 * Resolution is deferred to the first request, not done here: a controller is
 * built while providers are still registering, and an alias asked for at module
 * scope would not exist yet.
 */
export function middleware(...names: string[]): { beforeHandle: MiddlewareHook[] } {
  let resolved: MiddlewareHook[] | undefined

  const run: MiddlewareHook = (context) => {
    if (!resolved) resolved = middlewares().resolve(names)

    return sequence(resolved, context)
  }

  /**
   * The names, left on the function for `route:list` to read back.
   *
   * Elysia compiles a route's hooks into an anonymous chain, so by the time the
   * router has a route table there is nothing to say *which* middleware guards
   * it — a listing could only report that one exists. Elysia wraps each hook as
   * `{ fn }` and leaves the function's own properties alone, so tagging it here is
   * what lets `route:list` show a column instead of a shrug.
   */
  Object.defineProperty(run, MIDDLEWARE_NAMES, { value: [...names], enumerable: false })

  return { beforeHandle: [run] }
}

/** Where `middleware()` records its names, and `route:list` looks for them. */
export const MIDDLEWARE_NAMES = Symbol.for('elysian.middleware.names')

/**
 * Read the middleware names off a compiled route, in declaration order.
 *
 * Tolerant of shape on purpose: this reaches into Elysia's route table, which is
 * not a public contract, so a version that stops wrapping hooks as `{ fn }`
 * should make the column empty rather than break `route:list`.
 */
export function middlewareNamesOf(route: unknown): string[] {
  const hooks = (route as { hooks?: { beforeHandle?: unknown } }).hooks?.beforeHandle
  const list = Array.isArray(hooks) ? hooks : hooks === undefined ? [] : [hooks]

  return list.flatMap((entry) => {
    const fn = (entry as { fn?: unknown })?.fn ?? entry
    const names = (fn as Record<symbol, unknown>)?.[MIDDLEWARE_NAMES]

    return Array.isArray(names) ? (names as string[]) : []
  })
}

/** Run hooks in order, stopping at the first that answers with a `Response`. */
async function sequence(hooks: MiddlewareHook[], context: MiddlewareContext): Promise<unknown> {
  for (const hook of hooks) {
    const answer = await hook(context)

    if (answer instanceof Response) return answer
    // A hook may also answer with a plain value, which Elysia sends as the body.
    if (answer !== undefined && answer !== null) return answer
  }

  return undefined
}
