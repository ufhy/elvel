# Mail

A mailable describes a message; a mailer sends it. Views are the **same JSX
components** the web pages use — there is no second template engine.

```ts
import { Mailable, viewContent } from '@elvel/mail'

export class ArticlePublished extends Mailable<{ title: string; name: string }> {
  envelope() {
    return { subject: `Published: ${this.data.title}`, replyTo: 'editor@example.com' }
  }

  content() {
    return viewContent(ArticleMail, { title: this.data.title, name: this.data.name })
  }

  attachments() {
    return [{ filename: 'notes.txt', content: 'the notes' }]
  }
}
```

```ts
import { mailTo } from '@elvel/mail'

await mailTo(user.email).send(new ArticlePublished({ title, name }))
await mailTo(user.email).cc(editor).bcc(archive).send(mailable)
```

`bun elvel make:mail ArticlePublished` writes the class.

`data` is the constructor argument, as with a queued job, and for the same
reason: a mailable can be queued, and then only its data travels.

## `viewContent`, and why it is a function

```ts
content() {
  return viewContent(ArticleMail, { title: this.data.title }, 'the plain text part')
}
```

A missing or misspelled prop is a compile error **at this call site**, which is
the only place that can know what the component wants. A `content()` that
returned a typed `Content<Props>` would force every mailable in the application
to agree on one props type; erasing it in the return and checking it in the
helper is what lets each mailable keep its own.

`{ html, text }` and `{ text }` are the other two shapes, for a message with no
view.

## Addresses

A recipient is a string or `{ address, name }`, and either may be a list:

```ts
{ to: 'ada@example.com' }
{ to: { address: 'ada@example.com', name: 'Ada' } }
{ to: ['a@example.com', { address: 'b@example.com', name: 'B' }] }
```

A display name is quoted when written into the header, so a comma or a colon in
somebody's name cannot break it.

The envelope also carries `cc`, `bcc`, `replyTo`, `tags`, `metadata` and
`headers`; tags and metadata are passed through to transports that understand
them and ignored by those that do not.

## Queueing

```ts
await mailTo(user.email).queue(mailable)
await mailTo(user.email).later(300, mailable)
```

The recipients are resolved **now** and travel with the payload, so a worker does
not have to reconstruct who `mailTo(user.email)` meant. `static queue` and
`static connection` on the mailable pick where it goes.

`build(mailable)` returns the message that would be sent without sending it —
useful in a test, and for a preview route.

## Markdown

```ts
markdownToHtml('# Hi\n\nA **bold** [link](https://example.com)')
```

```html
<h1 style="margin: 0 0 12px; color: #111; font-weight: 600; font-size: 24px;">Hi</h1>
<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.6; color: #333;">A <strong>bold</strong> …
```

Note the inline styles. **Gmail strips `<style>` blocks**, so a
stylesheet-driven renderer produces mail that looks right in the preview and
unstyled in the inbox — the styling has to be attached as the HTML is produced.

It is deliberately a subset of markdown, chosen by what survives in a mail
client: headings, paragraphs, emphasis, links, lists, blockquotes, rules, and
code. No tables, no footnotes, and **no raw HTML passthrough**:

```
markdownToHtml('<script>x</script>')
→ <p style="…">&lt;script&gt;x&lt;/script&gt;</p>
```

Markdown for a mail usually contains a value somebody typed, and passing tags
through is how a display name becomes a phishing link.

A link's *target* is the same question with a different answer, and it took longer to
get right — measured, `[Click](javascript:alert(1))` used to emit the scheme
verbatim. `http:`, `https:`, `mailto:` and root-relative paths survive; everything
else becomes `#`, for links, images and buttons alike. It is mostly inert in a mail
client, which does not run it. It is not inert in the preview below.

## The parts a mail is made of

`markdownContent` wraps its output in a layout, and takes the pieces a transactional
mail usually needs:

```ts
content() {
  return markdownContent(`
    # Thank you

    Invoice **${this.data.number}** is settled.
  `, {
    action: { text: 'View the receipt', url: `https://example.com/r/${this.data.number}` },
    subcopy: `If the button does not work, open https://example.com/r/${this.data.number}`
  })
}
```

One button per message, on purpose: a second competes with the first, and a mail that
asks two things gets neither done. The subcopy is what a client that hides buttons
leaves somebody — usually the same URL as text.

The pieces are exported, for a mail assembled rather than written in markdown:
`heading`, `paragraph`, `button`, `panel`, `subcopy`, `salutation`, and `emailLayout`
around them. `layout: false` renders the markdown alone, for a mail whose markup
somebody else owns.

`layout` also takes a wrapper of your own:

```ts
markdownContent(source, {
  layout: (parts, theme) => `<html><body>${banner(theme)}${emailLayout(parts, theme)}</body></html>`
})
```

It receives the rendered parts and the colours — the signature `emailLayout` has —
so a replacement that only adds something around the default can call it from
inside itself. A notification names the same thing with
[`template()`](/digging-deeper/notifications).

::: tip This is where the notification template went
It used to live inside `MailMessage`, which meant only a notification could have it —
a `Mailable` had no way to render a button at all. Same markup, one owner.
:::

## Colours

```ts
// config/mail.ts
theme: { accent: { info: '#c9241a' } }
```

Only what you name changes. Values rather than a stylesheet, for the reason the
markup carries inline styles: a theme published as CSS looks right in a preview and
unstyled in an inbox.

| | |
| --- | --- |
| `page` | behind the card |
| `card` | the card |
| `ink` | body text and headings |
| `muted` | small print and the salutation |
| `line` | rules and the subcopy divider |
| `accent` | the button, per level: `info`, `success`, `error` |

## Looking at a mail without sending one

```ts
// config/mail.ts
preview: '/_mail'
```

That is the whole setup. Every mailable in `app/Mail` is already discovered, so the
page has its list; one joins it by saying what a sample of itself looks like:

```ts
export class InvoicePaid extends Mailable {
  static preview() {
    return [
      new InvoicePaid({ number: 'INV-001', total: 1200 }),
      new InvoicePaid({ number: 'INV-002', total: 49 })
    ]
  }
}
```

Return an array to show several. An invoice paid and one overdue read very
differently, and the second is the one nobody checks.

Embedded images work here, which is not free: a `cid:` reference points at the
message's own attachments and a browser has none of them, so the renderer inlines
them as data URIs on the way to the page. Without that every embedded image in a
preview is broken, and the person checking the design cannot tell that from an image
that is genuinely missing. What goes to a real client keeps the `cid:`.

::: warning Never in production
The route is not mounted when the application is in production, whatever the config
says. A page that renders every mail you send describes your customers to whoever
finds it.
:::

Laravel gets the rendering half from one interface — `Mailable implements Renderable`,
so a route returning a mailable renders it — and leaves the page to you; catching mail
there is Mailpit, a container in `laravel/sail` rather than part of the framework.
`mailer().render(mailable)` is the same thing when you want the HTML rather than the
page.

## Attachments

```ts
import { attachFromDisk, attachFromUpload, attachFromUrl } from '@elvel/mail'

