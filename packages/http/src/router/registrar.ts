import { routes as routeRegistry } from '../route-helpers.ts'
import { type Metadata, mergeMetadata } from './metadata.ts'
import { type ResourceBuilder, resourceBuilder } from './resource.ts'
import { redirectResponse, renderView } from './responses.ts'
import { type HttpMethod, type RouteAction, RouteDefinition } from './route.ts'

/**
 * The `Route` facade, and the group stack behind it.
 *
 * `Illuminate\Routing\Router` plus `RouteRegistrar`, with the same two halves:
 * methods that declare a route and methods that open a group. The group stack is
 * what makes `prefix`, `name`, `middleware`, `domain` and `controller` inherit
 * downwards and nest, which is the behaviour Laravel's own
 * `testNestedRouteGroupingPrefixing` pins down.
 *
 * Declaring does not register. Every route lands in a collection this module
 * holds, and `compile()` in `compile.ts` turns the collection into Elysia routes
 * once the file has finished being read. Two reasons, both load-bearing:
 * `->name()` and `->where()` arrive *after* the route is declared and need
 * something still open to modify, and a wildcard has to be registered last
 * whatever order the file wrote it in.
 */
export type GroupAttributes = {
  prefix?: string
  name?: string
  middleware?: string | string[]
  withoutMiddleware?: string | string[]
  domain?: string
  metadata?: Metadata
  controller?: new (...args: never[]) => object
  where?: Record<string, string>
  scopeBindings?: boolean
  withoutScopedBindings?: boolean
  missing?: (request: Request) => unknown
}

/** Global parameter patterns — `Route.pattern('id', '[0-9]+')`. */
const patterns: Record<string, string> = {}

/** Everything declared since the last `drain()`. */
let collected: RouteDefinition[] = []

/** The open groups, outermost first. */
let stack: GroupAttributes[] = []

/**
 * Resources described but not yet declared.
 *
 * A resource is seven routes and its `.only()` arrives after it, so the seven
 * cannot be declared on the spot. They are declared when the collection is
 * drained — inside whatever groups were open at the time, which is why the stack
 * is captured with each one.
 */
let pendingResources: Array<{ resource: ResourceBuilder; groups: GroupAttributes[] }> = []

/**
 * A route declaration, with a group's attributes already folded in.
 *
 * Applied at declaration time rather than at compile time so that a route's own
 * modifiers win: `Route.middleware('auth').group(() => Route.get(…).withoutMiddleware('auth'))`
 * has to end with nothing guarding that route, and it can only do that if the
 * group's contribution is already on the definition when `withoutMiddleware` runs.
 */
function declare(methods: HttpMethod[], uri: string, action: RouteAction): RouteDefinition {
  const prefix = stack
    .map((group) => group.prefix ?? '')
    .filter((part) => part !== '')
    .join('/')

  const route = new RouteDefinition(methods, prefix === '' ? uri : `${prefix}/${uri}`, action)

  for (const group of stack) {
    if (group.name !== undefined) route.name(group.name)
    if (group.middleware !== undefined) route.middleware(group.middleware)
    if (group.withoutMiddleware !== undefined) route.withoutMiddleware(group.withoutMiddleware)
    if (group.domain !== undefined) route.domain(group.domain)
    if (group.metadata !== undefined) route.metadata(group.metadata)
    if (group.where !== undefined) route.where(group.where)
    if (group.missing !== undefined) route.missing(group.missing)
    if (group.scopeBindings === true) route.scopeBindings()
    if (group.withoutScopedBindings === true) route.withoutScopedBindings()
    if (group.controller !== undefined) route.controllerClass = group.controller
  }

  /**
   * Global patterns come last and lose to anything more specific.
   *
   * `Route.pattern('id', '[0-9]+')` is a default for every `{id}` in the
   * application, and a route that says `where('id', '.*')` means it.
   */
  for (const [name, pattern] of Object.entries(patterns)) {
    if (route.parsed.parameters.includes(name) && route.wheres[name] === undefined) {
      route.where(name, pattern)
    }
  }

  collected.push(route)

  return route
}

/**
 * A group being described, before its body runs.
 *
 * Every method returns a new builder rather than mutating one, so
 * `Route.prefix('admin')` can be assigned and reused — and so the 13 attributes
 * `RouteRegistrar::$allowedAttributes` lists can be chained in any order.
 */
export class RouteGroupBuilder {
  constructor(private readonly attributes: GroupAttributes = {}) {}

  private with(extra: GroupAttributes): RouteGroupBuilder {
    return new RouteGroupBuilder({ ...this.attributes, ...extra })
  }

