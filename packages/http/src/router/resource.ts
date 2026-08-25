import { RouteGroupBuilder } from './registrar.ts'
import type { RouteDefinition } from './route.ts'

/**
 * `Route::resource` — seven routes from one line.
 *
 * The URIs, the verbs and the names are `Illuminate\Routing\ResourceRegistrar`'s,
 * read from the source rather than from the documentation, because three details
 * only appear there:
 *
 * - `update` answers **PUT and PATCH**, not just PUT.
 * - the parameter is the resource name **singularised**, because
 *   `ResourceRegistrar::$singularParameters` is `true` by default — `photos`
 *   gives `{photo}`.
 * - a nested resource is written `photos.comments` with a dot, and becomes
 *   `/photos/{photo}/comments/{comment}`.
 *
 * ```ts
 * Route.resource('photos', PhotoController)
 * Route.resource('photos.comments', CommentController).shallow()
 * Route.apiResource('photos', PhotoController).only(['index', 'show'])
 * ```
 */
export type ResourceMethod = 'index' | 'create' | 'store' | 'show' | 'edit' | 'update' | 'destroy'

const ALL: ResourceMethod[] = ['index', 'create', 'store', 'show', 'edit', 'update', 'destroy']

/** `apiResource` leaves out the two that render forms. */
const API: ResourceMethod[] = ['index', 'store', 'show', 'update', 'destroy']

/** A singleton has no index and no identifier — `Route::singleton`. */
const SINGLETON: ResourceMethod[] = ['show', 'edit', 'update']

type Options = {
  only?: ResourceMethod[]
  except?: ResourceMethod[]
  names?: string | Partial<Record<ResourceMethod, string>>
  parameters?: string | Record<string, string>
  shallow?: boolean
  scoped?: Record<string, string> | boolean
  middleware?: Array<string | string[]>
  withoutMiddleware?: Array<string | string[]>
  missing?: (request: Request) => unknown
  creatable?: boolean
  destroyable?: boolean
  trashed?: boolean
}

/**
 * A resource being described.
 *
 * Nothing is declared until `register()`, which the facade calls for you at the
 * end of the tick — the same reason a single route is a value first: `.only()`
 * and `.names()` arrive after the resource does.
 */
export class ResourceBuilder {
  private options: Options = {}
  private registered = false

  constructor(
    private readonly name: string,
    private readonly controller: new (...args: never[]) => object,
    private readonly defaults: ResourceMethod[],
    private readonly singleton = false
  ) {}

  only(methods: ResourceMethod[]): this {
    this.options.only = methods

    return this
  }

  except(methods: ResourceMethod[]): this {
    this.options.except = methods

    return this
  }

  /** `names('photo')` renames all seven, or an object renames some. */
  names(names: string | Partial<Record<ResourceMethod, string>>): this {
    this.options.names = names

    return this
  }

  /** `parameters({ photos: 'photo_id' })` — what the placeholder is called. */
  parameters(parameters: string | Record<string, string>): this {
    this.options.parameters = parameters

    return this
  }

  /**
   * A nested resource whose own identifier is enough — Laravel's `shallow`.
   *
   * `index`, `create` and `store` keep the parent, because they have no child to
   * identify; `show`, `edit`, `update` and `destroy` drop it, because an id
   * already says which one.
   */
  shallow(shallow = true): this {
    this.options.shallow = shallow

    return this
  }

  /** Bind children through their parent — `scoped()`, and `{child:field}` with it. */
  scoped(fields: Record<string, string> | boolean = true): this {
    this.options.scoped = fields

    return this
  }

  middleware(...names: Array<string | string[]>): this {
    this.options.middleware = [...(this.options.middleware ?? []), ...names]

    return this
  }

  withoutMiddleware(...names: Array<string | string[]>): this {
    this.options.withoutMiddleware = [...(this.options.withoutMiddleware ?? []), ...names]

    return this
  }

  missing(handler: (request: Request) => unknown): this {
    this.options.missing = handler

    return this
  }

  /**
   * Let the bindings on these routes resolve a soft-deleted row.
   *
   * Laravel applies it to `show`, `edit` and `update` when no list is given —
   * `$options['trashed']` in `ResourceRegistrar` — because those are the screens
   * that act on a deleted record.
   */
  withTrashed(trashed = true): this {
    this.options.trashed = trashed

    return this
  }

  /** A singleton that can also be created — `Route::singleton(…)->creatable()`. */
  creatable(): this {
    this.options.creatable = true

    return this
  }

  /** A singleton that can be deleted but not created. */
  destroyable(): this {
    this.options.destroyable = true

    return this
  }

  /**
   * Declare the routes.
   *
   * Idempotent, because the facade calls it and a caller may too: a resource
   * registered twice would be seven duplicate routes and a duplicate-name error
   * from the registry, which is a confusing way to learn you called it yourself.
   */
  register(): RouteDefinition[] {
    if (this.registered) return []

    this.registered = true

    const declared: RouteDefinition[] = []

    for (const method of this.wanted()) {
      const route = this.declare(method)

      if (route !== undefined) declared.push(route)
    }

    return declared
  }

  private wanted(): ResourceMethod[] {
    let methods = [...this.defaults]

    /**
     * A creatable singleton gains `create`, `store` and `destroy`.
     *
     * Read from the source: `singletonResourceDefaults` is `['show','edit','update']`
     * and `creatable` adds all three, while `destroyable` adds only `destroy`.
     */
    if (this.singleton && this.options.creatable === true) {
      methods = [...methods, 'create', 'store', 'destroy']
    } else if (this.singleton && this.options.destroyable === true) {
      methods = [...methods, 'destroy']
    }

    if (this.options.only !== undefined) {
      methods = methods.filter((one) => this.options.only?.includes(one))
    }

    if (this.options.except !== undefined) {
      methods = methods.filter((one) => !this.options.except?.includes(one))
    }

    return methods
  }

