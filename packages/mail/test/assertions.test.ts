import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { expectMessage } from '../src/assertions.ts'
import type { MailFake } from '../src/fake.ts'
import { type Content, type Envelope, Mailable } from '../src/mailable.ts'
import { MailManager } from '../src/manager.ts'

class Invoice extends Mailable<{ customer: string }> {
  envelope(): Envelope {
    return {
      from: { address: 'billing@example.com', name: 'Billing' },
      to: [{ address: 'ada@example.com', name: 'Ada' }],
      cc: 'accounts@example.com',
      bcc: 'archive@example.com',
      replyTo: 'support@example.com',
      subject: 'Your invoice',
      tags: ['billing'],
      metadata: { invoice: '42' },
      headers: { 'x-campaign': 'monthly' }
    }
  }

  content(): Content {
    return {
      // The apostrophe is the point of the escaping test below.
      html: `<p>Hello ${this.data.customer.replaceAll("'", '&#39;')}.</p><p>Line one</p><p>Total: 42</p>`,
      text: `Hello ${this.data.customer}.\nLine one\nTotal: 42`
    }
  }

  override attachments() {
    return [{ filename: 'invoice.pdf', content: 'PDF-BYTES', contentType: 'application/pdf' }]
  }
}

class Bare extends Mailable<Record<string, never>> {
  envelope(): Envelope {
    return { from: 'hello@example.com', to: 'ada@example.com', subject: 'Nothing attached' }
  }

  content(): Content {
    return { text: 'Nothing here.' }
  }
}

let manager: MailManager
let fake: MailFake

beforeEach(async () => {
  const app = new Application(process.cwd())
  app.config.set('mail.default', 'array')
  app.config.set('mail.from', 'hello@example.com')
  app.config.set('mail.mailers', { array: { transport: 'array' } })

  manager = new MailManager(app)
  fake = manager.fake()

  await manager.mailer().send(new Invoice({ customer: "O'Brien" }))
})

afterEach(() => {
  manager.restore()
})

describe('recipients', () => {
  test('every field can be asserted, by address or with a name', () => {
    fake
      .assertSent('Invoice')
      .assertHasTo('ada@example.com')
      .assertHasTo('ada@example.com', 'Ada')
      .assertTo({ address: 'ada@example.com', name: 'Ada' })
      .assertHasCc('accounts@example.com')
      .assertHasBcc('archive@example.com')
      .assertHasReplyTo('support@example.com')
      .assertFrom('billing@example.com', 'Billing')
  })

  test('a wrong name fails even when the address is right', () => {
    // The failure a name-less assertion cannot see: right inbox, wrong person on
    // the envelope, which is what a merged customer record looks like.
    expect(() => fake.assertSent('Invoice').assertHasTo('ada@example.com', 'Grace')).toThrow(
      /Did not see the expected recipient in "to"/
    )
  })

  test('the failure names who did receive it', () => {
    expect(() => fake.assertSent('Invoice').assertHasTo('nobody@example.com')).toThrow(
      /Ada <ada@example.com>/
    )
  })

  /**
   * The assertion that catches a leak rather than a typo.
   *
   * `assertHasTo` passes on a message that also went to two hundred other
   * people; this is the one that does not.
   */
  test('assertOnlyRecipients refuses an extra copy', () => {
    fake
      .assertSent('Invoice')
      .assertOnlyRecipients(['ada@example.com', 'accounts@example.com', 'archive@example.com'])

    expect(() => fake.assertSent('Invoice').assertOnlyRecipients(['ada@example.com'])).toThrow(
      /Unexpected recipients: \[accounts@example.com, archive@example.com\]/
    )
  })
})

describe('the envelope', () => {
  test('subject, tag, metadata and header', () => {
    fake
      .assertSent('Invoice')
      .assertHasSubject('Your invoice')
      .assertHasTag('billing')
      .assertHasMetadata('invoice')
      .assertHasMetadata('invoice', '42')
      .assertHasHeader('x-campaign', 'monthly')
  })

  test('a present key with the wrong value still fails', () => {
    expect(() => fake.assertSent('Invoice').assertHasMetadata('invoice', '43')).toThrow(
      /to be \[43\] but it was \[42\]/
    )
    expect(() => fake.assertSent('Invoice').assertHasTag('marketing')).toThrow(/Tags: \[billing\]/)
  })
})

