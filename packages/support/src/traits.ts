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
