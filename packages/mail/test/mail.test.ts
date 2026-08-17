import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elyvel/core'
import { attachFromDisk } from '../src/attachments.ts'
import {
  type Attachment,
  type Content,
  type Envelope,
  Mailable,
  markdownContent,
  viewContent
} from '../src/mailable.ts'
import { Mailer } from '../src/mailer.ts'
import { MailManager } from '../src/manager.ts'
import { markdownToHtml, markdownToText } from '../src/markdown.ts'
import type { SentMessage, Transport } from '../src/message.ts'
import { ArrayTransport } from '../src/transports/array.ts'
import { FailoverTransport, RoundRobinTransport } from '../src/transports/fallback.ts'
import { MailgunTransport, PostmarkTransport, ResendTransport } from '../src/transports/http.ts'
import { LogTransport } from '../src/transports/log.ts'
import { SmtpTransport } from '../src/transports/smtp.ts'
import { type CapturedMessage, startSmtpServer } from './smtp-server.ts'

class Welcome extends Mailable<{ name: string }> {
  envelope(): Envelope {
    return {
      from: { address: 'hello@example.com', name: 'Elyvel' },
      to: 'ada@example.com',
      subject: `Welcome, ${this.data.name}`
    }
  }

  content(): Content {
    return {
      html: `<p>Hello ${this.data.name}.</p>`,
      text: `Hello ${this.data.name}.`
    }
  }
}

class WithAttachment extends Mailable<Record<string, never>> {
  envelope(): Envelope {
    return { from: 'hello@example.com', to: 'ada@example.com', subject: 'Report' }
  }

  content(): Content {
    return { text: 'See attached.' }
  }

  override attachments() {
    return [{ filename: 'report.txt', content: 'total: 42', contentType: 'text/plain' }]
  }
}

function mailerWith(transport: Transport, options = {}): Mailer {
  return new Mailer('test', transport, options)
}

