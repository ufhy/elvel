import { describe, expect, test } from 'bun:test'
import { Application, enterWorkContext } from '@elvel/core'
import { Dispatcher } from '@elvel/events'
import type { IncomingEntry } from '../src/entry.ts'
import { EntryType } from '../src/entry-type.ts'
import { Recorder } from '../src/recorder.ts'
import { ClientRequestWatcher } from '../src/watchers/client-request.ts'
import { DumpWatcher } from '../src/watchers/dump.ts'
import { EventWatcher } from '../src/watchers/event.ts'
import { MailWatcher } from '../src/watchers/mail.ts'
import { NotificationWatcher } from '../src/watchers/notification.ts'
import type { Watcher } from '../src/watchers/watcher.ts'

/** Synchronous — see the note in `watchers-more.test.ts` for why it must be. */
function bench(watcher: Watcher) {
  const app = new Application(process.cwd())
  const recorded: Array<{ type: string; entry: IncomingEntry }> = []
  const lens = new Recorder()

  lens.enable(true)
  app.instance('events', new Dispatcher())
  app.instance('lens', lens)

  enterWorkContext()
  lens.start()

  const original = lens.record.bind(lens)

  lens.record = (type, entry) => {
    original(type, entry)
    recorded.push({ type, entry })
  }

  watcher.register(app)

  return { events: app.make('events'), recorded, lens }
}

function content(entry: IncomingEntry): Record<string, unknown> {
  return entry.content as Record<string, unknown>
}

const MESSAGE = {
  mailable: 'InvoicePaid',
  from: { address: 'billing@shop.test', name: 'Shop' },
  to: [{ address: 'ada@example.test', name: 'Ada' }],
  cc: [{ address: 'books@shop.test' }],
  bcc: [],
  replyTo: [],
  subject: 'Your invoice',
  html: '<p>Thanks</p>',
  text: 'Thanks',
  attachments: [{ name: 'invoice.pdf' }]
}

describe('the mail watcher', () => {
  test('records the addresses, the subject and the body', () => {
    const { events, recorded } = bench(new MailWatcher({}))

    events.dispatch('mail.sent', { mailer: 'smtp', message: MESSAGE })

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(recorded[0]?.type).toBe(EntryType.MAIL)
    expect(fields.mailable).toBe('InvoicePaid')
    expect(fields.from).toEqual(['Shop <billing@shop.test>'])
    expect(fields.to).toEqual(['Ada <ada@example.test>'])
    expect(fields.cc).toEqual(['books@shop.test'])
    expect(fields.subject).toBe('Your invoice')
    expect(fields.html).toBe('<p>Thanks</p>')
    expect(fields.attachments).toBe(1)
  })

  /**
   * "Show me everything sent to this person" is the question support asks, and
   * a tag is what turns it into a lookup rather than a scan.
   */
  test('tags the entry with every recipient', () => {
    const { events, recorded } = bench(new MailWatcher({}))

    events.dispatch('mail.sent', { mailer: 'smtp', message: MESSAGE })

    expect(recorded[0]?.entry.tags).toEqual(['ada@example.test', 'books@shop.test'])
  })

  test('a body over the limit is dropped rather than truncated', () => {
    const { events, recorded } = bench(new MailWatcher({ bodyLimit: 1 }))

    events.dispatch('mail.sent', {
      mailer: 'smtp',
      message: { ...MESSAGE, html: 'x'.repeat(4000) }
    })

    expect(content(recorded[0]?.entry as IncomingEntry).html).toBe('Purged By Lens')
  })

  test('mail.sending is not recorded, only mail.sent', () => {
    const { events, recorded } = bench(new MailWatcher({}))

    events.dispatch('mail.sending', { mailer: 'smtp', message: MESSAGE })

    expect(recorded).toHaveLength(0)
  })
})

describe('the notification watcher', () => {
  /**
   * The two outcomes Telescope cannot see, because Laravel fires one event.
   *
   * A notification that was skipped looks exactly like one never dispatched,
   * and that is the support question a table of successes cannot answer.
   */
  test('records sent, failed and skipped', () => {
    const { events, recorded } = bench(new NotificationWatcher({}))

    events.dispatch('notification.sent', { notification: 'InvoicePaid', channel: 'mail', id: 'n1' })
    events.dispatch('notification.failed', {
      notification: 'InvoicePaid',
      channel: 'webhook',
      error: new Error('502')
    })
    events.dispatch('notification.skipped', { notification: 'Digest', channel: 'sms' })

    expect(recorded.map((one) => content(one.entry).outcome)).toEqual(['sent', 'failed', 'skipped'])
    expect(recorded.every((one) => one.type === EntryType.NOTIFICATION)).toBe(true)
    expect(content(recorded[1]?.entry as IncomingEntry).error).toBe('502')
    expect(content(recorded[0]?.entry as IncomingEntry).id).toBe('n1')
  })

  test('one entry per channel, because channels fail separately', () => {
    const { events, recorded } = bench(new NotificationWatcher({}))

    events.dispatch('notification.sent', { notification: 'Alert', channel: 'mail' })
    events.dispatch('notification.failed', {
      notification: 'Alert',
      channel: 'sms',
      error: 'no route'
    })

    expect(recorded).toHaveLength(2)
    expect(recorded.map((one) => content(one.entry).channel)).toEqual(['mail', 'sms'])
  })
})

