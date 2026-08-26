import { NotFoundException } from '@elvel/core'
import { Elysia } from 'elysia'
import { describeRouteBindings } from '../bindings.ts'
import { middleware as middlewareHooks } from '../middleware.ts'
import { routes as routeRegistry } from '../route-helpers.ts'
import { enterCurrentRoute } from './current.ts'
import { drainRoutes } from './registrar.ts'
import type { RouteDefinition } from './route.ts'

/**
 * Everything declared with `Route` so far, as an Elysia plugin.
 *
 * ```ts
 * // routes/web.ts
 * Route.get('/', [PageController, 'index']).name('home')
 *
 * export default compileRoutes('web')
 * ```
 *
 * The collection is drained, so a second call compiles a second file rather than
 * the same routes twice — which is what `routes/web.ts` and a package shipping
 * its own routes both need.
 */
export function compileRoutes(name = 'routes'): Elysia {
  const definitions = drainRoutes()

  /**
   * Which definition answers which compiled path, so `current()` can say.
   *
   * Keyed by the path Elysia matched rather than by the Laravel URI, because the
   * matched path is what the context reports back — measured: `context.route`
   * holds `/articles/:id`, the compiled form, not `/articles/{id}`.
   */
  const byPath = new Map<string, RouteDefinition>()

  for (const route of definitions) {
    byPath.set(route.path, route)

    if (route.rootPath !== undefined) byPath.set(route.rootPath, route)
  }

  let instance = new Elysia({ name }).onBeforeHandle({ as: 'global' }, (context) => {
    enterCurrentRoute(byPath.get((context as { route?: string }).route ?? ''))
  })

  for (const route of definitions) {
    instance = mount(instance, route)
  }

  return instance
}

function mount(instance: Elysia, route: RouteDefinition): Elysia {
  const handler = handlerFor(route)
  const hooks = hooksFor(route)

  let next = instance

  for (const path of [route.path, route.rootPath].filter(
    (one): one is string => one !== undefined
  )) {
    for (const method of route.methods) {
      /**
       * `HEAD` is not registered separately.
       *
       * Elysia answers a HEAD from the matching GET route, and registering both
       * makes the second overwrite the first — measured as a GET that stopped
       * answering once its HEAD twin was added.
       */
      if (method === 'HEAD') continue

      next = (next as unknown as Record<string, CallableFunction>)[method.toLowerCase()]?.(
        path,
        handler,
        hooks
      ) as Elysia
    }
  }

  if (route.routeName !== undefined) {
    routeRegistry().name(route.routeName, route.uri, route.methods)
  }

  return next
}

/**
 * The per-route hooks: middleware, constraints, the domain, and `missing`.
 *
 * All of it goes in `beforeHandle`, which is Elysia's own per-route slot and runs
 * its hooks in order until one returns a response. Nothing here reimplements a
 * pipeline.
 */
function hooksFor(route: RouteDefinition): Record<string, unknown> | undefined {
  const names = route.middlewareNames.filter((name) => !route.excludedMiddleware.includes(name))
  const before: unknown[] = []

  if (route.domainPattern !== undefined) before.push(domainGuard(route.domainPattern))
  if (Object.keys(route.wheres).length > 0) before.push(constraintGuard(route))

  /**
   * What this route said about its own bindings, left where the middleware
   * will find it.
   *
   * `{post:slug}` and `scopeBindings()` belong to the route; the `bindings`
   * middleware is an alias that sees only the request. Without this both were
   * parsed, stored, and silently ignored — measured, `/posts/{post:slug}` bound
   * by primary key and said nothing about it.
   *
   * Pushed ahead of the middleware, and unconditionally: the alias may sit
   * anywhere in the chain, and a route with neither hint stores an empty object
   * rather than making the reader wonder which routes are described.
   */
  before.push(bindingHints(route))

  if (names.length > 0) before.push(...middlewareHooks(...names).beforeHandle)

  const validation = route.validation ?? {}

  /**
   * `missing()` has to wrap the chain, not just the handler.
   *
   * A binding resolves in `beforeHandle` — that is what the `bindings` middleware
   * is — so the `NotFoundException` it throws never reached a `try` around the
   * handler. Measured: a route with `.missing()` and an unresolvable model
   * answered 404 and the handler never ran, `missing fired: false`.
   *
   * So the hooks are sequenced inside one hook this file owns, and the `catch` is
   * around all of them.
   */
  const chain = route.missingHandler === undefined ? before : [guarded(before, route)]

  return { ...validation, beforeHandle: chain }
}