describe('building a message', () => {
  test('the envelope and content are resolved into one object', async () => {
    const transport = new ArrayTransport()
    await mailerWith(transport).send(new Welcome({ name: 'Ada' }))

    const message = transport.messages[0] as SentMessage

    expect(message.mailable).toBe('Welcome')
    expect(message.from).toEqual({ address: 'hello@example.com', name: 'Elyvel' })
    expect(message.to).toEqual([{ address: 'ada@example.com' }])
    expect(message.subject).toBe('Welcome, Ada')
    expect(message.html).toBe('<p>Hello Ada.</p>')
    expect(message.text).toBe('Hello Ada.')
  })

  test('a mailer-level sender fills in for a mailable that names none', async () => {
    class NoSender extends Mailable<Record<string, never>> {
      envelope(): Envelope {
        return { to: 'ada@example.com', subject: 'Hi' }
      }

      content(): Content {
        return { text: 'Hi' }
      }
    }

    const transport = new ArrayTransport()

    await mailerWith(transport, { from: { address: 'noreply@example.com', name: 'App' } }).send(
      new NoSender({})
    )

    expect(transport.messages[0]?.from.address).toBe('noreply@example.com')
  })

  test('no sender anywhere is an error that says where to set one', async () => {
    class NoSender extends Mailable<Record<string, never>> {
      envelope(): Envelope {
        return { to: 'ada@example.com' }
      }

      content(): Content {
        return { text: 'Hi' }
      }
    }

    await expect(mailerWith(new ArrayTransport()).send(new NoSender({}))).rejects.toThrow(
      /has no sender.*mail\.from/s
    )
  })

  test('no recipients is an error rather than a message nobody receives', async () => {
    class Nowhere extends Mailable<Record<string, never>> {
      envelope(): Envelope {
        return { from: 'hello@example.com', subject: 'Hi' }
      }

      content(): Content {
        return { text: 'Hi' }
      }
    }

    await expect(mailerWith(new ArrayTransport()).send(new Nowhere({}))).rejects.toThrow(
      /has no recipients/
    )
  })

  test('recipients passed to to() win over the envelope', async () => {
    const transport = new ArrayTransport()

    await mailerWith(transport)
      .to({ address: 'linus@example.com', name: 'Linus' })
      .cc('team@example.com')
      .send(new Welcome({ name: 'Linus' }))

    const message = transport.messages[0] as SentMessage

    expect(message.to).toEqual([{ address: 'linus@example.com', name: 'Linus' }])
    expect(message.cc).toEqual([{ address: 'team@example.com' }])
  })

  test('alwaysTo redirects everything and keeps the originals in headers', async () => {
    const transport = new ArrayTransport()

    await mailerWith(transport, { alwaysTo: 'dev@example.com' })
      .to('customer@example.com')
      .bcc('audit@example.com')
      .send(new Welcome({ name: 'Ada' }))

    const message = transport.messages[0] as SentMessage

    expect(message.to).toEqual([{ address: 'dev@example.com' }])
    expect(message.bcc).toEqual([])
    // Dropping them silently would make a staging send impossible to trace.
    expect(message.headers['X-Elyvel-To']).toBe('customer@example.com')
    expect(message.headers['X-Elyvel-Bcc']).toBe('audit@example.com')
  })

  test('a view is rendered through the renderer it was given', async () => {
    const transport = new ArrayTransport()

    const Component = ({ title }: { title: string }) => `<h1>${title}</h1>`

    class ViewMail extends Mailable<{ title: string }> {
      envelope(): Envelope {
        return { from: 'hello@example.com', to: 'ada@example.com', subject: 'View' }
      }

      content(): Content {
        // `viewContent` is where the component and its props are checked against
        // each other; the stored type is erased on purpose.
        return viewContent(Component as never, { title: this.data.title }, 'plain')
      }
    }

    const rendered = await mailerWith(transport, {
      render: async (component: never, props: never) =>
        (component as unknown as (props: unknown) => string)(props)
    }).send(new ViewMail({ title: 'Published' }))

    expect(rendered.transport).toBe('array')
    expect(transport.messages[0]?.html).toBe('<h1>Published</h1>')
    expect(transport.messages[0]?.text).toBe('plain')
  })

  test('a view with no renderer says what to register', async () => {
    class ViewMail extends Mailable<Record<string, never>> {
      envelope(): Envelope {
        return { from: 'hello@example.com', to: 'ada@example.com' }
      }

      content(): Content {
        return viewContent((() => '') as never, {})
      }
    }

    await expect(mailerWith(new ArrayTransport()).send(new ViewMail({}))).rejects.toThrow(
      /cannot render a view.*ViewServiceProvider/s
    )
  })

  test('render() returns the body without sending', async () => {
    const transport = new ArrayTransport()

    expect(await mailerWith(transport).render(new Welcome({ name: 'Ada' }))).toBe(
      '<p>Hello Ada.</p>'
    )
    expect(transport.messages.length).toBe(0)
  })

  test('events announce sending and sent', async () => {
    const seen: string[] = []

    await mailerWith(new ArrayTransport(), {
      events: { dispatch: (event: string) => seen.push(event) }
    }).send(new Welcome({ name: 'Ada' }))

    expect(seen).toEqual(['mail.sending', 'mail.sent'])
  })
})