describe('the bodies', () => {
  /**
   * Escaping on by default, which is what makes this usable.
   *
   * The view wrote `O&#39;Brien`; a raw search for `O'Brien` finds nothing in a
   * message that is perfectly correct. The needle is escaped the same way the
   * view escaped the value.
   */
  test('assertSeeInHtml escapes the needle', () => {
    fake.assertSent('Invoice').assertSeeInHtml("O'Brien")

    // And can be told not to, for markup the assertion is checking on purpose.
    fake.assertSent('Invoice').assertSeeInHtml('<p>Line one</p>', false)
  })

  test('the text body is not escaped, because it is not HTML', () => {
    fake.assertSent('Invoice').assertSeeInText("O'Brien").assertDontSeeInText('&#39;')
  })

  test('assertDontSeeInHtml', () => {
    fake.assertSent('Invoice').assertDontSeeInHtml('Refund')

    expect(() => fake.assertSent('Invoice').assertDontSeeInHtml("O'Brien")).toThrow(
      /and should not have/
    )
  })

  /**
   * Order, not merely presence.
   *
   * "Total" before the line items is a different invoice from "Total" after
   * them, and two `assertSeeInHtml` calls cannot tell the two apart.
   */
  test('assertSeeInOrder fails when the order is wrong', () => {
    fake.assertSent('Invoice').assertSeeInOrderInHtml(['Hello', 'Line one', 'Total'])
    fake.assertSent('Invoice').assertSeeInOrderInText(['Hello', 'Line one', 'Total'])

    expect(() => fake.assertSent('Invoice').assertSeeInOrderInHtml(['Total', 'Line one'])).toThrow(
      /after the ones before it/
    )
  })

  test('a missing body is empty rather than an exception', async () => {
    await manager.mailer().send(new Bare({}))

    expect(() => fake.assertSent('Bare').assertSeeInHtml('anything')).toThrow(
      /Did not see \[anything\] in the HTML body/
    )
  })
})

describe('attachments', () => {
  test('by name, and by name with its bytes', () => {
    fake
      .assertSent('Invoice')
      .assertHasAttachment('invoice.pdf')
      .assertHasAttachedData('invoice.pdf', 'PDF-BYTES')
  })

  test('the right name with the wrong bytes fails', () => {
    // An empty or half-written file has the right name too, which is exactly the
    // bug a name-only assertion lets through.
    expect(() =>
      fake.assertSent('Invoice').assertHasAttachedData('invoice.pdf', 'SOMETHING-ELSE')
    ).toThrow(/is not the content expected/)
  })

  test('assertHasNoAttachments', async () => {
    await manager.mailer().send(new Bare({}))

    fake.assertSent('Bare').assertHasNoAttachments()

    expect(() => fake.assertSent('Invoice').assertHasNoAttachments()).toThrow(
      /but found: invoice.pdf/
    )
  })
})

describe('without sending', () => {
  /**
   * The same assertions on a message that never went anywhere.
   *
   * `build()` resolves the view, the addresses and the subject without a
   * transport, so a mailable can be checked in isolation — which is what
   * Laravel's assertions on `Mailable` itself are for.
   */
  test('build() then assert', async () => {
    const built = await manager.mailer().build(new Invoice({ customer: 'Ada' }))

    expectMessage(built).assertHasSubject('Your invoice').assertSeeInHtml('Hello Ada.')
  })
})

describe('chaining', () => {
  test('the failure names the first thing that was wrong', () => {
    // Not the last: a chain that reported the final failure would send somebody
    // to the wrong end of the message.
    expect(() =>
      fake
        .assertSent('Invoice')
        .assertHasSubject('Something else')
        .assertHasTo('nobody@example.com')
    ).toThrow(/Expected subject \[Something else\]/)
  })

  test('and every failure says which message it was', () => {
    expect(() => fake.assertSent('Invoice').assertHasSubject('x')).toThrow(
      /Message: \[Invoice\] "Your invoice"/
    )
  })
})
