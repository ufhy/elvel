import { describe, expect, test } from 'bun:test'
import { JsxViewFactory } from '../src/factory.ts'

const factory = new JsxViewFactory()

describe('JsxViewFactory', () => {
  test('renders a component with its props', async () => {
    const Greeting = ({ name }: { name: string }) => `<p>Hello ${name}</p>`

    expect(await factory.render(Greeting, { name: 'Elyvel' })).toBe('<p>Hello Elyvel</p>')
  })

  test('awaits async components', async () => {
    const Delayed = async ({ name }: { name: string }) => `<p>${await Promise.resolve(name)}</p>`

    expect(await factory.render(Delayed, { name: 'later' })).toBe('<p>later</p>')
  })

  test('prepends the doctype for a full document', async () => {
    const Page = () => '<html lang="en"><body></body></html>'

    expect(await factory.render(Page, {})).toBe(
      '<!DOCTYPE html><html lang="en"><body></body></html>'
    )
  })

  test('detects the document regardless of leading whitespace or case', async () => {
    const Padded = () => '\n  <HTML></HTML>'

    expect(await factory.render(Padded, {})).toStartWith('<!DOCTYPE html>')
  })

  test('leaves partials alone', async () => {
    const Partial = () => '<p>fragment</p>'

    expect(await factory.render(Partial, {})).toBe('<p>fragment</p>')
  })

  test('never doubles an existing doctype', async () => {
    const Page = () => '<!DOCTYPE html><html></html>'

    expect(await factory.render(Page, {})).toBe('<!DOCTYPE html><html></html>')
  })

  test('doctype: false opts out entirely', async () => {
    const bare = new JsxViewFactory({ doctype: false })
    const Page = () => '<html></html>'

    expect(await bare.render(Page, {})).toBe('<html></html>')
  })

  test('renders an empty component', async () => {
    expect(await factory.render(() => '', {})).toBe('')
  })
})