describe('transports', () => {
  test('the log transport writes headers and a body', async () => {
    const lines: string[] = []
    const transport = new LogTransport({ info: (message: string) => lines.push(message) })

    await mailerWith(transport).cc('team@example.com').send(new WithAttachment({}))

    const written = lines.join('\n')

    expect(written).toContain('From: hello@example.com')
    expect(written).toContain('Cc: team@example.com')
    expect(written).toContain('Subject: Report')
    expect(written).toContain('Attachments: report.txt')
    expect(written).toContain('See attached.')
  })

  test('failover moves on when a transport throws', async () => {
    const broken: Transport = {
      name: 'broken',
      send: async () => {
        throw new Error('provider down')
      }
    }

    const working = new ArrayTransport()
    const result = await mailerWith(new FailoverTransport([broken, working])).send(
      new Welcome({ name: 'Ada' })
    )

    expect(result.transport).toBe('array')
    expect(working.messages.length).toBe(1)
  })

  test('failover reports the last failure when everything is down', async () => {
    const first: Transport = {
      name: 'first',
      send: async () => {
        throw new Error('first down')
      }
    }
    const second: Transport = {
      name: 'second',
      send: async () => {
        throw new Error('second down')
      }
    }

    await expect(
      mailerWith(new FailoverTransport([first, second])).send(new Welcome({ name: 'Ada' }))
    ).rejects.toThrow('second down')
  })

  test('roundrobin spreads messages and still retries the others', async () => {
    const left = new ArrayTransport()
    const right = new ArrayTransport()

    const mailer = mailerWith(new RoundRobinTransport([left, right]))

    for (let index = 0; index < 4; index += 1) {
      await mailer.send(new Welcome({ name: `n${index}` }))
    }

    // Two each, whichever it started from.
    expect(left.messages.length).toBe(2)
    expect(right.messages.length).toBe(2)
  })

  test('an empty failover or roundrobin is refused at construction', () => {
    expect(() => new FailoverTransport([])).toThrow(/at least one/)
    expect(() => new RoundRobinTransport([])).toThrow(/at least one/)
  })
})

describe('HTTP transports', () => {
  type Captured = {
    path: string
    headers: Headers
    /** Read inside the handler — see the note below. */
    text: string
  }

  /**
   * A server that records what a provider would have received.
   *
   * The body is read *inside* the handler rather than from a `clone()` kept for
   * later: a cloned request's body cannot be drained once the response has gone
   * out, and awaiting it afterwards hangs.
   */
  async function capturingServer(
    respond: (request: Request) => Response | Promise<Response>
  ): Promise<{ url: string; captured: Captured[]; stop(): void }> {
    const captured: Captured[] = []

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        captured.push({
          path: new URL(request.url).pathname,
          headers: request.headers,
          text: await request.text()
        })

        return respond(request)
      }
    })

    return {
      url: `http://127.0.0.1:${server.port}`,
      captured,
      stop: () => server.stop(true)
    }
  }

  /** The multipart body Mailgun sends, parsed back into a FormData. */
  function formOf(entry: Captured): FormData {
    return new Response(entry.text, {
      headers: { 'content-type': entry.headers.get('content-type') ?? '' }
    }).formData() as unknown as FormData
  }

  test('Resend gets the message as JSON', async () => {
    const server = await capturingServer(() => Response.json({ id: 'resend-1' }))

    try {
      const transport = new ResendTransport({ key: 'secret', endpoint: server.url })
      const result = await mailerWith(transport).send(new Welcome({ name: 'Ada' }))

      expect(result.id).toBe('resend-1')

      const entry = server.captured[0] as Captured
      expect(entry.headers.get('authorization')).toBe('Bearer secret')

      const body = JSON.parse(entry.text) as Record<string, unknown>
      expect(body.from).toBe('"Elyvel" <hello@example.com>')
      expect(body.to).toEqual(['ada@example.com'])
      expect(body.subject).toBe('Welcome, Ada')
      expect(body.html).toBe('<p>Hello Ada.</p>')
    } finally {
      server.stop()
    }
  })

  test('Resend attachments are base64', async () => {
    const server = await capturingServer(() => Response.json({ id: 'resend-2' }))

    try {
      await mailerWith(new ResendTransport({ key: 'k', endpoint: server.url })).send(
        new WithAttachment({})
      )

      const body = JSON.parse((server.captured[0] as Captured).text) as {
        attachments: Array<{ filename: string; content: string }>
      }

      expect(body.attachments[0]?.filename).toBe('report.txt')
      expect(Buffer.from(String(body.attachments[0]?.content), 'base64').toString()).toBe(
        'total: 42'
      )
    } finally {
      server.stop()
    }
  })

  test('a rejected message names the provider and the reason', async () => {
    const server = await capturingServer(
      () => new Response('domain is not verified', { status: 422 })
    )

    try {
      await expect(
        mailerWith(new ResendTransport({ key: 'k', endpoint: server.url })).send(
          new Welcome({ name: 'Ada' })
        )
      ).rejects.toThrow(/Resend rejected the message \(422\).*domain is not verified/s)
    } finally {
      server.stop()
    }
  })

  test('Postmark gets its own field names and a message stream', async () => {
    const server = await capturingServer(() => Response.json({ MessageID: 'pm-1' }))

    try {
      const transport = new PostmarkTransport({ key: 'token', endpoint: server.url })
      const result = await mailerWith(transport).send(new Welcome({ name: 'Ada' }))

      expect(result.id).toBe('pm-1')

      const entry = server.captured[0] as Captured
      expect(entry.headers.get('X-Postmark-Server-Token')).toBe('token')

      const body = JSON.parse(entry.text) as Record<string, unknown>
      expect(body.HtmlBody).toBe('<p>Hello Ada.</p>')
      expect(body.MessageStream).toBe('outbound')
    } finally {
      server.stop()
    }
  })

  test('Mailgun posts form data to the domain endpoint', async () => {
    const server = await capturingServer(() => Response.json({ id: 'mg-1' }))

    try {
      const transport = new MailgunTransport({
        key: 'key-1',
        domain: 'mail.example.com',
        endpoint: server.url
      })

      const result = await mailerWith(transport).send(new WithAttachment({}))
      expect(result.id).toBe('mg-1')

      const entry = server.captured[0] as Captured
      expect(entry.path).toBe('/mail.example.com/messages')
      // Basic auth with the literal username `api`.
      expect(
        Buffer.from(String(entry.headers.get('authorization')).slice(6), 'base64').toString()
      ).toBe('api:key-1')

      const form = await formOf(entry)
      expect(form.get('subject')).toBe('Report')
      expect((form.get('attachment') as File).name).toBe('report.txt')
    } finally {
      server.stop()
    }
  })
})

