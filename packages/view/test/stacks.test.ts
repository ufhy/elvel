import { describe, expect, test } from 'bun:test'
import { JsxViewFactory } from '../src/factory.ts'
import { once, prepend, push, pushOnce, stack } from '../src/stacks.ts'

const factory = new JsxViewFactory({ doctype: false })

describe('stacks', () => {
  /**
   * The whole reason the feature exists.
   *
   * `<head>` is rendered before `children`, so by the time the page body runs the
   * head is already a string. Anything that collected pushes at render time and
   * printed them in place would print nothing here.
   */
  test('a page can put something in a head that rendered before it', async () => {
    const markup = await factory.render(
      () =>
        `<html><head>${stack('head')}</head><body>${push('head', '<link rel="x" />')}ok</body></html>`,
      {}
    )

    expect(markup).toBe('<html><head><link rel="x" /></head><body>ok</body></html>')
  })

  test('pushes come out in the order they were written', async () => {
    const markup = await factory.render(
      () => `${push('s', 'one')}${push('s', 'two')}[${stack('s')}]`,
      {}
    )

    expect(markup).toBe('[onetwo]')
  })

  /**
   * Prepends reverse, which is what makes the name mean something.
   *
   * The last thing prepended ends up nearest the top, and every prepend sits
   * ahead of every push regardless of when it was written. Blade's order.
   */
  test('prepends come out reversed and ahead of the pushes', async () => {
    const markup = await factory.render(
      () => `${push('s', 'p')}${prepend('s', 'a')}${prepend('s', 'b')}[${stack('s')}]`,
      {}
    )

    expect(markup).toBe('[bap]')
  })

  test('an empty stack leaves nothing behind', async () => {
    expect(await factory.render(() => `[${stack('nobody')}]`, {})).toBe('[]')
  })

  test('several stacks on one page stay apart', async () => {
    const markup = await factory.render(
      () => `${push('a', '1')}${push('b', '2')}[${stack('a')}][${stack('b')}]`,
      {}
    )

    expect(markup).toBe('[1][2]')
  })

  /**
   * The marker is not forgeable from page content.
   *
   * Its id is random per render, so a comment a visitor typed into a field cannot
   * name a stack and have somebody else's markup substituted into it.
   */
  test('a marker written by hand is left alone', async () => {
    const markup = await factory.render(
      () => `${push('head', '<script></script>')}<!--elysian:stack:guessed:head-->${stack('head')}`,
      {}
    )

    expect(markup).toBe('<!--elysian:stack:guessed:head--><script></script>')
  })

  test('two renders do not see each other', async () => {
    const first = await factory.render(() => `${push('s', 'first')}[${stack('s')}]`, {})
    const second = await factory.render(() => `[${stack('s')}]`, {})

    expect(first).toBe('[first]')
    // Module-level state would have leaked `first` into this one.
    expect(second).toBe('[]')
  })

  /**
   * Concurrent renders keep their own stacks.
   *
   * Two requests render at the same time on one process, and an implementation
   * that kept the pushes in a module variable would put one page's scripts in the
   * other's head. `AsyncLocalStorage` is what stops it.
   */
  test('and concurrent renders do not either', async () => {
    const slow = factory.render(async () => {
      push('s', 'slow')
      await Bun.sleep(10)

      return `[${stack('s')}]`
    }, {})

    const quick = factory.render(() => `${push('s', 'quick')}[${stack('s')}]`, {})

    expect(await quick).toBe('[quick]')
    expect(await slow).toBe('[slow]')
  })
})

describe('once', () => {
  test('renders the first time and nothing after', async () => {
    const widget = () => once('widget', '<style></style>') + '<div></div>'

    expect(await factory.render(() => widget() + widget() + widget(), {})).toBe(
      '<style></style><div></div><div></div><div></div>'
    )
  })

  test('and starts again on the next page', async () => {
    const widget = () => once('widget', '<style></style>')

    expect(await factory.render(widget, {})).toBe('<style></style>')
    expect(await factory.render(widget, {})).toBe('<style></style>')
  })

  test('different ids are counted separately', async () => {
    expect(await factory.render(() => once('a', 'A') + once('b', 'B') + once('a', 'A'), {})).toBe(
      'AB'
    )
  })

  test('pushOnce sends one copy to the stack', async () => {
    const widget = () => pushOnce('head', 'w', '<style></style>')

    const markup = await factory.render(() => `${widget()}${widget()}[${stack('head')}]`, {})

    expect(markup).toBe('[<style></style>]')
  })
})

describe('outside a render', () => {
  /**
   * A component called directly in a test still works.
   *
   * `stack()` answers with an empty string rather than a marker nobody will
   * substitute, and `once()` renders — because "at most once" and "never" are
   * different, and returning nothing would make the component look broken.
   */
  test('stack is empty and once renders', () => {
    expect(stack('head')).toBe('')
    expect(push('head', 'x')).toBe('')
    expect(once('id', 'content')).toBe('content')
  })
})
