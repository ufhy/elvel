import type { ViewComponent, ViewFactory } from '@elysian/contracts'
import { resolveStacks, withStacks } from './stacks.ts'

const DOCTYPE = '<!DOCTYPE html>'

export type ViewFactoryOptions = {
  /**
   * Prepend `<!DOCTYPE html>` when the rendered markup starts with `<html`.
   * JSX has no doctype node, so without this every full page would have to
   * carry the string by hand.
   */
  doctype?: boolean
}

/**
 * View renderer for `@kitajs/html` components.
 *
 * There is no template engine, no view path, and no compile cache: a view is a
 * TypeScript function, so Bun's own module cache is the compile cache and
 * `tsc` is the template checker. Props are checked at every call site.
 */
export class JsxViewFactory implements ViewFactory {
  constructor(private readonly options: ViewFactoryOptions = {}) {}

  async render<Props>(component: ViewComponent<Props>, props: Props): Promise<string> {
    return withStacks(async () => {
      // Substituted after the whole tree has rendered, which is the only moment
      // a `<head>` can hold something a page body pushed to it.
      const markup = resolveStacks(await component(props))

      if (this.options.doctype === false) return markup

      return markup.trimStart().toLowerCase().startsWith('<html') ? `${DOCTYPE}${markup}` : markup
    })
  }
}