describe('SMTP, against a real server', () => {
  test('a message completes an SMTP session', async () => {
    const server = await startSmtpServer()

    try {
      const transport = new SmtpTransport({ host: '127.0.0.1', port: server.port })
      const result = await mailerWith(transport).send(new Welcome({ name: 'Ada' }))

      expect(result.id).toBeDefined()
      expect(server.messages.length).toBe(1)

      const captured = server.messages[0] as CapturedMessage

      // The envelope the server was given, which is what actually decides delivery.
      expect(captured.from).toBe('hello@example.com')
      expect(captured.recipients).toEqual(['ada@example.com'])

      // And the MIME nodemailer wrote for us.
      expect(captured.data).toContain('Subject: Welcome, Ada')
      expect(captured.data).toContain('multipart/alternative')
      expect(captured.data).toContain('Hello Ada.')

      transport.close()
    } finally {
      server.stop()
    }
  })

  test('bcc recipients reach the envelope but not the headers', async () => {
    const server = await startSmtpServer()

    try {
      const transport = new SmtpTransport({ host: '127.0.0.1', port: server.port })

      await mailerWith(transport)
        .to('ada@example.com')
        .bcc('audit@example.com')
        .send(new Welcome({ name: 'Ada' }))

      const captured = server.messages[0] as CapturedMessage

      expect(captured.recipients).toEqual(['ada@example.com', 'audit@example.com'])
      // A Bcc header would tell every recipient who else got it.
      expect(captured.data).not.toContain('audit@example.com')

      transport.close()
    } finally {
      server.stop()
    }
  })

  test('credentials are offered when the server asks for them', async () => {
    const server = await startSmtpServer({ requireAuth: true })

    try {
      const transport = new SmtpTransport({
        host: '127.0.0.1',
        port: server.port,
        username: 'postmaster',
        password: 'secret'
      })

      await mailerWith(transport).send(new Welcome({ name: 'Ada' }))

      expect(server.messages[0]?.authenticated).toBe('postmaster')

      transport.close()
    } finally {
      server.stop()
    }
  })

  test('a server that demands auth refuses an anonymous send', async () => {
    const server = await startSmtpServer({ requireAuth: true })

    try {
      const transport = new SmtpTransport({ host: '127.0.0.1', port: server.port })

      await expect(mailerWith(transport).send(new Welcome({ name: 'Ada' }))).rejects.toThrow()

      expect(server.messages.length).toBe(0)

      transport.close()
    } finally {
      server.stop()
    }
  })

  test('an attachment is encoded into the message', async () => {
    const server = await startSmtpServer()

    try {
      const transport = new SmtpTransport({ host: '127.0.0.1', port: server.port })
      await mailerWith(transport).send(new WithAttachment({}))

      const captured = server.messages[0] as CapturedMessage

      expect(captured.data).toContain('filename=report.txt')
      // base64 of "total: 42"
      expect(captured.data).toContain(Buffer.from('total: 42').toString('base64'))

      transport.close()
    } finally {
      server.stop()
    }
  })

  test('verify() reports a reachable server, and an unreachable one', async () => {
    const server = await startSmtpServer()

    try {
      const reachable = new SmtpTransport({ host: '127.0.0.1', port: server.port })
      expect(await reachable.verify()).toBe(true)
      reachable.close()

      const unreachable = new SmtpTransport({ host: '127.0.0.1', port: 1, timeout: 500 })
      await expect(unreachable.verify()).rejects.toThrow()
      unreachable.close()
    } finally {
      server.stop()
    }
  })
})

