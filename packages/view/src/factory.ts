import type { ViewComponent, ViewFactory } from '@elvel/contracts'
import { resolveStacks, withStacks } from './stacks.ts'

const DOCTYPE = '<!DOCTYPE html>'

/** Leading whitespace then `<html`, case-insensitively — anchored, so it stops early. */
const OPENS_WITH_HTML = /^\s*<html/i

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

      /**
       * Asked with an anchored regex, which reads the front of the page and stops.
       *
       * `markup.trimStart().toLowerCase()` copies the rendered document twice to
       * look at five characters of it — 26µs on a 50KB page, per render, against
       * 0.014µs here. A bounded `slice` was the first attempt and it was wrong: a
       * page with forty characters of leading whitespace lost its doctype, because
       * the slice ended before the markup began.
       */
      return OPENS_WITH_HTML.test(markup) ? `${DOCTYPE}${markup}` : markup
    })
  }
}
