import { type Metadata, mergeMetadata, metadataAt } from './metadata.ts'
import { compileUri, isWildcard, type ParsedUri, parseUri, rootFor } from './uri.ts'

/**
 * A route, and everything that can be said about one after it is declared.
 *
 * The fluent modifiers are `Illuminate\Routing\Route`'s: `name`, `where` and the
 * `where*` shorthands, `middleware`, `withoutMiddleware`, `domain`, `defaults`,
 * `missing`, `scopeBindings`. They return `this`, so a route reads as one
 * sentence — which is the whole reason Laravel's routing files are pleasant to
 * read and worth copying exactly.
 *
 * Nothing is registered here. A declaration is a value; the registrar collects
 * them and `compile.ts` turns the collection into Elysia routes at the end. That
 * order is what makes `->name()` and `->where()` work at all: both arrive *after*
 * the path and the handler, and a router that registered eagerly would have
 * nothing left to modify.
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD'

/** What a route does: a closure, or a controller method named by class. */
export type RouteAction =
  | ((context: never) => unknown)
  | [new (...args: never[]) => object, string]
  /** A bare method name, inside a `Route.controller(X).group(...)`. */
  | string

export type MissingHandler = (request: Request) => unknown

export class RouteDefinition {
  readonly parsed: ParsedUri

  /** Constraints by parameter name, merged from the route, its groups and globals. */
  readonly wheres: Record<string, string> = {}

  /** Middleware names, in the order they will run. */
  readonly middlewareNames: string[] = []

  /** Names removed again — the field behind `withoutMiddleware()` below. */
  readonly excludedMiddleware: string[] = []

  routeName?: string
  domainPattern?: string

  /** Arbitrary values a page knows about itself — see `metadata.ts`. */
  routeMetadata: Metadata = {}
  controllerClass?: new (
    ...args: never[]
  ) => object
  missingHandler?: MissingHandler
  scoped?: boolean
  trashed?: boolean
  defaultValues: Record<string, unknown> = {}

  /** Set by `Route.fallback()`: this answers only what nothing else claimed. */
  isFallback = false

  /**
   * Elysia's own per-route validation, if this route wants any.
   *
   * Laravel has no equivalent and needs none — a `FormRequest` is a class, and
   * `@elvel/http` ships those too. This is here because Elysia's schemas do
   * something a FormRequest cannot: they type the handler's `body` and `query`,
   * so a typo in a field name is a compile error rather than an `undefined` two
   * layers later.
   */
  validation?: Record<string, unknown>

  constructor(
    readonly methods: HttpMethod[],
    uri: string,
    readonly action: RouteAction
  ) {
    this.parsed = parseUri(uri)
  }

  /** The URI as Laravel writes it — what `route:list` and error messages show. */
  get uri(): string {
    return this.parsed.uri
  }

  /** The path Elysia matches, constraints taken into account. */
  get path(): string {
    return compileUri(this.parsed, this.wheres)
  }

  /** The extra path a prefixed wildcard needs, or nothing. See `uri.ts`. */
  get rootPath(): string | undefined {
    return rootFor(this.parsed, this.wheres)
  }

  get wildcard(): boolean {
    return isWildcard(this.parsed, this.wheres)
  }

  // ------------------------------------------------------------------ modifiers

  name(name: string): this {
    // Appended, because a group's `name('admin.')` is a prefix and the route
    // adds to it. Laravel does the same, and it is why group names end in a dot.
    this.routeName = `${this.routeName ?? ''}${name}`

    return this
  }

  /** `where('id', '[0-9]+')`, or `where({ id: '[0-9]+', slug: '[a-z-]+' })`. */
  where(name: string | Record<string, string>, pattern?: string): this {
    if (typeof name === 'string') {
      if (pattern !== undefined) this.wheres[name] = pattern

      return this
    }

    Object.assign(this.wheres, name)

    return this
  }

  whereNumber(...names: string[]): this {
    return this.constrain(names, '[0-9]+')
  }

  whereAlpha(...names: string[]): this {
    return this.constrain(names, '[a-zA-Z]+')
  }

  whereAlphaNumeric(...names: string[]): this {
    return this.constrain(names, '[a-zA-Z0-9]+')
  }

