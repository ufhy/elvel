import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type Policy, type PolicyLike, type PolicyResult, policyAllowsGuests } from './policy.ts'
import { AuthorizationError, AuthorizationResponse } from './response.ts'

/** The authenticated subject. Anything with an id; better-auth uses a string. */
export type AuthUser = { id: string | number } & Record<string, unknown>

/** What a `Gate.define()` callback may return. */
export type AbilityResult = PolicyResult

export type AbilityCallback = (user: AuthUser | null, ...args: unknown[]) => AbilityResult

export type AbilityOptions = {
  /** Let the ability run for a guest instead of denying outright. */
  allowGuests?: boolean
}

type BeforeCallback = (
  user: AuthUser | null,
  ability: string,
  args: unknown[]
) => AbilityResult | Promise<AbilityResult>

type AfterCallback = (
  user: AuthUser | null,
  ability: string,
  result: boolean | AuthorizationResponse | undefined,
  args: unknown[]
) => AbilityResult | Promise<AbilityResult>

/** Anything a policy can be registered against. */
type Subject = string | (new (...args: never[]) => unknown)

type Dispatcher = { dispatch(event: string, payload?: unknown): unknown }

/**
 * Decides what a user may do — `Illuminate\Auth\Access\Gate`.
 *
 * Two ways in. An ability defined inline:
 *
 * ```ts
 * gate.define('view-dashboard', (user) => user?.role === 'admin')
 * await gate.allows('view-dashboard')
 * ```
 *
 * Or a policy bound to a model, where the ability name is the method name:
 *
 * ```ts
 * gate.policy(Article, ArticlePolicy)
 * await gate.allows('update', article)
 * ```
 *
 * Every check is async: unlike Laravel's, a policy here may read the database.
 */
export class Gate {
  private readonly abilities = new Map<string, { callback: AbilityCallback; guests: boolean }>()
  private readonly policies = new Map<Subject, PolicyLike>()
  private readonly resolved = new Map<PolicyLike, Policy>()
  private readonly beforeCallbacks: BeforeCallback[] = []
  private readonly afterCallbacks: AfterCallback[] = []

  constructor(
    private userResolver: () => AuthUser | null | Promise<AuthUser | null>,
    private readonly events?: () => Dispatcher | undefined
  ) {}

  /** Is this ability, or a policy method, defined? */
  has(ability: string): boolean {
    return this.abilities.has(ability)
  }

  define(ability: string, callback: AbilityCallback, options: AbilityOptions = {}): this {
    this.abilities.set(ability, { callback, guests: options.allowGuests === true })

    return this
  }

  /** Map a model to the policy that authorizes it. */
  policy(subject: Subject, policy: PolicyLike): this {
    this.policies.set(subject, policy)

    return this
  }

  /**
   * Find policies by name — Laravel's policy auto-discovery.
   *
   * `ArticlePolicy` in the given directory is registered for the model called
   * `Article`, resolved from the model registry the application already keeps
   * for queue payloads. Laravel guesses the *namespace*; here the guess is the
   * class name, which is the part that carries the same meaning.
   *
   * Explicit registration still wins: this only fills in what nobody named, so
   * `gate.policy(Article, SomethingElse)` is never overridden by a file that
   * happens to be called `ArticlePolicy`.
   */
  async discoverPolicies(
    directory: string,
    models: { get(name: string): unknown }
  ): Promise<number> {
    let entries: string[]

    try {
      entries = await readdir(directory)
    } catch {
      // No policies directory is the ordinary case, not an error.
      return 0
    }

    let found = 0

    for (const entry of entries.sort()) {
      if (!/\.(ts|js|mts|mjs)$/.test(entry) || entry.endsWith('.d.ts')) continue

      const module = (await import(join(directory, entry))) as Record<string, unknown>

      for (const exported of Object.values(module)) {
        if (typeof exported !== 'function' || !exported.name.endsWith('Policy')) continue

        const subject = models.get(exported.name.replace(/Policy$/, ''))

        if (!subject || this.policies.has(subject as Subject)) continue

        this.policy(subject as Subject, exported as PolicyLike)
        found += 1
      }
    }

    return found
  }

