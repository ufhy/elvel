import { describe, expect, test } from 'bun:test'
import { Application } from '@elvel/core'
import { type Content, type Envelope, Mailable, markdownContent } from '../src/mailable.ts'
import { MailManager } from '../src/manager.ts'
import { handlePreview, previewable } from '../src/preview.ts'

/**
 * Looking at a mail without sending one, and without a second service.
 *
 * Laravel gets the rendering from one interface — `Mailable implements Renderable`,
 * so a route returning a mailable renders it — and leaves the page to you. Catching
 * mail is Mailpit's job there, which is a container in `laravel/sail` rather than
 * anything the framework ships.
 *
 * These cover the page: which mailables appear, which sample is shown, and the two
 * ways it must refuse.
 */
class InvoicePaid extends Mailable<{ number: string }> {
  envelope(): Envelope {
    return { subject: `Invoice ${this.data.number}` }
  }

  content(): Content {
    return markdownContent(`Invoice **${this.data.number}** is settled.`, {
      action: { text: 'View', url: 'https://example.com/r' }
    })
  }

  static preview(): InvoicePaid[] {
    return [new InvoicePaid({ number: 'INV-001' }), new InvoicePaid({ number: 'INV-002' })]
  }
}

/** A mailable with no sample, which is most of them. */
class Silent extends Mailable<Record<string, never>> {
  envelope(): Envelope {
    return { subject: 'Nothing' }
  }

  content(): Content {
    return markdownContent('Nothing to see.')
  }
}

async function manager(): Promise<MailManager> {
  const app = new Application(process.cwd())

  app.config.set('mail', {
    default: 'array',
    // A scaffolded application always has one; rendering reads it like sending does.
    from: { address: 'hello@example.com', name: 'Example' },
    mailers: { array: { transport: 'array' } }
  })

  const made = new MailManager(app)

  made.mailables.register(InvoicePaid, Silent)

  return made
}

const ask = async (path: string) =>
  handlePreview(await manager(), new Request(`http://localhost${path}`), '/_mail')

describe('the mail preview page', () => {
  test('lists only the mailables that offer a sample', async () => {
    expect(previewable(await manager())).toEqual([{ name: 'InvoicePaid', samples: 2 }])
  })

  test('the index names every sample, not just the mailable', async () => {
    const body = await (await ask('/_mail'))?.text()

    expect<boolean>(body?.includes('InvoicePaid 1') ?? false).toBe(true)
    expect<boolean>(body?.includes('InvoicePaid 2') ?? false).toBe(true)
    // The one with nothing to show is not offered as a dead link.
    expect<boolean>(body?.includes('Silent') ?? false).toBe(false)
  })

  /**
   * The frame asks for the same URL with `raw=1`, so opening a mail in its own tab
   * needs no second route — and what comes back is the mail itself, not the page.
   */
  test('raw answers the rendered mail rather than the page', async () => {
    const body = await (await ask('/_mail?mailable=InvoicePaid&sample=1&raw=1'))?.text()

    expect<boolean>(body?.includes('INV-002') ?? false).toBe(true)
    expect<boolean>(body?.includes('Mail preview') ?? false).toBe(false)
    // The layout, which is what markdown alone used to be missing.
    expect<boolean>(body?.includes('View') ?? false).toBe(true)
  })

  test('and a sample index out of range falls back rather than throwing', async () => {
    const answer = await ask('/_mail?mailable=InvoicePaid&sample=99')

    expect<number | undefined>(answer?.status).toBe(404)
  })

  test('a mailable nobody registered is a 404, not a stack trace', async () => {
    expect<number | undefined>((await ask('/_mail?mailable=Nope'))?.status).toBe(404)
  })

  /**
   * Anything that is not the preview path is somebody else's request.
   *
   * The handler runs from an `onRequest` hook, which sees every request in the
   * application — returning anything but `undefined` here would answer for routes
   * that have nothing to do with mail.
   */
  test('and another address is left alone', async () => {
    expect<Response | undefined>(await ask('/dashboard')).toBeUndefined()
  })
})