  /** The URI for one of the seven, parents and shallowness taken into account. */
  private uriFor(method: ResourceMethod): string {
    const segments = this.name.split('.')
    const own = segments[segments.length - 1] as string
    const parents = segments.slice(0, -1)

    const identified = ['show', 'edit', 'update', 'destroy'].includes(method)
    const shallow = this.options.shallow === true && identified

    const base = shallow
      ? own
      : [...parents.map((parent) => `${parent}/{${this.parameterFor(parent)}}`), own].join('/')

    if (this.singleton) {
      // No identifier at all: there is one of these, and its URI says so.
      if (method === 'create') return `${base}/create`
      if (method === 'edit') return `${base}/edit`

      return base
    }

    if (method === 'index' || method === 'store') return base
    if (method === 'create') return `${base}/create`

    const parameter = `{${this.parameterFor(own)}${this.bindingFieldFor(own)}}`

    if (method === 'edit') return `${base}/${parameter}/edit`

    return `${base}/${parameter}`
  }

  /**
   * `photos` → `photo`, `-` → `_`.
   *
   * Singular by default because `ResourceRegistrar::$singularParameters` is
   * `true`. The pluraliser is deliberately small: it handles the endings a
   * resource name actually has, and `parameters()` is there for anything it gets
   * wrong — which is the same escape hatch Laravel provides.
   */
  private parameterFor(segment: string): string {
    const { parameters } = this.options

    if (typeof parameters === 'string') return parameters.replace(/-/g, '_')

    const named = parameters?.[segment]

    if (named !== undefined) return named.replace(/-/g, '_')

    return singular(segment).replace(/-/g, '_')
  }

  /** `:field` for a scoped child, so `{comment:slug}` binds by slug. */
  private bindingFieldFor(segment: string): string {
    const { scoped } = this.options

    if (typeof scoped !== 'object') return ''

    const field = scoped[segment]

    return field === undefined ? '' : `:${field}`
  }

  private nameFor(method: ResourceMethod): string {
    const { names } = this.options
    const base = typeof names === 'string' ? names : this.shallowName()

    if (typeof names === 'object' && names[method] !== undefined) return names[method] as string

    return `${base}.${method}`
  }

  /** A shallow resource is named by its own segment, not by its parents. */
  private shallowName(): string {
    if (this.options.shallow !== true) return this.name

    return this.name.split('.').pop() as string
  }

  private declare(method: ResourceMethod): RouteDefinition | undefined {
    const uri = this.uriFor(method)
    const action = method
    let group = new RouteGroupBuilder()

    if (this.options.middleware !== undefined) group = group.middleware(...this.options.middleware)
    if (this.options.withoutMiddleware !== undefined) {
      group = group.withoutMiddleware(...this.options.withoutMiddleware)
    }
    if (this.options.scoped !== undefined && this.options.scoped !== false) {
      group = group.scopeBindings()
    }
    if (this.options.missing !== undefined) group = group.missing(this.options.missing)

    group = group.controller(this.controller)

    const trashed = this.options.trashed === true && ['show', 'edit', 'update'].includes(method)

    const named = (route: RouteDefinition) => {
      route.name(this.nameFor(method))

      if (trashed) route.withTrashed()

      return route
    }

    switch (method) {
      case 'index':
      case 'create':
      case 'show':
      case 'edit':
        return named(group.get(uri, action))
      case 'store':
        return named(group.post(uri, action))
      /**
       * PUT **and** PATCH, which the documentation does not say.
       *
       * `addResourceUpdate` is `match(['PUT', 'PATCH'], …)`, and a form that
       * spoofs PATCH against a PUT-only route is a 405 nobody expects.
       */
      case 'update':
        return named(group.match(['PUT', 'PATCH'], uri, action))
      case 'destroy':
        return named(group.delete(uri, action))
      default:
        return undefined
    }
  }
}

/** Everything a facade needs to build the four flavours. */
export function resourceBuilder(
  name: string,
  controller: new (...args: never[]) => object,
  flavour: 'resource' | 'api' | 'singleton' | 'apiSingleton'
): ResourceBuilder {
  if (flavour === 'resource') return new ResourceBuilder(name, controller, ALL)
  if (flavour === 'api') return new ResourceBuilder(name, controller, API)

  return new ResourceBuilder(
    name,
    controller,
    flavour === 'apiSingleton' ? SINGLETON.filter((one) => one !== 'edit') : SINGLETON,
    true
  )
}

/**
 * Enough English to turn a resource name into a parameter.
 *
 * Not a general pluraliser and not trying to be. Laravel leans on `Str::singular`,
 * which carries a full inflector; this handles the endings a resource name has in
 * practice and leaves `parameters()` for the rest — the same escape hatch Laravel
 * gives for the words its inflector gets wrong.
 */
function singular(word: string): string {
  const irregular: Record<string, string> = {
    children: 'child',
    people: 'person',
    men: 'man',
    women: 'woman',
    feet: 'foot',
    teeth: 'tooth',
    geese: 'goose',
    mice: 'mouse',
    data: 'datum',
    media: 'media',
    news: 'news'
  }

  const lower = word.toLowerCase()

  if (irregular[lower] !== undefined) return irregular[lower]

  if (/(ss|sh|ch|x|z|o)es$/i.test(word)) return word.slice(0, -2)
  if (/[^aeiou]ies$/i.test(word)) return `${word.slice(0, -3)}y`
  if (/ves$/i.test(word)) return `${word.slice(0, -3)}f`
  if (/s$/i.test(word) && !/ss$/i.test(word)) return word.slice(0, -1)

  return word
}