  /**
   * Define `name.viewAny`, `name.view`, … against a policy, as Laravel's
   * `Gate::resource()` does. Handy when the ability is not reached through a
   * model instance.
   */
  resource(name: string, policy: PolicyLike, abilities?: Record<string, string>): this {
    const map = abilities ?? {
      viewAny: 'viewAny',
      view: 'view',
      create: 'create',
      update: 'update',
      delete: 'delete'
    }

    for (const [ability, method] of Object.entries(map)) {
      this.define(`${name}.${ability}`, async (user, ...args) => {
        const instance = this.resolvePolicy(policy)

        const before = await this.callPolicyBefore(instance, user, method, args)
        if (before !== undefined) return before

        return this.callPolicyMethod(instance, method, user, args)
      })
    }

    return this
  }

  /** Runs before every check. A non-undefined result decides it outright. */
  before(callback: BeforeCallback): this {
    this.beforeCallbacks.push(callback)

    return this
  }

  /** Runs after every check, and may supply a result when none was reached. */
  after(callback: AfterCallback): this {
    this.afterCallbacks.push(callback)

    return this
  }

  async allows(ability: string, args: unknown | unknown[] = []): Promise<boolean> {
    return (await this.inspect(ability, args)).allowed()
  }

  async denies(ability: string, args: unknown | unknown[] = []): Promise<boolean> {
    return !(await this.allows(ability, args))
  }

  /** Every ability must pass. */
  async check(abilities: string | string[], args: unknown | unknown[] = []): Promise<boolean> {
    const list = Array.isArray(abilities) ? abilities : [abilities]

    for (const ability of list) {
      if (!(await this.allows(ability, args))) return false
    }

    return true
  }

  /** At least one ability must pass. */
  async any(abilities: string | string[], args: unknown | unknown[] = []): Promise<boolean> {
    const list = Array.isArray(abilities) ? abilities : [abilities]

    for (const ability of list) {
      if (await this.allows(ability, args)) return true
    }

    return false
  }

  async none(abilities: string | string[], args: unknown | unknown[] = []): Promise<boolean> {
    return !(await this.any(abilities, args))
  }

  /** Throw `AuthorizationError` unless the check passes. */
  async authorize(ability: string, args: unknown | unknown[] = []): Promise<AuthorizationResponse> {
    return (await this.inspect(ability, args)).authorize()
  }

  /** The full response, so a caller can read the message and status. */
  async inspect(ability: string, args: unknown | unknown[] = []): Promise<AuthorizationResponse> {
    try {
      const result = await this.raw(ability, args)

      if (result instanceof AuthorizationResponse) return result

      return result ? AuthorizationResponse.allow() : AuthorizationResponse.deny()
    } catch (error) {
      if (error instanceof AuthorizationError) return error.toResponse()

      throw error
    }
  }

  /**
   * The raw result: before callbacks, then the ability or policy, then the after
   * callbacks. An ability nobody defined denies, rather than throwing — the same
   * empty callback Laravel falls back to.
   */
  async raw(
    ability: string,
    args: unknown | unknown[] = []
  ): Promise<boolean | AuthorizationResponse | undefined> {
    const list = Array.isArray(args) ? args : [args]
    const user = await this.userResolver()

    let result = await this.callBeforeCallbacks(user, ability, list)

    if (result === undefined) {
      result = await this.callAuthCallback(user, ability, list)
    }

    result = await this.callAfterCallbacks(user, ability, list, result)

    this.events?.()?.dispatch('gate.evaluated', { user, ability, result, arguments: list })

    return result
  }

  /** A gate that answers for a specific user instead of the current one. */
  forUser(user: AuthUser | null): Gate {
    const gate = new Gate(() => user, this.events)

    for (const [ability, entry] of this.abilities) gate.abilities.set(ability, entry)
    for (const [subject, policy] of this.policies) gate.policies.set(subject, policy)
    gate.beforeCallbacks.push(...this.beforeCallbacks)
    gate.afterCallbacks.push(...this.afterCallbacks)

    return gate
  }

  /** Authorize on the spot, without defining an ability first. */
  async allowIf(
    condition: unknown | (() => unknown),
    message?: string,
    code?: string
  ): Promise<AuthorizationResponse> {
    const passes =
      typeof condition === 'function' ? await (condition as () => unknown)() : condition

    return passes
      ? AuthorizationResponse.allow(message, code)
      : AuthorizationResponse.deny(message, code).authorize()
  }

  async denyIf(
    condition: unknown | (() => unknown),
    message?: string,
    code?: string
  ): Promise<AuthorizationResponse> {
    const denies =
      typeof condition === 'function' ? await (condition as () => unknown)() : condition

    return this.allowIf(!denies, message, code)
  }

