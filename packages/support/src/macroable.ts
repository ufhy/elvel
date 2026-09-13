/**
 * Runtime extension, for classes and for the object literals alike.
 *
 * This is how a package adds to the framework without patching it —
 * `Collection.macro('toCsv', …)`, `Str.macro('slugify', …)` — and the reason it
 * has to cover both shapes is that half of what anybody wants to extend here is
 * an object of functions rather than a class.
 *
 * Types are opt-in through declaration merging: an interface for a class, the
 * `…Macros` interface beside an object literal. The runtime side is a plain
 * property write, so no macro costs anything on a call that is not one.
 */

export type Macro = (...args: any[]) => unknown

/** What a macroable target answers, whichever shape it has. */
export type Macroed = {
  /** Add one method. */
  macro(name: string, callback: Macro): void

  /**
   * Add every method of an object or class at once — how a package usually
   * registers, rather than a `macro()` call per name.
   */
  mixin(source: object, replace?: boolean): void

  hasMacro(name: string): boolean

  /** Remove them all. A test that adds one otherwise leaks it into the next. */
  flushMacros(): void
}

/**
 * Registered macros per target.
 *
 * Keyed on the target itself rather than its name: two classes called `Builder`
 * in two packages are two targets, and a name-keyed registry would have them
 * overwrite each other.
 */
type Registered = {
  callback: Macro

  /**
   * What the name held before, when a macro replaced something real.
   *
   * Without it `flushMacros()` deletes the method it shadowed — a macro named
   * `sum` on a collection takes the whole class's `sum` with it, and only the
   * tests that ran afterwards say so.
   */
  previous?: PropertyDescriptor
}

const registries = new WeakMap<object, Map<string, Registered>>()

function registryFor(target: object): Map<string, Registered> {
  const existing = registries.get(target)

  if (existing) return existing

  const created = new Map<string, Registered>()
  registries.set(target, created)

  return created
}

/** Where a macro lands: a class's prototype, or the object itself. */
function hostOf(target: object): Record<string, unknown> {
  return typeof target === 'function'
    ? ((target as { prototype: Record<string, unknown> }).prototype ?? target)
    : (target as Record<string, unknown>)
}

function define(on: object, name: string, value: unknown): void {
  Object.defineProperty(on, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false
  })
}

/** Every own method of an object, or of a class's prototype. */
function methodsOf(source: object): Array<[string, Macro]> {
  const host = hostOf(source)

  return Object.getOwnPropertyNames(host)
    .filter((name) => name !== 'constructor' && typeof host[name] === 'function')
    .map((name) => [name, host[name] as Macro])
}

/** Give a target `macro`, `mixin`, `hasMacro` and `flushMacros`. */
export function macroable<T extends object>(target: T): T & Macroed {
  const host = hostOf(target)
  const macros = registryFor(target)

  const methods: Macroed = {
    macro(name: string, callback: Macro): void {
      const previous = macros.get(name)?.previous ?? Object.getOwnPropertyDescriptor(host, name)

      macros.set(name, { callback, previous })
      define(host, name, callback)
    },

    mixin(source: object, replace = true): void {
      for (const [name, callback] of methodsOf(source)) {
        if (!replace && name in host) continue

        methods.macro(name, callback)
      }
    },

    hasMacro(name: string): boolean {
      return macros.has(name)
    },

    flushMacros(): void {
      for (const [name, { previous }] of macros) {
        delete host[name]

        if (previous) Object.defineProperty(host, name, previous)
      }

      macros.clear()
    }
  }

  // Not enumerable, so a target whose own entries are walked — `Str` is, to
  // build the fluent chain — does not see these as helpers of its own.
  for (const [name, value] of Object.entries(methods)) define(target, name, value)

  return target as T & Macroed
}

/**
 * The same, for a class that would rather inherit it than be wrapped.
 *
 * `this` in these statics is the concrete subclass, which is the whole point:
 * `Collection.macro(…)` must land on `Collection.prototype`, not on this one.
 *
 * biome-ignore lint/complexity/noStaticOnlyClass: the statics are the point — a
 * base other classes extend to gain them, which is what keeps each subclass's
 * macros its own.
 */
export abstract class Macroable {
  static macro(this: object, name: string, callback: Macro): void {
    macroable(this).macro(name, callback)
  }

  static mixin(this: object, source: object, replace = true): void {
    macroable(this).mixin(source, replace)
  }

  static hasMacro(this: object, name: string): boolean {
    return macroable(this).hasMacro(name)
  }

  static flushMacros(this: object): void {
    macroable(this).flushMacros()
  }
}
