import { controller, NotFoundException } from '@elvel/core'
import { attachFromDisk, expectMessage, mail, mailer, mailTo } from '@elvel/mail'
import { queue } from '@elvel/queue'
import { disk } from '@elvel/storage'
import { t } from 'elysia'
import { ArticlePublished } from '../../Mail/ArticlePublished.ts'
import { InvoiceMail } from '../../Mail/InvoiceMail.ts'
import { Article } from '../../Models/Article.ts'

/**
 * Generated with `bun run playground make:controller MailController`, then
 * extended.
 *
 * `?mailer=array` keeps the message in memory so a route can read it back;
 * without it the configured mailer is used, which is `log` here. Asserted by
 * `scripts/smoke.ts` and driven over the network with `elvel serve` + curl.
 */
export default controller('mail')
  /** Send now, and answer with what the transport reported. */
  .post(
    '/check/mail/send/:id',
    async ({ params, body, query }) => {
      const article = await Article.find(Number(params.id))
      if (!article) throw new NotFoundException(`No article [${params.id}].`)

      const name = typeof query.mailer === 'string' ? query.mailer : undefined

      const mailable = new ArticlePublished({
        title: article.title,
        excerpt: (article as unknown as { excerpt: string }).excerpt,
        articleId: article.id
      })

      const result = await mailer(name)
        .to(body.to ?? 'ada@example.com')
        .send(mailable)

      return { sent: result.transport, id: result.id }
    },
    { body: t.Object({ to: t.Optional(t.String()) }) }
  )

  /**
   * Queue it instead. The request returns before anything is rendered or sent;
   * `queue:work` does both.
   */
  .post('/check/mail/queue/:id', async ({ params }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    const id = await mailTo('ada@example.com').queue(
      new ArticlePublished({
        title: article.title,
        excerpt: (article as unknown as { excerpt: string }).excerpt,
        articleId: article.id
      })
    )

    return { queued: id, size: await queue().connection().size('mail') }
  })

  /** What the `array` mailer has collected, so a test can read the real message. */
  .get('/check/mail/outbox', async () => {
    const transport = mailer('array').transport as { messages?: unknown[] }
    const messages = (transport.messages ?? []) as Array<{
      mailable: string
      subject: string
      to: Array<{ address: string }>
      replyTo: Array<{ address: string }>
      html?: string
      text?: string
    }>

    return {
      count: messages.length,
      messages: messages.map((message) => ({
        mailable: message.mailable,
        subject: message.subject,
        to: message.to.map((mailbox) => mailbox.address),
        // Enough of the body to prove the view rendered, not the whole document.
        htmlHead: message.html?.slice(0, 120),
        hasText: typeof message.text === 'string',
        // A field of its own on the message, not a header: transports that have
        // their own reply-to parameter need it separately.
        replyTo: message.replyTo.map((mailbox) => mailbox.address)
      }))
    }
  })

  .delete('/check/mail/outbox', async () => {
    const transport = mailer('array').transport as { flush?: () => void }
    transport.flush?.()

    return { cleared: true }
  })

  /**
   * The message assertions, run against a message this application really built.
   *
   * A test double can be made to pass by an assertion that reads the double
   * rather than the message; this builds an `ArticlePublished` through the same
   * mailer a request would, then asserts on it — including one assertion written
   * to fail, because an assertion library that cannot fail proves nothing.
   */
  .get('/check/mail/assertions/:id', async ({ params }) => {
    const article = await Article.query().find(Number(params.id))
    if (!article) throw new NotFoundException('No such article.')

    const built = await mailer('array').build(
      new ArticlePublished({
        title: article.title,
        excerpt: article.body.slice(0, 80),
        articleId: article.id
      }),
      // `to` is not on this mailable's envelope — a request supplies it through
      // `mailTo()`, and `build` takes the same override.
      { to: [{ address: 'ada@example.com' }] }
    )
    const passed: string[] = []

    expectMessage(built)
      .assertHasTo('ada@example.com')
      .assertHasReplyTo('editors@example.com')
      .assertHasSubject(`Published: ${article.title}`)
      .assertHasTag('article')
      .assertHasMetadata('articleId', String(article.id))
      .assertSeeInHtml(article.title)
      .assertSeeInText(article.title)
      .assertHasNoAttachments()

    passed.push('to', 'replyTo', 'subject', 'tag', 'metadata', 'html', 'text', 'noAttachments')

    let failure: string | undefined

    try {
      expectMessage(built).assertHasTo('nobody@example.com')
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }

    return { passed, failure }
  })

  /** The rendered HTML, without sending anything — a preview route. */
  .get('/check/mail/preview/:id', async ({ params }) => {
    const article = await Article.find(Number(params.id))
    if (!article) throw new NotFoundException(`No article [${params.id}].`)

    const html = await mailer('array').render(
      new ArticlePublished({
        title: article.title,
        excerpt: (article as unknown as { excerpt: string }).excerpt,
        articleId: article.id
      })
    )

    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  })

  /**
   * An invoice attached from a disk, with an embedded logo.
   *
   * `?disk=s3` reads it back out of MinIO over the network, which is the case
   * worth proving: a path would not have travelled.
   */
  .post('/check/mail/invoice', async ({ query }) => {
    const name = typeof query.disk === 'string' ? query.disk : 'local'
    const target = disk(name)

    await target.put('invoices/april.pdf', '%PDF-1.4 fake invoice')
    await target.put('brand/logo.png', 'PNGBYTES')

    const mailable = new InvoiceMail({ name: 'Ada', reference: 'INV-042' }).withFiles([
      await attachFromDisk(name, 'invoices/april.pdf', { as: 'Invoice-042.pdf' }),
      await attachFromDisk(name, 'brand/logo.png', { cid: 'logo' })
    ])

    await mailer('array').send(mailable)

    // The preview inlines the embedded image; what was sent keeps the reference.
    const preview = await mailer('array').render(mailable)

    return {
      disk: name,
      previewInlines: preview.includes('data:image/png;base64,'),
      previewHasCid: preview.includes('cid:logo')
    }
  })

  /** Which mailables a worker could resolve by name. */
  .get('/check/mail/mailables', () => ({ mailables: mail().mailables.names() }))
