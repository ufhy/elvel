import type { Attachment } from './mailable.ts'
import type { SentMessage } from './message.ts'

/** An address as an assertion names it: `'ada@example.com'` or with a name. */
export type ExpectedAddress = string | { address: string; name?: string }

type Mailbox = { address: string; name?: string }

const show = (list: Mailbox[]) =>
  list.length === 0
    ? '(none)'
    : list.map((one) => (one.name ? `${one.name} <${one.address}>` : one.address)).join(', ')

function matches(list: Mailbox[], expected: ExpectedAddress, name?: string): boolean {
  const address = typeof expected === 'string' ? expected : expected.address
  const expectedName = typeof expected === 'string' ? name : (expected.name ?? name)

  return list.some(
    (one) => one.address === address && (expectedName === undefined || one.name === expectedName)
  )
}

/**
 * Assertions on a message that was built — Laravel's `Mailable::assertHasTo` and
 * its twenty relatives.
 *
 * The fake could already say *that* a mailable went out; this says *what was in
 * it*. The difference matters more than it sounds: a test that only checks a
 * class name passes when the subject is empty, the body is the wrong template,
 * and the invoice went to the wrong customer.
 *
 * These read a `SentMessage` — everything already resolved — which means the same
 * assertions work on a message the fake captured and on one built with
 * `Mailer.build()` without sending anything at all.
 *
 * Every method returns `this`, so a failure names the first thing that was wrong
 * rather than the last.
 */
export class MessageAssertions {
  constructor(readonly message: SentMessage) {}

  private fail(what: string): never {
    throw new Error(`${what}\nMessage: [${this.message.mailable}] "${this.message.subject}"`)
  }

  // ------------------------------------------------------------- recipients

  assertHasTo(address: ExpectedAddress, name?: string): this {
    if (!matches(this.message.to, address, name)) {
      this.fail(
        `Did not see the expected recipient in "to".\nExpected: [${typeof address === 'string' ? address : address.address}]\nActual: [${show(this.message.to)}]`
      )
    }

    return this
  }

  /** Laravel keeps both spellings; so does this. */
  assertTo(address: ExpectedAddress, name?: string): this {
    return this.assertHasTo(address, name)
  }

  assertHasCc(address: ExpectedAddress, name?: string): this {
    if (!matches(this.message.cc, address, name)) {
      this.fail(`Did not see the expected recipient in "cc".\nActual: [${show(this.message.cc)}]`)
    }

    return this
  }

  assertHasBcc(address: ExpectedAddress, name?: string): this {
    if (!matches(this.message.bcc, address, name)) {
      this.fail(`Did not see the expected recipient in "bcc".\nActual: [${show(this.message.bcc)}]`)
    }

    return this
  }

  assertHasReplyTo(address: ExpectedAddress, name?: string): this {
    if (!matches(this.message.replyTo, address, name)) {
      this.fail(
        `Did not see the expected address in "reply-to".\nActual: [${show(this.message.replyTo)}]`
      )
    }

    return this
  }

  assertFrom(address: ExpectedAddress, name?: string): this {
    if (!matches([this.message.from], address, name)) {
      this.fail(`Did not see the expected sender.\nActual: [${show([this.message.from])}]`)
    }

    return this
  }

  /**
   * Nobody outside this list received it.
   *
   * The assertion that catches a leak rather than a mistake: `assertHasTo` passes
   * happily on a message that also went to two hundred other people.
   */
  assertOnlyRecipients(addresses: string[]): this {
    const actual = [...this.message.to, ...this.message.cc, ...this.message.bcc].map(
      (one) => one.address
    )
    const extra = actual.filter((one) => !addresses.includes(one))

    if (extra.length > 0) {
      this.fail(`Unexpected recipients: [${extra.join(', ')}]\nAll: [${actual.join(', ')}]`)
    }

    return this
  }

  // ---------------------------------------------------------------- envelope

  assertHasSubject(subject: string): this {
    if (this.message.subject !== subject) {
      this.fail(`Expected subject [${subject}] but the message says [${this.message.subject}].`)
    }

    return this
  }

  assertHasTag(tag: string): this {
    if (!this.message.tags.includes(tag)) {
      this.fail(`Expected tag [${tag}]. Tags: [${this.message.tags.join(', ') || '(none)'}]`)
    }

    return this
  }

  assertHasMetadata(key: string, value?: string): this {
    const actual = this.message.metadata[key]

    if (actual === undefined) {
      this.fail(
        `Expected metadata [${key}]. Keys: [${Object.keys(this.message.metadata).join(', ') || '(none)'}]`
      )
    }

    if (value !== undefined && actual !== value) {
      this.fail(`Expected metadata [${key}] to be [${value}] but it was [${actual}].`)
    }

    return this
  }