describe('MailManager', () => {
  let app: Application

  beforeEach(() => {
    app = new Application(process.cwd())
    app.config.set('app.env', 'testing')
    app.config.set('mail.default', 'array')
    app.config.set('mail.from', { address: 'hello@example.com', name: 'Elyvel' })
    app.config.set('mail.mailers', {
      array: { transport: 'array' },
      log: { transport: 'log' },
      smtp: { transport: 'smtp', host: '127.0.0.1', port: 2525 },
      resend: { transport: 'resend', key: 'k' },
      backup: { transport: 'array' },
      failover: { transport: 'failover', mailers: ['array', 'backup'] }
    })
  })

  test('mailers are resolved by name and memoised', () => {
    const manager = new MailManager(app)

    expect(manager.mailer().name).toBe('array')
    expect(manager.mailer('log').transport.name).toBe('log')
    expect(manager.mailer('smtp')).toBe(manager.mailer('smtp'))
  })

  test('an unconfigured mailer says where to configure it', () => {
    expect(() => new MailManager(app).mailer('nope')).toThrow(/is not configured.*config\/mail/s)
  })

  test('an unsupported transport points at extend()', () => {
    app.config.set('mail.mailers.weird', { transport: 'carrier-pigeon' })

    expect(() => new MailManager(app).mailer('weird')).toThrow(/mail\(\)\.extend/)
  })

  test('extend registers a transport of your own', async () => {
    const delivered: SentMessage[] = []

    app.config.set('mail.mailers.custom', { transport: 'custom' })

    const manager = new MailManager(app)
    manager.extend('custom', () => ({
      name: 'custom',
      send: async (message) => {
        delivered.push(message)

        return { transport: 'custom' }
      }
    }))

    await manager.mailer('custom').send(new Welcome({ name: 'Ada' }))

    expect(delivered.length).toBe(1)
  })

  test('a failover mailer is assembled from the mailers it names', () => {
    expect(new MailManager(app).mailer('failover').transport.name).toBe('failover')
  })

  test('a failover mailer naming something unconfigured says so', () => {
    app.config.set('mail.mailers.broken', { transport: 'failover', mailers: ['nope'] })

    expect(() => new MailManager(app).mailer('broken')).toThrow(/refers to mailer \[nope\]/)
  })

  test('allowSelfSigned is refused in production', () => {
    app.config.set('mail.mailers.smtp', {
      transport: 'smtp',
      host: 'mail.example.com',
      allowSelfSigned: true
    })

    // Accepted while developing…
    expect(new MailManager(app).mailer('smtp').transport.name).toBe('smtp')

    app.config.set('app.env', 'production')

    // …and refused where it would mean readable mail in transit.
    expect(() => new MailManager(app).mailer('smtp')).toThrow(/refused in production/)
  })

  test('the sender from config reaches every mailer', async () => {
    class NoSender extends Mailable<Record<string, never>> {
      envelope(): Envelope {
        return { to: 'ada@example.com', subject: 'Hi' }
      }

      content(): Content {
        return { text: 'Hi' }
      }
    }

    const manager = new MailManager(app)
    const mailer = manager.mailer('array')

    await mailer.send(new NoSender({}))

    const transport = mailer.transport as ArrayTransport
    expect(transport.messages[0]?.from).toEqual({
      address: 'hello@example.com',
      name: 'Elyvel'
    })
  })

  test('queued mail without a queue says what to register', async () => {
    await expect(
      new MailManager(app).to('ada@example.com').queue(new Welcome({ name: 'Ada' }))
    ).rejects.toThrow(/needs a queue.*QueueServiceProvider/s)
  })
})

