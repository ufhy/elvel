import { app, NotFoundException } from '@elyvel/core'

declare module '@elyvel/contracts' {
  interface ContainerBindings {
    bindings: BindingRegistry
  }
}

/**
 * What a model must offer to be bound to a route.
 *
 * Duck-typed rather than imported: this package must keep working with no
 * database package present, and a route binding is a routing concern that
 * happens to resolve a model.
 */
export type RouteBindable = {
  name?: string
  routeKeyName(): string
  resolveRouteBinding(value: string, field?: string): Promise<unknown>
  resolveChildRouteBinding?(
    parent: unknown,
    relation: string,
    value: string,
    field?: string
  ): Promise<unknown>
}

/** A binding written by hand, for anything that is not a model. */
export type BindingResolver = (value: string, request: Request) => unknown | Promise<unknown>

type Registration =
  | { kind: 'model'; model: RouteBindable; scope?: { parent: string; relation: string } }
  | { kind: 'callback'; resolve: BindingResolver }

/**
 * What `{post}` in a path means — Laravel's `Route::model` and `Route::bind`.
 *
 * Laravel reads the handler's type hints and needs no registration at all. That
 * is not available here and cannot be: TypeScript erases the types, and Bun emits
 * no decorator metadata to put them back — the check is written down in
 * `BEHAVIOURS.md`. So a binding is declared, which is what Laravel's own
 * `Route::model()` is for anyway.
 *
 * ```ts
 * bindings().model('article', Article)
 * bindings().model('comment', Comment, { parent: 'article', relation: 'comments' })
 * bindings().bind('kind', (value) => KINDS[value])
 * ```
 */
export class BindingRegistry {
  private readonly registrations = new Map<string, Registration>()

  /** `{article}` resolves to an Article by its route key. */
  model(name: string, model: RouteBindable, scope?: { parent: string; relation: string }): this {
    this.registrations.set(name, { kind: 'model', model, scope })

    return this
  }

  /** `{kind}` resolves to whatever the callback returns. */
  bind(name: string, resolve: BindingResolver): this {
    this.registrations.set(name, { kind: 'callback', resolve })

    return this
  }

  has(name: string): boolean {
    return this.registrations.has(name)
  }

  names(): string[] {
    return [...this.registrations.keys()].sort()
  }

  get(name: string): Registration | undefined {
    return this.registrations.get(name)
  }
}

/** The registry. */
export function bindings(): BindingRegistry {
  return app('bindings')
}

/** Resolved models for one request, kept off the context Elysia types. */
const resolved = new WeakMap<Request, Map<string, unknown>>()

/**
 * The model a route parameter resolved to.
 *
 * ```ts
 * .get('/articles/:article', () => bound<Article>('article').title, middleware('bindings'))
 * ```
 *
 * Typed by the caller because the registry is keyed by string: a name maps to a
 * model at runtime, and no signature can know which. Throws rather than
 * answering `undefined` — reaching for a binding the route never declared is a
 * mistake in the route, not a value to handle.
 */
export function bound<T>(name: string, request?: Request): T {
  const found = lookup(name, request)

  if (found === undefined) {
    throw new Error(
      `No bound model for [${name}]. Declare it with bindings().model('${name}', …) ` +
        `and put middleware('bindings') on the route.`
    )
  }

  return found as T
}

/** The same, without insisting. */
export function boundOrNothing<T>(name: string, request?: Request): T | undefined {
  return lookup(name, request) as T | undefined
}

function lookup(name: string, request?: Request): unknown {
  if (request) return resolved.get(request)?.get(name)

  // Without a request in hand there is nothing to key by; the middleware always
  // passes one, and this branch exists for a caller outside a request.
  return undefined
}

/**
 * Resolve every declared parameter on this route.
 *
 * Order matters: a scoped binding needs its parent resolved first, so parents are
 * done before children rather than in whatever order the path happened to list
 * them.
 */
export async function resolveBindings(
  registry: BindingRegistry,
  params: Record<string, string>,
  request: Request
): Promise<void> {
  const store = new Map<string, unknown>()
  resolved.set(request, store)

  const entries = Object.entries(params).filter(([name]) => registry.has(name))

  const scoped = entries.filter(([name]) => {
    const registration = registry.get(name)

    return registration?.kind === 'model' && registration.scope !== undefined
  })
  const plain = entries.filter((entry) => !scoped.includes(entry))

  for (const [name, value] of [...plain, ...scoped]) {
    store.set(name, await resolveOne(registry, name, value, store, request))
  }
}

async function resolveOne(
  registry: BindingRegistry,
  name: string,
  value: string,
  store: Map<string, unknown>,
  request: Request
): Promise<unknown> {
  const registration = registry.get(name) as Registration

  if (registration.kind === 'callback') {
    const answer = await registration.resolve(value, request)

    if (answer === undefined || answer === null) throw missing(name, value)

    return answer
  }

  const { model, scope } = registration

  /**
   * A scoped child is resolved through its parent's relation.
   *
   * `/articles/{article}/comments/{comment}` must find the comment among *that
   * article's* comments. Resolving it on its own would hand somebody else's
   * comment to a caller who guessed an id — a route that looks like it works and
   * is an authorization hole.
   */
  if (scope) {
    const parent = store.get(scope.parent)

    if (parent === undefined) {
      throw new Error(
        `Binding [${name}] is scoped to [${scope.parent}], which this route does not bind. ` +
          `Add it to the path, or drop the scope.`
      )
    }

    if (!model.resolveChildRouteBinding) {
      throw new Error(`[${name}] cannot be scoped: its model has no resolveChildRouteBinding.`)
    }

    const child = await model.resolveChildRouteBinding(parent, scope.relation, value)
    if (child === undefined || child === null) throw missing(name, value)

    return child
  }

  const found = await model.resolveRouteBinding(value)
  if (found === undefined || found === null) throw missing(name, value)

  return found
}

/**
 * A binding that resolved to nothing is a 404, not a 500.
 *
 * The URL named a thing that is not there, which is exactly what 404 means — and
 * saying which parameter failed makes a wrong route obvious without a debugger.
 */
function missing(name: string, value: string): NotFoundException {
  return new NotFoundException(`No result for [${name}] = ${value}.`)
}