  /** The policy registered for a model, an instance of it, or its name. */
  getPolicyFor(subject: unknown): Policy | undefined {
    const key = Gate.subjectOf(subject)
    if (key === undefined) return undefined

    const direct = this.policies.get(key)
    if (direct) return this.resolvePolicy(direct)

    // A policy registered against a base class authorizes its subclasses.
    if (typeof key === 'function') {
      for (const [registered, policy] of this.policies) {
        if (typeof registered === 'function' && key.prototype instanceof registered) {
          return this.resolvePolicy(policy)
        }
      }
    }

    return undefined
  }

  /** Reset registrations. Used by tests, and by a reloading dev server. */
  flush(): this {
    this.abilities.clear()
    this.policies.clear()
    this.resolved.clear()
    this.beforeCallbacks.length = 0
    this.afterCallbacks.length = 0

    return this
  }

  /** Point the gate at a different source for the current user. */
  resolveUsing(resolver: () => AuthUser | null | Promise<AuthUser | null>): this {
    this.userResolver = resolver

    return this
  }

  private static subjectOf(subject: unknown): Subject | undefined {
    if (typeof subject === 'string') return subject
    if (typeof subject === 'function') return subject as Subject
    if (typeof subject === 'object' && subject !== null) {
      return (subject as object).constructor as Subject
    }

    return undefined
  }

  private async callAuthCallback(
    user: AuthUser | null,
    ability: string,
    args: unknown[]
  ): Promise<boolean | AuthorizationResponse | undefined> {
    // A policy wins when the first argument identifies a model it authorizes.
    if (args.length > 0) {
      const policy = this.getPolicyFor(args[0])
      const method = Gate.formatAbilityToMethod(ability)

      if (policy && typeof (policy as unknown as Record<string, unknown>)[method] === 'function') {
        if (user === null && !policyAllowsGuests(policy, method)) return false

        const before = await this.callPolicyBefore(policy, user, method, args)
        if (before !== undefined) return before

        return this.callPolicyMethod(policy, method, user, args)
      }
    }

    const entry = this.abilities.get(ability)
    if (!entry) return undefined

    if (user === null && !entry.guests) return false

    return entry.callback(user, ...args)
  }

  private async callBeforeCallbacks(
    user: AuthUser | null,
    ability: string,
    args: unknown[]
  ): Promise<boolean | AuthorizationResponse | undefined> {
    for (const before of this.beforeCallbacks) {
      const result = await before(user, ability, args)

      if (result !== undefined) return result
    }

    return undefined
  }

  /**
   * `result ??= afterResult`: an after callback may supply a verdict when none
   * was reached, but never overturn one that was.
   */
  private async callAfterCallbacks(
    user: AuthUser | null,
    ability: string,
    args: unknown[],
    result: boolean | AuthorizationResponse | undefined
  ): Promise<boolean | AuthorizationResponse | undefined> {
    let current = result

    for (const after of this.afterCallbacks) {
      const supplied = await after(user, ability, current, args)

      current ??= supplied
    }

    return current
  }

  private async callPolicyBefore(
    policy: Policy,
    user: AuthUser | null,
    ability: string,
    args: unknown[]
  ): Promise<boolean | AuthorizationResponse | undefined> {
    if (typeof policy.before !== 'function') return undefined
    if (user === null && !policyAllowsGuests(policy, ability)) return undefined

    return policy.before(user, ability, ...Gate.policyArguments(args))
  }

  private async callPolicyMethod(
    policy: Policy,
    method: string,
    user: AuthUser | null,
    args: unknown[]
  ): Promise<boolean | AuthorizationResponse | undefined> {
    const callable = (policy as unknown as Record<string, unknown>)[method]
    if (typeof callable !== 'function') return undefined

    return (callable as (...called: unknown[]) => PolicyResult).call(
      policy,
      user,
      ...Gate.policyArguments(args)
    )
  }

  /**
   * Drop the leading argument when it only names the model — `allows('create',
   * Article)` passes the class so the policy can be found, and the policy
   * already knows what it authorizes.
   */
  private static policyArguments(args: unknown[]): unknown[] {
    const [first] = args

    return typeof first === 'string' || typeof first === 'function' ? args.slice(1) : args
  }

  private resolvePolicy(policy: PolicyLike): Policy {
    const cached = this.resolved.get(policy)
    if (cached) return cached

    const instance = typeof policy === 'function' ? new policy() : policy
    this.resolved.set(policy, instance)

    return instance
  }

  /** `view-any` and `view_any` both reach the `viewAny` method. */
  private static formatAbilityToMethod(ability: string): string {
    if (!/[-_]/.test(ability)) return ability

    return ability
      .split(/[-_]/)
      .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join('')
  }
}