  assertHasHeader(name: string, value?: string): this {
    const actual = this.message.headers[name]

    if (actual === undefined) {
      this.fail(
        `Expected header [${name}]. Headers: [${Object.keys(this.message.headers).join(', ') || '(none)'}]`
      )
    }

    if (value !== undefined && actual !== value) {
      this.fail(`Expected header [${name}] to be [${value}] but it was [${actual}].`)
    }

    return this
  }

  // -------------------------------------------------------------- the bodies

  /**
   * `escaped` defaults on, and that is the setting that makes this useful.
   *
   * A name with an apostrophe in it renders as `O&#39;Brien`, so a raw search for
   * `O'Brien` fails on a page that is perfectly correct. The needle is escaped the
   * same way the view escaped the value, which is what makes the two comparable.
   *
   * Named `escaped` rather than `escape` because `escape` is a global function:
   * a parameter of that name shadows it, which the linter refuses and which
   * would silently break any code in scope that expected the global.
   */
  assertSeeInHtml(needle: string, escaped = true): this {
    const html = this.message.html ?? ''
    const wanted = escaped ? escapeHtml(needle) : needle

    if (!html.includes(wanted)) {
      this.fail(`Did not see [${wanted}] in the HTML body.`)
    }

    return this
  }

  assertDontSeeInHtml(needle: string, escaped = true): this {
    const html = this.message.html ?? ''
    const wanted = escaped ? escapeHtml(needle) : needle

    if (html.includes(wanted)) {
      this.fail(`Saw [${wanted}] in the HTML body, and should not have.`)
    }

    return this
  }

  /**
   * Each one after the last, not merely all present.
   *
   * "Total" appearing before every line item is a different page from the one
   * where it appears after, and `assertSeeInHtml` twice cannot tell them apart.
   */
  assertSeeInOrderInHtml(needles: string[], escaped = true): this {
    return this.assertInOrder(this.message.html ?? '', needles, escaped, 'HTML')
  }

  assertSeeInText(needle: string): this {
    if (!(this.message.text ?? '').includes(needle)) {
      this.fail(`Did not see [${needle}] in the text body.`)
    }

    return this
  }

  assertDontSeeInText(needle: string): this {
    if ((this.message.text ?? '').includes(needle)) {
      this.fail(`Saw [${needle}] in the text body, and should not have.`)
    }

    return this
  }

  assertSeeInOrderInText(needles: string[]): this {
    return this.assertInOrder(this.message.text ?? '', needles, false, 'text')
  }

  private assertInOrder(body: string, needles: string[], escaped: boolean, which: string): this {
    let cursor = 0

    for (const needle of needles) {
      const wanted = escaped ? escapeHtml(needle) : needle
      const at = body.indexOf(wanted, cursor)

      if (at === -1) {
        this.fail(
          `Did not see [${wanted}] in the ${which} body after the ones before it.\nOrder expected: [${needles.join(' → ')}]`
        )
      }

      cursor = at + wanted.length
    }

    return this
  }

  // ------------------------------------------------------------ attachments

  /**
   * By filename, because that is all a built message remembers.
   *
   * Laravel has `assertHasAttachmentFromStorageDisk`, which this cannot answer:
   * a disk attachment is resolved to bytes while the message is built, precisely
   * so a queued message does not depend on the disk still holding the file. By
   * the time there is a message to assert on, where it came from is gone.
   */
  assertHasAttachment(filename: string): this {
    if (!this.message.attachments.some((one) => one.filename === filename)) {
      this.fail(`Expected an attachment named [${filename}].\nAttached: ${this.attached()}`)
    }

    return this
  }

  /** The bytes as well as the name — for a file the application generated. */
  assertHasAttachedData(filename: string, content: string | Uint8Array): this {
    const found = this.message.attachments.find((one) => one.filename === filename)

    if (!found) {
      this.fail(`Expected an attachment named [${filename}].\nAttached: ${this.attached()}`)
    }

    if (bytesOf(found) !== bytesOf({ content })) {
      this.fail(`The attachment [${filename}] is not the content expected.`)
    }

    return this
  }

  assertHasNoAttachments(): this {
    if (this.message.attachments.length > 0) {
      this.fail(`Expected no attachments, but found: ${this.attached()}`)
    }

    return this
  }

  private attached(): string {
    return this.message.attachments.map((one) => one.filename).join(', ') || '(none)'
  }
}

/** Assert on any built message, whether it was sent or only built. */
export function expectMessage(message: SentMessage): MessageAssertions {
  return new MessageAssertions(message)
}

/** The five characters an HTML view escapes, so a needle can be compared to it. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Attachment content as a comparable string, whatever form it arrived in. */
function bytesOf(attachment: Pick<Attachment, 'content'>): string {
  const content = attachment.content

  if (content === undefined) return ''

  return typeof content === 'string' ? content : new TextDecoder().decode(content)
}
