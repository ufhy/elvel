/**
 * Names for routes, and URLs built from them — Laravel's `route()`.
 *
 * Elysia declares routes as strings on a plugin, so there is no router object to
 * hang a name on. The registry is that missing table: a controller says which
 * name belongs to which path, and everything that needs a URL asks for the name
 * instead of repeating the path.
 *
 * Why bother, when a path is a string you could just write? Because the path is
 * written in a dozen places and changed in one. A rename that misses a redirect
 * produces a 404 nobody sees until a user finds it; a rename that misses a
 * *name* fails at boot, which is the whole point of the indirection.
 */
export class RouteRegistry {
  private readonly paths = new Map<string, string>()

  /**
   * The verbs each name answers, when whoever registered it said.
   *
   * Kept apart from `paths` because nothing that builds a URL needs it: `route()`
   * asks for a name and gets a path. What needs it is `route:list`, which reads
   * the table the other way round — and a path alone cannot answer, because
   * `/settings/profile` is three routes under three names. Measured: the listing
   * labelled the GET row `settings.profile.destroy`.
   */
  private readonly methods = new Map<string, string[]>()

  /**
   * Name a path.
   *
   * ```ts
   * routes().name('articles.show', '/articles/:id')
   * ```
   *
   * A duplicate name is refused rather than overwritten: two routes answering to
   * one name means `route()` silently returns whichever was registered last, and
   * the one that loses is a link nobody notices is wrong.
   */
  name(name: string, path: string, methods: string[] = []): this {
    const existing = this.paths.get(name)

    if (existing !== undefined && existing !== path) {
      throw new Error(
        `Route name [${name}] is already taken by [${existing}]. Names must be unique, or route() would build whichever was registered last.`
      )
    }

    this.paths.set(name, path)

    if (methods.length > 0) this.methods.set(name, methods)

    return this
  }

  /** Name several at once, which is how a controller usually registers them. */
  names(entries: Record<string, string>): this {
    for (const [name, path] of Object.entries(entries)) this.name(name, path)

    return this
  }

  has(name: string): boolean {
    return this.paths.has(name)
  }

  path(name: string): string | undefined {
    return this.paths.get(name)
  }

  all(): Record<string, string> {
    return Object.fromEntries(this.paths)
  }

  /**
   * Every name with its path and the verbs it answers — for `route:list`.
   *
   * A list rather than a map, because two names may share a path and the caller
   * is matching from the other direction.
   */
  registered(): Array<{ name: string; path: string; methods: string[] }> {
    return [...this.paths].map(([name, path]) => ({
      name,
      path,
      methods: this.methods.get(name) ?? []
    }))
  }

  /**
   * Build the URL for a name.
   *
   * Parameters fill the placeholders — `:id` as Elysia writes them, `{id}` as
   * Laravel does — and whatever is left over becomes the query string, which is
   * what makes `route('articles.index', { page: 2 })` read the way it does.
   *
   * A missing parameter throws and names both the route and the parameter. The
   * alternative is a URL with `:id` still in it, which 404s somewhere far from
   * the call that built it.
   */
  to(name: string, parameters: Record<string, unknown> = {}, absolute = false): string {
    const path = this.paths.get(name)

    if (path === undefined) {
      const known = [...this.paths.keys()].sort().join(', ')

      throw new Error(`Route [${name}] is not defined.${known === '' ? '' : ` Known: ${known}.`}`)
    }

    const remaining = { ...parameters }

    const filled = path.replace(
      /:([A-Za-z0-9_]+)\??|\{([A-Za-z0-9_]+)\??\}/g,
      (match, colon, brace) => {
        const key = (colon ?? brace) as string
        const value = remaining[key]

        if (value === undefined || value === null) {
          // An optional segment is allowed to vanish; a required one is a mistake
          // worth stopping for.
          if (match.includes('?')) return ''

          throw new Error(`Route [${name}] needs a [${key}] parameter.`)
        }

        delete remaining[key]

        return encodeURIComponent(String(value))
      }
    )

    const query = new URLSearchParams()

    for (const [key, value] of Object.entries(remaining)) {
      if (value === undefined || value === null) continue

      query.set(key, String(value))
    }

    const search = query.toString()
    const relative = `${collapse(filled)}${search === '' ? '' : `?${search}`}`

    return absolute ? `${this.origin}${relative}` : relative
  }

  /**
   * Where absolute URLs point.
   *
   * Set from `app.url` at boot, and overridable per request by the http provider
   * when a trusted proxy says otherwise — a link built behind a gateway has to
   * point at the address outside it.
   */
  origin = ''

  /**
   * Refuse to boot when a name points nowhere.
   *
   * The registry is the whole reason a rename is safe, and it only is if a name
   * that no longer matches a route is a startup failure rather than a 404 later.
   * Compared against Elysia's own route table, so it sees what actually got
   * registered rather than what was meant to be.
   */
  verify(registered: Array<{ path: string }>): void {
    const known = new Set(registered.map((route) => normalise(route.path)))
    const missing: string[] = []

    for (const [name, path] of this.paths) {
      if (!known.has(normalise(path))) missing.push(`${name} -> ${path}`)
    }

    if (missing.length > 0) {
      throw new Error(
        `These route names point at paths no route answers: ${missing.join(', ')}. Rename the route, or fix the name.`
      )
    }
  }
}

/** `/articles//1` is `/articles/1`, and a trailing slash is not a different route. */
function collapse(path: string): string {
  const squeezed = path.replace(/\/{2,}/g, '/')

  return squeezed.length > 1 ? squeezed.replace(/\/$/, '') : squeezed
}

/** Compare paths by shape, not by parameter name: `:id` and `:article` match. */
function normalise(path: string): string {
  return collapse(path).replace(/:([A-Za-z0-9_]+)\??|\{([A-Za-z0-9_]+)\??\}/g, ':param')
}
