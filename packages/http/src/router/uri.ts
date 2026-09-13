/**
 * The route URI syntax, parsed and then compiled for Elysia.
 *
 * Two jobs that are worth keeping apart. Parsing answers what a URI *says* — its
 * parameters, which are optional, and which name a binding field. Compiling turns
 * that into the string Elysia's router wants. A route keeps its declared form for
 * everything a human reads: `route:list`, the name table, error messages.
 *
 * `{bar:slug}` binds that parameter by the `slug` column rather than by the
 * key. The test beside this file covers every shape.
 */

/**
 * A route parameter: `{name}`, `{name?}`, `{name:field}`, `{name:field?}`.
 *
 * No whitespace anywhere inside the braces: `/\{([\w\:]+?)\??\}/` and nothing
 * looser. Tolerating it
 * cost more than it bought: the `\s*` runs were ambiguous with each other, so a
 * pattern like `{{0` followed by many spaces made the engine try every way of
 * splitting them between two of them. Polynomial backtracking, and CodeQL was right
 * to say so even though only an application's own source reaches this.
 */
const PARAMETER = /\{(\w+)(?::(\w+))?(\?)?\}/g

export type ParsedUri = {
  /** The URI with binding fields stripped: `/foo/{bar:slug}` → `/foo/{bar}`. */
  uri: string

  /** `{ qux: 'slug' }` for `/foo/{qux:slug}`. Empty when nothing named a field. */
  bindingFields: Record<string, string>

  /** Every parameter, in the order the URI lists them. */
  parameters: string[]

  /** The subset that may be absent. */
  optional: string[]
}

/**
 * Read a declared URI.
 *
 * A leading slash is added when it is missing: `Route.get('users')` and
 * `Route.get('/users')` are one route, and a framework that treated them as two
 * would be one nobody could copy an example into.
 */
export function parseUri(uri: string): ParsedUri {
  const bindingFields: Record<string, string> = {}
  const parameters: string[] = []
  const optional: string[] = []

  const stripped = uri.replace(
    PARAMETER,
    (_match, name: string, field?: string, question?: string) => {
      parameters.push(name)

      if (field !== undefined) bindingFields[name] = field
      if (question !== undefined) optional.push(name)

      return `{${name}${question ?? ''}}`
    }
  )

  return {
    uri: normalise(stripped),
    bindingFields,
    parameters,
    optional
  }
}

/**
 * The path Elysia matches on.
 *
 * `{id}` becomes `:id` and `{id?}` becomes `:id?`, which is Elysia's own syntax
 * for the same two things.
 *
 * A parameter constrained to `.*` becomes a wildcard instead. That is the one
 * place a constraint changes *matching* rather than filtering, and it has to:
 * `Route.view('/{path}', 'main').where('path', '.*')` is how an application
 * hands every address to a client-side router, and `:path` matches
 * one segment. Nothing else about `where` reaches this function — see
 * `patterns.ts` for why the rest cannot.
 */
export function compileUri(parsed: ParsedUri, wheres: Record<string, string> = {}): string {
  let path = parsed.uri

  for (const name of parsed.parameters) {
    const pattern = wheres[name]
    const optional = parsed.optional.includes(name)

    if (pattern === '.*') {
      // The wildcard takes the slash in front of it: `/{path}` is `/*`, not `/:*`.
      path = path.replace(`/{${name}${optional ? '?' : ''}}`, '/*')

      continue
    }

    path = path.replace(`{${name}${optional ? '?' : ''}}`, `:${name}${optional ? '?' : ''}`)
  }

  return normalise(path)
}

/**
 * The extra path a *prefixed* wildcard needs, or nothing.
 *
 * Measured against Elysia's router, with one route registered at a time:
 *
 * ```
 * /*         →  /  200      /x         200
 * /admin/*   →  /admin 404  /admin/    200   /admin/x 200
 * ```
 *
 * So a wildcard at the root already matches the root, and needs nothing. A
 * prefixed one misses the prefix itself, while `/admin/{rest?}` must match
 * `/admin` — and a panel whose own front page 404s is the kind of gap that gets
 * found in production. This returns that second path, and the registrar
 * registers it alongside.
 */
export function rootFor(
  parsed: ParsedUri,
  wheres: Record<string, string> = {}
): string | undefined {
  const wildcard = parsed.parameters.find((name) => wheres[name] === '.*')

  if (wildcard === undefined) return undefined

  const optional = parsed.optional.includes(wildcard)
  const withoutSegment = normalise(
    parsed.uri.replace(`/{${wildcard}${optional ? '?' : ''}}`, '') || '/'
  )

  // The root case: `/*` already answers `/`.
  return withoutSegment === '/' ? undefined : withoutSegment
}

/**
 * Is this URI a wildcard route?
 *
 * Asked by the registrar, which registers those last: a wildcard is the widest
 * thing an application can declare, and anything registered after it that shares
 * its prefix would be unreachable.
 */
export function isWildcard(parsed: ParsedUri, wheres: Record<string, string> = {}): boolean {
  return parsed.parameters.some((name) => wheres[name] === '.*')
}

/** A leading slash, no double slashes, and no trailing one except at the root. */
function normalise(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`
  const squeezed = withSlash.replace(/\/{2,}/g, '/')

  return squeezed.length > 1 ? squeezed.replace(/\/$/, '') : squeezed
}
