import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Application } from '@elysian/core'
import { ConnectionManager } from '@elysian/database'
import { BroadcastNotificationChannel } from '../src/channels/broadcast.ts'
import { DatabaseNotificationChannel } from '../src/channels/database.ts'
import { LogNotificationChannel } from '../src/channels/log.ts'
import { MailNotificationChannel } from '../src/channels/mail.ts'
import { NotificationManager } from '../src/manager.ts'
import { escapeAttribute, escapeHtml, MailMessage } from '../src/message.ts'
import { AnonymousNotifiable, identify, type Notifiable, routeFor } from '../src/notifiable.ts'
import { Notification } from '../src/notification.ts'
import { type NotificationChannel, NotificationSender } from '../src/sender.ts'

/** A recipient that looks like one of our models. */
class User implements Notifiable {
  constructor(
    readonly id: number,
    readonly email: string
  ) {}

  getKey(): unknown {
    return this.id
  }
}

class ArticlePublished extends Notification<{ title: string }> {
  via(): string[] {
    return ['mail', 'database']
  }

  override toMail(): MailMessage {
    return new MailMessage()
      .subject(`Published: ${this.data.title}`)
      .line('Your article is live.')
      .action('Read it', 'https://example.com/articles/1')
      .line('Thanks for writing.')
  }

  override toDatabase(): Record<string, unknown> {
    return { title: this.data.title }
  }
}

/** Records what it was given, so the sender can be tested on its own. */
function recordingChannel(name: string): NotificationChannel & { calls: unknown[] } {
  const calls: unknown[] = []

  return {
    name,
    calls,
    send: async (notifiable, notification) => {
      calls.push({ notifiable, id: notification.id })

      return `${name}-response`
    }
  }
}

describe('routing', () => {
  test('mail falls back to the email attribute', () => {
    expect(routeFor(new User(1, 'ada@example.com'), 'mail')).toBe('ada@example.com')
  })

  test('an explicit route wins', () => {
    class Custom implements Notifiable {
      email = 'ignored@example.com'

      routeNotificationFor(channel: string): unknown {
        return channel === 'mail' ? 'preferred@example.com' : null
      }
    }

    expect(routeFor(new Custom(), 'mail')).toBe('preferred@example.com')
  })

  test('a channel with no route is null, not an error', () => {
    expect(routeFor(new User(1, 'ada@example.com'), 'sms')).toBeNull()
  })

  test('identify reads the key and the type', () => {
    expect(identify(new User(7, 'ada@example.com'))).toEqual({ type: 'User', id: 7 })
  })

  test('an anonymous recipient carries only what it was given', () => {
    const anonymous = new AnonymousNotifiable().route('mail', 'ada@example.com')

    expect(routeFor(anonymous, 'mail')).toBe('ada@example.com')
    expect(routeFor(anonymous, 'log')).toBeNull()
    expect(anonymous.channels()).toEqual(['mail'])
  })

  test('an anonymous recipient refuses the database channel, and says why', () => {
    expect(() => new AnonymousNotifiable().route('database', 'x')).toThrow(
      /no record to attach it to/
    )
  })
})

