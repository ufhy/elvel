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