/**
 * The route's binding hints, as a hook.
 *
 * A hook rather than something the middleware imports, because the middleware is
 * an alias an application may not use at all — and one that returns nothing lets
 * the chain carry on.
 */
function bindingHints(route: RouteDefinition) {
  const fields = route.parsed.bindingFields
  const scope = route.scoped === true ? scopeFor(route) : undefined
  const trashed = route.trashed

  return (context: { request: Request }) => {
    describeRouteBindings(context.request, { fields, scope, trashed })

    return undefined
  }
}

/**
 * Who each child parameter belongs to, read off the URI.
 *
 * `/photos/{photo}/comments/{comment}` says two things: `comment`'s parent is
 * `photo`, and the relation to reach it by is `comments` — the segment in front
 * of it. Laravel derives both the same way, which is why `scopeBindings()` needs
 * no arguments.
 */
function scopeFor(route: RouteDefinition): Record<string, { parent: string; relation: string }> {
  const segments = route.uri.split('/').filter((segment) => segment !== '')
  const scope: Record<string, { parent: string; relation: string }> = {}

  let previousParameter: string | undefined
  let previousSegment: string | undefined

  for (const segment of segments) {
    const parameter = /^\{(\w+)\??\}$/.exec(segment)?.[1]

    if (parameter === undefined) {
      previousSegment = segment

      continue
    }

    if (previousParameter !== undefined && previousSegment !== undefined) {
      scope[parameter] = { parent: previousParameter, relation: previousSegment }
    }

    previousParameter = parameter
  }

  return scope
}

/**
 * Run the hooks in order, and answer `missing()` if a binding was not there.
 *
 * Only `NotFoundException`, and only from the chain: anything else is a real
 * failure and must not be turned into a redirect that hides it. A hook that
 * returns a response still stops the chain, because that is what a guard does.
 */
function guarded(hooks: unknown[], route: RouteDefinition) {
  const missing = route.missingHandler as (request: Request) => unknown

  return async (context: { request: Request }) => {
    try {
      for (const hook of hooks) {
        const answer = await (hook as (given: unknown) => unknown)(context)

        if (answer !== undefined) return answer
      }

      return undefined
    } catch (problem) {
      if (problem instanceof NotFoundException) return missing(context.request)

      throw problem
    }
  }
}

/**
 * Constraints, checked after matching rather than during it.
 *
 * Laravel treats `where` as part of matching: `/users/{id}` constrained to digits
 * and `/users/{slug}` can both exist, and a non-numeric id falls through to the
 * second. Here a failed constraint is a 404 instead.
 *
 * Not a choice, and measured rather than assumed. Registering those two routes
 * together and then handling a request answers:
 *
 * ```
 * Cannot create route "/users/:slug" with parameter "slug" because a route
 * already exists with a different parameter name ("id") in the same location
 * ```
 *
 * So the pair cannot coexist at all, let alone fall through — closing that gap
 * means replacing Elysia's router, and with it the typed context, the schema
 * validation and the speed that come from it. Every other use of `where` behaves
 * as Laravel's does.
 */
function constraintGuard(route: RouteDefinition) {
  const checks = Object.entries(route.wheres)
    // `.*` is the wildcard, already handled by the path itself.
    .filter(([, pattern]) => pattern !== '.*')
    .map(([name, pattern]) => [name, new RegExp(`^(?:${pattern})$`)] as const)

  return (context: { params?: Record<string, string> }) => {
    for (const [name, expression] of checks) {
      const value = context.params?.[name]

      // An absent optional parameter is not a violation — Laravel's
      // `RoutesDontMatchNonMatchingPathsWithLeadingOptionals` is about matching,
      // and an optional that was not supplied has nothing to constrain.
      if (value === undefined || value === '') continue

      if (!expression.test(value)) throw new NotFoundException(`No route matched.`)
    }
  }
}

