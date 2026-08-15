/**
 * Conditionable — Laravel's `->when()/->unless()` fluent guard.
 */
export class Conditionable {
  when(condition: unknown, callback: (self: this) => void): this {
    if (condition) callback(this)
    return this
  }

  unless(condition: unknown, callback: (self: this) => void): this {
    if (!condition) callback(this)
    return this
  }

  tap(callback: (self: this) => void): this {
    callback(this)
    return this
  }
}

/**
 * Macroable — runtime extension of a class, the way Laravel packages bolt
 * methods onto `Str`, `Request`, or the query builder.
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