describe('Mail.fake()', () => {
  let app: Application
  let manager: MailManager

  beforeEach(() => {
    app = new Application(process.cwd())
    app.config.set('mail.default', 'array')
    app.config.set('mail.from', 'hello@example.com')
    app.config.set('mail.mailers', { array: { transport: 'array' }, log: { transport: 'log' } })

    manager = new MailManager(app)
  })

  afterEach(() => {
    manager.restore()
  })

  test('nothing is sent, and what would have been is recorded', async () => {
    const fake = manager.fake()

    await manager.to('ada@example.com').send(new Welcome({ name: 'Ada' }))

    fake.assertSent('Welcome')
    fake.assertSentCount(1)
    fake.assertNotSent('WithAttachment')
    expect(fake.htmlOf('Welcome')).toBe('<p>Hello Ada.</p>')
  })

  test('a named mailer cannot slip past the fake', async () => {
    const fake = manager.fake()

    // A test that asked for `log` explicitly must not write to the log.
    await manager
      .mailer('log')
      .to('ada@example.com')
      .send(new Welcome({ name: 'Ada' }))

    fake.assertSent('Welcome')
  })

  test('assertions describe what was actually sent', async () => {
    const fake = manager.fake()

    await manager.to('ada@example.com').send(new Welcome({ name: 'Ada' }))

    expect(() => fake.assertSent('Missing')).toThrow(/but it was not\. Sent: Welcome/)
    expect(() => fake.assertNotSent('Welcome')).toThrow(/not to have been sent/)
    expect(() => fake.assertNothingSent()).toThrow(/found: Welcome/)
    expect(() => fake.assertSentCount(3)).toThrow(/Expected 3 message\(s\).*found 1/)
  })

  test('a matcher narrows the assertion to the message it wants', async () => {
    const fake = manager.fake()

    await manager.to('ada@example.com').send(new Welcome({ name: 'Ada' }))

    fake.assertSent('Welcome', (message) => message.to[0]?.address === 'ada@example.com')

    expect(() =>
      fake.assertSent('Welcome', (message) => message.to[0]?.address === 'linus@example.com')
    ).toThrow(/matching the callback/)
  })

  test('queued mail is recorded rather than queued', async () => {
    // A queue is bound, so without the fake this would reach it.
    app.instance('queue', {
      dispatch: async () => {
        throw new Error('the fake should have intercepted this')
      },
      jobs: { register: () => undefined }
    } as never)

    const fake = manager.fake()

    await manager.to('ada@example.com').queue(new Welcome({ name: 'Ada' }))

    fake.assertQueued('Welcome')
    fake.assertNothingSent()
  })

  test('restore() sends for real again', async () => {
    manager.fake()
    manager.restore()

    expect(manager.isFaking).toBe(false)
    expect(manager.mailer().transport).toBeInstanceOf(ArrayTransport)
  })

  test('flush forgets what was recorded', async () => {
    const fake = manager.fake()

    await manager.to('ada@example.com').send(new Welcome({ name: 'Ada' }))
    fake.flush()

    fake.assertNothingSent()
  })
})

