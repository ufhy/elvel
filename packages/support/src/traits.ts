/**
 * Conditionable — the `.when()` / `.unless()` fluent guard.
 */
export class Conditionable {
  /**
   * Apply the callback when the condition holds.
   *
   * The condition may be a **function**, and is called if it is. Without that,
   * `when(() => user.isAdmin(), …)` reads correctly and always runs, because a
   * function object is truthy — the habitual spelling silently doing the
   * opposite of what it says.
   *
   * The resolved value reaches the callback, so
   * `when(search, (q, term) => q.where('title', 'like', term))` needs no capture,
   * and `otherwise` is the else branch that makes this worth using over an `if`.
   */
  when<V>(
    condition: V | ((self: this) => V),
    callback: (self: this, value: NonNullable<V>) => unknown,
    otherwise?: (self: this, value: V) => unknown
  ): this {
    const resolved = (
      typeof condition === 'function' ? (condition as (self: this) => V)(this) : condition
    ) as V

    if (resolved) callback(this, resolved as NonNullable<V>)
    else otherwise?.(this, resolved)

    return this
  }

  unless<V>(
    condition: V | ((self: this) => V),
    callback: (self: this, value: V) => unknown,
    otherwise?: (self: this, value: NonNullable<V>) => unknown
  ): this {
    const resolved = (
      typeof condition === 'function' ? (condition as (self: this) => V)(this) : condition
    ) as V

    if (!resolved) callback(this, resolved)
    else otherwise?.(this, resolved as NonNullable<V>)

    return this
  }

  tap(callback: (self: this) => void): this {
    callback(this)
    return this
  }
}

/**
 * Macroable — runtime extension of a class, so a package can bolt methods onto
 * `Str`, the query builder, or anything else.
 *
 * Types are opt-in via declaration merging on the consuming class; the runtime
 * side is a plain prototype write, no proxy cost on every access.
 */
export type Macro = (...args: any[]) => unknown

/**
 * biome-ignore lint/complexity/noStaticOnlyClass: the statics are the point — a
 * class other classes extend to gain `macro()`, which is what makes the registry
 * shared and the type merging work.
 */
export class Macroable {
  private static macros = new Map<string, Macro>()

  /**
   * `this` here is the concrete subclass, not `Macroable` — that is the whole
   * point: `Str.macro('slugify', ...)` must land on `Str.prototype`, keyed by
   * `Str`. Rewriting these to `Macroable.*` would install every macro on the
   * shared base class.
   */
  static macro(name: string, callback: Macro): void {
    Macroable.macros.set(`${this.name}:${name}`, callback)
    Object.defineProperty(this.prototype, name, {
      value: callback,
      writable: true,
      configurable: true,
      enumerable: false
    })
  }

  static hasMacro(name: string): boolean {
    return Macroable.macros.has(`${this.name}:${name}`)
  }
}