  whereUuid(...names: string[]): this {
    return this.constrain(
      names,
      '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
    )
  }

  whereUlid(...names: string[]): this {
    return this.constrain(names, '[0-7][0-9hjkmnpqrstvwxyzHJKMNPQRSTVWXYZ]{25}')
  }

  /** `whereIn('category', ['news', 'sport'])` — the values, and nothing else. */
  whereIn(name: string, values: readonly string[]): this {
    this.wheres[name] = values.map(quote).join('|')

    return this
  }

  /** Names, or an array of them. Laravel takes both and so does this. */
  middleware(...names: Array<string | string[]>): this {
    this.middlewareNames.push(...names.flat())

    return this
  }

  /** Drop middleware a group added, for one route inside it. */
  withoutMiddleware(...names: Array<string | string[]>): this {
    this.excludedMiddleware.push(...names.flat())

    return this
  }

  /**
   * `validate({ body: t.Object({ email: t.String() }) })`.
   *
   * Passed straight to Elysia, so anything its hooks accept works: `body`,
   * `query`, `params`, `headers`, `response`, `cookie`. A failure comes back as
   * the framework's 422 with the error bag, the same shape a `FormRequest` gives.
   */
  validate(schema: Record<string, unknown>): this {
    this.validation = { ...this.validation, ...schema }

    return this
  }

  /**
   * `can('update', 'post')` — Laravel's `->can()`.
   *
   * Sugar over the `can` middleware `@elvel/auth` registers, spelt the way
   * Laravel spells it. Nothing new is authorised here; what it buys is that a
   * route reads as one sentence instead of hiding the ability inside a string.
   */
  can(ability: string, ...args: string[]): this {
    return this.middleware([`can:${[ability, ...args].join(',')}`])
  }

  /**
   * `metadata({ head: { title: 'Users' } })` — Laravel 13's `Route::metadata`.
   *
   * Merged over whatever the group set, deeply. The rules are in `metadata.ts`,
   * with the two that surprise: a list replaces a list, and an empty object
   * clears the group's value rather than inheriting it.
   */
  metadata(values: Metadata): this {
    /**
     * Guarded at run time as well as in the type.
     *
     * TypeScript stops this for anyone compiling, and `Attribute [metadata]
     * expects an array` is the error Laravel raises for the same mistake — worth
     * keeping for a caller reaching this from JavaScript, where a string would
     * otherwise be spread into characters.
     */
    if (typeof values !== 'object' || values === null || Array.isArray(values)) {
      throw new TypeError('metadata() expects an object.')
    }

    this.routeMetadata = mergeMetadata(this.routeMetadata, values)

    return this
  }

  /** Everything, a branch, or a leaf by dotted path: `getMetadata('head.title')`. */
  getMetadata(key?: string, fallback?: unknown): unknown {
    return metadataAt(this.routeMetadata, key, fallback)
  }

  domain(pattern: string): this {
    this.domainPattern = pattern

    return this
  }

  /**
   * What to answer when a bound model is not there — Laravel's `->missing()`.
   *
   * Without it a missing binding is a 404, which is right for a page and wrong
   * for a form that should send somebody back to the index with a message.
   */
  missing(handler: MissingHandler): this {
    this.missingHandler = handler

    return this
  }

  /**
   * Let a soft-deleted model resolve — Laravel's `withTrashed`.
   *
   * A binding normally refuses one, which is right for a page and wrong for the
   * screen that restores it: `/posts/{post}/restore` cannot find the post it is
   * about to bring back.
   */
  withTrashed(trashed = true): this {
    this.trashed = trashed

    return this
  }

  /** Resolve child bindings through their parent — Laravel's `scopeBindings`. */
  scopeBindings(): this {
    this.scoped = true

    return this
  }

  withoutScopedBindings(): this {
    this.scoped = false

    return this
  }

  /** A value for a parameter the URI does not carry — Laravel's `defaults`. */
  defaults(name: string, value: unknown): this {
    this.defaultValues[name] = value

    return this
  }

  private constrain(names: string[], pattern: string): this {
    for (const name of names) this.wheres[name] = pattern

    return this
  }
}

/** Escape a literal for use inside the alternation `whereIn` builds. */
function quote(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