// -------------------------------------------------- batch A: defaults, disks

class Embedded extends Mailable<Record<string, never>> {
  envelope(): Envelope {
    return { from: 'hello@example.com', to: 'ada@example.com', subject: 'Look' }
  }

  content(): Content {
    return { html: '<p><img src="cid:logo"><img src="cid:logo-small"></p>' }
  }

  override attachments(): Attachment[] {
    return [
      { filename: 'logo.png', content: 'PNGBYTES', contentType: 'image/png', cid: 'logo' },
      {
        filename: 'small.png',
        content: 'SMALLBYTES',
        contentType: 'image/png',
        cid: 'logo-small'
      }
    ]
  }
}

describe('a default reply-to', () => {
  test('is used when the mailable names none', async () => {
    const message = await mailerWith(new ArrayTransport(), {
      replyTo: 'support@example.com'
    }).build(new Welcome({ name: 'Ada' }))

    // The use for it: sending from a no-reply address while still letting an
    // answer reach somebody.
    expect<string | undefined>(message.replyTo[0]?.address).toBe('support@example.com')
  })

  test("but a mailable's own wins", async () => {
    class Answered extends Welcome {
      override envelope(): Envelope {
        return { ...super.envelope(), replyTo: 'ada-team@example.com' }
      }
    }

    const message = await mailerWith(new ArrayTransport(), {
      replyTo: 'support@example.com'
    }).build(new Answered({ name: 'Ada' }))

    // A default, not an override — this is where Laravel's `alwaysReplyTo`
    // differs from `alwaysTo`, which forces.
    expect<number>(message.replyTo.length).toBe(1)
    expect<string | undefined>(message.replyTo[0]?.address).toBe('ada-team@example.com')
  })
})

describe('embedded images in a preview', () => {
  test('render() inlines them as data URIs', async () => {
    const html = await mailerWith(new ArrayTransport()).render(new Embedded({}))

    expect<boolean>(html.includes(`data:image/png;base64,${btoa('PNGBYTES')}`)).toBe(true)
    // Matched with its delimiter, so `cid:logo` cannot also rewrite the longer id.
    expect<boolean>(html.includes(`data:image/png;base64,${btoa('SMALLBYTES')}`)).toBe(true)
    expect<boolean>(html.includes('cid:')).toBe(false)
  })

  test('but what is sent keeps the cid reference', async () => {
    const transport = new ArrayTransport()
    await mailerWith(transport).send(new Embedded({}))

    // A real client resolves it against the attachment and shows the image
    // without fetching anything; a data URI would only make the message bigger.
    expect<boolean>(transport.messages[0]?.html?.includes('cid:logo') === true).toBe(true)
  })

  test('a missing file leaves the reference alone rather than failing', async () => {
    class Broken extends Embedded {
      override attachments(): Attachment[] {
        return [{ filename: 'gone.png', path: '/no/such/file.png', cid: 'logo' }]
      }
    }

    const html = await mailerWith(new ArrayTransport()).render(new Broken({}))

    // A design review of a message whose image has moved should still render.
    expect<boolean>(html.includes('cid:logo')).toBe(true)
  })
})