  prefix(prefix: string): RouteGroupBuilder {
    return this.with({ prefix })
  }

  /** A name prefix. Laravel's `as` is the same method under its other name. */
  name(name: string): RouteGroupBuilder {
    return this.with({ name: `${this.attributes.name ?? ''}${name}` })
  }

  as(name: string): RouteGroupBuilder {
    return this.name(name)
  }

  middleware(...names: Array<string | string[]>): RouteGroupBuilder {
    return this.with({ middleware: [...toArray(this.attributes.middleware), ...names.flat()] })
  }

  withoutMiddleware(...names: Array<string | string[]>): RouteGroupBuilder {
    return this.with({
      withoutMiddleware: [...toArray(this.attributes.withoutMiddleware), ...names.flat()]
    })
  }

  domain(domain: string): RouteGroupBuilder {
    return this.with({ domain })
  }

  /**
   * Metadata for everything in the group, which each route may add to.
   *
   * Merged here as well as on the route, so a nested group deepens its parent's
   * rather than replacing it — `testCanSetRouteMetadataOnGroup` is the shape.
   */
  metadata(values: Metadata): RouteGroupBuilder {
    return this.with({
      metadata:
        this.attributes.metadata === undefined
          ? values
          : mergeMetadata(this.attributes.metadata, values)
    })
  }

  controller(controller: new (...args: never[]) => object): RouteGroupBuilder {
    return this.with({ controller })
  }

  where(name: string | Record<string, string>, pattern?: string): RouteGroupBuilder {
    const added = typeof name === 'string' ? { [name]: pattern ?? '' } : name

    return this.with({ where: { ...this.attributes.where, ...added } })
  }

  whereNumber(...names: string[]): RouteGroupBuilder {
    return this.whereEach(names, '[0-9]+')
  }

  whereAlpha(...names: string[]): RouteGroupBuilder {
    return this.whereEach(names, '[a-zA-Z]+')
  }

  whereAlphaNumeric(...names: string[]): RouteGroupBuilder {
    return this.whereEach(names, '[a-zA-Z0-9]+')
  }

  whereIn(name: string, values: readonly string[]): RouteGroupBuilder {
    return this.where(name, values.join('|'))
  }

  scopeBindings(): RouteGroupBuilder {
    return this.with({ scopeBindings: true })
  }

  withoutScopedBindings(): RouteGroupBuilder {
    return this.with({ withoutScopedBindings: true })
  }

  missing(handler: (request: Request) => unknown): RouteGroupBuilder {
    return this.with({ missing: handler })
  }

  /** Run the body with these attributes applied to everything it declares. */
  group(body: () => void): void {
    stack.push(this.attributes)

    try {
      body()
    } finally {
      stack.pop()
    }
  }

  // Declaring a route on a group builder applies the group to that one route,
  // which is how `Route.middleware('auth').get(…)` reads in Laravel.
  get(uri: string, action: RouteAction): RouteDefinition {
    return this.one(['GET', 'HEAD'], uri, action)
  }

  post(uri: string, action: RouteAction): RouteDefinition {
    return this.one(['POST'], uri, action)
  }

  put(uri: string, action: RouteAction): RouteDefinition {
    return this.one(['PUT'], uri, action)
  }

  patch(uri: string, action: RouteAction): RouteDefinition {
    return this.one(['PATCH'], uri, action)
  }

  delete(uri: string, action: RouteAction): RouteDefinition {
    return this.one(['DELETE'], uri, action)
  }

  options(uri: string, action: RouteAction): RouteDefinition {
    return this.one(['OPTIONS'], uri, action)
  }

  any(uri: string, action: RouteAction): RouteDefinition {
    return this.one(ALL_METHODS, uri, action)
  }

  match(methods: string[], uri: string, action: RouteAction): RouteDefinition {
    return this.one(normaliseMethods(methods), uri, action)
  }

  private one(methods: HttpMethod[], uri: string, action: RouteAction): RouteDefinition {
    let route!: RouteDefinition

    this.group(() => {
      route = declare(methods, uri, action)
    })

    return route
  }

  private whereEach(names: string[], pattern: string): RouteGroupBuilder {
    const added: Record<string, string> = {}

    for (const name of names) added[name] = pattern

    return this.where(added)
  }
}

export const ALL_METHODS: HttpMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS'
]

/** Remember a resource, and the groups it was described inside. */
function queueResource(resource: ResourceBuilder): ResourceBuilder {
  pendingResources.push({ resource, groups: [...stack] })

  return resource
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return []

  return Array.isArray(value) ? value : [value]
}

function normaliseMethods(methods: string[]): HttpMethod[] {
  return methods.map((method) => method.toUpperCase() as HttpMethod)
}