content() {
  return { view: Invoice, with: { invoice: this.invoice } }
}

async attachments() {
  return [
    { filename: 'invoice.pdf', content: bytes, contentType: 'application/pdf' },
    await attachFromDisk('s3', 'invoices/42.pdf', { as: 'invoice.pdf' }),
    await attachFromUrl('https://example.com/terms.pdf'),
    await attachFromUpload(uploaded, { as: 'your-photo.jpg' })
  ]
}
```

`attachments()` may return a promise, which it has to: all three helpers read the
bytes **now** rather than remembering where they came from.
That is the difference that matters for a queued mail: a path on a local disk
means nothing to another machine, a signed URL expires, and a mail whose
attachment is a broken link arrives looking like it worked.

`as` renames the file — worth doing for an upload, since the name a browser sends
is the name on the sender's own disk and `IMG_4021.HEIC` says nothing to whoever
receives the mail. `cid` makes the attachment embeddable, so `<img src="cid:…">`
in the body shows it inline.

`attachFromUrl` has no allowlist, deliberately: you chose the URL. Do not pass one
a visitor supplied — it fetches from wherever it points, including addresses only
your server can reach.

## Transports

```ts
// config/mail.ts
default: env('MAIL_MAILER', 'log'),

mailers: {
  log:      { transport: 'log' },      // writes the message to the log channel
  array:    { transport: 'array' },    // keeps it in memory, for tests
  smtp:     { transport: 'smtp', host: …, port: …, username: …, password: … },
  resend:   { transport: 'resend', key: env('RESEND_KEY', '') },
  failover: { transport: 'failover', mailers: ['smtp', 'log'] }
}
```

`log` is the default a scaffolded application starts with, which is the right
default while developing: nothing leaves the machine and the message is still
there to read. There is an SES transport as well, and `RoundRobinTransport`
beside `FailoverTransport` for spreading load rather than surviving failure.

`allowSelfSigned` exists for a local mail catcher, and **the manager refuses to
honour it in production** — a setting that makes sense on a laptop and nowhere
else should not quietly follow the code to a server.

## `alwaysTo` — the staging safety net

```ts
alwaysTo: env('MAIL_ALWAYS_TO', '') || undefined
```

Every message goes there instead, and the real recipient is kept in a header:

```
to:      [{ "address": "staging@example.com" }]
headers: { "X-Elvel-To": "real-customer@example.com" }
```

On a staging copy of production data this is the difference between a test send
and mail reaching real customers. Leave it unset in production.

## Testing

```ts
const fake = mail().fake()

await mailTo({ address: 'ada@example.com', name: 'Ada' }).cc('cc@example.com').send(mailable)

fake
  .assertSent('ArticlePublished')
  .assertHasTo('ada@example.com')
  .assertHasCc('cc@example.com')
  .assertFrom('hello@example.com')
  .assertHasSubject('Published: Hello <b>world</b>')
  .assertHasTag('articles')
  .assertHasAttachment('notes.txt')
  .assertSeeInHtml('Hello <b>world</b>')
```

`assertSent` returns the **first matching message**, and the chain continues into
it. That is the whole design: without it a test asserts on a class name and
passes while the subject is empty and the invoice went to the wrong customer.

`assertSeeInHtml(needle)` escapes the needle before looking, so you write what
the user typed rather than what the escaper made of it; pass `false` as the
second argument to search the raw markup instead.

Also there: `assertNotSent`, `assertQueued`, `assertOnlyRecipients`,
`assertHasReplyTo`, `assertHasMetadata`, `assertHasHeader`,
`assertSeeInOrderInHtml`, `assertSeeInText`, `assertHasAttachedData` and
`assertHasNoAttachments`.

```ts
await fake.assertSent('InvoicePaid').assertHasAttachmentFromDisk('s3', 'invoices/42.pdf')
```

Laravel's version of this compares the path its attachment kept. Ours has no path
to compare — the bytes were read when the attachment was built — so it reads the
disk and compares the content instead. It is the one assertion that awaits.