describe('attaching from a storage disk', () => {
  let app: Application

  const disk = {
    files: new Map<string, Uint8Array>([
      ['invoices/april.pdf', new TextEncoder().encode('%PDF-1')]
    ]),
    async bytes(path: string) {
      return this.files.get(path) ?? null
    },
    async mimeType(path: string) {
      return path.endsWith('.pdf') ? 'application/pdf' : null
    }
  }

  beforeEach(() => {
    app = new Application(process.cwd())
    app.instance('storage' as never, { disk: () => disk } as never)
  })

  test('the bytes travel with the message, not a path', async () => {
    const attachment = await attachFromDisk('s3', 'invoices/april.pdf')

    // A path only works for a disk that has one, so a queued message would fail
    // on S3 and a local path handed to another machine is a file that is nowhere.
    expect<boolean>(attachment.content instanceof Uint8Array).toBe(true)
    expect<string | undefined>(attachment.path).toBeUndefined()
  })

  test('the name and type come from the file unless overridden', async () => {
    const attachment = await attachFromDisk('s3', 'invoices/april.pdf')

    expect<string>(attachment.filename).toBe('april.pdf')
    // A wrong content type is how a PDF arrives as a download nobody opens.
    expect<string | undefined>(attachment.contentType).toBe('application/pdf')

    const renamed = await attachFromDisk('s3', 'invoices/april.pdf', {
      as: 'Invoice.pdf',
      contentType: 'application/x-pdf',
      cid: 'invoice'
    })

    expect<string>(renamed.filename).toBe('Invoice.pdf')
    expect<string | undefined>(renamed.contentType).toBe('application/x-pdf')
    expect<string | undefined>(renamed.cid).toBe('invoice')
  })

  test('a missing file is named in the error', async () => {
    // The usual cause is a path relative to the wrong disk, and the alternative
    // is a message that goes out silently missing its invoice.
    await expect(attachFromDisk('s3', 'invoices/may.pdf')).rejects.toThrow('invoices/may.pdf')
  })
})

describe('markdown mail', () => {
  test('the shapes a mail actually uses', () => {
    const html = markdownToHtml(
      '# Shipped\n\nIt is **on its way**. [Track it](https://example.com/t/7).\n\n- one\n- two'
    )

    expect<boolean>(html.includes('<h1')).toBe(true)
    expect<boolean>(html.includes('<strong>on its way</strong>')).toBe(true)
    expect<boolean>(html.includes('href="https://example.com/t/7"')).toBe(true)
    expect<boolean>(html.includes('<li>one</li>')).toBe(true)
  })

  test('styles are inline, because Gmail strips a style block', () => {
    const html = markdownToHtml('Hello.')

    expect<boolean>(html.includes('style="margin: 0 0 16px')).toBe(true)
    expect<boolean>(html.includes('<style')).toBe(false)
  })

  test('raw HTML in the source is escaped', () => {
    // Markdown for a mail usually contains something somebody typed, and passing
    // tags through is how a display name becomes a phishing link.
    const html = markdownToHtml('Hi <script>alert(1)</script> and <b>bold</b>')

    expect<boolean>(html.includes('<script>')).toBe(false)
    expect<boolean>(html.includes('&lt;script&gt;')).toBe(true)
  })

  test('the text part keeps links usable', () => {
    const text = markdownToText('# Shipped\n\n[Track it](https://example.com/t/7) now.')

    // Not the HTML with tags stripped: a link with its URL removed is a text
    // part that looks broken to anybody whose client prefers text.
    expect<boolean>(text.includes('Track it (https://example.com/t/7)')).toBe(true)
  })

  test('markdownContent produces both parts, dedented', () => {
    const content = markdownContent(`
      # Hello

      A line.
    `) as { html: string; text: string }

    // Without dedenting, every line starts four spaces in and markdown reads the
    // whole message as one code block.
    expect<boolean>(content.html.includes('<h1')).toBe(true)
    expect<boolean>(content.html.includes('<pre')).toBe(false)
    expect<boolean>(content.text.startsWith('# Hello')).toBe(true)
  })

  test('fenced code survives as code', () => {
    const html = markdownToHtml('```\nbun test\n```')

    expect<boolean>(html.includes('<pre')).toBe(true)
    expect<boolean>(html.includes('bun test')).toBe(true)
  })
})