/**
 * Everything declared so far, and the collection emptied.
 *
 * Called by `compile()` and by nothing else. Wildcards are moved to the end:
 * Elysia matches on specificity rather than on registration order, so this is
 * not what makes `/users` beat `/*` — it is what makes two wildcards under one
 * prefix behave predictably, and it makes `route:list` read the way the
 * application behaves.
 */
export function drainRoutes(): RouteDefinition[] {
  /**
   * Resources first, in the groups they were described in.
   *
   * `stack` is restored around each one rather than assumed empty: a resource
   * inside `Route.prefix('admin').group(…)` has to come out prefixed, and by the
   * time this runs that group has long since closed.
   */
  const pending = pendingResources

  pendingResources = []

  for (const { resource, groups } of pending) {
    const outer = stack

    stack = groups

    try {
      resource.register()
    } finally {
      stack = outer
    }
  }

  const routes = collected

  collected = []

  const plain = routes.filter((route) => !route.wildcard && !route.isFallback)
  const wildcards = routes.filter((route) => route.wildcard && !route.isFallback)
  const fallbacks = routes.filter((route) => route.isFallback)

  return [...plain, ...wildcards, ...fallbacks]
}

/** For tests and for a second compile in one process. */
export function resetRouter(): void {
  collected = []
  stack = []
  pendingResources = []

  for (const key of Object.keys(patterns)) delete patterns[key]
}

export function registeredPatterns(): Record<string, string> {
  return { ...patterns }
}

/**
 * The facade — `Route`.
 *
 * ```ts
 * Route.get('/users/{id}', [UserController, 'show']).name('users.show').whereNumber('id')
 * Route.view('/{path}', MainLayout, { title: 'Home' }).where('path', '.*')
 * Route.prefix('admin').middleware('auth').name('admin.').group(() => {
 *   Route.get('/', [AdminController, 'index']).name('index')
 * })
 * ```
 */
