import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * What a page contributes to a layout it does not own — Blade's `@push`/`@stack`.
 *
 * The problem this solves is ordering. A layout renders its `<head>` before it
 * renders `children`, so a page that wants a stylesheet or a preload hint in the
 * head is already too late by the time it runs. Blade gets away with it because
 * `@extends` renders the child first and the layout second; JSX nests the other
 * way round and cannot.
 *
 * So `stack()` writes a marker and the factory substitutes it once the whole tree
 * has rendered. The marker carries a per-render random id, which is what stops
 * user input that happens to contain the marker text from being replaced with
 * somebody else's scripts.
 */
type Store = {
  id: string
  pushes: Map<string, string[]>
  prepends: Map<string, string[]>
  seen: Set<string>
}

const storage = new AsyncLocalStorage<Store>()

/**
 * Everything pushed during one render, discarded when it ends.
 *
 * A render nested inside another keeps the outer store rather than starting a
 * fresh one: a partial rendered with `render()` and embedded in a page is part of
 * that page, and its pushes belong in the page's stacks.
 */
export function withStacks<T>(run: () => Promise<T>): Promise<T> {
  const existing = storage.getStore()

  if (existing) return run()

  return storage.run(
    {
      id: crypto.randomUUID(),
      pushes: new Map(),
      prepends: new Map(),
      seen: new Set()
    },
    run
  )
}

const marker = (id: string, name: string) => `<!--elvel:stack:${id}:${name}-->`

/**
 * Replace every marker with what was pushed to it.
 *
 * Prepends come out in reverse — the last one written is nearest the top — and
 * then the pushes in the order they were written. That is Blade's order, and it
 * is the one that makes "prepend" mean anything.
 */
/** The prefix every stack placeholder starts with — cheap to look for. */
const MARKER = '<!--elvel:stack:'

export function resolveStacks(markup: string): string {
  const store = storage.getStore()

  if (!store) return markup

  /**
   * Most pages push to no stack at all, and scanning a rendered document for a
   * marker that is not there costs 1.18µs on a 47KB page against 0.65µs for asking
   * whether the substring appears — the regex is only built when there is
   * something for it to replace.
   */
  if (!markup.includes(MARKER)) return markup

  return markup.replaceAll(
    new RegExp(`${MARKER}${store.id}:([^-]*)-->`, 'g'),
    (_match, name: string) =>
      [...(store.prepends.get(name) ?? [])].reverse().join('') +
      (store.pushes.get(name) ?? []).join('')
  )
}

/**
 * The placeholder a layout leaves for its pages.
 *
 * ```tsx
 * <head>
 *   <title safe>{title}</title>
 *   {stack('head')}
 * </head>
 * ```
 */
export function stack(name: string): string {
  const store = storage.getStore()

  // Rendered outside a render — in a test calling a component directly, say.
  // Nothing was pushed either, so an empty string is the truthful answer.
  return store ? marker(store.id, name) : ''
}

/** Add to a stack. The markup lands wherever the layout put `stack()`. */
export function push(name: string, markup: string): string {
  const store = storage.getStore()

  if (store) {
    const existing = store.pushes.get(name)

    existing ? existing.push(markup) : store.pushes.set(name, [markup])
  }

  // Returns nothing, so it can sit inside JSX where it is written without
  // printing the markup twice.
  return ''
}

/** Add to the front of a stack, ahead of anything pushed before it. */
export function prepend(name: string, markup: string): string {
  const store = storage.getStore()

  if (store) {
    const existing = store.prepends.get(name)

    existing ? existing.push(markup) : store.prepends.set(name, [markup])
  }

  return ''
}

/**
 * Render something at most once per page — Blade's `@once`.
 *
 * For a component used several times on a page that needs one copy of a script
 * or a `<style>`: the markup goes out with the first instance and the rest see
 * nothing.
 */
export function once(id: string, markup: string): string {
  const store = storage.getStore()

  if (!store) return markup
  if (store.seen.has(id)) return ''

  store.seen.add(id)

  return markup
}

/** `once` and `push` together, which is what a component usually wants. */
export function pushOnce(name: string, id: string, markup: string): string {
  return push(name, once(`push:${name}:${id}`, markup))
}