describe('NotificationSender', () => {
  test('every channel a recipient uses gets the same id', async () => {
    const mail = recordingChannel('mail')
    const database = recordingChannel('database')

    const sender = new NotificationSender((name) => (name === 'mail' ? mail : database))

    await sender.sendNow(new User(1, 'ada@example.com'), new ArticlePublished({ title: 'Hello' }))

    const mailId = (mail.calls[0] as { id: string }).id
    const databaseId = (database.calls[0] as { id: string }).id

    // Correlating a stored row with the mail about it depends on this.
    expect(mailId).toBe(databaseId)
    expect(mailId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('each recipient gets its own id', async () => {
    const mail = recordingChannel('mail')
    const sender = new NotificationSender(() => mail)

    await sender.sendNow(
      [new User(1, 'ada@example.com'), new User(2, 'linus@example.com')],
      new ArticlePublished({ title: 'Hello' }),
      ['mail']
    )

    const [first, second] = mail.calls as Array<{ id: string }>
    expect(first?.id).not.toBe(second?.id)
  })

  test('via() is asked per recipient', async () => {
    const mail = recordingChannel('mail')
    const database = recordingChannel('database')

    class PerRecipient extends Notification<Record<string, never>> {
      via(notifiable: Notifiable): string[] {
        // One person is mailed, the other only gets a stored row.
        return notifiable.email === 'ada@example.com' ? ['mail'] : ['database']
      }

      override toMail(): MailMessage {
        return new MailMessage().line('hi')
      }

      override toDatabase(): Record<string, unknown> {
        return {}
      }
    }

    const sender = new NotificationSender((name) => (name === 'mail' ? mail : database))

    await sender.sendNow(
      [new User(1, 'ada@example.com'), new User(2, 'linus@example.com')],
      new PerRecipient({})
    )

    expect(mail.calls.length).toBe(1)
    expect(database.calls.length).toBe(1)
  })

  test('a recipient whose via() is empty is skipped', async () => {
    const mail = recordingChannel('mail')

    class Silent extends Notification<Record<string, never>> {
      via(): string[] {
        return []
      }
    }

    await new NotificationSender(() => mail).sendNow(new User(1, 'a@b.c'), new Silent({}))

    expect(mail.calls.length).toBe(0)
  })

  test('shouldSend can refuse one channel and allow another', async () => {
    const mail = recordingChannel('mail')
    const database = recordingChannel('database')

    class Picky extends Notification<Record<string, never>> {
      via(): string[] {
        return ['mail', 'database']
      }

      override shouldSend(_notifiable: Notifiable, channel: string): boolean {
        return channel !== 'mail'
      }

      override toMail(): MailMessage {
        return new MailMessage()
      }

      override toDatabase(): Record<string, unknown> {
        return {}
      }
    }

    await new NotificationSender((name) => (name === 'mail' ? mail : database)).sendNow(
      new User(1, 'a@b.c'),
      new Picky({})
    )

    expect(mail.calls.length).toBe(0)
    expect(database.calls.length).toBe(1)
  })

  test('afterSending sees the channel and the response', async () => {
    const seen: Array<{ channel: string; response: unknown }> = []

    class Watched extends Notification<Record<string, never>> {
      via(): string[] {
        return ['mail']
      }

      override toMail(): MailMessage {
        return new MailMessage()
      }

      override afterSending(_notifiable: Notifiable, channel: string, response: unknown): void {
        seen.push({ channel, response })
      }
    }

    await new NotificationSender(() => recordingChannel('mail')).sendNow(
      new User(1, 'a@b.c'),
      new Watched({})
    )

    expect(seen).toEqual([{ channel: 'mail', response: 'mail-response' }])
  })

  test('a failing channel dispatches an event and re-throws', async () => {
    const events: string[] = []

    const broken: NotificationChannel = {
      name: 'mail',
      send: async () => {
        throw new Error('smtp is down')
      }
    }

    const sender = new NotificationSender(() => broken, {
      events: { dispatch: (event: string) => events.push(event) }
    })

    // Re-thrown on purpose: a worker has to know, or the notification vanishes.
    await expect(
      sender.sendNow(new User(1, 'a@b.c'), new ArticlePublished({ title: 'x' }), ['mail'])
    ).rejects.toThrow('smtp is down')

    expect(events).toEqual(['notification.sending', 'notification.failed'])
  })

  test('events describe a successful send', async () => {
    const events: string[] = []

    await new NotificationSender(() => recordingChannel('mail'), {
      events: { dispatch: (event: string) => events.push(event) }
    }).sendNow(new User(1, 'a@b.c'), new ArticlePublished({ title: 'x' }), ['mail'])

    expect(events).toEqual(['notification.sending', 'notification.sent'])
  })

  test('the database channel is skipped for an anonymous recipient', async () => {
    const mail = recordingChannel('mail')
    const database = recordingChannel('database')

    const anonymous = new AnonymousNotifiable().route('mail', 'ada@example.com')

    await new NotificationSender((name) => (name === 'mail' ? mail : database)).sendNow(
      anonymous,
      new ArticlePublished({ title: 'x' })
    )

    expect(mail.calls.length).toBe(1)
    // There is no row for it to belong to.
    expect(database.calls.length).toBe(0)
  })

  test('a queued notification without a queue says what to register', async () => {
    class Queued extends Notification<Record<string, never>> {
      static override shouldQueue = true

      via(): string[] {
        return ['mail']
      }

      override toMail(): MailMessage {
        return new MailMessage()
      }
    }

    const sender = new NotificationSender(() => recordingChannel('mail'))

    await expect(sender.queue(new User(1, 'a@b.c'), new Queued({}))).rejects.toThrow(
      /needs a queue.*QueueServiceProvider/s
    )
  })

  test('queueing hands one job to the queue per channel', async () => {
    const queued: Array<{ channel: string; route: unknown }> = []

    const sender = new NotificationSender(() => recordingChannel('mail'), {
      queue: async (notifiable, _notification, channel) => {
        queued.push({ channel, route: routeFor(notifiable, channel) })

        return 'job-id'
      }
    })

    await sender.queue(new User(1, 'ada@example.com'), new ArticlePublished({ title: 'x' }))

    // A mail server being down must not stop the row being stored, so they are
    // separate jobs.
    expect(queued).toEqual([
      { channel: 'mail', route: 'ada@example.com' },
      { channel: 'database', route: null }
    ])
  })
})

describe('MailMessage', () => {
  test('lines land above and below the action', () => {
    const message = new MailMessage()
      .greeting('Hello Ada!')
      .line('above one')
      .line('above two')
      .action('Do it', 'https://example.com/go')
      .line('below')
      .salutation('Bye,\nElysian')

    const text = message.toText('Elysian')

    expect(text.indexOf('above one')).toBeLessThan(text.indexOf('Do it'))
    expect(text.indexOf('Do it')).toBeLessThan(text.indexOf('below'))
    expect(text).toContain('https://example.com/go')
    expect(text).toContain('Bye,')
  })

  test('the HTML carries the greeting, the lines and the button', () => {
    const html = new MailMessage()
      .greeting('Hello Ada!')
      .line('Your article is live.')
      .action('Read it', 'https://example.com/a')
      .toHtml('Elysian')

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('Hello Ada!')
    expect(html).toContain('Your article is live.')
    expect(html).toContain('href="https://example.com/a"')
    expect(html).toContain('Read it')
  })

  test('level changes the button colour', () => {
    expect(new MailMessage().action('a', 'https://x.test').toHtml('E')).toContain('#2563eb')
    expect(new MailMessage().success().action('a', 'https://x.test').toHtml('E')).toContain(
      '#16a34a'
    )
    expect(new MailMessage().error().action('a', 'https://x.test').toHtml('E')).toContain('#dc2626')
  })

  test('an error message greets differently by default', () => {
    expect(new MailMessage().error().toText('E')).toContain('Whoops!')
  })

  test('a line from user input cannot inject markup', () => {
    // A notification line very often carries a title or a name somebody typed.
    const html = new MailMessage().line('<script>alert(1)</script>').toHtml('Elysian')

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  test('a hostile action URL is replaced rather than emitted', () => {
    const html = new MailMessage().action('Click', 'javascript:alert(1)').toHtml('Elysian')

    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="#"')
  })

  test('escaping covers the characters that matter', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;')
    expect(escapeAttribute('https://example.com/a?b=1&c=2')).toBe(
      'https://example.com/a?b=1&amp;c=2'
    )
    expect(escapeAttribute('/relative/path')).toBe('/relative/path')
    expect(escapeAttribute('mailto:ada@example.com')).toBe('mailto:ada@example.com')
  })

  test('the subject falls back to what it was given', () => {
    expect(new MailMessage().subjectOr('ArticlePublished')).toBe('ArticlePublished')
    expect(new MailMessage().subject('Explicit').subjectOr('Fallback')).toBe('Explicit')
  })
})

describe('the mail channel', () => {
  test('a MailMessage becomes a mailable the mail package sends', async () => {
    const sent: Array<{ envelope: unknown; content: unknown; name: string }> = []

    const mail = {
      mailer: () => ({
        send: async (mailable: {
          envelope(): unknown
          content(): unknown
          constructor: { name: string }
        }) => {
          sent.push({
            envelope: mailable.envelope(),
            content: mailable.content(),
            name: mailable.constructor.name
          })

          return 'sent'
        }
      })
    }

    const channel = new MailNotificationChannel(mail as never, 'Playground')

    await channel.send(new User(1, 'ada@example.com'), new ArticlePublished({ title: 'Hello' }))

    const message = sent[0] as { envelope: unknown; content: unknown; name: string }

    expect(message.envelope).toMatchObject({
      to: 'ada@example.com',
      subject: 'Published: Hello'
    })
    expect((message.content as { html: string }).html).toContain('Your article is live.')
    expect((message.content as { text: string }).text).toContain('Read it:')
    // The class name is what a `Mail.fake()` assertion sees.
    expect(message.name).toBe('ArticlePublished')
  })

  test('a recipient with no address is skipped, not an error', async () => {
    const channel = new MailNotificationChannel({
      mailer: () => ({ send: async () => 'sent' })
    } as never)

    class NoAddress implements Notifiable {}

    expect(await channel.send(new NoAddress(), new ArticlePublished({ title: 'x' }))).toBeNull()
  })

  test('a notification listing mail without toMail() says so', async () => {
    class Broken extends Notification<Record<string, never>> {
      via(): string[] {
        return ['mail']
      }
    }

    const channel = new MailNotificationChannel({
      mailer: () => ({ send: async () => 'sent' })
    } as never)

    await expect(channel.send(new User(1, 'a@b.c'), new Broken({}))).rejects.toThrow(
      /has no toMail\(\)/
    )
  })
})

describe('the database channel', () => {
  let db: ConnectionManager

  beforeEach(async () => {
    const app = new Application(process.cwd())
    app.config.set('database.default', 'notifications-test')
    app.config.set('database.connections.notifications-test', {
      driver: 'sqlite',
      database: ':memory:'
    })

    db = new ConnectionManager(app)

    await (await db.schema()).create('notifications', (table) => {
      table.string('id').primary()
      table.string('type')
      table.string('notifiable_type')
      table.string('notifiable_id')
      table.text('data')
      table.timestamp('read_at').nullable()
      table.timestamps()
    })
  })

  afterEach(async () => {
    await db.disconnectAll()
  })

  test('a row is written with the recipient and the payload', async () => {
    const channel = new DatabaseNotificationChannel(db)
    const notification = new ArticlePublished({ title: 'Hello' })
    notification.id = 'fixed-id'

    await channel.send(new User(7, 'ada@example.com'), notification)

    const row = await (await db.table('notifications')).first()

    expect(row).toMatchObject({
      id: 'fixed-id',
      type: 'ArticlePublished',
      notifiable_type: 'User',
      notifiable_id: '7',
      read_at: null
    })
    expect(JSON.parse(String(row?.data))).toEqual({ title: 'Hello' })
  })

  test('toArray is used when there is no toDatabase', async () => {
    class ViaArray extends Notification<Record<string, never>> {
      via(): string[] {
        return ['database']
      }

      override toArray(): Record<string, unknown> {
        return { from: 'toArray' }
      }
    }

    const notification = new ViaArray({})
    notification.id = 'array-id'

    await new DatabaseNotificationChannel(db).send(new User(1, 'a@b.c'), notification)

    const row = await (await db.table('notifications')).first()
    expect(JSON.parse(String(row?.data))).toEqual({ from: 'toArray' })
  })

  test('a notification with neither says which methods it needs', async () => {
    class Broken extends Notification<Record<string, never>> {
      via(): string[] {
        return ['database']
      }
    }

    await expect(
      new DatabaseNotificationChannel(db).send(new User(1, 'a@b.c'), new Broken({}))
    ).rejects.toThrow(/neither toDatabase\(\) nor toArray\(\)/)
  })

  test('a recipient with no key cannot be stored, and is told why', async () => {
    class Unsaved implements Notifiable {
      email = 'a@b.c'
    }

    await expect(
      new DatabaseNotificationChannel(db).send(new Unsaved(), new ArticlePublished({ title: 'x' }))
    ).rejects.toThrow(/needs a saved model/)
  })
})

describe('the log channel', () => {
  test('the payload and the recipient are written', async () => {
    const lines: Array<{ message: string; context?: Record<string, unknown> }> = []

    const channel = new LogNotificationChannel({
      info: (message, context) => lines.push({ message, context })
    })

    const notification = new ArticlePublished({ title: 'Hello' })
    notification.id = 'log-id'

    await channel.send(new User(1, 'ada@example.com'), notification)

    expect(lines[0]?.message).toContain('ArticlePublished')
    expect(lines[0]?.context).toMatchObject({
      id: 'log-id',
      route: 'ada@example.com',
      data: { title: 'Hello' }
    })
  })
})

describe('NotificationManager', () => {
  let app: Application

  beforeEach(() => {
    app = new Application(process.cwd())
    app.config.set('app.name', 'Playground')
  })

  test('an unknown channel points at extend()', () => {
    expect(() => new NotificationManager(app).channel('carrier-pigeon')).toThrow(
      /notifications\(\)\.extend/
    )
  })

  test('the mail channel says what it needs when mail is not registered', () => {
    expect(() => new NotificationManager(app).channel('mail')).toThrow(/MailServiceProvider/)
  })

  test('the database channel says what it needs when the database is not registered', () => {
    expect(() => new NotificationManager(app).channel('database')).toThrow(
      /DatabaseServiceProvider/
    )
  })

  test('extend registers a channel of your own', async () => {
    const delivered: string[] = []

    const manager = new NotificationManager(app)
    manager.extend('sms', () => ({
      name: 'sms',
      send: async (notifiable) => {
        delivered.push(String(routeFor(notifiable, 'sms')))

        return 'sent'
      }
    }))

    class BySms extends Notification<Record<string, never>> {
      via(): string[] {
        return ['sms']
      }
    }

    class Phone implements Notifiable {
      routeNotificationFor(channel: string): unknown {
        return channel === 'sms' ? '+61...' : null
      }
    }

    await manager.sendNow(new Phone(), new BySms({}))

    expect(delivered).toEqual(['+61...'])
  })

  test('channels are memoised', () => {
    const manager = new NotificationManager(app)
    manager.extend('sms', () => ({ name: 'sms', send: async () => null }))

    expect(manager.channel('sms')).toBe(manager.channel('sms'))
  })
})

describe('Notification.fake()', () => {
  let app: Application
  let manager: NotificationManager

  beforeEach(() => {
    app = new Application(process.cwd())
    manager = new NotificationManager(app)
  })

  afterEach(() => {
    manager.restore()
  })

  test('nothing is delivered, and via() is still asked', async () => {
    const fake = manager.fake()
    const user = new User(1, 'ada@example.com')

    // No mail or database provider is registered: without the fake this throws.
    await manager.send(user, new ArticlePublished({ title: 'Hello' }))

    fake.assertSentTo(user, 'ArticlePublished')
    fake.assertSentTimes('ArticlePublished', 1)
    fake.assertSentVia(user, 'ArticlePublished', 'mail')
    fake.assertSentVia(user, 'ArticlePublished', 'database')
  })

  test('assertions name what was actually sent', async () => {
    const fake = manager.fake()
    const ada = new User(1, 'ada@example.com')
    const linus = new User(2, 'linus@example.com')

    await manager.send(ada, new ArticlePublished({ title: 'Hello' }))

    fake.assertNotSentTo(linus, 'ArticlePublished')

    expect(() => fake.assertSentTo(linus, 'ArticlePublished')).toThrow(/but it was not/)
    expect(() => fake.assertNotSentTo(ada, 'ArticlePublished')).toThrow(/but it was/)
    expect(() => fake.assertSentTimes('ArticlePublished', 2)).toThrow(/but it was 1/)
    expect(() => fake.assertNothingSent()).toThrow(/found: ArticlePublished/)
    expect(() => fake.assertSentVia(ada, 'ArticlePublished', 'sms')).toThrow(
      /it used: mail, database/
    )
  })

  test('a matcher can look at the notification', async () => {
    const fake = manager.fake()
    const user = new User(1, 'ada@example.com')

    await manager.send(user, new ArticlePublished({ title: 'Hello' }))

    fake.assertSentTo(
      user,
      'ArticlePublished',
      (notification) => (notification.data as { title: string }).title === 'Hello'
    )

    expect(() =>
      fake.assertSentTo(
        user,
        'ArticlePublished',
        (notification) => (notification.data as { title: string }).title === 'Other'
      )
    ).toThrow(/matching the callback/)
  })

  test('sending to several recipients records each', async () => {
    const fake = manager.fake()
    const ada = new User(1, 'ada@example.com')
    const linus = new User(2, 'linus@example.com')

    await manager.send([ada, linus], new ArticlePublished({ title: 'Hello' }))

    fake.assertSentTimes('ArticlePublished', 2)
    fake.assertSentTo(ada, 'ArticlePublished')
    fake.assertSentTo(linus, 'ArticlePublished')
  })

  test('restore stops faking', () => {
    manager.fake()
    manager.restore()

    expect(manager.isFaking).toBe(false)
  })
})

describe('the recipient’s own language', () => {
  test('the translator is switched for the send, and restored after', async () => {
    const locales: string[] = []
    let current = 'en'

    const translator = {
      getLocale: () => current,
      setLocale: (locale: string) => {
        current = locale
      }
    }

    const sender = new NotificationSender(
      () => ({
        name: 'probe',
        send: async () => {
          locales.push(current)
        }
      }),
      { translator }
    )

    class Probe extends Notification<Record<string, never>> {
      via(): string[] {
        return ['probe']
      }
    }

    await sender.sendNow(
      [{ email: 'ada@example.com', preferredLocale: () => 'id' }, { email: 'linus@example.com' }],
      new Probe({})
    )

    // The language belongs to the person, not to whoever triggered the
    // notification — and a recipient who never said keeps the default.
    expect<string[]>(locales).toEqual(['id', 'en'])
    expect<string>(current).toBe('en')
  })

  test('a channel that throws still restores the locale', async () => {
    let current = 'en'

    const sender = new NotificationSender(
      () => ({
        name: 'probe',
        send: async () => {
          throw new Error('channel failed')
        }
      }),
      {
        translator: {
          getLocale: () => current,
          setLocale: (locale: string) => {
            current = locale
          }
        }
      }
    )

    class Probe extends Notification<Record<string, never>> {
      via(): string[] {
        return ['probe']
      }
    }

    await expect(
      sender.sendNow([{ email: 'ada@example.com', preferredLocale: () => 'id' }], new Probe({}))
    ).rejects.toThrow('channel failed')

    // Otherwise the process speaks the last recipient's language to everybody
    // after them.
    expect<string>(current).toBe('en')
  })
})

describe('the broadcast channel', () => {
  const sent: Array<{ channel: string; event: string; payload: unknown }> = []
  const broadcaster = {
    broadcast: (message: { channel: string; event: string; payload: unknown }) => {
      sent.push(message)

      return 1
    }
  }

  class OrderShipped extends Notification<{ order: number }> {
    via(): string[] {
      return ['broadcast']
    }

    override toArray(): Record<string, unknown> {
      return { order: this.data.order }
    }
  }

  test('it goes to the recipient’s own channel', async () => {
    sent.length = 0

    const channel = new BroadcastNotificationChannel(broadcaster)
    const notification = new OrderShipped({ order: 7 })
    notification.id = 'note-1'

    await channel.send({ getKey: () => 42 } as never, notification)

    // One channel per recipient is what lets a page subscribe once and receive
    // everything addressed to whoever is signed in.
    expect<string | undefined>(sent[0]?.channel).toBe('notifications.42')
    expect<string | undefined>(sent[0]?.event).toBe('OrderShipped')
    expect<unknown>(sent[0]?.payload).toEqual({ id: 'note-1', order: 7 })
  })

  test('an anonymous recipient is skipped', async () => {
    sent.length = 0

    const channel = new BroadcastNotificationChannel(broadcaster)

    // There is no id, so there is no private channel it could belong to — and a
    // guessable name would deliver somebody's notification to whoever subscribed.
    await channel.send({} as never, new OrderShipped({ order: 7 }))

    expect<number>(sent.length).toBe(0)
  })
})

describe('a notification written in markdown', () => {
  test('the mail channel renders it through the mail package', async () => {
    const sent: Array<{ html?: string; text?: string }> = []

    const mail = {
      mailer: () => ({
        send: async (mailable: { content(): { html?: string; text?: string } }) => {
          sent.push(mailable.content())

          return null
        }
      })
    }

    class ReleaseNotes extends Notification<Record<string, never>> {
      via(): string[] {
        return ['mail']
      }

      override toMail(): MailMessage {
        return new MailMessage()
          .subject('What changed')
          .markdown('## Changes\n\n- One thing\n- Another')
      }
    }

    await new MailNotificationChannel(mail as never).send(
      { email: 'ada@example.com' } as never,
      new ReleaseNotes({})
    )

    // A list stays a list — twelve `.line()` calls would lose the structure the
    // reader needs.
    expect<boolean>(sent[0]?.html?.includes('<li>One thing</li>') === true).toBe(true)
    expect<boolean>(sent[0]?.html?.includes('<h2') === true).toBe(true)
    // And the text part is the markdown itself, still readable.
    expect<boolean>(sent[0]?.text?.includes('- One thing') === true).toBe(true)
  })
})