export const Route = {
  get: (uri: string, action: RouteAction) => declare(['GET', 'HEAD'], uri, action),
  post: (uri: string, action: RouteAction) => declare(['POST'], uri, action),
  put: (uri: string, action: RouteAction) => declare(['PUT'], uri, action),
  patch: (uri: string, action: RouteAction) => declare(['PATCH'], uri, action),
  delete: (uri: string, action: RouteAction) => declare(['DELETE'], uri, action),
  options: (uri: string, action: RouteAction) => declare(['OPTIONS'], uri, action),

  /** Every verb — Laravel's `Route::any`. */
  any: (uri: string, action: RouteAction) => declare(ALL_METHODS, uri, action),

  /** `Route.match(['get', 'post'], …)`, case-insensitive as Laravel's is. */
  match: (methods: string[], uri: string, action: RouteAction) =>
    declare(normaliseMethods(methods), uri, action),

  /**
   * A route that only renders — Laravel's `Route::view`.
   *
   * ```ts
   * Route.view('/', Welcome, { title: 'Home' })
   * Route.view('/{path}', MainLayout, { title: 'Home' }).where('path', '.*')
   * ```
   *
   * The second line is the whole reason this exists: it is how a Laravel
   * application hands every address to a client-side router, and writing it by
   * hand is four lines that say nothing.
   *
   * `status` and `headers` are Laravel's fourth and fifth arguments, and the fifth
   * is what a client-routed document needs: the shell every address answers with
   * is the same bytes for everybody, and saying so — `cache-control` — is the
   * difference between a cache that may keep it and a browser guessing at
   * freshness. A route that renders is still the only place a response header can
   * be named, since a view returns markup and not a response.
   *
   * ```ts
   * Route.view('/{path}', Shell, { entry }, 200, {
   *   'cache-control': 'public, max-age=0, must-revalidate'
   * }).where('path', '.*')
   * ```
   */
  view: (
    uri: string,
    component: unknown,
    props: Record<string, unknown> = {},
    status = 200,
    headers: Record<string, string> = {}
  ) => declare(['GET', 'HEAD'], uri, () => renderView(component, props, status, headers)),

  /**
   * `Route.redirect('/here', '/there')` — 302, as Laravel's is.
   */
  redirect: (from: string, to: string, status = 302) =>
    declare(['GET', 'HEAD'], from, () => redirectResponse(to, status)),

  /** 301. Separate from `redirect` because a cached 301 is hard to take back. */
  permanentRedirect: (from: string, to: string) =>
    declare(['GET', 'HEAD'], from, () => redirectResponse(to, 301)),

  /**
   * Whatever nothing else answered — Laravel's `Route::fallback`.
   *
   * Every verb, unlike a `/*` route written by hand: `Route::fallback` catches a
   * POST to a missing address too, and an application that only caught GET would
   * answer a form submission with the framework's 404 page.
   */
  fallback: (action: RouteAction) => {
    const route = declare(ALL_METHODS, '/{fallbackPlaceholder}', action)

    route.where('fallbackPlaceholder', '.*')
    route.isFallback = true

    return route
  },

  // Groups. Each returns a builder, so the 13 attributes chain in any order.
  prefix: (prefix: string) => new RouteGroupBuilder().prefix(prefix),
  name: (name: string) => new RouteGroupBuilder().name(name),
  as: (name: string) => new RouteGroupBuilder().as(name),
  middleware: (...names: Array<string | string[]>) => new RouteGroupBuilder().middleware(...names),
  withoutMiddleware: (...names: Array<string | string[]>) =>
    new RouteGroupBuilder().withoutMiddleware(...names),
  domain: (domain: string) => new RouteGroupBuilder().domain(domain),
  metadata: (values: Metadata) => new RouteGroupBuilder().metadata(values),
  controller: (controller: new (...args: never[]) => object) =>
    new RouteGroupBuilder().controller(controller),
  scopeBindings: () => new RouteGroupBuilder().scopeBindings(),
  withoutScopedBindings: () => new RouteGroupBuilder().withoutScopedBindings(),

  /**
   * Seven routes from one line — `Route::resource`.
   *
   * ```ts
   * Route.resource('photos', PhotoController)
   * Route.resource('photos.comments', CommentController).shallow().scoped()
   * Route.apiResource('photos', PhotoController).only(['index', 'show'])
   * ```
   */
  resource: (name: string, controller: new (...args: never[]) => object) =>
    queueResource(resourceBuilder(name, controller, 'resource')),

  /** The same without `create` and `edit`, which only exist to render forms. */
  apiResource: (name: string, controller: new (...args: never[]) => object) =>
    queueResource(resourceBuilder(name, controller, 'api')),

  /** One of a thing: `show`, `edit`, `update`, and no identifier in the URI. */
  singleton: (name: string, controller: new (...args: never[]) => object) =>
    queueResource(resourceBuilder(name, controller, 'singleton')),

  apiSingleton: (name: string, controller: new (...args: never[]) => object) =>
    queueResource(resourceBuilder(name, controller, 'apiSingleton')),

  /** `Route.resources({ photos: PhotoController, posts: PostController })`. */
  resources: (entries: Record<string, new (...args: never[]) => object>) => {
    for (const [name, controller] of Object.entries(entries)) {
      queueResource(resourceBuilder(name, controller, 'resource'))
    }
  },

  apiResources: (entries: Record<string, new (...args: never[]) => object>) => {
    for (const [name, controller] of Object.entries(entries)) {
      queueResource(resourceBuilder(name, controller, 'api'))
    }
  },

  /** Several singletons at once — `Route::singletons`. */
  singletons: (entries: Record<string, new (...args: never[]) => object>) => {
    for (const [name, controller] of Object.entries(entries)) {
      queueResource(resourceBuilder(name, controller, 'singleton'))
    }
  },

  apiSingletons: (entries: Record<string, new (...args: never[]) => object>) => {
    for (const [name, controller] of Object.entries(entries)) {
      queueResource(resourceBuilder(name, controller, 'apiSingleton'))
    }
  },

  /**
   * Resources whose bindings may resolve a soft-deleted row —
   * `Route::softDeletableResources`.
   *
   * The case it exists for is the screen that restores one: a route that cannot
   * find the deleted post cannot undelete it.
   */
  softDeletableResources: (entries: Record<string, new (...args: never[]) => object>) => {
    for (const [name, controller] of Object.entries(entries)) {
      queueResource(resourceBuilder(name, controller, 'resource').withTrashed())
    }
  },

  /**
   * Is a route with this name registered? — `Route::has`.
   *
   * The question a starter page asks: a link to `login` must not be rendered by
   * an application that has no sign-in.
   */
  has: (name: string) => routeRegistry().has(name),

  /** `Route.group({ prefix: 'admin', middleware: 'auth' }, () => …)`. */
  group: (attributes: GroupAttributes, body: () => void) =>
    new RouteGroupBuilder(attributes).group(body),

  /**
   * A default constraint for every parameter of that name — `Route::pattern`.
   *
   * Declared before the routes that should inherit it, which in Laravel means
   * in a service provider's `boot`. A route's own `where` always wins.
   */
  pattern: (name: string, pattern: string) => {
    patterns[name] = pattern
  },

  patterns: (entries: Record<string, string>) => {
    Object.assign(patterns, entries)
  }
}