describe('the event watcher', () => {
  test('records an application event with its payload', () => {
    const { events, recorded } = bench(new EventWatcher({}))

    events.dispatch('order.placed', { id: 9, total: 250 })

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(recorded[0]?.type).toBe(EntryType.EVENT)
    expect(fields.name).toBe('order.placed')
    expect(fields.payload).toEqual({ id: 9, total: 250 })
  })

  /**
   * The failure that took the spike's server down.
   *
   * `db.query` is dispatched by the insert that stores an entry, so a recorder
   * that records it grows one entry per entry and never stops.
   */
  test('ignores the framework events the other watchers cover', () => {
    const { events, recorded } = bench(new EventWatcher({}))

    for (const name of [
      'db.query',
      'log.message',
      'cache.hit',
      'gate.evaluated',
      'queue.job.processed',
      'schedule.task.finished',
      'mail.sent',
      'notification.sent',
      'user.created',
      'article.updated'
    ]) {
      events.dispatch(name, {})
    }

    expect(recorded).toHaveLength(0)
  })

  test('the framework list can be switched off', () => {
    const { events, recorded } = bench(new EventWatcher({ ignoreFrameworkEvents: false }))

    events.dispatch('cache.hit', { key: 'a' })

    expect(recorded).toHaveLength(1)
  })

  test('an ignored name is skipped', () => {
    const { events, recorded } = bench(new EventWatcher({ ignore: ['noisy.*'] }))

    events.dispatch('noisy.tick', {})
    events.dispatch('order.placed', {})

    expect(recorded).toHaveLength(1)
    expect(content(recorded[0]?.entry as IncomingEntry).name).toBe('order.placed')
  })

  /**
   * A payload holds a model, a model holds its relations, and a relation holds
   * the model back. A plain serialisation either throws or writes the graph.
   */
  test('a cycle in the payload does not throw, and is not followed forever', () => {
    const { events, recorded } = bench(new EventWatcher({}))

    class Node {
      name = 'root'
      self: unknown
    }

    const node = new Node()
    node.self = node

    events.dispatch('graph.built', { node })

    const payload = content(recorded[0]?.entry as IncomingEntry).payload

    expect(JSON.stringify(payload)).toContain('root')
    expect(JSON.stringify(payload)).toContain('[Node]')
  })

  test('a class payload is named as well as described', () => {
    const { events, recorded } = bench(new EventWatcher({}))

    class OrderPlaced {
      constructor(readonly id: number) {}
    }

    events.dispatch('anything', new OrderPlaced(4) as never)

    expect(content(recorded[0]?.entry as IncomingEntry).payload).toEqual({
      class: 'OrderPlaced',
      properties: { id: 4 }
    })
  })
})

describe('the client request watcher', () => {
  const attempt = {
    method: 'POST',
    url: 'https://api.stripe.test/v1/charges',
    headers: new Headers()
  }

  test('records the call, its host and its status', () => {
    const { events, recorded } = bench(new ClientRequestWatcher({}))

    events.dispatch('http.client.response', {
      attempt,
      response: { status: 201, body: 'x'.repeat(120) }
    })

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(recorded[0]?.type).toBe(EntryType.CLIENT_REQUEST)
    expect(fields.method).toBe('POST')
    expect(fields.host).toBe('api.stripe.test')
    expect(fields.responseStatus).toBe(201)
    expect(fields.responseSize).toBe(120)
    expect(fields.failed).toBe(false)
    expect(recorded[0]?.entry.tags).toContain('api.stripe.test')
  })

  /**
   * Somebody else's data arriving over a network the application does not
   * control is the wrong thing to keep by default.
   */
  test('does not record the response body', () => {
    const { events, recorded } = bench(new ClientRequestWatcher({}))

    events.dispatch('http.client.response', {
      attempt,
      response: { status: 200, body: '{"card":"4242424242424242"}' }
    })

    expect(JSON.stringify(recorded[0]?.entry.content)).not.toContain('4242')
  })

  test('a 5xx is marked failed', () => {
    const { events, recorded } = bench(new ClientRequestWatcher({}))

    events.dispatch('http.client.response', { attempt, response: { status: 503 } })

    expect(content(recorded[0]?.entry as IncomingEntry).failed).toBe(true)
  })

  test('an ignored host is skipped', () => {
    const { events, recorded } = bench(
      new ClientRequestWatcher({ ignoreHosts: ['api.stripe.test'] })
    )

    events.dispatch('http.client.response', { attempt, response: { status: 200 } })

    expect(recorded).toHaveLength(0)
  })

  test('a url that is not one does not throw', () => {
    const { events, recorded } = bench(new ClientRequestWatcher({}))

    events.dispatch('http.client.response', {
      attempt: { method: 'GET', url: 'not a url' },
      response: { status: 200 }
    })

    expect(content(recorded[0]?.entry as IncomingEntry).host).toBe('')
  })
})

describe('the dump watcher', () => {
  test('records the values and where they came from', () => {
    const { events, recorded } = bench(new DumpWatcher({}))

    events.dispatch('dump.captured', {
      values: [
        { label: '1', text: '{ id: 7 }' },
        { label: '2', text: '"Ada"' }
      ],
      origin: { file: '/app/routes/web.ts', line: 12 }
    })

    const fields = content(recorded[0]?.entry as IncomingEntry)

    expect(recorded[0]?.type).toBe(EntryType.DUMP)
    expect(fields.file).toBe('/app/routes/web.ts')
    expect(fields.line).toBe(12)
    expect((fields.values as Array<{ text: string }>).map((v) => v.text)).toEqual([
      '{ id: 7 }',
      '"Ada"'
    ])
  })

  test('an unlabelled single dump keeps a null label rather than inventing one', () => {
    const { events, recorded } = bench(new DumpWatcher({}))

    events.dispatch('dump.captured', {
      values: [{ label: undefined, text: '🐛' }],
      origin: undefined
    })

    const values = content(recorded[0]?.entry as IncomingEntry).values as Array<{
      label: unknown
    }>

    expect(values[0]?.label).toBeNull()
    expect(content(recorded[0]?.entry as IncomingEntry).file).toBeNull()
  })
})