/**
 * `Route.domain('{account}.example.com')`.
 *
 * A guard rather than part of matching, because Elysia's router keys on the path
 * alone. What that costs: two domain groups claiming the *same path* cannot both
 * work — the first registered answers, and the guard on it turns the other host
 * into a 404 rather than trying the next route.
 *
 * The same measurement that pins `where` pins this: a matched route cannot
 * decline and let another try. A tenant subdomain — one group whose paths are
 * shared across every host — is unaffected, and is what this is for.
 */
function domainGuard(pattern: string) {
  const names: string[] = []
  const expression = new RegExp(
    `^${pattern.replace(/[.]/g, '\\.').replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name)

      return '([^.]+)'
    })}$`
  )

  return (context: { request: Request; params?: Record<string, string> }) => {
    const host = (context.request.headers.get('host') ?? '').split(':')[0] ?? ''
    const found = expression.exec(host)

    if (found === null) throw new NotFoundException(`No route matched ${host}.`)

    /**
     * The host's own parameters join the path's, as Laravel's do.
     *
     * The object is created when the route has none of its own: Elysia leaves
     * `params` undefined for a path with no placeholders, and
     * `Route.domain('{account}.example.com')` around `/dashboard` is exactly that
     * shape — measured as `undefined is not an object` from the handler reading
     * `params.account`.
     */
    if (context.params === undefined) context.params = {}

    const params = context.params

    names.forEach((name, index) => {
      const value = found[index + 1]

      if (value !== undefined) params[name] = value
    })
  }
}

/**
 * What the route runs: a closure, or a method on a controller class.
 *
 * A controller is built once and reused, not per request. Laravel resolves one
 * out of the container per request because a PHP process serves one request at a
 * time; here a per-request instance would be a new object on every hit for a
 * class that almost never has state, and shared state on a controller is a bug
 * whichever way it is constructed.
 */
function handlerFor(route: RouteDefinition) {
  const { action } = route

  if (typeof action === 'function')
    return withDefaults(route, action as (context: never) => unknown)

  const [controller, method] =
    typeof action === 'string'
      ? [route.controllerClass, action]
      : (action as [new (...args: never[]) => object, string])

  if (controller === undefined) {
    throw new Error(
      `Route [${route.uri}] names the method "${String(method)}" but no controller. ` +
        `Wrap it in Route.controller(TheController).group(…), or pass [TheController, '${String(method)}'].`
    )
  }

  type Methods = Record<string, (context: never) => unknown>

  let instance: Methods | undefined

  return withDefaults(route, (context: never) => {
    instance ??= new controller() as unknown as Methods

    const target = instance[method]

    if (typeof target !== 'function') {
      throw new Error(`[${controller.name}] has no method "${String(method)}".`)
    }

    return target.call(instance, context)
  })
}

/**
 * `defaults()` values, and `missing()` around the whole thing.
 *
 * `missing` catches the `NotFoundException` a binding throws, and only that: an
 * exception from the handler's own work is not a missing model and must not be
 * turned into a redirect that hides it.
 */
function withDefaults(route: RouteDefinition, run: (context: never) => unknown) {
  const defaults = Object.entries(route.defaultValues)
  const missing = route.missingHandler

  if (defaults.length === 0 && missing === undefined) return run

  return async (context: never) => {
    const typed = context as unknown as { params?: Record<string, unknown>; request: Request }

    for (const [name, value] of defaults) {
      if (typed.params !== undefined && typed.params[name] === undefined) {
        typed.params[name] = value
      }
    }

    if (missing === undefined) return run(context)

    try {
      return await run(context)
    } catch (problem) {
      if (problem instanceof NotFoundException) return missing(typed.request)

      throw problem
    }
  }
}
